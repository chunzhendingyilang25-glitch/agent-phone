import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import { AGENTS } from './config.mjs';

const KINDS = new Set(['terminal', 'line-json', 'hook', 'dsh']);
const BUILTINS = AGENTS.map(a => ({ ...a, kind: 'builtin', builtin: true, enabled: true }));
const defaults = { enabled: true, color: '#6d5bd0', short: 'AG', args: [], completionMode: 'exit', inputMode: 'line' };

export function initializeRegistry(store, persist = true) {
  const previous = store.data.agents || [];
  const agents = [...BUILTINS.map(a => ({ ...a, enabled: previous.find(p => p.id === a.id)?.enabled !== false })),
    ...previous.filter(a => !BUILTINS.some(b => b.id === a.id))];
  const changed = JSON.stringify(agents) !== JSON.stringify(previous);
  store.data.agents = agents;
  if (changed && persist) store.save();
  return agents;
}

// The manager UI never receives environment variable values.
export function listAgents(store, { includeDisabled = true } = {}) {
  return initializeRegistry(store, false).filter(a => includeDisabled || a.enabled !== false).map(({ env, ...a }) => ({ ...a }));
}
export function getAgent(store, id) {
  const agent = initializeRegistry(store, false).find(a => a.id === id);
  if (!agent) throw new Error('请选择可用 Agent，当前 Agent 不存在。');
  return agent;
}

function validate(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Agent 配置格式不正确。');
  const result = { ...defaults, ...existing, ...input };
  if (input.executable !== undefined && input.command === undefined) result.command = input.executable;
  if (input.completionPattern !== undefined && input.completionMarker === undefined) result.completionMarker = input.completionPattern;
  if (input.attentionPattern !== undefined && input.attentionMarker === undefined) result.attentionMarker = input.attentionPattern;
  if (input.completionPattern && input.completionMode === undefined) result.completionMode = 'marker';
  result.name = String(result.name || '').trim();
  if (!result.name || result.name.length > 80) throw new Error('请输入 1–80 字的 Agent 名称。');
  if (!KINDS.has(result.kind)) throw new Error('请选择终端、JSON 事件、通知接入或 DSH。');
  result.description = String(result.description || '').slice(0, 300);
  result.short = String(result.short || result.name.slice(0, 2)).slice(0, 4);
  if (!/^#[a-f\d]{6}$/i.test(result.color)) result.color = defaults.color;
  result.enabled = result.enabled !== false;
  if (!Array.isArray(result.args) || result.args.length > 100 || result.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 10000)) throw new Error('启动参数必须是字符串数组。');
  if (result.kind === 'dsh') {
    const endpoint = new URL(result.endpoint || 'http://127.0.0.1:43120');
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('DSH 地址必须是电脑本地的 HTTP 地址。');
    result.endpoint = endpoint.origin;
  } else if (result.kind !== 'hook') {
    if (typeof result.command !== 'string' || !result.command.trim() || result.command.includes('\0')) throw new Error('请选择 Agent 程序，或输入 PATH 中的命令。');
    result.command = result.command.trim();
    result.executable = result.command;
    if (path.isAbsolute(result.command) && (!fs.existsSync(result.command) || !fs.statSync(result.command).isFile())) throw new Error('Agent 程序文件不存在。');
  }
  if (!['exit', 'marker', 'json'].includes(result.completionMode)) throw new Error('完成信号配置不正确。');
  if (!['line', 'raw', 'json'].includes(result.inputMode)) throw new Error('输入方式配置不正确。');
  for (const key of ['completionMarker', 'attentionMarker']) {
    if (result[key] != null && (typeof result[key] !== 'string' || result[key].length > 300)) throw new Error('事件标记必须是短文本。');
  }
  if (result.completionMode === 'marker' && !result.completionMarker?.trim()) throw new Error('请输入 Agent 明确输出的完成标记。');
  if (result.env != null && (typeof result.env !== 'object' || Array.isArray(result.env) || Object.entries(result.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z\d_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')))) throw new Error('环境变量配置不正确。');
  result.builtin = false;
  result.completionPattern = result.completionMarker || '';
  result.attentionPattern = result.attentionMarker || '';
  return result;
}

export function addAgent(store, input) {
  const agent = validate(input);
  agent.id = `custom-${randomUUID()}`;
  agent.createdAt = Date.now(); agent.updatedAt = agent.createdAt;
  initializeRegistry(store, false).push(agent); store.save();
  return listAgents(store).find(a => a.id === agent.id);
}
export function updateAgent(store, id, input) {
  const existing = getAgent(store, id);
  if (existing.builtin) {
    if (Object.keys(input).some(key => key !== 'enabled')) throw new Error('内置 Agent 只支持启用或停用。');
    existing.enabled = input.enabled !== false; store.save(); return { ...existing };
  }
  const updated = validate(input, existing);
  updated.id = existing.id; updated.createdAt = existing.createdAt; updated.updatedAt = Date.now();
  Object.assign(existing, updated); store.save();
  return listAgents(store).find(a => a.id === id);
}
export function deleteAgent(store, id) {
  const agent = getAgent(store, id);
  if (agent.builtin) throw new Error('内置 Agent 可以停用，不能删除。');
  if (store.data.sessions?.some(s => s.agentId === id && (['running', 'attention', 'waiting'].includes(s.status) || s.managedRunning))) throw new Error('请先停止这个 Agent 正在运行的任务。');
  store.data.agents = store.data.agents.filter(a => a.id !== id); store.save();
}

export function discoverAgents({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const found = [];
  const dshPaths = platform === 'win32' ? [
    path.join(env.ProgramFiles || 'C:\\Program Files', 'DSH Desktop', 'DSH Desktop.exe'),
    path.join(env.LOCALAPPDATA || os.homedir(), 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
  ] : platform === 'darwin' ? ['/Applications/DSH Desktop.app'] : [];
  const desktop = dshPaths.find(exists);
  if (desktop) found.push({ name: 'DSH Desktop', short: 'DS', color: '#5268d8', kind: 'dsh', endpoint: 'http://127.0.0.1:43120',
    executable: desktop, description: 'DeepSeek Harness 桌面：持续对话、完成通知、审批和问题回复', completionMode: 'json', inputMode: 'json', args: [] });
  for (const command of ['dsh', 'gemini', 'opencode', 'aider', 'qwen', 'cursor-agent']) {
    const binary = spawn.sync(platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
    if (binary && exists(binary)) found.push({ name: command === 'dsh' ? 'DSH CLI' : command, kind: 'terminal', command: binary, executable: binary, args: [],
      description: '可交互终端；配置明确完成 / 待操作标记，或由 Agent 发出标准事件。', completionMode: 'exit', inputMode: 'line' });
  }
  return found;
}
