import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import { Store } from './store.mjs';
import { AgentEngine } from './agents.mjs';
import { Catalog, browse } from './catalog.mjs';
import { FeishuHub } from './feishu.mjs';
import { DATA_DIR, HUB_RUNTIME, cleanPath, log } from './config.mjs';
import { prepareLocations } from './paths.cjs';
import { listAgents,getAgent,addAgent,updateAgent,deleteAgent,discoverAgents } from './registry.mjs';
import { SetupManager } from './setup.mjs';
import { DshMonitor } from './dsh-monitor.mjs';
import { hookStatus, installHooks } from './hooks.mjs';
import { getSourceId } from './source-id.cjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.AGENT_PHONE_PORT || 4318), base=`http://127.0.0.1:${port}`;
const token=randomBytes(32).toString('hex');
prepareLocations();
const store=new Store(), engine=new AgentEngine(store);
let feishu;
let connectRetry, closing=false, connectAttempt=0;
const inflight=new Map();
const catalog=new Catalog(store, notifyExternal);
feishu=new FeishuHub(store,engine,catalog);
const setup=new SetupManager(async()=>{
  clearTimeout(connectRetry);connectAttempt++;await feishu.disconnect();
  store.data.ownerChatId=null;for(const item of store.data.outbox)item.to=null;store.data.contexts={};store.save();
  await connectFeishu();
});
const publicState=()=>({...store.publicState(feishu.connection),setup:setup.state(),version:'0.3.0'});
const dshMonitor=new DshMonitor(store,{
  isManagedSession:(profile,remoteId)=>store.data.sessions.some(s=>s.agentId===profile.id && s.remoteId===remoteId && engine.jobs.has(s.id)),
  onStatus:status=>{store.data.agentConnections ||= {};const old=store.data.agentConnections[status.agentId];if(JSON.stringify(old)!==JSON.stringify(status)){store.data.agentConnections[status.agentId]=status;store.emit('change');}},
  onCompleted:async event=>{
    const s=dshSession(event);if(!s)return feishu.notifyGeneric({agent:event.profile.name,cwd:event.cwd,last_assistant_message:event.text,status:event.status},event.key);
    if(engine.jobs.has(s.id))return;
    s.status=event.status;s.updatedAt=Date.now();s.lastTurnId=event.key;
    if(event.status==='error')s.error=event.event.data?.reason?.error?.message || 'DSH 任务失败。';else s.error=null;
    if(event.text && s.messages.at(-1)?.text!==event.text)s.messages.push({role:'assistant',text:event.text,ts:Date.now()});
    engine.requests.cancelSession(s.id);store.save();await feishu.notifySession(s,event.key);
  },
  onAttention:async event=>{
    const s=dshSession(event);const spec={sessionId:s?.id,agentId:event.profile.id,nativeRequestId:event.request.id,kind:event.request.kind,title:event.request.title || `${event.profile.name} 需要你的操作`,description:event.request.message,options:event.request.choices};
    if(event.request.questions?.length>1){const job={session:s || {id:null},stopped:false};const values=await engine.askQuestions(job,event.request.questions,{nativeRequestId:event.request.id,agentId:event.profile.id});if(values)await event.respond({answers:values.map(v=>({id:v.question.id,selected:v.selected,...(v.selected.length?{}:{custom:v.value})}))});}
    else engine.requests.create(spec,answer=>answer.cancelled?undefined:event.respond(answer));
  },
  onResolved:event=>{
    for(const r of engine.requests.pending())if(r.agentId===event.profile.id && r.nativeRequestId===event.requestId)engine.requests.cancel(r.id);
    const s=store.data.sessions.find(s=>s.agentId===event.profile.id && s.remoteId===event.sessionId);if(s?.status==='waiting' && !engine.requests.pending(s.id).length){s.status='running';store.save();}
  }
});
dshMonitor.on('callback-error',({name,error})=>log('dsh.monitor-error',{name,message:error.message}));
function dshSession(event){
  let s=store.data.sessions.find(s=>s.agentId===event.profile.id && s.remoteId===event.sessionId);if(s)return s;
  if(!event.cwd || !fs.existsSync(event.cwd))return null;
  const p=store.addProject(event.cwd);
  s={id:randomUUID(),agentId:event.profile.id,projectId:p.id,cwd:p.path,title:event.title || 'DSH 任务',remoteId:event.sessionId,source:'external',messages:[],status:'running',createdAt:Date.now(),updatedAt:Date.now()};store.data.sessions.unshift(s);store.save();return s;
}

async function notifyExternal(event) {
  const remoteId=event.session_id || event.thread_id || event.conversation_id;
  const key=remoteId && event.turn_id ? `${remoteId}:${event.turn_id}` : null;
  if(key && store.data.notifications.some(n=>n.externalKey===key))return { duplicate:true };
  if(key && inflight.has(key))return inflight.get(key);
  const promise=(async()=>{
    catalog.refresh();
    let session=remoteId ? store.data.sessions.find(s=>s.remoteId===remoteId) : null;
    const agentId={codex:'codex-cli',claude:'claude',cursor:'cursor'}[event.agent] || event.agent;
    if(!session && listAgents(store).some(a=>a.id===agentId) && event.cwd) {
      const p=store.addProject(event.cwd);
      session={id:randomUUID(),agentId,projectId:p.id,cwd:p.path,title:'电脑上的任务',remoteId,source:'external',messages:[],status:'done',createdAt:Date.now(),updatedAt:Date.now()};
      store.data.sessions.unshift(session);
    }
    const needsInput=event.event==='attention' || event.type==='attention' || ['Notification','PermissionRequest'].includes(event.hook_event_name);
    if(needsInput){
      if(session && engine.jobs.has(session.id))return {managed:true};
      const nativeId=event.request_id || event.requestId;
      const existing=nativeId && engine.requests.pending().find(r=>r.nativeRequestId===nativeId && r.sessionId===session?.id);if(existing)return {accepted:true,requestId:existing.id};
      const request=engine.requests.create({sessionId:session?.id,agentId,kind:event.kind || 'input',title:event.title || `${event.agent || 'Agent'} 需要你的操作`,description:event.description || event.message || event.prompt || event.last_assistant_message || '请查看任务并回复。',options:event.options || event.choices || [],blocking:event.blocking!==false,nativeRequestId:nativeId});
      return {accepted:true,requestId:request.id};
    }
    if(session) {
      if(engine.jobs.has(session.id))return { managed:true };
      catalog.loadHistory(session);
      const answer=event.last_assistant_message || '任务已完成。';
      if(session.messages?.at(-1)?.text!==answer) {session.messages ||= [];session.messages.push({role:'assistant',text:answer,ts:Date.now()});}
      session.status=event.status==='error'?'error':'done';session.updatedAt=Date.now();store.save();
      engine.requests.cancelSession(session.id);
      await feishu.notifySession(session,key);
    }else{
      await feishu.notifyGeneric(event,key);
    }
    return {accepted:true};
  })();
  if(key)inflight.set(key,promise);
  try{return await promise;}finally{if(key)inflight.delete(key);}
}

function json(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));
}
async function readBody(req) {
  const chunks=[];let count=0;
  for await(const chunk of req){count+=chunk.length;if(count>1024*1024)throw new Error('请求过大。');chunks.push(chunk);}
  const body=Buffer.concat(chunks).toString('utf8');return body ? JSON.parse(body) : {};
}
function validatedFiles(files) {
  if(!Array.isArray(files)||files.length>20)throw new Error('一次最多选择 20 个文件。');
  return files.map(file=>{const p=cleanPath(file);if(!fs.statSync(p).isFile())throw new Error('所选文件不存在。');return p;});
}
function nativePicker(kind) {
  if(!['folder','files','executable'].includes(kind))throw new Error('不支持的选择器。');
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'picker.ps1'),'-Kind',kind],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    child.on('error',reject);child.on('close',code=>{try{if(code)throw new Error(err || '目录选择器退出。');resolve(JSON.parse(out.trim() || '[]'));}catch(e){reject(e);}});
  });
}

export const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return json(res,403,{error:'仅允许本机访问。'});
    const url=new URL(req.url,base);
    if(req.headers.origin && ![base,`http://localhost:${port}`].includes(req.headers.origin))return json(res,403,{error:'来源无效。'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'来源无效。'});
    const staticFiles={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/guide':'guide.html'};
    if(req.method==='GET' && staticFiles[url.pathname]){
      const file=staticFiles[url.pathname],types={html:'text/html',js:'text/javascript',css:'text/css'};
      res.writeHead(200,{'Content-Type':`${types[path.extname(file).slice(1)]}; charset=utf-8`,'Cache-Control':'no-store','Set-Cookie':`agent_phone=${token}; HttpOnly; SameSite=Strict; Path=/`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});
      return res.end(fs.readFileSync(path.join(ROOT,'web',file)));
    }
    const authenticated=req.headers['x-agent-phone-token']===token || req.headers.cookie?.split(';').some(s=>s.trim()===`agent_phone=${token}`);
    if(!authenticated)return json(res,401,{error:'请先打开本机管理界面。'});
    if(req.method!=='GET' && !req.headers.origin && req.headers['x-agent-phone-token']!==token)return json(res,403,{error:'来源无效。'});
    if(req.method==='GET' && url.pathname==='/api/state')return json(res,200,publicState());
    if(req.method==='GET' && url.pathname==='/api/agents/discover')return json(res,200,{agents:discoverAgents()});
    if(req.method==='GET' && url.pathname==='/api/hooks/status')return json(res,200,{hooks:hookStatus()});
    if(req.method==='GET' && url.pathname==='/api/browse')return json(res,200,browse(url.searchParams.get('path'),url.searchParams.get('offset'),url.searchParams.get('files')!=='false'));
    const sessionMatch=url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(run|stop|input))?$/);
    const agentMatch=url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    const requestMatch=url.pathname.match(/^\/api\/requests\/([^/]+)(?:\/(respond|cancel))?$/);
    if(req.method==='GET' && requestMatch){const request=store.data.requests.find(r=>r.id===requestMatch[1]);if(!request)return json(res,404,{error:'请求不存在。'});return json(res,200,request);}
    if(req.method==='DELETE' && agentMatch){if(store.data.sessions.some(s=>s.agentId===agentMatch[1] && engine.jobs.has(s.id)))throw new Error('请先停止这个 Agent 的任务。');deleteAgent(store,agentMatch[1]);return json(res,200,{deleted:true});}
    if(req.method==='PATCH' && agentMatch){return json(res,200,updateAgent(store,agentMatch[1],await readBody(req)));}
    if(req.method==='GET' && sessionMatch){const s=store.session(sessionMatch[1]);catalog.loadHistory(s);return json(res,200,s);}
    if(req.method==='POST'){
      const body=await readBody(req);
      if(url.pathname==='/api/agents')return json(res,201,addAgent(store,body));
      if(url.pathname==='/api/hooks/install')return json(res,200,installHooks({agents:body.agents,cursorApproval:body.cursorApproval===true}));
      if(requestMatch?.[2]==='respond')return json(res,200,await engine.requests.respond(requestMatch[1],body));
      if(requestMatch?.[2]==='cancel')return json(res,200,{cancelled:engine.requests.cancel(requestMatch[1],'expired')});
      if(url.pathname==='/api/setup/pairing')return json(res,200,await setup.startPairing());
      if(url.pathname==='/api/setup/credentials')return json(res,200,await setup.credentials(body));
      if(url.pathname==='/api/setup/disconnect'){clearTimeout(connectRetry);connectAttempt++;setup.disconnect();await feishu.disconnect();return json(res,200,setup.state());}
      if(url.pathname==='/api/projects')return json(res,201,store.addProject(body.path));
      if(url.pathname==='/api/picker')return json(res,200,{paths:await nativePicker(body.kind)});
      if(url.pathname==='/api/sessions')return json(res,201,store.createSession(body.agentId,body.projectId));
      if(sessionMatch?.[2]==='run')return json(res,202,engine.start(sessionMatch[1],body.prompt,validatedFiles(body.files || [])));
      if(sessionMatch?.[2]==='stop')return json(res,200,{stopped:await engine.stop(sessionMatch[1])});
      if(sessionMatch?.[2]==='input')return json(res,200,await engine.input(sessionMatch[1],body.text));
      if(url.pathname==='/api/refresh'){catalog.refresh();return json(res,200,publicState());}
      if(url.pathname==='/api/menu'){await feishu.menu();return json(res,200,{sent:true});}
      if(url.pathname==='/api/hooks')return json(res,200,await notifyExternal(body));
      if(url.pathname==='/api/shutdown'){json(res,200,{stopping:true});setTimeout(shutdown,20);return;}
    }
    json(res,404,{error:'接口不存在。'});
  }catch(error){json(res,400,{error:error.message});}
});

server.listen(port,'127.0.0.1',()=>{
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(HUB_RUNTIME,JSON.stringify({pid:process.pid,url:base,token,serverHash:getSourceId(ROOT),startedAt:new Date().toISOString()}));
  catalog.start();
  dshMonitor.start();
  console.log(`Agent Phone 管理界面：${base}`);
  if(setup.state().configured)void connectFeishu();
});
async function connectFeishu(){
  const attempt=++connectAttempt;if(closing || !setup.state().configured)return;
  try{await feishu.connect();if(attempt===connectAttempt && feishu.connection.connected)console.log('统一飞书机器人已连接。');}
  catch(error){if(attempt!==connectAttempt)return;feishu.connection.error=error.message;log('feishu.connect-failed',{message:error.message});console.error('飞书连接失败：'+error.message);if(!closing && setup.state().configured)connectRetry=setTimeout(connectFeishu,10000);}
}
server.on('error',error=>{console.error('服务启动失败：'+error.message);catalog.close();dshMonitor.stop();clearTimeout(connectRetry);void feishu.disconnect().finally(()=>process.exit(1));});
async function shutdown(){if(closing)return;closing=true;clearTimeout(connectRetry);setup.close();catalog.close();dshMonitor.stop();await engine.close();await feishu.disconnect();server.close();try{if(JSON.parse(fs.readFileSync(HUB_RUNTIME)).pid===process.pid)fs.unlinkSync(HUB_RUNTIME);}catch{}process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
