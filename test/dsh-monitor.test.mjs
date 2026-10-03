import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { DshMonitor } from '../hub/dsh-monitor.mjs';
import { DshRunner } from '../hub/dsh.mjs';

class Client extends EventEmitter {
  constructor() { super(); this.responses = []; }
  async connect() {}
  async listSessions() { return { items: [{ sessionId: 's', cwd: 'C:\\宿舍项目', running: true }] }; }
  async respond(id, value) { this.responses.push({ id, value }); }
  close() { this.closed = true; }
  send(type, more = {}, rpcId = 'rpc') { this.emit('notification', { rpcId, payload: { type, sessionId: 's', ...more } }); }
}
function setup(options = {}) {
  const store = new EventEmitter(); store.data = { agents: [{ id: 'dsh', name: 'DSH', kind: 'dsh', endpoint: 'http://127.0.0.1:43120' }] };
  const client = new Client(), monitor = new DshMonitor(store, { ...options, createClient: () => client });
  return { store, client, monitor };
}
test('DSH monitor uses subscription baseline, fresh completion and managed dedup', async () => {
  let managed = false; const { client, monitor } = setup({ isManagedSession: () => managed });
  const connected = once(monitor, 'status'); monitor.start(); await connected;
  const completed = []; monitor.on('completed', item => completed.push(item));
  client.send('session/subscribed', { lastSeq: 10 });
  client.send('session/event', { event: { type: 'turn/end', seq: 10, data: { reason: { kind: 'completed' } } } }); assert.equal(completed.length, 0);
  client.send('session/event', { event: { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '宿舍电脑完成' }] } } } });
  client.send('session/event', { event: { type: 'turn/end', seq: 12, data: { reason: { kind: 'completed' } } } });
  assert.equal(completed[0].text, '宿舍电脑完成'); assert.equal(completed[0].cwd, 'C:\\宿舍项目'); assert.equal(completed[0].key, 's:12');
  managed = true; client.send('session/event', { event: { type: 'turn/end', seq: 13, data: { reason: { kind: 'completed' } } } }); assert.equal(completed.length, 1);
  monitor.stop(); assert.equal(client.closed, true);
});
test('DSH monitor deduplicates request replay and converts mobile answer to original RPC', async () => {
  const { client, monitor } = setup(); const connected = once(monitor, 'status'); monitor.start(); await connected;
  const requested = []; monitor.on('attention', value => requested.push(value));
  client.send('approval/requested', { approvalId: 'approval', toolName: 'pwsh' }, 'question-rpc'); client.send('approval/requested', { approvalId: 'approval', toolName: 'pwsh' }, 'question-rpc'); assert.equal(requested.length, 1);
  await requested[0].respond({ optionId: 'rejected' }); assert.equal(client.responses[0].id, 'question-rpc'); assert.equal(client.responses[0].value.outcome, 'rejected');
  monitor.stop();
});
test('DSH runner stopped during connection never creates or prompts a session', async () => {
  let connected; const client = new Client(); client.connect = () => new Promise(resolve => { connected = resolve; }); client.calls = []; client.rpc = async (method) => { client.calls.push(method); return { sessionId: 's' }; };
  const runner = new DshRunner({ kind: 'dsh' }, { client }); const done = once(runner, 'completed'); const start = runner.start({ cwd: '.', prompt: 'must not run' });
  await runner.stop(); connected(); await start; assert.equal((await done)[0].status, 'interrupted'); assert.deepEqual(client.calls, []);
});
test('DSH runner stopped during session creation does not submit a late prompt', async () => {
  let created; const client = new Client(); client.calls = []; client.rpc = async method => { client.calls.push(method); return new Promise(resolve => { created = () => resolve({ sessionId: 's' }); }); };
  const runner = new DshRunner({ kind: 'dsh' }, { client }); const start = runner.start({ cwd: '.', prompt: 'must not run' });
  await new Promise(resolve => setImmediate(resolve)); await runner.stop(); created(); await start; assert.deepEqual(client.calls, ['session.create']);
});

test('DSH monitor reconnect retains request dedup and drops disabled profiles', async () => {
  const store=new EventEmitter();store.data={agents:[{id:'dsh',name:'DSH',kind:'dsh',endpoint:'http://127.0.0.1:43120'}]};
  const clients=[];const monitor=new DshMonitor(store,{retryMs:5,createClient:()=>{const client=new Client();clients.push(client);return client;}});
  const first=once(monitor,'status');monitor.start();await first;
  const requests=[];monitor.on('attention',value=>requests.push(value));
  clients[0].send('question/requested',{questions:[{id:'q',question:'继续？'}]},'question');assert.equal(requests.length,1);
  const reconnected=new Promise(resolve=>monitor.on('status',status=>{if(status.connected&&clients.length>1)resolve();}));
  clients[0].emit('disconnected',new Error('socket closed'));await reconnected;
  assert.equal(clients[0].closed,true);
  clients[1].send('question/requested',{questions:[{id:'q',question:'继续？'}]},'question');assert.equal(requests.length,1);
  await requests[0].respond({text:'继续'});assert.equal(clients[1].responses.length,1);assert.equal(clients[0].responses.length,0);
  store.data.agents.find(a=>a.id==='dsh').enabled=false;monitor.refresh();assert.equal(monitor.connections.size,0);assert.equal(clients[1].closed,true);monitor.stop();
});
