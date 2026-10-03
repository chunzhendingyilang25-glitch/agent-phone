import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../hub/store.mjs';
import { Catalog, browse } from '../hub/catalog.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-中文 空格-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, '配置 目录', '状态.json') };
}

test('projects and selected file paths survive save/reload with Chinese characters and spaces', t => {
  const { directory, file } = fixture(t);
  const store = new Store(file);
  const project = store.addProject(directory);
  assert.equal(store.addProject(directory + path.sep).id, project.id);
  const session = store.createSession('claude', project.id);
  session.messages.push({ role: 'user', text: '查看这个文件', files: [path.join(directory, '中文 文件.txt')] });
  store.context('feishu-chat').projectId = project.id;
  store.save();
  const loaded = new Store(file);
  assert.equal(loaded.project(project.id).path, directory);
  assert.equal(loaded.session(session.id).messages[0].files[0], path.join(directory, '中文 文件.txt'));
  assert.equal(loaded.context('feishu-chat').projectId, project.id);
  assert.equal(loaded.data.projects.length, 1);
});

test('restart marks an unfinished job interrupted while keeping its context and completed jobs', t => {
  const { directory, file } = fixture(t);
  const store = new Store(file);
  const project = store.addProject(directory);
  const running = store.createSession('codex-cli', project.id);
  running.status = 'running'; running.remoteId = 'remote-persisted'; running.messages.push({ role: 'user', text: '继续上下文' });
  const done = store.createSession('codex-desktop', project.id); done.status = 'done';
  store.save();
  const loaded = new Store(file);
  assert.equal(loaded.session(running.id).status, 'interrupted');
  assert.match(loaded.session(running.id).error, /服务重启/);
  assert.equal(loaded.session(running.id).remoteId, 'remote-persisted');
  assert.equal(loaded.session(running.id).messages[0].text, '继续上下文');
  assert.equal(loaded.session(done.id).status, 'done');
});

test('directory browser returns selectable full paths and deterministic paging without hidden/dependency folders', t => {
  const { directory } = fixture(t);
  fs.mkdirSync(path.join(directory, '中文 项目'));
  fs.mkdirSync(path.join(directory, '.hidden'));
  fs.mkdirSync(path.join(directory, 'node_modules'));
  for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(directory, `${String(i).padStart(2, '0')} 文件.txt`), '');
  const first = browse(directory);
  const second = browse(directory, 12);
  assert.equal(first.path, directory);
  assert.equal(first.parent, path.dirname(directory));
  assert.equal(first.total, 16);
  assert.equal(first.entries.length, 12);
  assert.equal(first.entries[0].name, '中文 项目');
  assert.equal(second.entries.length, 4);
  const entries = [...first.entries, ...second.entries];
  assert.equal(new Set(entries.map(e => e.path)).size, 16);
  for (const entry of entries) assert.equal(entry.path, path.join(directory, entry.name));
  assert.deepEqual(browse(directory, 0, false).entries.map(e => e.name), ['中文 项目']);
});

test('invalid project selections and unsupported agents are rejected without creating a session', t => {
  const { directory, file } = fixture(t);
  const store = new Store(file);
  const project = store.addProject(directory);
  assert.throws(() => store.createSession('unknown-agent', project.id), /可用 Agent/);
  assert.throws(() => store.createSession('codex-cli', 'missing-project'), /项目不存在/);
  assert.equal(store.data.sessions.length, 0);
});

test('external transcript history is imported even when a completion message is already present', t => {
  const { directory, file } = fixture(t);
  const store = new Store(file);
  const project = store.addProject(directory);
  const session = store.createSession('codex-desktop', project.id);
  session.source = 'external';
  session.rolloutPath = path.join(directory, '已有 会话.jsonl');
  session.messages = [{ role: 'assistant', text: '最终结果', ts: Date.now() }];
  const record = (role, text, phase) => JSON.stringify({ type: 'response_item', timestamp: '2026-10-01T00:00:00Z', payload: { type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';
  fs.writeFileSync(session.rolloutPath, record('user', '先前的任务') + record('assistant', '内部分析不显示', 'analysis') + record('assistant', '最终结果', 'final_answer'));
  const catalog = new Catalog(store, async () => {});
  catalog.loadHistory(session);
  assert.deepEqual(session.messages.map(m => [m.role, m.text]), [['user', '先前的任务'], ['assistant', '最终结果']]);
  const historySize = session.historySize;
  catalog.loadHistory(session);
  assert.equal(session.historySize, historySize);
  assert.equal(session.messages.length, 2);
  fs.appendFileSync(session.rolloutPath, record('user', '后续任务') + record('assistant', '后续结果', 'final_answer'));
  catalog.loadHistory(session);
  assert.deepEqual(session.messages.map(m => m.text), ['先前的任务', '最终结果', '后续任务', '后续结果']);
  assert.equal(new Store(store.file).session(session.id).messages.length, 4);
});
