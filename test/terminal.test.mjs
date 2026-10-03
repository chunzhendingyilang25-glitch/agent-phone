import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TerminalRunner } from '../hub/terminal.mjs';

function fakePty() {
  const writes = []; let data, exit; let launches = 0;
  const process = { onData(fn) { data = fn; }, onExit(fn) { exit = fn; }, write(v) { writes.push(v); }, kill() { exit({ exitCode: 1 }); } };
  return { pty: { spawn() { launches++; return process; } }, data(v) { data(v); }, exit(code) { exit({ exitCode: code }); }, writes, get launches() { return launches; } };
}
test('persistent terminal completes only on explicit marker and reuses process', async () => {
  const fake = fakePty(), runner = new TerminalRunner({ kind: 'terminal', command: 'fake', completionMode: 'marker', completionMarker: '[DONE]', attentionMarker: '[ASK]' }, { pty: fake.pty });
  const finished = [], requests = []; runner.on('completed', value => finished.push(value)); runner.on('attention', value => requests.push(value));
  await runner.start({ cwd: '.', prompt: 'first', sessionId: 's1' });
  assert.equal(fake.writes[0], 'first\r'); fake.data('ordinary output\n'); assert.equal(finished.length, 0);
  fake.data('\x1b[32m[ASK] Allow?\x1b[0m'); assert.equal(requests.length, 1);
  runner.respond(requests[0].id, { optionId: 'yes' }); assert.equal(fake.writes.at(-1), 'yes\r');
  fake.data('\nanswer\n[DONE]\n'); assert.equal(finished.length, 1); assert.match(finished[0].text, /answer/);
  await runner.start({ cwd: '.', prompt: 'second', sessionId: 's1' }); fake.data('second answer\n[DONE]'); assert.equal(fake.launches, 1); assert.equal(finished.length, 2);
  fake.exit(0); assert.equal(finished.length, 2);
});
test('terminal input preserves multiline prompt and stops only owned process', async () => {
  const fake = fakePty(), runner = new TerminalRunner({ kind: 'terminal', command: 'fake', completionMode: 'exit' }, { pty: fake.pty });
  const completed = []; runner.on('completed', v => completed.push(v));
  await runner.start({ cwd: '.', prompt: '中文\nnext', sessionId: 's' }); assert.equal(fake.writes[0], '\x1b[200~中文\nnext\x1b[201~\r');
  runner.stop(); assert.equal(completed[0].status, 'interrupted');
});
test('line-json adapter handles structured attention, response and repeated completion', async () => {
  const code = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){let e=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(e.type==='prompt')console.log(JSON.stringify({type:'attention',id:'ask-'+e.text,message:'请选择',choices:['yes']}));else if(e.type==='response')console.log(JSON.stringify({type:'completed',text:'收到 '+e.value.optionId}));}});`;
  const runner = new TerminalRunner({ kind: 'line-json', command: process.execPath, args: ['-e', code], inputMode: 'json', completionMode: 'json' });
  const firstAttention = once(runner, 'attention'); await runner.start({ cwd: '.', prompt: 'first', sessionId: 's' });
  const [attention] = await firstAttention; assert.equal(attention.id, 'ask-first'); assert.equal(attention.choices[0].id, 'yes');
  const done = once(runner, 'completed'); runner.respond(attention.id, { optionId: 'yes' }); assert.equal((await done)[0].text, '收到 yes');
  const next = once(runner, 'attention'); await runner.start({ cwd: '.', prompt: 'second', sessionId: 's' }); assert.equal((await next)[0].id, 'ask-second');
  const exit = once(runner, 'exit'); runner.stop(); await exit;
});

test('real ConPTY host preserves Chinese input and exits its owned process tree', {skip:process.platform !== 'win32',timeout:15000}, async () => {
  const code="process.stdin.setEncoding('utf8');process.stdin.on('data',text=>process.stdout.write('已收到:'+text+'\\n[DONE]\\n'));setInterval(()=>{},1000);";
  const runner=new TerminalRunner({kind:'terminal',command:process.execPath,args:['-e',code],completionMode:'marker',completionMarker:'[DONE]'});
  let hostPid,agentPid;
  try {
    const completed=once(runner,'completed');await runner.start({cwd:process.cwd(),prompt:'中文停止测试',sessionId:'conpty-stop'});
    hostPid=runner.host.pid;agentPid=runner.process.pid;
    assert.match((await completed)[0].text,/中文停止测试/);
    const exited=once(runner,'exit');runner.stop();await exited;
    assert.equal(runner.closed,true);
    assert.throws(()=>process.kill(hostPid,0),{code:'ESRCH'});
    assert.throws(()=>process.kill(agentPid,0),{code:'ESRCH'});
  } finally {runner.close();}
});

test('real ConPTY natural exit releases the native host', {skip:process.platform !== 'win32',timeout:15000}, async () => {
  const code="process.stdin.setEncoding('utf8');process.stdin.once('data',()=>{process.stdout.write('自然结束\\n',()=>process.exit(0));});";
  const runner=new TerminalRunner({kind:'terminal',command:process.execPath,args:['-e',code],completionMode:'exit'});
  try {
    const completed=once(runner,'completed');const exited=once(runner,'exit');
    await runner.start({cwd:process.cwd(),prompt:'test',sessionId:'conpty-natural-exit'});
    const host=runner.host;const hostClosed=once(host,'close');
    assert.equal((await completed)[0].status,'done');await exited;await hostClosed;
    assert.throws(()=>process.kill(host.pid,0),{code:'ESRCH'});
  } finally {runner.close();}
});
