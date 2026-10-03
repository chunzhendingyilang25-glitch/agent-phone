import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../hub/store.mjs';
import { RequestBroker } from '../hub/requests.mjs';
import { FeishuHub } from '../hub/feishu.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-request-ux-'));
  const store = new Store(path.join(directory, 'state.json'));
  const project = store.addProject(directory);
  const first = store.createSession('claude', project.id);
  const second = store.createSession('codex-cli', project.id);
  const engine = new EventEmitter(); engine.requests = new RequestBroker(store);
  const runs = [], sends = [], answers = [];
  engine.start = (id, text) => { runs.push({ id, text }); return store.session(id); };
  const hub = new FeishuHub(store, engine, { refresh() {} });
  hub.credentials = { ownerId: 'fixture-owner' }; hub.connection.connected = true;
  hub.channel = { async send(to, input) { sends.push({ to, input }); return { messageId: `message-${sends.length}` }; }, async disconnect() {} };
  Object.assign(store.context('chat'), { agentId: second.agentId, projectId: project.id, sessionId: second.id });
  const request = engine.requests.create({ sessionId: first.id, title: 'Old question', description: 'Old task question?' }, answer => answers.push(answer));
  t.after(async () => { await hub.disconnect(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, project, first, second, engine, hub, runs, sends, answers, request };
}

for (const action of ['agent', 'project', 'session', 'directory', 'new']) {
  test(`selecting ${action} exits a previous Feishu text-response mode without answering its old request`, async t => {
    const f = fixture(t);
    await f.hub.handleAction({ chatId: 'chat', action: { value: { action: 'replyRequest', requestId: f.request.id } } });
    assert.equal(f.store.context('chat').requestId, f.request.id);
    const value = { action, ...(action === 'agent' ? { id: f.second.agentId } : action === 'project' ? { id: f.project.id } : action === 'session' ? { id: f.second.id } : action === 'directory' ? { path: f.directory } : {}) };
    await f.hub.handleAction({ chatId: 'chat', action: { value } });
    assert.equal(f.store.context('chat').requestId, null);
    await f.hub.handleMessage({ chatId: 'chat', content: 'A new task after selecting context' });
    assert.equal(f.answers.length, 0, 'the new task must not reach the old question handler');
    assert.equal(f.request.status, 'pending', 'switching selection does not cancel another task');
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].text, 'A new task after selecting context');
  });
}

test('an explicit reply to an older request notification still targets its original task after changing selection', async t => {
  const f = fixture(t);
  const notice = await f.hub.notifyRequest(f.request);
  await new Promise(resolve => setImmediate(resolve));
  await f.hub.handleAction({ chatId: 'chat', action: { value: { action: 'session', id: f.second.id } } });
  await f.hub.handleMessage({ chatId: 'chat', content: 'Answer for old task', replyToMessageId: notice.messageId });
  assert.equal(f.answers.length, 1);
  assert.equal(f.answers[0].text, 'Answer for old task');
  assert.equal(f.runs.length, 0);
});

test('an already answered approval card cannot approve the next request in the same session', async t => {
  const f = fixture(t);
  const decisions = [];
  const first = f.engine.requests.create({ sessionId: f.first.id, kind: 'approval', options: [{ id: 'allow', label: 'Allow once' }] }, answer => decisions.push({ id: 'first', answer }));
  await f.hub.handleAction({ chatId: 'chat', action: { value: { action: 'respond', requestId: first.id, optionId: 'allow' } } });
  const second = f.engine.requests.create({ sessionId: f.first.id, kind: 'approval', options: [{ id: 'allow', label: 'Allow once' }] }, answer => decisions.push({ id: 'second', answer }));
  await assert.rejects(f.hub.handleAction({ chatId: 'chat', action: { value: { action: 'respond', requestId: first.id, optionId: 'allow' } } }), /已经处理|失效/);
  assert.equal(decisions.length, 1);
  assert.equal(second.status, 'pending');
  assert.equal(f.runs.length, 0);
});

test('offline attention answered on the computer is not delivered as a new action prompt on reconnect', async t => {
  const f = fixture(t);
  f.hub.connection.connected = false;
  const notice = await f.hub.notifyRequest(f.request);
  await f.engine.requests.respond(f.request.id, { text: 'Answered on computer' });
  f.first.status = 'done'; f.first.messages.push({ role: 'assistant', text: 'The final result' });
  const finished = await f.hub.notifySession(f.first);
  f.hub.connection.connected = true;
  await f.hub.flushOutbox();
  assert.equal(f.sends.length, 1, 'only the completion remains actionable when the connection returns');
  assert.ok(JSON.stringify(f.sends[0]).includes('The final result'));
  assert.equal(notice.delivery, 'superseded');
  assert.equal(finished.delivery, 'sent');
  assert.equal(f.store.data.outbox.length, 0);
});

test('approval requests require an explicit option and the phone card does not offer free text as approval', async t => {
  const f = fixture(t);
  const answers = [];
  const request = f.engine.requests.create({ sessionId: f.first.id, kind: 'approval', title: 'Permission', description: 'A command', options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }, value => answers.push(value));
  await assert.rejects(f.engine.requests.respond(request.id, { text: 'Allow once', source: 'feishu' }));
  assert.equal(request.status, 'pending'); assert.equal(answers.length, 0);
  const card = f.hub.requestCard(request);
  const actions = card.elements.flatMap(e => e.actions || []).map(button => button.value);
  assert.equal(actions.filter(v => v.action === 'replyRequest').length, 0);
  assert.equal(actions.filter(v => v.action === 'respond').length, 2);
  await f.engine.requests.respond(request.id, { optionId: 'allow', source: 'feishu' });
  assert.equal(answers.length, 1); assert.equal(answers[0].optionId, 'allow');
});

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function connectionFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-connection-ux-'));
  const store = new Store(path.join(directory, 'state.json'));
  const channels = [], operations = [], connectGates = [];
  const hub = new FeishuHub(store, new EventEmitter(), { refresh() {} }, {
    readCredentials: () => ({ ownerId: 'fixture-owner', appId: 'fixture-app', appSecret: 'fixture-secret' }),
    createChannel() {
      const gate = deferred(); connectGates.push(gate);
      const channel = new EventEmitter();
      channel.botIdentity = { name: `bot-${channels.length + 1}` };
      channel.connect = () => gate.promise;
      channel.disconnect = async () => { operations.push({ disconnect: channel.botIdentity.name }); };
      channel.send = async () => { throw new Error('unexpected send'); };
      channels.push(channel); return channel;
    }
  });
  t.after(async () => { for (const gate of connectGates) gate.resolve(); await hub.disconnect(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, hub, channels, connectGates, operations };
}

test('disconnect while connecting prevents late success or old channel events from reviving Feishu', async t => {
  const f = connectionFixture(t);
  const connecting = f.hub.connect();
  await new Promise(resolve => setImmediate(resolve));
  const channel = f.channels[0]; assert.ok(channel);
  await f.hub.disconnect();
  f.connectGates[0].resolve(); await connecting;
  assert.equal(f.hub.connection.connected, false); assert.equal(f.hub.channel, null);
  channel.emit('reconnected'); channel.emit('error', new Error('late old error'));
  channel.emit('message', { senderId: 'fixture-owner', chatType: 'p2p', chatId: 'late-old-chat', content: 'A task' });
  assert.equal(f.hub.connection.connected, false);
  assert.notEqual(f.store.data.ownerChatId, 'late-old-chat');
});

test('a new connection keeps its own identity when an earlier connection finishes later', async t => {
  const f = connectionFixture(t);
  const oldConnect = f.hub.connect(); await new Promise(resolve => setImmediate(resolve));
  const newConnect = f.hub.connect(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.channels.length, 2);
  f.connectGates[1].resolve(); await newConnect;
  assert.equal(f.hub.channel, f.channels[1]); assert.equal(f.hub.connection.botName, 'bot-2');
  f.connectGates[0].resolve(); await oldConnect;
  f.channels[0].emit('reconnecting');
  f.channels[0].emit('message', { senderId: 'fixture-owner', chatType: 'p2p', chatId: 'old-bot-chat', content: 'A task' });
  assert.equal(f.hub.channel, f.channels[1]); assert.equal(f.hub.connection.connected, true);
  assert.equal(f.hub.connection.botName, 'bot-2'); assert.notEqual(f.store.data.ownerChatId, 'old-bot-chat');
});
