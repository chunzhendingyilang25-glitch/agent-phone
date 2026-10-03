import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installHooks,hookStatus} from '../hub/hooks.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-phone-hooks-中文 空格-'));
  const profile=path.join(directory,'profile'),data=path.join(profile,'.agent-phone');fs.mkdirSync(data,{recursive:true});
  const env={...process.env,USERPROFILE:profile,APPDATA:path.join(profile,'AppData','Roaming'),LOCALAPPDATA:path.join(profile,'AppData','Local'),CODEX_HOME:path.join(profile,'.codex'),CLAUDE_CONFIG_DIR:path.join(profile,'.claude'),AGENT_PHONE_MANAGED:'0',AGENT_PHONE_STRICT:'0',AGENT_PHONE_HOOK_TIMEOUT_MS:'300',AGENT_PHONE_HOOK_POLL_MS:'10'};
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,profile,data,env};
}
async function service(t,fixture,callback) {
  const received=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request={path:req.url,method:req.method,token:req.headers['x-agent-phone-token'],body:chunks.length?JSON.parse(Buffer.concat(chunks)):null};received.push(request);
    const value=await callback(request,received);
    res.writeHead(value?.httpStatus || 200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(fixture.data,'hub-runtime.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'fixture-token'}));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return received;
}
async function notify(fixture,agent,mode,event) {
  const child=spawn(process.execPath,[path.join(ROOT,'feishu-notify.js'),agent,...(mode?[mode]:[])],{env:fixture.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.stdin.end(typeof event==='string'?event:JSON.stringify(event));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(stdout.trim().split('\n').length,1,'Hook stdout must contain exactly one JSON object');
  return {code,output:JSON.parse(stdout.trim()),stderr};
}

test('completion and advisory attention Hooks deliver through the authenticated Hub',async t=>{
  const f=fixture(t),received=await service(t,f,()=>({accepted:true,requestId:'advisory'}));
  const completed=await notify(f,'cursor','completion',{workspace_roots:[f.directory],conversation_id:'session',last_assistant_message:'完成'});
  assert.equal(completed.code,0);assert.deepEqual(completed.output,{});
  const attention=await notify(f,'claude','attention',{hook_event_name:'Notification',message:'等待输入',cwd:f.directory});
  assert.deepEqual(attention.output,{});assert.equal(received.length,2);
  assert.ok(received.every(r=>r.token==='fixture-token'));
  assert.equal(received[0].body.cwd,f.directory);assert.equal(received[0].body.event,'completed');
  assert.equal(received[1].body.event,'attention');assert.equal(received[1].body.blocking,false);assert.equal(received[1].body.description,'等待输入');
});

for(const agent of ['codex','claude'])test(`${agent} permission Hook waits and approves only the selected allow option`,async t=>{
  const f=fixture(t);let polls=0;
  const received=await service(t,f,r=>r.method==='POST'?{accepted:true,requestId:'permission-id'}:++polls<2?{status:'responding'}:{status:'answered',response:{optionId:'allow',text:'批准'}});
  const result=await notify(f,agent,'permission',{hook_event_name:'PermissionRequest',session_id:'remote-session',tool_name:'Bash',tool_input:{command:'echo "hello"',description:'读取文件'},cwd:f.directory});
  assert.equal(result.code,0);assert.equal(result.output.hookSpecificOutput.hookEventName,'PermissionRequest');assert.deepEqual(result.output.hookSpecificOutput.decision,{behavior:'allow'});
  assert.equal(polls,2);assert.equal(received[0].body.kind,'approval');assert.equal(received[0].body.blocking,true);
  assert.match(received[0].body.description,/echo "hello"/);assert.deepEqual(received[0].body.options.map(o=>o.id),['allow','deny']);
});

test('Cursor permission Hook denies a typed allow without an allow option id',async t=>{
  const f=fixture(t);await service(t,f,r=>r.method==='POST'?{accepted:true,requestId:'permission-id'}:{status:'answered',response:{text:'allow'}});
  const result=await notify(f,'cursor','permission',{command:'echo hi',cwd:f.directory});assert.equal(result.code,0);assert.equal(result.output.permission,'deny');
});

test('a timed out Hook cancels the Hub request and emits a native denial',async t=>{
  const f=fixture(t);f.env.AGENT_PHONE_HOOK_TIMEOUT_MS='25';
  const received=await service(t,f,r=>r.path.endsWith('/cancel')?{cancelled:true}:r.method==='POST'?{accepted:true,requestId:'timeout-id'}:{status:'pending'});
  const result=await notify(f,'claude','permission',{tool_name:'Bash',tool_input:{command:'echo hi'},cwd:f.directory});
  assert.equal(result.code,0);assert.equal(result.output.hookSpecificOutput.decision.behavior,'deny');assert.match(result.stderr,/超时/);
  assert.equal(received.at(-1).path,'/api/requests/timeout-id/cancel');assert.equal(received.at(-1).method,'POST');
});

test('a disconnected Hub cannot grant a permission and pending request is cancelled',async t=>{
  const f=fixture(t);const received=await service(t,f,r=>r.path.endsWith('/cancel')?{cancelled:true}:r.method==='POST'?{accepted:true,requestId:'broken-id'}:{httpStatus:503,error:'offline'});
  const result=await notify(f,'codex','permission',{tool_name:'Bash',tool_input:{command:'echo hi'}});
  assert.equal(result.output.hookSpecificOutput.decision.behavior,'deny');assert.equal(result.code,0);assert.equal(received.at(-1).path,'/api/requests/broken-id/cancel');
});

test('cancelled requests and malformed input are explicitly denied',async t=>{
  const f=fixture(t);await service(t,f,r=>r.method==='POST'?{accepted:true,requestId:'cancelled-id'}:{status:'cancelled',response:{cancelled:true}});
  assert.equal((await notify(f,'codex','permission',{})).output.hookSpecificOutput.decision.behavior,'deny');
  assert.equal((await notify(f,'claude','permission','{invalid')).output.hookSpecificOutput.decision.behavior,'deny');
});

test('managed Agents skip native Hooks, and a generic input Hook returns its response',async t=>{
  const f=fixture(t);f.env.AGENT_PHONE_MANAGED='1';
  assert.deepEqual((await notify(f,'codex','permission',{})).output,{});
  f.env.AGENT_PHONE_MANAGED='0';await service(t,f,r=>r.method==='POST'?{accepted:true,requestId:'input-id'}:{status:'answered',response:{text:'下一步',source:'feishu'}});
  assert.deepEqual((await notify(f,'custom','input',{message:'下一步做什么？'})).output,{response:{text:'下一步',source:'feishu'}});
});

test('reading Hook status changes no files; install preserves other Hooks and creates backups',t=>{
  const f=fixture(t),file=path.join(f.profile,'.claude','settings.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  const initial={model:'existing',hooks:{Stop:[{hooks:[{type:'command',command:'unrelated.exe'}]}]}};fs.writeFileSync(file,JSON.stringify(initial));
  assert.equal(hookStatus({env:f.env})[1].installed,false);assert.deepEqual(JSON.parse(fs.readFileSync(file)),initial);
  const result=installHooks({env:f.env,agents:['claude'],node:process.execPath});assert.equal(result.backups.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(result.backups[0])),initial);
  const config=JSON.parse(fs.readFileSync(file));assert.equal(config.model,'existing');assert.equal(config.hooks.Stop[0].hooks[0].command,'unrelated.exe');
  const hook=config.hooks.PermissionRequest[0].hooks[0];assert.equal(hook.command,process.execPath);assert.deepEqual(hook.args.slice(-2),['claude','permission']);
  const again=installHooks({env:f.env,agents:['claude'],node:process.execPath});assert.equal(again.changed.length,0);assert.equal(again.status[1].attention,true);
});

test('Codex install leaves config.toml and trust records intact; Cursor approval fails closed',t=>{
  const f=fixture(t),codex=path.join(f.profile,'.codex');fs.mkdirSync(codex,{recursive:true});
  const original='notify = ["existing"]\n[hooks]\ntrusted_hash = "user-controlled"\n';fs.writeFileSync(path.join(codex,'config.toml'),original);
  const result=installHooks({env:f.env,agents:['codex','cursor'],node:process.execPath,cursorApproval:true});
  assert.equal(fs.readFileSync(path.join(codex,'config.toml'),'utf8'),original);assert.equal(result.codexTrustRequired,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile,'.cursor','hooks.json'))).hooks.beforeShellExecution[0].failClosed,true);
});

test('invalid existing Hook config is rejected before any config is written',t=>{
  const f=fixture(t),cursor=path.join(f.profile,'.cursor');fs.mkdirSync(cursor,{recursive:true});fs.writeFileSync(path.join(cursor,'hooks.json'),'{bad');
  assert.throws(()=>installHooks({env:f.env,agents:['claude','cursor'],node:process.execPath}));assert.equal(fs.existsSync(path.join(f.profile,'.claude','settings.json')),false);
});
