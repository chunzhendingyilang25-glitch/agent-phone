import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('a clean install adds an agent, pauses for input, resumes the same process and queues notifications',async t=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'agent-phone-clean-中文-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const base=`http://127.0.0.1:${port}`;
 const root=fileURLToPath(new URL('..',import.meta.url));
 const child=spawn(process.execPath,['hub/server.mjs'],{cwd:root,env:{...process.env,USERPROFILE:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),CODEX_HOME:path.join(profile,'.codex'),CLAUDE_CONFIG_DIR:path.join(profile,'.claude'),AGENT_PHONE_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',()=>{});
 let token;
 t.after(async()=>{
  if(child.exitCode===null){const done=once(child,'exit');try{await api('/api/shutdown',{});}catch{child.kill();}await done;}
  assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 });
 const runtime=path.join(profile,'.agent-phone/hub-runtime.json');
 for(let i=0;i<200 && !fs.existsSync(runtime);i++){if(child.exitCode!==null)assert.fail(stderr);await new Promise(resolve=>setTimeout(resolve,20));}
 assert.ok(fs.existsSync(runtime),stderr);token=JSON.parse(fs.readFileSync(runtime,'utf8')).token;
 async function api(route,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(base+route,{method,headers:{'x-agent-phone-token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();assert.ok(response.ok,`${route}: ${JSON.stringify(result)}`);return result;
 }
 const state=await api('/api/state');assert.equal(state.version,'0.3.0');assert.equal(state.setup.configured,false);assert.equal(state.connection.connected,false);assert.deepEqual(state.projects,[]);assert.deepEqual(state.sessions,[]);assert.equal(fs.existsSync(path.join(profile,'.agent-phone/feishu-config.toml')),false);
 const unauth=await fetch(base+'/api/state');assert.equal(unauth.status,401);
 const foreign=await fetch(base+'/api/projects',{method:'POST',headers:{'x-agent-phone-token':token,Origin:'https://foreign.invalid','Content-Type':'application/json'},body:JSON.stringify({path:profile})});assert.equal(foreign.status,403);
 const project=await api('/api/projects',{path:profile});
 const script=path.join(profile,'fixture-agent.mjs');fs.writeFileSync(script,`import {createInterface} from 'node:readline';let round=0;createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='prompt'){round++;process.stdout.write(JSON.stringify({type:'attention',id:'q-'+round,kind:'question',message:'请选择测试选项',choices:[{id:'yes',label:'确认'}]})+'\\n');}if(m.type==='response')process.stdout.write(JSON.stringify({type:'completed',text:'第'+round+'轮:'+m.value.text})+'\\n');});`);
 const agent=await api('/api/agents',{name:'测试 Agent',kind:'line-json',executable:process.execPath,args:[script],completionMode:'json',inputMode:'json'});
 const session=await api('/api/sessions',{agentId:agent.id,projectId:project.id});
 async function pending(){for(let i=0;i<100;i++){const state=await api('/api/state');const r=state.requests.find(r=>r.sessionId===session.id);if(r)return r;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Agent request was not surfaced');}
 async function done(){for(let i=0;i<100;i++){const s=await api('/api/sessions/'+session.id);if(s.status==='done')return s;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Agent did not complete');}
 await api(`/api/sessions/${session.id}/run`,{prompt:'测试第一轮'});let request=await pending();assert.equal((await api('/api/sessions/'+session.id)).status,'waiting');
 const removal=await fetch(base+'/api/agents/'+agent.id,{method:'DELETE',headers:{'x-agent-phone-token':token}});assert.equal(removal.status,400);
 await api(`/api/requests/${request.id}/respond`,{optionId:'yes'});let completed=await done();assert.equal(completed.messages.at(-1).text,'第1轮:确认');
 await api(`/api/sessions/${session.id}/run`,{prompt:'原进程续聊'});request=await pending();await api(`/api/requests/${request.id}/respond`,{text:'中文输入'});completed=await done();assert.equal(completed.messages.at(-1).text,'第2轮:中文输入');
 const current=await api('/api/state');assert.equal(current.notifications.filter(n=>n.sessionId===session.id && n.status==='waiting').length,2);assert.equal(current.notifications.filter(n=>n.sessionId===session.id && n.status==='done').length,2);assert.ok(current.notifications.every(n=>n.delivery==='pending'));
 const hook=await api('/api/hooks',{agent:agent.id,type:'attention',session_id:'external-test',cwd:profile,kind:'approval',description:'外部命令需要批准',options:[{id:'allow',label:'允许'}]});
 assert.ok(hook.requestId);await api(`/api/requests/${hook.requestId}/respond`,{optionId:'allow'});const receipt=await api('/api/requests/'+hook.requestId);assert.equal(receipt.status,'answered');assert.equal(receipt.response.optionId,'allow');
 await api('/api/hooks',{agent:agent.id,type:'completion',session_id:'external-test',cwd:profile,last_assistant_message:'外部任务完成'});
 await api('/api/agents/'+agent.id,undefined,'DELETE');assert.ok(!(await api('/api/state')).agents.some(a=>a.id===agent.id));
});
