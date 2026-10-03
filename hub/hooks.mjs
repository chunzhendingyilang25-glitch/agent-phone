import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  codex: 'https://learn.chatgpt.com/docs/hooks',
  claude: 'https://code.claude.com/docs/en/hooks',
  cursor: 'https://prod.cursor.com/docs/hooks',
};
function locations(options = {}) {
  const env = options.env || process.env, profile = options.profile || env.USERPROFILE || os.homedir();
  return {
    codex: path.join(env.CODEX_HOME || path.join(profile, '.codex'), 'hooks.json'),
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(profile, '.claude'), 'settings.json'),
    cursor: path.join(profile, '.cursor', 'hooks.json'),
  };
}
function read(file) {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Hook 配置必须是 JSON 对象：' + file);
  if (value.hooks && (typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error('Hook 配置 hooks 字段无效：' + file);
  return value;
}
function owned(handler) {
  return /(?:^|[\\/\s"'])feishu-notify\.js(?:[\s"']|$)/i.test(String(handler?.command || '')) ||
    (Array.isArray(handler?.args) && handler.args.some(item => /(?:^|[\\/])feishu-notify\.js$/i.test(String(item))));
}
function quote(file) {
  const value = path.resolve(file).replace(/\\/g, '/');
  if (/["\r\n]/.test(value)) throw new Error('运行环境路径包含不支持的字符。');
  return '"' + value + '"';
}
function definitions(agent, options) {
  const node = options.node || process.execPath, notifier = options.notifier || path.join(ROOT, 'feishu-notify.js');
  if (!fs.existsSync(node) || !fs.existsSync(notifier)) throw new Error('Hook 所需的内置 Node 或通知脚本不存在。');
  const command = mode => `${quote(node)} ${quote(notifier)} ${agent} ${mode}`;
  const handler = (mode, timeout = 10) => agent === 'claude'
    ? { type: 'command', command: path.resolve(node), args: [path.resolve(notifier), agent, mode], timeout }
    : { type: 'command', command: command(mode), timeout };
  if (agent === 'codex') return { Stop: [{ hooks: [handler('completion')] }], PermissionRequest: [{ hooks: [handler('permission', 600)] }] };
  if (agent === 'claude') return {
    Stop: [{ hooks: [handler('completion')] }],
    StopFailure: [{ hooks: [handler('completion')] }],
    Notification: [{ matcher: 'permission_prompt|idle_prompt|auth_success|elicitation_dialog', hooks: [handler('attention')] }],
    PermissionRequest: [{ hooks: [handler('permission', 600)] }],
  };
  return { stop: [handler('completion')], ...(options.cursorApproval ? { beforeShellExecution: [{...handler('permission', 600),failClosed:true}] } : {}) };
}
function mergeHooks(config, agent, additions) {
  config.hooks ||= {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) throw new Error('Hook 事件必须是数组：' + event);
    config.hooks[event] = agent === 'cursor'
      ? groups.filter(handler => !owned(handler))
      : groups.map(group => {
        if (!Array.isArray(group?.hooks)) throw new Error('Hook matcher 组缺少 hooks 数组：' + event);
        return { ...group, hooks: group.hooks.filter(handler => !owned(handler)) };
      }).filter(group => group.hooks.length);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  for (const [event, groups] of Object.entries(additions)) config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  if (agent === 'cursor') config.version ||= 1;
  return config;
}

export function hookStatus(options = {}) {
  const files = locations(options);
  return Object.entries(files).map(([agent, file]) => {
    try {
      const config = read(file), events = Object.entries(config.hooks || {}).filter(([, groups]) =>
        Array.isArray(groups) && groups.some(group => agent === 'cursor' ? owned(group) : group?.hooks?.some(owned))).map(([name]) => name);
      return { agent, file, exists: fs.existsSync(file), installed: events.length > 0, events,
        completion: events.includes(agent === 'cursor' ? 'stop' : 'Stop'),
        attention: agent === 'cursor' ? events.includes('beforeShellExecution') : events.includes('PermissionRequest'),
        trustRequired: agent === 'codex' && events.length > 0,
        source: SOURCES[agent], error: null };
    } catch (error) { return { agent, file, installed: false, events: [], error: error.message, source: SOURCES[agent] }; }
  });
}

// Called only after the user chooses the Hook install action. Importing this
// module and reading hookStatus never changes an Agent's configuration.
export function installHooks(options = {}) {
  const agents = options.agents || ['codex', 'claude', 'cursor'];
  if (!Array.isArray(agents) || agents.some(agent => !Object.hasOwn(SOURCES, agent))) throw new Error('请选择 Codex、Claude Code 或 Cursor。');
  const files = locations(options), planned = [];
  for (const agent of [...new Set(agents)]) {
    const file = files[agent], config = read(file);
    const next = JSON.stringify(mergeHooks(config, agent, definitions(agent, options)), null, 2) + '\n';
    const prior = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (next !== prior) planned.push({ agent, file, next, prior });
  }
  const backups = [];
  for (const plan of planned) {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    if (plan.prior !== null) {
      const backup = plan.file + `.agent-phone-backup-${Date.now()}-${randomBytes(3).toString('hex')}`;
      fs.writeFileSync(backup, plan.prior); backups.push(backup);
    }
    const temporary = plan.file + `.agent-phone-${process.pid}.tmp`;
    fs.writeFileSync(temporary, plan.next); fs.renameSync(temporary, plan.file);
  }
  return { installed: agents, changed: planned.map(plan => plan.file), backups, status: hookStatus(options),
    codexTrustRequired: agents.includes('codex'), restartRequired: true,
    notes: [
      ...(agents.includes('codex') ? ['在 Codex 中打开 /hooks，核对并信任新增的 Stop 和 PermissionRequest。原 config.toml 的 inline Hooks 与 notify 设置保留。'] : []),
      ...(agents.includes('cursor') ? [options.cursorApproval ? 'Cursor 每条 Shell 命令均需手机批准；这不是 Cursor 原生等待通知。' : 'Cursor 默认仅完成通知；可选逐条 Shell 命令手机审批。'] : []),
      '请让原 Agent 重新加载配置。权限请求超时或工作台断开时拒绝本次操作。',
    ] };
}
