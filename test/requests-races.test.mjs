import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestBroker } from '../hub/requests.mjs';

function fixture() {
  const store = { data: { requests: [] }, save() {} };
  return { store, broker: new RequestBroker(store) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('failed remote response remains pending and can be retried', async () => {
  const { broker } = fixture(); let attempts = 0;
  const request = broker.create({ sessionId: 's1' }, async () => {
    attempts++;
    if (attempts === 1) throw new Error('remote unavailable');
  });
  await assert.rejects(Promise.resolve().then(() => broker.respond(request.id, { text: 'yes' })), /remote unavailable/);
  assert.equal(request.status, 'pending');
  assert.equal(broker.handlers.has(request.id), true);
  await broker.respond(request.id, { text: 'yes' });
  assert.equal(request.status, 'answered'); assert.equal(attempts, 2);
  assert.equal(broker.handlers.has(request.id), false);
});

test('simultaneous phone and desktop replies reach remote agent only once', async () => {
  const { broker } = fixture(); const remote = deferred(); let calls = 0;
  const request = broker.create({ sessionId: 's1' }, async () => { calls++; await remote.promise; });
  const first = Promise.resolve().then(() => broker.respond(request.id, { text: 'phone' }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(Promise.resolve().then(() => broker.respond(request.id, { text: 'desktop' })));
  assert.equal(calls, 1);
  remote.resolve(); await first;
  assert.equal(request.status, 'answered'); assert.equal(request.response.text, 'phone');
});

test('cancelling a session while its response is in flight does not restore answered state', async () => {
  const { broker } = fixture(); const remote = deferred(); let responses = 0;
  const request = broker.create({ sessionId: 's1' }, async answer => {
    if (answer.cancelled) return;
    responses++; await remote.promise;
  });
  const responding = Promise.resolve().then(() => broker.respond(request.id, { text: 'yes' }));
  await new Promise(resolve => setImmediate(resolve));
  broker.cancelSession('s1');
  remote.resolve(); await responding.catch(() => {});
  assert.equal(request.status, 'cancelled');
  assert.equal(broker.handlers.has(request.id), false);
  assert.equal(responses, 1);
});

test('restart expires both unanswered and in-flight requests whose remote handlers were lost', () => {
  const store = { data: { requests: [{ id: 'pending', status: 'pending' }, { id: 'inflight', status: 'responding' }, { id: 'done', status: 'answered' }] }, save() {} };
  const broker = new RequestBroker(store);
  assert.deepEqual(store.data.requests.map(r => r.status), ['expired', 'expired', 'answered']);
  assert.equal(broker.handlers.size, 0);
});
