import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { Store } from '../hub/store.mjs';
import { AgentEngine } from '../hub/agents.mjs';
import { RequestBroker } from '../hub/requests.mjs';
import { FeishuHub } from '../hub/feishu.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

class Rpc extends EventEmitter {
  async connect() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: 'remote' } };
    if (method === 'turn/start') return { turn: { id: 'current-turn' } };
    if (method === 'turn/interrupt') { this.complete('interrupted'); return {}; }
    throw new Error(`unexpected method: ${method}`);
  }
  complete(status = 'completed') { this.emit('notification', { method: 'turn/completed', params: { threadId: 'remote', turn: { id: 'current-turn', status, items: [{ type: 'agentMessage', text: 'result' }] } } }); }
  close() {}
}

function engineFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-approval-review-'));
  const store = new Store(path.join(directory, 'state.json'));
  const project = store.addProject(directory), session = store.createSession('codex-cli', project.id);
  const rpc = new Rpc(), engine = new AgentEngine(store, rpc);
  t.after(async () => { await engine.close(); await tick(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, session, rpc, engine };
}
async function begin(fixture) {
  fixture.engine.start(fixture.session.id, 'task');
  for (let attempt = 0; attempt < 20 && !fixture.engine.codexJobs.get('remote')?.turnId; attempt++) await tick();
  assert.equal(fixture.engine.codexJobs.get('remote')?.turnId, 'current-turn');
}
function interact(rpc, method, params = {}) {
  return new Promise(resolve => rpc.emit('interaction', { id: 7, method, params: { threadId: 'remote', turnId: 'current-turn', ...params } }, (result, error) => resolve({ result, error })));
}

test('Codex command approval waits for the user and returns the selected decision', async t => {
  const fixture = engineFixture(t); await begin(fixture);
  const { engine, rpc, session } = fixture;
  const answer = interact(rpc, 'item/commandExecution/requestApproval', { command: ['echo', 'hello'], cwd: session.cwd, reason: 'requires approval' });
  await tick();
  const request = engine.requests.pending(session.id)[0];
  assert.equal(session.status, 'waiting'); assert.ok(request.description.includes('echo hello'));
  await engine.requests.respond(request.id, { optionId: 'accept', source: 'feishu' });
  assert.deepEqual(await answer, { result: { decision: 'accept' }, error: undefined });
  assert.equal(session.status, 'running');
  const finished = once(engine, 'finished'); rpc.complete(); await finished;
});

test('Codex questions are answered one at a time and mapped back to question ids', async t => {
  const fixture = engineFixture(t); await begin(fixture);
  const { engine, rpc, session } = fixture;
  const answer = interact(rpc, 'item/tool/requestUserInput', { questions: [
    { id: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'Markdown' }, { label: 'Text' }] },
    { id: 'name', header: 'Name', question: 'What name?', options: [] }
  ] });
  await tick();
  await engine.requests.respond(engine.requests.pending(session.id)[0].id, { optionId: '0' });
  await tick();
  assert.equal(engine.requests.pending(session.id)[0].description, 'What name?');
  await engine.requests.respond(engine.requests.pending(session.id)[0].id, { text: 'notes' });
  assert.deepEqual((await answer).result, { answers: { format: { answers: ['Markdown'] }, name: { answers: ['notes'] } } });
  const finished = once(engine, 'finished'); rpc.complete(); await finished;
});

test('stopping a Codex task cancels its pending approval and returns cancel', async t => {
  const fixture = engineFixture(t); await begin(fixture);
  const { engine, rpc, session } = fixture;
  const answer = interact(rpc, 'item/fileChange/requestApproval', { reason: 'change file' });
  await tick(); const request = engine.requests.pending(session.id)[0];
  const finished = once(engine, 'finished'); await engine.stop(session.id); await finished;
  assert.equal(request.status, 'cancelled');
  assert.deepEqual((await answer).result, { decision: 'cancel' });
  assert.equal(session.status, 'interrupted');
});

test('an approval for an old turn is not shown as permission for the current task', async t => {
  const fixture = engineFixture(t); await begin(fixture);
  const { engine, rpc, session } = fixture;
  const received = [];
  rpc.emit('interaction', { id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'remote', turnId: 'old-turn', command: 'old command' } }, (result, error) => received.push({ result, error }));
  await tick();
  assert.equal(engine.requests.pending(session.id).length, 0);
  assert.equal(received.length, 1);
  assert.ok(received[0].error || received[0].result?.decision === 'decline' || received[0].result?.decision === 'cancel');
  const finished = once(engine, 'finished'); rpc.complete(); await finished;
});

function phoneFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-phone-request-review-'));
  const store = new Store(path.join(directory, 'state.json'));
  const project = store.addProject(directory);
  const first = store.createSession('claude', project.id), second = store.createSession('codex-cli', project.id);
  const engine = new EventEmitter(); engine.requests = new RequestBroker(store);
  const runs = [], sends = [];
  engine.start = (id, prompt, files) => { runs.push({ id, prompt, files }); return store.session(id); };
  const hub = new FeishuHub(store, engine, { refresh() {} });
  hub.credentials = { ownerId: 'fake-owner' }; hub.connection.connected = true;
  hub.channel = { async send(to, input) { sends.push({ to, input }); return { messageId: `message-${sends.length}` }; }, async disconnect() {} };
  Object.assign(store.context('chat'), { sessionId: second.id, agentId: second.agentId, projectId: project.id });
  t.after(async () => { await hub.disconnect(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, first, second, engine, hub, runs, sends };
}

test('a Feishu request-card option responds to its request id across selected sessions', async t => {
  const { first, engine, hub, runs, sends } = phoneFixture(t);
  const answers = [];
  const request = engine.requests.create({ sessionId: first.id, title: 'Approval', description: 'Allow?', options: [{ id: 'yes', label: 'Allow' }] }, answer => answers.push(answer));
  await hub.notifyRequest(request); await tick();
  const button = sends.find(s => s.input.card).input.card.elements.flatMap(e => e.actions || []).find(b => b.value?.action === 'respond');
  assert.equal(button.value.requestId, request.id);
  await hub.handleAction({ chatId: 'chat', action: { value: button.value } });
  assert.equal(answers.length, 1); assert.equal(answers[0].optionId, 'yes'); assert.equal(answers[0].source, 'feishu');
  assert.equal(runs.length, 0);
});

test('a text reply to the request notification reaches that request without starting another task', async t => {
  const { store, first, engine, hub, runs } = phoneFixture(t);
  let answer;
  const request = engine.requests.create({ sessionId: first.id, title: 'Question', description: 'Name?', options: [] }, value => { answer = value; });
  const notification = await hub.notifyRequest(request); await tick();
  await hub.handleMessage({ chatId: 'chat', content: 'phone answer', replyToMessageId: notification.messageId });
  assert.equal(answer.text, 'phone answer'); assert.equal(request.status, 'answered'); assert.equal(runs.length, 0);
  assert.equal(store.context('chat').requestId, null);
});

test('a request answered on desktop does not trap later Feishu tasks in a stale input mode', async t => {
  const { store, first, second, engine, hub, runs } = phoneFixture(t);
  const request = engine.requests.create({ sessionId: first.id, title: 'Question', description: 'Name?', options: [] }, () => {});
  await hub.handleAction({ chatId: 'chat', action: { value: { action: 'replyRequest', requestId: request.id } } });
  await engine.requests.respond(request.id, { text: 'answered on desktop' });
  await hub.handleMessage({ chatId: 'chat', content: 'new task' });
  assert.equal(store.context('chat').requestId, null);
  assert.equal(runs.length, 1); assert.equal(runs[0].id, second.id); assert.equal(runs[0].prompt, 'new task');
});
