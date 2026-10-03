import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../hub/store.mjs';
import { FeishuHub } from '../hub/feishu.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-hub-中文 空格-'));
  const store = new Store(path.join(directory, '状态.json'));
  const calls = [], sends = [];
  const engine = new EventEmitter();
  engine.start = (id, prompt, files) => { calls.push({ id, prompt, files: [...files] }); const s = store.session(id); s.status = 'running'; return s; };
  engine.stop = async id => { calls.push({ stop: id }); return true; };
  const hub = new FeishuHub(store, engine, { refresh() {}, loadHistory() {} });
  hub.credentials = { ownerId: 'fake-owner' };
  hub.channel = { async send(to, input) { sends.push({ to, input }); return { messageId: `fake-message-${sends.length}` }; }, async disconnect() {} };
  t.after(async () => { await hub.disconnect(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, hub, calls, sends };
}

test('offline completion remains in the durable outbox until a later successful delivery', async t => {
  const { directory, store, hub, sends } = fixture(t);
  const project = store.addProject(directory);
  const session = store.createSession('claude', project.id);
  session.status = 'done'; session.messages.push({ role: 'assistant', text: '任务结果' });
  const notification = await hub.notifySession(session);
  assert.equal(sends.length, 0);
  assert.equal(notification.delivery, 'pending');
  assert.equal(new Store(store.file).data.outbox.length, 1);
  hub.connection.connected = true;
  const send = hub.channel.send;
  hub.channel.send = async () => { throw new Error('模拟临时网络断开'); };
  await hub.flushOutbox();
  assert.equal(store.data.outbox.length, 1);
  assert.equal(notification.delivery, 'pending');
  hub.channel.send = send;
  await hub.flushOutbox();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'fake-owner');
  assert.equal(notification.delivery, 'sent');
  assert.equal(notification.messageId, 'fake-message-1');
  assert.equal(new Store(store.file).data.outbox.length, 0);
});

test('replies to a completion notification continue that selected agent and session', async t => {
  const { directory, store, hub, calls } = fixture(t);
  const project = store.addProject(directory);
  const session = store.createSession('claude', project.id);
  store.addNotification({ sessionId: session.id, messageId: 'notification-1' });
  hub.connection.connected = true;
  await hub.handleMessage({ chatId: 'fake-chat', content: '继续刚才的任务', rootId: 'notification-1' });
  assert.deepEqual(calls, [{ id: session.id, prompt: '继续刚才的任务', files: [] }]);
  assert.equal(store.context('fake-chat').agentId, 'claude');
  assert.equal(store.context('fake-chat').projectId, project.id);
  assert.equal(session.notifyChatId, 'fake-chat');
});

test('clicking directory and file cards selects their full paths without typed paths', async t => {
  const { directory, store, hub, calls, sends } = fixture(t);
  const file = path.join(directory, '选择 文件.txt'); fs.writeFileSync(file, 'fixture');
  hub.connection.connected = true;
  await hub.directory('fake-chat', directory);
  const card = sends.at(-1).input.card;
  const buttons = card.elements.flatMap(e => e.actions || []);
  const fileButton = buttons.find(b => b.value?.action === 'file');
  const directoryButton = buttons.find(b => b.value?.action === 'directory');
  assert.equal(fileButton.value.path, file);
  assert.equal(directoryButton.value.path, directory);
  await hub.handleAction({ chatId: 'fake-chat', action: { value: directoryButton.value } });
  await hub.handleAction({ chatId: 'fake-chat', action: { value: fileButton.value } });
  await hub.handleMessage({ chatId: 'fake-chat', content: '读取已选文件' });
  assert.equal(calls.length, 1);
  assert.equal(store.session(calls[0].id).cwd, directory);
  assert.deepEqual(calls[0].files, [file]);
  assert.deepEqual(store.context('fake-chat').files, []);
});

test('task sent before project selection is started after the project card is clicked', async t => {
  const { directory, store, hub, calls, sends } = fixture(t);
  const project = store.addProject(directory);
  hub.connection.connected = true;
  await hub.handleMessage({ chatId: 'fake-chat', content: '先选项目再执行' });
  assert.equal(calls.length, 0);
  assert.equal(sends.at(-1).input.card.header.title.content, '选择项目目录');
  await hub.handleAction({ chatId: 'fake-chat', action: { value: { action: 'project', id: project.id } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '先选项目再执行');
  assert.equal(store.context('fake-chat').pendingPrompt, null);
});

test('a freshly started hub delivers the outbox saved by the previous process', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const session = store.createSession('codex-cli', project.id);
  session.status = 'done'; session.notifyChatId = 'original-chat';
  session.messages.push({ role: 'assistant', text: '重启前的任务结果' });
  await hub.notifySession(session);
  await hub.disconnect();
  const restored = new Store(store.file);
  const restarted = new FeishuHub(restored, new EventEmitter(), { refresh() {} });
  t.after(() => restarted.disconnect());
  restarted.credentials = { ownerId: 'fake-owner' };
  restarted.connection.connected = true;
  const sends = [];
  restarted.channel = { async send(to, input) { sends.push({ to, input }); return { messageId: 'after-restart' }; }, async disconnect() {} };
  await restarted.flushOutbox();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'original-chat');
  assert.ok(JSON.stringify(sends[0].input.card).includes('重启前的任务结果'));
  assert.equal(restored.data.outbox.length, 0);
  assert.equal(restored.data.notifications[0].messageId, 'after-restart');
  await restarted.flushOutbox();
  assert.equal(sends.length, 1);
});

test('managed completion and a later catalog event for the same Codex turn create one notification', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const session = store.createSession('codex-desktop', project.id);
  session.source = 'external'; session.remoteId = 'external-codex-thread'; session.lastTurnId = 'turn-1'; session.status = 'done';
  session.messages.push({ role: 'assistant', text: '同一个完成结果' });
  const managed = await hub.notifySession(session);
  const polled = await hub.notifySession(session, 'external-codex-thread:turn-1');
  assert.equal(managed.id, polled.id);
  assert.equal(store.data.notifications.length, 1);
  assert.equal(store.data.outbox.length, 1);
  session.lastTurnId = 'turn-2';
  await hub.notifySession(session);
  assert.equal(store.data.notifications.length, 2);
  assert.equal(store.data.outbox.length, 2);
});

test('generic unsupported-agent notifications persist their external deduplication key', async t => {
  const { store, hub } = fixture(t);
  const notification = await hub.notifyGeneric({ agent: 'cursor', status: 'error', last_assistant_message: '模拟失败' }, 'cursor-thread:cursor-turn');
  assert.equal(notification.externalKey, 'cursor-thread:cursor-turn');
  assert.equal(notification.status, 'error');
  assert.equal(new Store(store.file).data.notifications[0].externalKey, 'cursor-thread:cursor-turn');
});

function completedSession(store, project, text, destination) {
  const session = store.createSession('claude', project.id);
  session.status = 'done'; session.notifyChatId = destination;
  session.messages.push({ role: 'assistant', text });
  return session;
}

for (const code of ['target_revoked', 'permission_denied']) {
  test(`${code} from a group forwards its completion to the owner and delivers later notifications`, async t => {
    const { directory, store, hub } = fixture(t);
    const project = store.addProject(directory);
    store.data.ownerChatId = 'private-owner-chat';
    const first = await hub.notifySession(completedSession(store, project, '第一条群任务结果', 'unavailable-group'));
    const second = await hub.notifySession(completedSession(store, project, '后续正常任务结果', 'private-owner-chat'));
    const attempts = [];
    hub.channel.send = async (to, input) => {
      attempts.push({ to, input });
      if (to === 'unavailable-group') throw Object.assign(new Error('模拟群目标不可用'), { code });
      return { messageId: `permanent-fallback-${attempts.length}` };
    };
    hub.connection.connected = true;
    await hub.flushOutbox();
    assert.equal(first.delivery, 'sent');
    assert.equal(second.delivery, 'sent');
    assert.equal(store.data.outbox.length, 0);
    assert.equal(attempts[0].to, 'unavailable-group');
    assert.ok(attempts.some(a => a.to === 'private-owner-chat' && JSON.stringify(a.input).includes('第一条群任务结果')));
    assert.ok(attempts.some(a => a.to === 'private-owner-chat' && JSON.stringify(a.input).includes('后续正常任务结果')));
  });
}

test('a permanently rejected owner notification is marked failed and does not block the next task', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const first = await hub.notifySession(completedSession(store, project, '不可投递的第一条结果', 'fake-owner'));
  const second = await hub.notifySession(completedSession(store, project, '可投递的下一条结果', 'fake-owner'));
  const delivered = [];
  hub.channel.send = async (to, input) => {
    if (JSON.stringify(input).includes('不可投递的第一条结果')) throw Object.assign(new Error('模拟永久权限错误'), { code: 'permission_denied' });
    delivered.push({ to, input }); return { messageId: 'second-permanent-owner' };
  };
  hub.connection.connected = true;
  await hub.flushOutbox();
  assert.equal(first.delivery, 'failed');
  assert.equal(second.delivery, 'sent');
  assert.equal(delivered.length, 1);
  assert.equal(store.data.outbox.length, 0);
  assert.equal(new Store(store.file).data.notifications.find(n => n.id === first.id).delivery, 'failed');
});

test('a group fallback that is also permanently rejected fails only that notification', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const first = await hub.notifySession(completedSession(store, project, '群和私聊都失败的结果', 'revoked-group'));
  const second = await hub.notifySession(completedSession(store, project, '下一条仍可到达', 'fake-owner'));
  const attemptedTargets = [];
  hub.channel.send = async (to, input) => {
    attemptedTargets.push(to);
    if (JSON.stringify(input).includes('群和私聊都失败的结果')) throw Object.assign(new Error('模拟永久目标错误'), { code: 'target_revoked' });
    return { messageId: 'after-failed-fallback' };
  };
  hub.connection.connected = true;
  await hub.flushOutbox();
  assert.equal(first.delivery, 'failed');
  assert.equal(second.delivery, 'sent');
  assert.deepEqual(attemptedTargets, ['revoked-group', 'fake-owner', 'fake-owner']);
  assert.equal(store.data.outbox.length, 0);
});

test('card formatting failure falls back to text while later cards still deliver', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const first = await hub.notifySession(completedSession(store, project, '卡片格式错误的完成结果', 'fake-owner'));
  const second = await hub.notifySession(completedSession(store, project, '下一条正常卡片', 'fake-owner'));
  const deliveries = [];
  hub.channel.send = async (to, input) => {
    if (input.card && JSON.stringify(input).includes('卡片格式错误的完成结果')) throw Object.assign(new Error('模拟无效卡片格式'), { code: 'format_error' });
    deliveries.push({ to, input }); return { messageId: `format-fallback-${deliveries.length}` };
  };
  hub.connection.connected = true;
  await hub.flushOutbox();
  assert.equal(first.delivery, 'sent');
  assert.equal(second.delivery, 'sent');
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries[0].input.text?.includes('卡片格式错误的完成结果'));
  assert.ok(deliveries[1].input.card);
  assert.equal(store.data.outbox.length, 0);
});

test('a text fallback that remains permanently malformed fails only that notification', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const first = await hub.notifySession(completedSession(store, project, '卡片和文本均无法投递', 'fake-owner'));
  const second = await hub.notifySession(completedSession(store, project, '后来正常的结果', 'fake-owner'));
  let delivered = 0;
  hub.channel.send = async (to, input) => {
    if (JSON.stringify(input).includes('卡片和文本均无法投递')) throw Object.assign(new Error('模拟持续格式错误'), { code: 'format_error' });
    delivered++; return { messageId: 'after-permanent-format-error' };
  };
  hub.connection.connected = true;
  await hub.flushOutbox();
  assert.equal(first.delivery, 'failed');
  assert.equal(second.delivery, 'sent');
  assert.equal(delivered, 1);
  assert.equal(store.data.outbox.length, 0);
});

test('a temporary send timeout preserves both queued notifications for a later successful retry', async t => {
  const { directory, store, hub } = fixture(t);
  const project = store.addProject(directory);
  const first = await hub.notifySession(completedSession(store, project, '暂时网络断开的第一条', 'fake-owner'));
  const second = await hub.notifySession(completedSession(store, project, '等待重试的第二条', 'fake-owner'));
  hub.channel.send = async () => { throw Object.assign(new Error('模拟发送超时'), { code: 'send_timeout' }); };
  hub.connection.connected = true;
  await hub.flushOutbox();
  assert.equal(first.delivery, 'pending');
  assert.equal(second.delivery, 'pending');
  assert.equal(new Store(store.file).data.outbox.length, 2);
  let delivered = 0;
  hub.channel.send = async () => ({ messageId: `network-restored-${++delivered}` });
  await hub.flushOutbox();
  assert.equal(delivered, 2);
  assert.equal(first.delivery, 'sent');
  assert.equal(second.delivery, 'sent');
  assert.equal(store.data.outbox.length, 0);
});
