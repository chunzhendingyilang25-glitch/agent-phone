import { EventEmitter } from 'node:events';
import { DshClient, dshText, normalizeDshRequest, buildDshResponse } from './dsh.mjs';
import { listAgents } from './registry.mjs';

/** Watches every enabled DSH profile, including tasks started in DSH Desktop itself. */
export class DshMonitor extends EventEmitter {
  constructor(store, options = {}) {
    super(); this.store = store; this.options = options; this.connections = new Map(); this.started = false; this.refreshTimer = null;
    this.storeChanged = () => { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refresh(), 200); };
  }
  start() { if (this.started) return; this.started = true; this.store.on?.('change', this.storeChanged); this.refresh(); }
  refresh() {
    if (!this.started) return;
    const profiles = listAgents(this.store, { includeDisabled: false }).filter(p => p.kind === 'dsh');
    for (const [id, state] of this.connections) {
      const current = profiles.find(p => p.id === id);
      if (!current || current.endpoint !== state.profile.endpoint) { this.drop(state); this.connections.delete(id); }
      else state.profile = current;
    }
    for (const profile of profiles) if (!this.connections.has(profile.id)) {
      const state = { profile, records: new Map(), requests: new Map(), retryTimer: null, client: null, closed: false, connecting: false };
      this.connections.set(profile.id, state); this.connect(state);
    }
  }
  status(state, connected, error = null) {
    const status = { agentId: state.profile.id, connected, error: error?.message || null };
    this.emit('status', status); this.options.onStatus?.(status);
  }
  async connect(state) {
    if (!this.started || state.closed || state.connecting) return;
    state.connecting = true;
    const client = this.options.createClient ? this.options.createClient(state.profile) : new DshClient(state.profile.endpoint, this.options.clientOptions);
    state.client?.close(); state.client = client;
    client.on('notification', envelope => { if (state.client === client && !state.closed) this.onFrame(state, envelope); });
    client.on('disconnected', error => { if (state.client !== client || state.closed) return; this.status(state, false, error); this.scheduleRetry(state); });
    try {
      await client.connect();
      if (state.closed || state.client !== client) { client.close(); return; }
      const listed = await client.listSessions();
      for (const summary of listed.items || []) {
        const row = state.records.get(summary.sessionId) || { seq: -1, text: '' };
        row.cwd = summary.cwd || row.cwd; row.running = summary.running; row.title ||= 'DSH 任务'; state.records.set(summary.sessionId, row);
      }
      this.status(state, true);
    } catch (error) {
      if (!state.closed && state.client === client) { this.status(state, false, error); this.scheduleRetry(state); }
      client.close();
    } finally { state.connecting = false; }
  }
  scheduleRetry(state) {
    if (!this.started || state.closed || state.retryTimer) return;
    state.retryTimer = setTimeout(() => { state.retryTimer = null; this.connect(state); }, this.options.retryMs ?? 10000);
    state.retryTimer.unref?.();
  }
  dispatch(name, value) {
    this.emit(name, value);
    const callback = this.options[{ completed: 'onCompleted', attention: 'onAttention', resolved: 'onResolved' }[name]];
    if (callback) Promise.resolve().then(() => callback(value)).catch(error => this.emit('callback-error', { name, error }));
  }
  onFrame(state, envelope) {
    const { rpcId, payload } = envelope, sessionId = payload?.sessionId;
    if (!sessionId) return;
    const record = state.records.get(sessionId) || { seq: -1, text: '', title: 'DSH 任务' };
    state.records.set(sessionId, record);
    if (state.records.size > 1000) state.records.delete(state.records.keys().next().value);
    const common = { profile: state.profile, sessionId, cwd: record.cwd, title: record.title, client: state.client };
    if (payload.type === 'session/subscribed') { record.seq = Math.max(record.seq, payload.lastSeq ?? -1); return; }
    if (payload.type === 'approval/resolved' || payload.type === 'question/resolved') {
      const id = payload.questionRpcId || [...state.requests].find(([, r]) => r.approvalId === payload.approvalId && r.sessionId === sessionId)?.[0];
      if (id && state.requests.delete(id)) this.dispatch('resolved', { ...common, requestId: id, event: payload });
      return;
    }
    const managed = this.options.isManagedSession?.(state.profile, sessionId) === true;
    if (payload.type === 'approval/requested' || payload.type === 'question/requested') {
      if (managed || state.requests.has(rpcId)) return;
      state.requests.set(rpcId, payload);
      const request = normalizeDshRequest(rpcId, payload);
      this.dispatch('attention', { ...common, request, envelope, respond: async value => {
        if (!state.requests.has(rpcId)) throw new Error('这个 DSH 操作请求已经结束。');
        await state.client.respond(rpcId, buildDshResponse(payload, sessionId, value));
        state.requests.delete(rpcId); this.dispatch('resolved', { ...common, requestId: rpcId });
      } });
      return;
    }
    if (payload.type !== 'session/event' || !payload.event) return;
    const event = payload.event;
    if (typeof event.seq !== 'number' || event.seq <= record.seq) return;
    record.seq = event.seq;
    if (event.type === 'turn/start') { record.text = ''; record.running = true; }
    else if (event.type === 'assistant/message') record.text = dshText(event) || record.text;
    else if (event.type === 'assistant/text-delta') record.text += dshText(event);
    else if (event.type === 'session/meta') record.cwd = event.data?.cwd || record.cwd;
    else if (event.type === 'session/title') record.title = event.data?.title || record.title;
    else if (event.type === 'turn/end') {
      record.running = false;
      if (!managed) this.dispatch('completed', { ...common, cwd: record.cwd, title: record.title, event, text: record.text,
        status: event.data?.reason?.kind === 'completed' ? 'done' : event.data?.reason?.kind === 'error' ? 'error' : 'interrupted', key: `${sessionId}:${event.seq}` });
    }
  }
  drop(state) { state.closed = true; clearTimeout(state.retryTimer); state.client?.close(); }
  stop() {
    this.started = false; clearTimeout(this.refreshTimer); this.store.off?.('change', this.storeChanged);
    for (const state of this.connections.values()) this.drop(state); this.connections.clear();
  }
}
