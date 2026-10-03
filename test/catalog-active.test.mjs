import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../hub/catalog.mjs';
import { Store } from '../hub/store.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-中文 空格-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(path.join(directory, 'hub-state.json'));
  return { directory, store };
}
const event = (type, turnId = 'original-turn', extra = {}) => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId, ...extra } }) + '\n';

test('initial import uses the latest rollout lifecycle event despite older completed turns and huge trailing tool output', t => {
  const { directory, store } = fixture(t);
  const originalProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = directory;
  t.after(() => { if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile; });
  fs.mkdirSync(path.join(directory, '.codex'));
  const db = new DatabaseSync(path.join(directory, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, source TEXT, title TEXT, updated_at INTEGER, rollout_path TEXT, archived INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, 0)');
  const files = [
    ['active-import', event('task_started') + event('task_complete') + event('task_started') + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: '巨大工具输出'.repeat(70000) } }) + '\n'],
    ['done-import', event('task_started') + event('task_complete')],
    ['aborted-import', event('task_started') + event('turn_aborted')],
  ];
  for (const [id, content] of files) {
    const file = path.join(directory, `${id}.jsonl`); fs.writeFileSync(file, content);
    insert.run(id, directory, 'app-server', id, 1, file);
  }
  db.close();
  const catalog = new Catalog(store, async () => {});
  catalog.refresh();
  const byRemote = id => store.data.sessions.find(s => s.remoteId === id);
  assert.equal(byRemote('active-import')?.status, 'running');
  assert.equal(byRemote('done-import')?.status, 'done');
  assert.equal(byRemote('aborted-import')?.status, 'interrupted');
  assert.equal(byRemote('active-import')?.agentId, 'codex-desktop');
});

test('completion lines larger than the poll buffer preserve Chinese text split across the UTF-8 boundary', async t => {
  const { directory, store } = fixture(t);
  const project = store.addProject(directory);
  const session = store.createSession('codex-desktop', project.id);
  session.source = 'external'; session.remoteId = 'giant-thread';
  session.rolloutPath = path.join(directory, '巨大 中文.jsonl');
  const completions = [];
  const catalog = new Catalog(store, async e => { completions.push(e); });
  fs.writeFileSync(session.rolloutPath, '');
  catalog.offsets.set(session.rolloutPath, { offset: 0, carry: '' });
  const started = event('task_started', 'giant-turn');
  // The first byte of "汉" is the final byte of the first 2 MiB poll buffer.
  const prefix = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'giant-turn', last_agent_message: '' } }).split('"last_agent_message":"')[0] + '"last_agent_message":"';
  const padding = 'A'.repeat(2 * 1024 * 1024 - Buffer.byteLength(started + prefix) - 1);
  const expected = padding + '汉字跨分块保持完整';
  fs.appendFileSync(session.rolloutPath, started + prefix + expected + '"}}\n');
  await catalog.poll();
  assert.equal(session.status, 'running');
  assert.equal(completions.length, 0);
  await catalog.poll();
  assert.equal(session.status, 'done');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].turn_id, 'giant-turn');
  assert.equal(completions[0].last_assistant_message, expected);
  await catalog.poll();
  assert.equal(completions.length, 1);
});

test('an external turn aborted after monitoring starts no longer appears running', async t => {
  const { directory, store } = fixture(t);
  const project = store.addProject(directory);
  const session = store.createSession('codex-desktop', project.id);
  session.source = 'external'; session.remoteId = 'aborted-thread';
  session.rolloutPath = path.join(directory, '中断 会话.jsonl');
  const catalog = new Catalog(store, async () => {});
  fs.writeFileSync(session.rolloutPath, event('task_started', 'aborted-turn'));
  catalog.offsets.set(session.rolloutPath, { offset: 0, carry: '' });
  await catalog.poll();
  assert.equal(session.status, 'running');
  fs.appendFileSync(session.rolloutPath, event('turn_aborted', 'aborted-turn'));
  await catalog.poll();
  assert.equal(session.status, 'interrupted');
});
