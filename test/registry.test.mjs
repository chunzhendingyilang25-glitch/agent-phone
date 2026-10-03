import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeRegistry, listAgents, getAgent, addAgent, updateAgent, deleteAgent, discoverAgents } from '../hub/registry.mjs';

function store() { return { data: { sessions: [] }, saved: 0, save() { this.saved++; } }; }
test('registry persists builtins and custom configuration; public rows omit env', () => {
  const s = store(); initializeRegistry(s); assert.equal(s.data.agents.length, 3); assert.equal(s.saved, 1);
  const a = addAgent(s, { name: '测试 Agent', kind: 'terminal', command: 'fake', args: ['a b'], env: { TEST_SECRET: 'private' } });
  assert.equal(a.env, undefined); assert.deepEqual(getAgent(s, a.id).args, ['a b']); assert.equal(getAgent(s, a.id).env.TEST_SECRET, 'private');
  updateAgent(s, a.id, { name: '改名', enabled: false }); assert.equal(listAgents(s, { includeDisabled: false }).length, 3);
  deleteAgent(s, a.id); assert.equal(listAgents(s).length, 3);
});
test('registry validates exact args, markers, dsh loopback endpoint and builtins', () => {
  const s = store();
  assert.throws(() => addAgent(s, { name: 'test', kind: 'terminal', command: 'fake', args: 'shell string' }), /数组/);
  assert.throws(() => addAgent(s, { name: 'test', kind: 'terminal', command: 'fake', completionMode: 'marker' }), /完成标记/);
  assert.throws(() => addAgent(s, { name: 'test', kind: 'dsh', endpoint: 'https://example.org' }), /本地/);
  assert.throws(() => deleteAgent(s, 'codex-cli'), /不能删除/);
  assert.throws(() => updateAgent(s, 'codex-cli', { command: 'fake' }), /启用或停用/);
  updateAgent(s, 'codex-cli', { enabled: false }); assert.equal(getAgent(s, 'codex-cli').enabled, false);
});
test('registry keeps running profiles and finds installed DSH without launching it', () => {
  const s = store(), a = addAgent(s, { name: 'hook', kind: 'hook' });
  s.data.sessions.push({ agentId: a.id, status: 'attention' }); assert.throws(() => deleteAgent(s, a.id), /先停止/);
  const found = discoverAgents({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Local' }, exists: file => /DSH Desktop\.exe$/.test(file) });
  assert.equal(found[0].kind, 'dsh'); assert.equal(found[0].endpoint, 'http://127.0.0.1:43120');
});
