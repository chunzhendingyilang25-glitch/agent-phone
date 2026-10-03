import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRunner } from '../hub/terminal.mjs';

test('responding to a prompt without newline consumes its attention marker', () => {
  const runner = new TerminalRunner({ kind: 'terminal', attentionMarker: 'NEED_INPUT', completionMode: 'exit' });
  const requests = [];
  runner.process = { write() {} }; runner.busy = true; runner.sessionId = 's1';
  runner.on('attention', request => requests.push(request));
  runner.onData('NEED_INPUT');
  assert.equal(requests.length, 1);
  runner.respond(requests[0].id, 'yes');
  runner.onData('accepted\n');
  assert.equal(requests.length, 1, 'ordinary output after the response must not create another request');
  runner.onData('NEED_INPUT');
  assert.equal(requests.length, 2, 'a new occurrence can request input again');
});

test('stopping during terminal launch never sends a task to the late process', async () => {
  const runner = new TerminalRunner({ kind: 'terminal', completionMode: 'exit' });
  let finishLaunch; let writes = 0, kills = 0;
  runner.launch = () => new Promise(resolve => { finishLaunch = () => { runner.process = { write() { writes++; }, kill() { kills++; } }; resolve(); }; });
  const starting = runner.start({ cwd: '.', prompt: 'run me', sessionId: 's1' });
  runner.stop(); finishLaunch();
  await starting.catch(() => {});
  assert.equal(writes, 0, 'a cancelled startup must not submit the prompt');
  assert.ok(kills > 0, 'a process created after cancellation must be closed');
});
