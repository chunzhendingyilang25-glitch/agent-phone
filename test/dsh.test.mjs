import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { DshClient, DshRunner } from '../hub/dsh.mjs';

class FakeClient extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = []; this.streamStarts = 0; }
  async connect() { this.streamStarts++; }
  async listSessions() { return { items: [] }; }
  async rpc(method, payload) {
    this.calls.push({ method, payload });
    if (method === 'session.create') return { sessionId: payload.sessionId || 'dsh-session' };
    if (method === 'session.prompt') {
      this.event('turn/start', 1 + this.calls.filter(c => c.method === method).length * 3);
      return { accepted: true };
    }
    return { accepted: true };
  }
  event(type, seq, data = {}) { this.emit('notification', { rpcId: `e-${seq}`, payload: { type: 'session/event', sessionId: 'dsh-session', event: { type, seq, time: Date.now(), data } } }); }
  async respond(id, payload) { this.responses.push({ id, payload }); return { accepted: true }; }
  close() {}
}
test('DSH session emits exact completion and resumes original remote id', async () => {
  const client = new FakeClient(), runner = new DshRunner({ kind: 'dsh' }, { client });
  let remote; runner.on('remote-id', id => remote = id);
  await runner.start({ cwd: '项目', prompt: '测试' }); assert.equal(remote, 'dsh-session');
  const finished = once(runner, 'completed'); client.event('assistant/message', 5, { message: { content: [{ type: 'text', text: '完成' }] } }); client.event('turn/end', 6, { reason: { kind: 'completed' } });
  assert.equal((await finished)[0].text, '完成');
  await runner.start({ cwd: '项目', prompt: '继续' }); assert.equal(client.calls.filter(c => c.method === 'session.create').length, 1);
  const next = once(runner, 'completed'); client.event('turn/end', 9, { reason: { kind: 'completed' } }); assert.equal((await next)[0].turnId, 'dsh-session:9');
});
test('DSH approval and single-question replies preserve official protocol', async () => {
  const client = new FakeClient(), runner = new DshRunner({ kind: 'dsh' }, { client }); await runner.start({ cwd: '.', prompt: 'test' });
  const approval = once(runner, 'attention'); client.emit('notification', { rpcId: 'approve-rpc', payload: { type: 'approval/requested', sessionId: 'dsh-session', approvalId: 'a1', toolName: 'pwsh', reason: '执行命令' } });
  assert.equal((await approval)[0].choices[0].id, 'allowed-once'); await runner.respond('approve-rpc', { optionId: 'allowed-once' });
  assert.deepEqual(client.responses[0], { id: 'approve-rpc', payload: { sessionId: 'dsh-session', approvalId: 'a1', outcome: 'allowed-once' } });
  client.emit('notification', { rpcId: 'q1', payload: { type: 'question/requested', sessionId: 'dsh-session', questions: [{ id: 'question', question: '选择', options: [{ label: 'A' }] }] } });
  await runner.respond('q1', { optionId: 'A' }); assert.deepEqual(client.responses[1].payload.answer.answers, [{ id: 'question', selected: ['A'] }]);
  client.emit('notification', { rpcId: 'q2', payload: { type: 'question/requested', sessionId: 'dsh-session', questions: [{ id: 'question', question: '输入' }] } });
  await runner.respond('q2', { text: '中文答案' }); assert.equal(client.responses[2].payload.answer.answers[0].custom, '中文答案');
});
test('DSH reports explicit failure and interruption, skips duplicated sequence', async () => {
  const client = new FakeClient(), runner = new DshRunner({ kind: 'dsh' }, { client }); await runner.start({ cwd: '.', prompt: 'test' });
  const failure = once(runner, 'failed'); client.event('turn/end', 6, { reason: { kind: 'error', error: { message: 'bad model' } } }); assert.match((await failure)[0].message, /bad model/);
  await runner.start({ cwd: '.', prompt: 'test2' }); await runner.stop(); assert.equal(client.calls.at(-1).method, 'session.cancel');
  let completed = 0; runner.on('completed', e => { completed++; assert.equal(e.status, 'interrupted'); }); client.event('turn/end', 9, { reason: { kind: 'cancelled' } }); client.event('turn/end', 9, { reason: { kind: 'cancelled' } }); assert.equal(completed, 1);
});
test('DSH transport rejects external origins, denied browser access and RPC id mismatch', async () => {
  assert.throws(() => new DshClient('https://remote.example'), /本地/);
  const denied = new DshClient('http://127.0.0.1:43120', { fetch: async () => new Response('forbidden', { status: 403 }) });
  await assert.rejects(denied.connect(), /浏览器访问/);
  const bad = new DshClient('http://127.0.0.1:43120', { fetch: async () => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }) });
  await assert.rejects(bad.rpc('host.describe'), /协议/);
});
test('DSH SSE preserves split UTF8 and answers use client-response envelope', async () => {
  let controller, posted; const enc = new TextEncoder();
  const client = new DshClient('http://127.0.0.1:43120', { fetch: async (url, init) => {
    if (url.endsWith('events.mux')) return new Response(new ReadableStream({ start(c) { controller = c; } }));
    posted = JSON.parse(init.body); return Response.json({ accepted: true });
  } });
  await client.connect(); const message = once(client, 'notification');
  const data = enc.encode('data: '+JSON.stringify({ type: 'server-request', rpcId: 'q', method: 'question/requested', payload: { type: 'question/requested', sessionId: 's', questions: [{ question: '中文问题' }] } })+'\n\n');
  const split = data.indexOf(0xe4) + 1; controller.enqueue(data.slice(0, split)); controller.enqueue(data.slice(split));
  assert.equal((await message)[0].payload.questions[0].question, '中文问题'); await client.respond('q', { sessionId: 's', answer: { answers: [] } }); assert.equal(posted.type, 'client-response'); assert.equal(posted.rpcId, 'q'); client.close(); controller.close();
});

test('DSH SSE accepts CRLF when delimiter is split across chunks', async () => {
  let controller; const enc = new TextEncoder();
  const client = new DshClient('http://127.0.0.1:43120', {fetch:async()=>new Response(new ReadableStream({start(c){controller=c;}}))});
  await client.connect(); const message=once(client,'notification');
  const data='data: '+JSON.stringify({type:'server-request',rpcId:'crlf',payload:{type:'session/subscribed',sessionId:'s'}})+'\r\n\r\n';
  for(const character of data)controller.enqueue(enc.encode(character));
  assert.equal((await message)[0].rpcId,'crlf');client.close();controller.close();
});

test('DSH 426 uses WebSocket carrier and re-connects after socket loss', async () => {
  class Socket extends EventTarget {
    static instances=[];
    constructor(url){super();this.url=url;Socket.instances.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    close(){this.dispatchEvent(new Event('close'));}
    sendEnvelope(value){const event=new Event('message');event.data=JSON.stringify(value);this.dispatchEvent(event);}
  }
  const client=new DshClient('http://127.0.0.1:43120',{fetch:async()=>new Response('Upgrade Required',{status:426}),WebSocket:Socket});
  await client.connect();assert.match(Socket.instances[0].url,/^ws:\/\/127\.0\.0\.1:43120\/api\/events\.mux$/);
  const notification=once(client,'notification');Socket.instances[0].sendEnvelope({type:'server-request',rpcId:'ws-event',payload:{type:'session/subscribed',sessionId:'s'}});
  assert.equal((await notification)[0].rpcId,'ws-event');
  const disconnected=once(client,'disconnected');Socket.instances[0].close();await disconnected;
  await client.connect();assert.equal(Socket.instances.length,2);
  let received=0;client.on('notification',()=>received++);
  Socket.instances[0].sendEnvelope({type:'server-request',rpcId:'old',payload:{type:'session/subscribed',sessionId:'s'}});assert.equal(received,0);
  client.close();assert.equal(client.ready,null);
});
