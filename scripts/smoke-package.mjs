import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const originalRuntime=path.join(root,'dist','win-unpacked','resources','runtime');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-phone-distribution-中文 空格-'));
const runtime=path.join(directory,'安装程序','runtime');
const profile=path.join(directory,'新用户');
const probe=net.createServer();
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const env={...process.env,USERPROFILE:profile,APPDATA:path.join(profile,'AppData','Roaming'),LOCALAPPDATA:path.join(profile,'AppData','Local'),CODEX_HOME:path.join(profile,'.codex'),CLAUDE_CONFIG_DIR:path.join(profile,'.claude'),AGENT_PHONE_PORT:String(port),AGENT_PHONE_DESKTOP:'1'};
delete env.NODE_PATH;delete env.NODE_OPTIONS;
let output='',child;
try {
  // Run outside the checkout so Node cannot accidentally resolve a missing
  // packaged dependency from the developer's ancestor node_modules.
  fs.cpSync(originalRuntime,runtime,{recursive:true});
  child=spawn(path.join(runtime,'node.exe'),[path.join(runtime,'hub','server.mjs')],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let info;
  for(let attempt=0;attempt<150;attempt++) {
    try {info=JSON.parse(fs.readFileSync(path.join(profile,'.agent-phone','hub-runtime.json')));break;}catch{}
    if(child.exitCode!==null)throw new Error('新用户后台启动失败：'+output);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(info,'Fresh user Hub did not become ready');
  assert.equal(info.url,`http://127.0.0.1:${port}`);
  const {getSourceId}=createRequire(import.meta.url)(path.join(runtime,'hub','source-id.cjs'));assert.equal(info.serverHash,getSourceId(path.join(runtime,'hub')));
  const request=async(route,method='GET',body)=>{
    const result=await fetch(info.url+route,{method,headers:{'x-agent-phone-token':info.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.ok(result.ok,`${route}: ${result.status}`);return result.json();
  };
  const state=await request('/api/state');assert.equal(state.setup.configured,false);assert.equal(state.projects.length,0);assert.equal(state.version,'0.3.0');
  assert.ok(state.agents.some(a=>a.id==='codex-cli'));
  assert.equal(fs.existsSync(path.join(profile,'.agent-phone','feishu-config.toml')),false);
  const page=await fetch(info.url+'/');assert.equal(page.status,200);assert.match(await page.text(),/Agent Phone/);
  const project=await request('/api/projects','POST',{path:directory});assert.equal(project.path,path.resolve(directory));
  const notice=await request('/api/hooks','POST',{agent:'fixture-agent',event:'attention',kind:'input',request_id:'distribution-input',message:'测试输入',cwd:directory,blocking:true});assert.ok(notice.requestId);
  await request('/api/requests/'+notice.requestId+'/respond','POST',{text:'输入测试成功'});
  const answer=await request('/api/requests/'+notice.requestId);assert.equal(answer.status,'answered');assert.equal(answer.response.text,'输入测试成功');
  await request('/api/shutdown','POST',{});
  let closeTimer;
  const code=await Promise.race([exited,new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('新用户后台关闭超时。')),10000);})]).finally(()=>clearTimeout(closeTimer));
  assert.equal(code,0);assert.equal(fs.existsSync(path.join(profile,'.agent-phone','hub-runtime.json')),false);
  console.log('发行包隔离新用户验证通过：无预绑凭据、空项目首次启动、内置运行环境、输入请求往返、干净关闭。');
} finally {
  if(child?.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});
}
