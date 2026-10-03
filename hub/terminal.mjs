import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

export function stripAnsi(value) {
  return String(value).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Persistent owned process. Completion is an explicit event, marker, or process exit. */
export class TerminalRunner extends EventEmitter {
  constructor(profile, options = {}) {
    super(); this.profile = profile; this.options = options; this.process = null; this.busy = false;
    this.closed = false; this.stopped = false; this.lineBuffer = ''; this.outputText = ''; this.pending = new Map();
  }
  async start({ cwd, prompt, sessionId, files = [] }) {
    if (this.busy) throw new Error('Agent 仍在运行，请先等待或停止。');
    if (this.closed) throw new Error('这个终端已退出，请创建新会话。');
    this.busy = true; this.stopped = false; this.outputText = ''; this.lineBuffer = '';
    try {
      if (!this.process) await this.launch(cwd);
      if (this.stopped) { this.stop(); return; }
      this.sessionId = sessionId;
      const text = files.length ? `${prompt}\n\n用户选择的文件：\n${files.map(f => `- ${f}`).join('\n')}` : prompt;
      if (this.profile.inputMode === 'json' || this.profile.kind === 'line-json') this.write(JSON.stringify({ type: 'prompt', sessionId, text, files }) + '\n');
      else this.input(text, { raw: this.profile.inputMode === 'raw', submit: true });
    } catch (error) { this.busy = false; this.emit('failed', error); throw error; }
  }
  async launch(cwd) {
    const profile = this.profile;
    const env = { ...process.env, ...profile.env, AGENT_PHONE_MANAGED: '1' };
    if (profile.kind === 'line-json') {
      const child = (this.options.spawn || spawn)(profile.command, profile.args || [], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = child;
      const decoder = new StringDecoder('utf8');
      child.stdout.on('data', data => this.onData(decoder.write(data)));
      child.stderr.on('data', data => this.emit('output', { text: data.toString(), stderr: true }));
      child.on('error', error => { this.busy = false; this.emit('failed', error); });
      child.on('close', code => { const tail = decoder.end(); if (tail) this.onData(tail); this.onExit({ exitCode: code }); });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } else {
      if (!this.options.pty) { await this.launchTerminalHost(cwd, env); return; }
      const pty = this.options.pty || await import('node-pty');
      // npm installs Windows command shims as .cmd files. ConPTY's
      // CreateProcess needs the shell carrier prepared by cross-spawn;
      // task prompts still travel through stdin, never a shell command.
      const parsed = spawn._parse(profile.command, profile.args || [], { cwd, env });
      const args = parsed.options.windowsVerbatimArguments ? parsed.args.join(' ') : parsed.args;
      this.process = pty.spawn(parsed.command, args, { cwd, env, name: 'xterm-256color', cols: 100, rows: 30, useConpty: true });
      this.process.onData(text => this.onData(text));
      this.process.onExit(event => this.onExit(event));
    }
  }
  async launchTerminalHost(cwd, env) {
    const host = spawn(process.execPath, [fileURLToPath(new URL('./terminal-host.mjs', import.meta.url))], {
      cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.host = host;
    this.process = {
      pid: null,
      write: text => {
        if (!host.connected) throw new Error('Agent 终端输入已关闭。');
        host.send({ type: 'input', text });
      },
      kill: () => this.killHost(host),
    };
    host.stderr.on('data', data => this.emit('output', { text: data.toString(), stderr: true }));
    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => { this.killHost(host); reject(new Error('Agent 终端启动超时。')); }, 15000);
      host.on('message', message => {
        if (message?.type === 'ready') { ready = true; this.process.pid = message.pid; clearTimeout(timer); resolve(); }
        else if (message?.type === 'data') this.onData(message.text);
        else if (message?.type === 'exit') this.onExit(message.event);
        else if (message?.type === 'failed') {
          const error = new Error(message.message || 'Agent 终端失败。');
          if (!ready) { clearTimeout(timer); reject(error); }
          else { this.busy = false; this.emit('failed', error); }
        }
      });
      host.on('error', error => {
        clearTimeout(timer);
        if (!ready) reject(error);
        else { this.busy = false; this.emit('failed', error); }
      });
      host.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`Agent 终端启动失败（${exitCode ?? signal ?? '未知'}）。`));
        this.onExit({ exitCode, signal });
      });
      host.once('spawn', () => host.send({ type: 'start', command: this.profile.command, args: this.profile.args || [], cwd, env }));
    });
  }
  killHost(host = this.host) {
    if (!host || host.exitCode !== null || host.signalCode !== null) return;
    if (process.platform === 'win32' && host.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', error => { this.emit('failed', error); host.kill(); });
    } else host.kill();
  }
  write(text) {
    if (!this.process || this.closed) throw new Error('Agent 终端未连接。');
    if (this.profile.kind === 'line-json') {
      if (!this.process.stdin?.writable) throw new Error('Agent 终端输入已关闭。');
      this.process.stdin.write(text);
    } else this.process.write(text);
  }
  input(text, { raw = false, submit = true } = {}) {
    if (typeof text !== 'string' || text.includes('\0')) throw new Error('输入文本不正确。');
    // ConPTY sends Enter as CR; bracketed paste keeps multiline prompts in one input.
    let value = text;
    if (!raw && this.profile.kind !== 'line-json' && /\r?\n/.test(text)) value = `\x1b[200~${text}\x1b[201~`;
    this.write(value + (raw || !submit ? '' : this.profile.kind === 'line-json' ? '\n' : '\r'));
  }
  respond(requestId, value) {
    const request = this.pending.get(requestId);
    if (!request) throw new Error('这个操作请求已经结束。');
    if (requestId.startsWith('marker-') && this.lineBuffer) {
      // This fragment has already produced the request. Do not scan it again
      // when the terminal prints the user's answer without first printing LF.
      this.outputText = (this.outputText + this.lineBuffer + '\n').slice(-200000); this.lineBuffer = '';
    }
    if (this.profile.kind === 'line-json' || this.profile.inputMode === 'json') this.write(JSON.stringify({ type: 'response', id: requestId, value }) + '\n');
    else this.input(typeof value === 'string' ? value : String(value?.text || value?.optionId || value?.value || ''));
    this.pending.delete(requestId); this.emit('attention-resolved', { id: requestId });
  }
  onData(text) {
    if (!text) return;
    if (this.profile.kind !== 'line-json') this.emit('output', { text: stripAnsi(text), terminal: true });
    this.lineBuffer += stripAnsi(text).replace(/\r\n/g, '\n');
    if (this.lineBuffer.length > 1024 * 1024) this.lineBuffer = this.lineBuffer.slice(-1024 * 1024);
    let newline;
    while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(newline + 1); this.onLine(line);
    }
    this.checkMarkers(this.lineBuffer);
  }
  onLine(line) {
    let value; try { value = JSON.parse(line); } catch {}
    if (value && ['completed', 'completion', 'attention', 'output', 'error'].includes(value.type)) {
      if (value.type === 'output') { this.outputText += String(value.text || ''); this.emit('output', { text: String(value.text || '') }); }
      else if (value.type === 'completed' || value.type === 'completion') this.complete(String(value.text || this.outputText), value);
      else if (value.type === 'attention') this.attention({ ...value, message: String(value.message || 'Agent 需要你操作。') });
      else { this.busy = false; this.emit('failed', new Error(String(value.message || 'Agent 任务失败。'))); }
      return;
    }
    if (this.profile.kind === 'line-json') this.emit('output', { text: line + '\n' });
    this.outputText = (this.outputText + line + '\n').slice(-200000);
    this.checkMarkers(line);
  }
  checkMarkers(text) {
    if (this.busy && this.profile.completionMode === 'marker' && this.profile.completionMarker && text.includes(this.profile.completionMarker)) this.complete(this.outputText + this.lineBuffer);
    if (this.busy && this.profile.attentionMarker && text.includes(this.profile.attentionMarker)) {
      const id = `marker-${this.sessionId || 'task'}`;
      if (!this.pending.has(id)) this.attention({ id, kind: 'input', message: text.slice(-2000) });
    }
  }
  attention(request) {
    const id = String(request.id || `input-${Date.now()}`);
    if (this.pending.has(id)) return;
    const normalized = { id, kind: request.kind || 'input', message: request.message,
      choices: (request.choices || []).map((c, i) => typeof c === 'string' ? { id: c, label: c } : { id: String(c.id ?? c.value ?? i), ...c }), questions: request.questions || [] };
    this.pending.set(id, normalized); this.emit('attention', normalized);
  }
  complete(text, extra = {}) {
    if (!this.busy) return;
    this.busy = false; this.pending.clear();
    this.emit('completed', { text, turnId: extra.turnId, status: extra.status || 'done' });
  }
  onExit({ exitCode, signal } = {}) {
    if (this.closed) return;
    if (this.lineBuffer) { this.onLine(this.lineBuffer); this.lineBuffer = ''; }
    this.closed = true;
    if (this.busy) {
      if (this.stopped) this.complete(this.outputText, { status: 'interrupted' });
      else if (exitCode === 0) this.complete(this.outputText);
      else { this.busy = false; this.emit('failed', new Error(`Agent 程序退出（${exitCode ?? signal ?? '未知'}）。`)); }
    }
    this.emit('exit', { exitCode, signal, stopped: this.stopped });
  }
  stop() {
    this.stopped = true;
    if (!this.process || this.closed) { if (this.busy) this.complete(this.outputText, { status: 'interrupted' }); return; }
    if (this.host) this.killHost();
    else if (process.platform === 'win32' && this.process.pid) {
      spawn('taskkill.exe', ['/PID', String(this.process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else this.process.kill();
  }
  close() {
    this.stop();if(this.closed || !this.process?.pid)return Promise.resolve();
    return new Promise(resolve=>{const ended=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{this.off('exit',ended);resolve();},3000);this.once('exit',ended);});
  }
}
