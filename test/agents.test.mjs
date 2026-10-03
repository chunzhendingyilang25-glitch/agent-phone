import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { AgentEngine, CodexRpc } from '../hub/agents.mjs';
import { Store } from '../hub/store.mjs';

class FakeRpc extends EventEmitter {
  constructor() { super(); this.calls = []; this.turn = 0; this.startTurn = null; }
  async connect() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'remote-1' } };
    if (method === 'thread/read') return { thread: { status: { type: this.active ? 'active' : 'idle' } } };
    if (method === 'thread/resume') return {};
    if (method === 'turn/start') {
      const id = `turn-${++this.turn}`;
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id } } });
      if (this.startTurn) return this.startTurn(id, params);
      return { turn: { id } };
    }
    if (method === 'turn/interrupt') {
      this.complete(params.turnId, '', 'interrupted');
      return {};
    }
    throw new Error(`Unexpected fake RPC request: ${method}`);
  }
  complete(id, text, status = 'completed', error) {
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'remote-1', turn: { id, status, items: text ? [{ type: 'agentMessage', text }] : [], error } } });
  }
  close() {}
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-中文 空格-'));
  const store = new Store(path.join(directory, '状态 文件.json'));
  const project = store.addProject(directory);
  const session = store.createSession('codex-cli', project.id);
  const rpc = new FakeRpc();
  const engine = new AgentEngine(store, rpc);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store, session, rpc, engine };
}

async function waitForTurn(rpc, count = 1) {
  for (let i = 0; i < 20; i++) {
    if (rpc.calls.filter(c => c.method === 'turn/start').length >= count) {
      await new Promise(resolve => setImmediate(resolve));
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Fake turn did not start');
}

test('Codex completion before turn/start response is saved and the same remote thread is resumed', async t => {
  const { directory, store, session, rpc, engine } = fixture(t);
  rpc.startTurn = async (id) => {
    rpc.complete(id, `回答 ${id}`);
    await new Promise(resolve => setImmediate(resolve));
    return { turn: { id } };
  };
  let finished = once(engine, 'finished');
  engine.start(session.id, '第一个任务', [path.join(directory, '文件 中文.txt')]);
  await finished;
  assert.equal(session.status, 'done');
  assert.equal(session.remoteId, 'remote-1');
  assert.equal(session.messages[1].text, '回答 turn-1');
  const input = rpc.calls.find(c => c.method === 'turn/start').params.input[0].text;
  assert.ok(input.includes(path.join(directory, '文件 中文.txt')));
  finished = once(engine, 'finished');
  engine.start(session.id, '接着做');
  await finished;
  assert.deepEqual(rpc.calls.map(c => c.method), ['thread/start', 'turn/start', 'thread/read', 'thread/resume', 'turn/start']);
  assert.equal(session.messages.length, 4);
  assert.equal(engine.jobs.size, 0);
  assert.equal(engine.codexJobs.size, 0);
  assert.equal(new Store(store.file).session(session.id).messages.at(-1).text, '回答 turn-2');
});

test('same-session concurrent prompts are rejected without adding messages or starting another turn', async t => {
  const { session, rpc, engine } = fixture(t);
  const finished = once(engine, 'finished');
  engine.start(session.id, '长任务');
  assert.throws(() => engine.start(session.id, '并发任务'), /仍在运行/);
  await waitForTurn(rpc);
  assert.equal(session.messages.length, 1);
  assert.equal(rpc.turn, 1);
  rpc.complete('turn-1', '完成');
  await finished;
});

test('failed turns produce a failed session and release the job for retry', async t => {
  const { session, rpc, engine } = fixture(t);
  const finished = once(engine, 'finished');
  engine.start(session.id, '失败任务');
  await waitForTurn(rpc);
  rpc.complete('turn-1', '', 'failed', { message: '模拟额度错误' });
  await finished;
  assert.equal(session.status, 'error');
  assert.equal(session.error, '模拟额度错误');
  assert.equal(session.messages.length, 1);
  assert.equal(engine.jobs.size, 0);
  assert.equal(engine.codexJobs.size, 0);
});

test('active original desktop threads are rejected before a resumed turn begins', async t => {
  const { session, rpc, engine } = fixture(t);
  session.agentId = 'codex-desktop'; session.remoteId = 'remote-1'; session.lastTurnId = 'previous-completed-turn'; rpc.active = true;
  const finished = once(engine, 'finished');
  engine.start(session.id, '续聊');
  await finished;
  assert.equal(session.status, 'error');
  assert.match(session.error, /原 Codex 聊天正在运行/);
  assert.equal(session.lastTurnId, null);
  assert.deepEqual(rpc.calls.map(c => c.method), ['thread/read']);
});

test('stop interrupts the remote turn and finishes without marking it failed', async t => {
  const { session, rpc, engine } = fixture(t);
  const finished = once(engine, 'finished');
  engine.start(session.id, '需要停止的任务');
  await waitForTurn(rpc);
  assert.equal(await engine.stop(session.id), true);
  await finished;
  assert.equal(session.status, 'interrupted');
  assert.equal(session.error, null);
  assert.deepEqual(rpc.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'remote-1', turnId: 'turn-1' } });
  assert.equal(await engine.stop(session.id), false);
});

test('stop requested before connection completes prevents any thread or turn creation', async t => {
  const { session, rpc, engine } = fixture(t);
  let connect;
  rpc.connect = () => new Promise(resolve => { connect = resolve; });
  const finished = once(engine, 'finished');
  engine.start(session.id, '马上停止');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await engine.stop(session.id), true);
  connect(); await finished;
  assert.equal(session.status, 'interrupted');
  assert.deepEqual(rpc.calls, []);
});

test('completion from an older turn cannot terminate the current turn', async t => {
  const { session, rpc, engine } = fixture(t);
  const finished = once(engine, 'finished');
  engine.start(session.id, '当前任务');
  await waitForTurn(rpc);
  rpc.complete('old-turn', '旧的回答');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status, 'running');
  assert.equal(engine.jobs.size, 1);
  rpc.complete('turn-1', '当前回答');
  await finished;
  assert.equal(session.messages.at(-1).text, '当前回答');
});

test('RPC writes that fail immediately do not leave orphaned pending requests', async () => {
  const rpc = new CodexRpc();
  await assert.rejects(rpc.request('thread/read', { threadId: 'no-child' }), /未连接/);
  assert.equal(rpc.pending.size, 0);
});

test('early failure during a delayed turn/start response does not crash Node with an unhandled rejection', t => {
  const { store, session } = fixture(t);
  // Run this race in an isolated process: a regression must fail this assertion,
  // rather than an unhandled rejection terminating the test runner itself.
  const script = `
    import { EventEmitter, once } from 'node:events';
    import { AgentEngine } from ${JSON.stringify(new URL('../hub/agents.mjs', import.meta.url).href)};
    import { Store } from ${JSON.stringify(new URL('../hub/store.mjs', import.meta.url).href)};
    const store = new Store(${JSON.stringify(store.file)});
    class Rpc extends EventEmitter {
      async connect() {}
      async request(method) {
        if (method === 'thread/start') return { thread: { id: 'remote-early' } };
        if (method === 'turn/start') {
          this.emit('notification', { method: 'turn/completed', params: { threadId: 'remote-early', turn: { id: 'early', status: 'failed', error: { message: 'early failure' } } } });
          await new Promise(resolve => setTimeout(resolve, 25));
          return { turn: { id: 'early' } };
        }
      }
    }
    const engine = new AgentEngine(store, new Rpc());
    const finished = once(engine, 'finished');
    engine.start(${JSON.stringify(session.id)}, 'test');
    const [result] = await finished;
    if (result.status !== 'error' || result.error !== 'early failure') process.exit(2);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

function rpcProcessFixture(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-中文 空格-'));
  const executableScript = path.join(directory, 'fake-rpc.mjs');
  const generationFile = path.join(directory, 'generation.txt');
  fs.writeFileSync(executableScript, `
    import fs from 'node:fs';
    import { createInterface } from 'node:readline';
    const marker = process.argv[2], mode = process.argv[3];
    const generation = Number(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 0) + 1;
    fs.writeFileSync(marker, String(generation));
    setInterval(() => {}, 1000);
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (!request.method || request.id === undefined) return;
      if (request.method === 'initialize' && mode === 'timeout') return;
      const response = request.method === 'initialize' && mode === 'fail-once' && generation === 1
        ? { id: request.id, error: { code: -32603, message: 'fake initialize failure' } }
        : { id: request.id, result: { generation } };
      process.stdout.write(JSON.stringify(response) + '\\n');
    });
  `);
  const rpc = new CodexRpc(process.execPath, { args: [executableScript, generationFile, mode] });
  t.after(async () => {
    const child = rpc.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); rpc.close(); await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return rpc;
}

test('failed RPC initialization kills the fake executable and a new process can reconnect', async t => {
  const rpc = rpcProcessFixture(t, 'fail-once');
  const firstReady = rpc.connect();
  const oldChild = rpc.child;
  const oldExited = once(oldChild, 'exit');
  await assert.rejects(firstReady, /fake initialize failure/);
  assert.equal(rpc.child, null);
  assert.equal(rpc.pending.size, 0);
  const secondReady = rpc.connect();
  const newChild = rpc.child;
  assert.notEqual(newChild, oldChild);
  assert.equal(rpc.connect(), secondReady);
  await secondReady;
  await oldExited;
  assert.equal(rpc.child, newChild);
  assert.deepEqual(await rpc.request('probe'), { generation: 2 });
});

test('RPC initialization timeout kills the fake executable and clears pending state', async t => {
  const rpc = rpcProcessFixture(t, 'timeout');
  const request = rpc.request.bind(rpc);
  rpc.request = (method, params, timeout) => request(method, params, method === 'initialize' ? 40 : timeout);
  const ready = rpc.connect();
  const child = rpc.child;
  const exited = once(child, 'exit');
  await assert.rejects(ready, /请求超时.*initialize/);
  await exited;
  assert.equal(rpc.child, null);
  assert.equal(rpc.ready, null);
  assert.equal(rpc.pending.size, 0);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('an external rollout with a latest started turn is refused even when the separate RPC reports idle', async t => {
  const { directory, session, rpc, engine } = fixture(t);
  session.agentId = 'codex-desktop'; session.source = 'external'; session.remoteId = 'remote-1'; session.status = 'running';
  session.rolloutPath = path.join(directory, '桌面 原会话.jsonl');
  const event = type => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'original-turn' } }) + '\n';
  fs.writeFileSync(session.rolloutPath, event('task_started') + event('task_complete') + event('task_started'));
  assert.throws(() => engine.start(session.id, '请续聊已有桌面会话'), /正在运行|仍在运行/);
  assert.equal(session.status, 'running');
  assert.equal(session.messages.length, 0);
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 0);
  fs.appendFileSync(session.rolloutPath, event('task_complete'));
  rpc.startTurn = async id => { rpc.complete(id, '原任务完成之后允许续聊'); return { turn: { id } }; };
  const finished = once(engine, 'finished');
  engine.start(session.id, '现在可以继续');
  await finished;
  assert.equal(session.status, 'done');
  assert.equal(session.messages.at(-1).text, '原任务完成之后允许续聊');
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 1);
});
