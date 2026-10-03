import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { AgentEngine } from '../hub/agents.mjs';
import { Store } from '../hub/store.mjs';

test('completion cancels remaining requests without restoring running status', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-finalize-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const store = new Store(path.join(directory, 'state.json'));
  const project = store.addProject(directory), session = store.createSession('codex-cli', project.id);
  class Rpc extends EventEmitter {
    async connect() {}
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'remote' } };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      throw new Error(`unexpected method: ${method}`);
    }
  }
  const rpc = new Rpc(), engine = new AgentEngine(store, rpc);
  const finished = once(engine, 'finished');
  engine.start(session.id, 'task');
  for (let tries = 0; tries < 20 && !engine.codexJobs.size; tries++) await new Promise(resolve => setImmediate(resolve));
  const request = engine.requests.create({ sessionId: session.id, title: 'Pending operation' });
  assert.equal(session.status, 'waiting');
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'remote', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'done' }] } } });
  await finished;
  assert.equal(request.status, 'cancelled');
  assert.equal(engine.requests.pending(session.id).length, 0);
  assert.equal(session.status, 'done');
  assert.equal(session.managedRunning, false);
});
