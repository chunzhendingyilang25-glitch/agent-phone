import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

function localEndpoint(value) {
  const url = new URL(value || 'http://127.0.0.1:43120');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('DSH 地址必须是电脑本地的 HTTP 地址。');
  return url.origin;
}
function transportError(response) {
  if (response.status === 403) return new Error('DSH 拒绝普通浏览器连接。请在 DSH 设置中开启浏览器访问，再重新连接。');
  return new Error(`DSH 连接失败（HTTP ${response.status}）。`);
}

/** The official DSH HTTP carrier: four-quadrant RPC plus server-request SSE. */
export class DshClient extends EventEmitter {
  constructor(endpoint, { fetch: transport = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket, timeout = 30000 } = {}) {
    super(); this.endpoint = localEndpoint(endpoint); this.fetch = transport; this.timeout = timeout;
    this.controller = null; this.ready = null; this.closed = false;
    this.Socket = Socket; this.socket = null;
  }
  async rpc(method, payload = {}, { signal } = {}) {
    const rpcId = randomUUID();
    const timeout = AbortSignal.timeout(this.timeout);
    const response = await this.fetch(`${this.endpoint}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    if (!response.ok) throw transportError(response);
    const body = await response.json();
    if (body.type !== 'server-response' || body.rpcId !== rpcId || typeof body.result?.ok !== 'boolean') throw new Error('DSH 返回的协议消息不正确。');
    if (!body.result.ok) throw new Error(body.result.error?.message || 'DSH 请求失败。');
    return body.result.value;
  }
  async openWebSocket(controller) {
    if (!this.Socket) throw new Error('当前运行环境不支持 DSH WebSocket 事件连接。');
    const socket = new this.Socket(`${this.endpoint.replace(/^http:/, 'ws:')}/api/events.mux`); this.socket = socket;
    await new Promise((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => { socket.close(); reject(new Error('DSH WebSocket 事件连接超时。')); }, this.timeout);
      const aborted = () => { socket.close(); if (!opened) { clearTimeout(timer); reject(controller.signal.reason || new Error('DSH 连接已取消。')); } };
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.addEventListener('message', message => {
        if (this.controller !== controller || controller.signal.aborted) return;
        this.parseEnvelope(typeof message.data === 'string' ? message.data : Buffer.isBuffer(message.data) ? message.data.toString('utf8') : '');
      });
      socket.addEventListener('open', () => { opened = true; clearTimeout(timer); resolve(); });
      socket.addEventListener('error', () => {
        const error = new Error('DSH WebSocket 事件连接失败，请确认 DSH 正在运行并允许本机浏览器访问。');
        if (!opened) { clearTimeout(timer); reject(error); }
        else if (this.controller === controller && !controller.signal.aborted) { this.ready = null; this.emit('disconnected', error); }
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
        if (!opened) { reject(new Error('DSH WebSocket 事件连接已关闭。')); return; }
        if (this.controller === controller && !controller.signal.aborted) { this.ready = null; this.emit('disconnected', new Error('DSH 事件连接已断开，请重新连接。')); }
      });
    });
  }
  parseEnvelope(data) {
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message.type !== 'server-request' || typeof message.rpcId !== 'string' || !message.payload?.type) return;
    this.emit('notification', message);
  }
  connect() {
    if (this.ready) return this.ready;
    this.closed = false; this.controller = new AbortController();
    const controller = this.controller;
    const ready = this.openStream(controller); this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }
  async openStream(controller) {
    let response;
    const timer = setTimeout(() => controller.abort(new Error('DSH 事件连接超时。')), this.timeout);
    try { response = await this.fetch(`${this.endpoint}/api/events.mux`, { signal: controller.signal }); }
    catch (error) { if (!controller.signal.aborted) throw new Error(`无法连接 DSH Desktop，请先启动 DSH，并检查本地地址。${error.cause?.code ? `（${error.cause.code}）` : ''}`); throw error; }
    finally { clearTimeout(timer); }
    if (response.status === 426) { await response.body?.cancel().catch(() => {}); return this.openWebSocket(controller); }
    if (!response.ok) throw transportError(response);
    if (!response.body) throw new Error('DSH 没有返回事件流。');
    // Attach the consumer before returning, so a completion before prompt RPC acknowledgement is retained.
    this.consume(response, controller).catch(error => {
      if (this.controller !== controller || controller.signal.aborted) return;
      this.ready = null; this.emit('disconnected', error);
    });
  }
  async consume(response, controller) {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) { if (!controller.signal.aborted) throw new Error('DSH 事件连接已断开，请重新连接。'); return; }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2 * 1024 * 1024) throw new Error('DSH 事件消息过大。');
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const raw = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          this.parseEnvelope(data);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  async respond(rpcId, value, { cancel = false } = {}) {
    const response = await this.fetch(`${this.endpoint}/api/respond`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: cancel ? { ok: false, error: { code: 'cancelled', message: '用户取消了操作。', details: {} } } : { ok: true, value } }),
      signal: AbortSignal.timeout(this.timeout) });
    if (!response.ok) throw transportError(response);
    const receipt = await response.json();
    if (receipt.accepted !== true) throw new Error(receipt.reason === 'not-pending' ? '这个 DSH 操作请求已经结束。' : 'DSH 没有接受这个回复，请检查选项。');
    return receipt;
  }
  listSessions() { return this.rpc('session.list'); }
  history(sessionId) { return this.rpc('session.history', { sessionId, maxMessages: 30 }); }
  close() { this.closed = true; this.controller?.abort(); this.ready = null; }
}

export function dshText(event) {
  if (event?.type === 'assistant/message') return (event.data?.message?.content || []).filter(p => p.type === 'text').map(p => p.text || '').join('');
  if (event?.type === 'assistant/text-delta') return event.data?.text || event.data?.delta || '';
  return '';
}

export function normalizeDshRequest(id, request) {
  if (request.type === 'approval/requested') return { id, kind: 'approval', title: 'DSH 请求批准',
    message: `${request.toolName}${request.reason ? `\n${request.reason}` : ''}`,
    choices: [{ id: 'allowed-once', value: 'allowed-once', label: '允许一次' }, { id: 'rejected', value: 'rejected', label: '拒绝' }], questions: [] };
  return { id, kind: 'question', title: 'DSH 需要你的回复', message: request.questions?.map(q => q.question).join('\n') || 'DSH 需要你的回复。',
    questions: request.questions || [], choices: request.questions?.length === 1 ? (request.questions[0].options || []).map(o => ({ id: o.label, value: o.label, label: o.label, description: o.description })) : [] };
}

export function buildDshResponse(request, sessionId, value) {
  if (request.type === 'approval/requested') {
    const choice = typeof value === 'string' ? value : value?.optionId || value?.value || value?.text;
    const outcome = ['allowed-once', '允许一次', '允许', 'approve', 'allow'].includes(choice) ? 'allowed-once' : ['rejected', '拒绝', 'reject', 'deny'].includes(choice) ? 'rejected' : null;
    if (!outcome) throw new Error('请选择“允许一次”或“拒绝”。');
    return { sessionId, approvalId: request.approvalId, outcome };
  }
  let answers = value?.answers || value?.answer?.answers;
  const text = typeof value === 'string' ? value : value?.text;
  if (!answers && text?.trim().startsWith('{')) { try { const parsed = JSON.parse(text); answers = parsed.answers || parsed.answer?.answers; } catch {} }
  if (!answers && request.questions?.length === 1) {
    const question = request.questions[0], choice = value?.optionId;
    if (choice && question.options?.some(o => o.label === choice)) answers = [{ id: question.id, selected: [choice] }];
    else if (text?.trim()) answers = [{ id: question.id, selected: [], custom: text.trim() }];
  }
  if (!Array.isArray(answers) || answers.length !== request.questions?.length) throw new Error('请逐项回答 DSH 的问题；多个问题可提交包含 answers 数组的 JSON。');
  return { sessionId, answer: { answers } };
}

/** Reusable DSH session driver. No private renderer capability or credential is used. */
export class DshRunner extends EventEmitter {
  constructor(profile, options = {}) {
    super(); this.profile = profile; this.client = options.client || new DshClient(profile.endpoint, options);
    this.remoteId = null; this.prepared = false; this.busy = false; this.pending = new Map(); this.lastSeq = -1; this.turnSeq = null; this.finalText = ''; this.stopped = false;
    this.onNotification = message => this.onFrame(message);
    this.onDisconnected = error => { if (this.busy) { this.busy = false; this.emit('failed', error); } };
    this.client.on('notification', this.onNotification); this.client.on('disconnected', this.onDisconnected);
  }
  async start({ cwd, prompt, remoteId, files = [] }) {
    if (this.busy) throw new Error('DSH 会话仍在运行，请等待或停止。');
    this.busy = true; this.stopped = false; this.promptSent = false; this.finalText = ''; this.turnSeq = null;
    try {
      if (!this.remoteId && remoteId) this.remoteId = remoteId;
      await this.client.connect();
      if (this.stopped) { this.complete('', 'interrupted'); return; }
      if (!this.prepared) {
      if (remoteId) {
        const listed = await this.client.listSessions();
        if (this.stopped) { this.complete('', 'interrupted'); return; }
        if (listed.items?.find(s => s.sessionId === remoteId)?.running) throw new Error('原 DSH 会话正在运行，请等它完成后再继续。');
      }
      const created = await this.client.rpc('session.create', { cwd, ...(remoteId ? { sessionId: remoteId } : {}) });
      this.remoteId = created.sessionId; this.prepared = true; this.emit('remote-id', this.remoteId);
      }
      if (this.stopped) { this.complete('', 'interrupted'); return; }
      const text = files.length ? `${prompt}\n\n用户选择的文件：\n${files.map(f => `- ${f}`).join('\n')}` : prompt;
      this.promptSent = true;
      const result = await this.client.rpc('session.prompt', { sessionId: this.remoteId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
      if (result.command) this.complete(result.command.text || '', 'done');
    } catch (error) { this.busy = false; this.emit('failed', error); throw error; }
  }
  input(text) {
    if (!this.remoteId) throw new Error('DSH 会话未连接。');
    return this.client.rpc('session.prompt', { sessionId: this.remoteId, mode: 'steer', content: [{ type: 'text', text }] });
  }
  onFrame({ rpcId, payload }) {
    if (payload.sessionId !== this.remoteId) return;
    if (payload.type === 'approval/requested') {
      if (this.pending.has(rpcId)) return;
      this.pending.set(rpcId, payload);
      this.emit('attention', normalizeDshRequest(rpcId, payload));
    } else if (payload.type === 'question/requested') {
      if (this.pending.has(rpcId)) return;
      this.pending.set(rpcId, payload);
      this.emit('attention', normalizeDshRequest(rpcId, payload));
    } else if (payload.type === 'approval/resolved' || payload.type === 'question/resolved') {
      const id = payload.questionRpcId || [...this.pending].find(([, p]) => p.approvalId === payload.approvalId)?.[0];
      if (id && this.pending.delete(id)) this.emit('attention-resolved', { id });
    } else if (payload.type === 'session/event') {
      const event = payload.event;
      if (!event || typeof event.seq !== 'number' || event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
      if (!this.busy) return;
      if (event.type === 'turn/start') this.turnSeq = event.seq;
      if (event.type === 'assistant/message') { this.finalText = dshText(event) || this.finalText; this.emit('output', { text: this.finalText, replace: true }); }
      else if (event.type === 'assistant/text-delta') { const text = dshText(event); this.finalText += text; this.emit('output', { text }); }
      else if (event.type === 'turn/end' && this.turnSeq !== null) {
        const reason = event.data?.reason;
        if (reason?.kind === 'error') { this.busy = false; this.emit('failed', new Error(reason.error?.message || 'DSH 任务失败。')); }
        else this.complete(this.finalText, this.stopped || reason?.kind !== 'completed' ? 'interrupted' : 'done', `${this.remoteId}:${event.seq}`);
      }
    }
  }
  complete(text, status, turnId) { if (!this.busy) return; this.busy = false; this.emit('completed', { text, status, turnId }); }
  async respond(requestId, value) {
    const request = this.pending.get(requestId);
    if (!request) throw new Error('这个 DSH 操作请求已经结束。');
    const payload = buildDshResponse(request, this.remoteId, value);
    await this.client.respond(requestId, payload); this.pending.delete(requestId); this.emit('attention-resolved', { id: requestId });
  }
  async stop() { this.stopped = true; if (this.remoteId && this.busy && this.prepared && this.promptSent) await this.client.rpc('session.cancel', { sessionId: this.remoteId }); }
  close() { this.client.off('notification', this.onNotification); this.client.off('disconnected', this.onDisconnected); this.client.close(); }
}
