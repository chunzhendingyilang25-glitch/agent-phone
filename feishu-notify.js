const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getLocations, prepareLocations } = require('./hub/paths.cjs');

const locations = getLocations();
const agent = (process.argv[2] || 'test').toLowerCase();
let mode = (process.argv[3] || '').toLowerCase();
let requestId, runtime;
const labels = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', test: 'Agent Phone' };
const label = labels[agent] || agent;
const setting = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
};
const waitMs = setting('AGENT_PHONE_HOOK_TIMEOUT_MS', 540000, 1, 540000);
const pollMs = setting('AGENT_PHONE_HOOK_POLL_MS', 800, 10, 5000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readProvider() {
  if (fs.existsSync(path.join(locations.dataDir, 'binding-disabled'))) throw new Error('飞书绑定已断开。');
  const config = fs.readFileSync(locations.routerConfig, 'utf8');
  const block = config.split(/(?=^\[\[providers\]\])/m).find(part => /^id\s*=\s*"feishu_lark"\s*$/m.test(part));
  if (!block) throw new Error('飞书应用配置不存在。');
  const field = name => {
    const match = block.match(new RegExp(`^${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm'));
    return match ? JSON.parse(match[1]) : null;
  };
  const provider = { appId: field('app_id'), appSecret: field('app_secret'), recipient: field('operator_open_id') };
  if (!provider.appId || !provider.appSecret || !provider.recipient) throw new Error('飞书绑定信息不完整。');
  return provider;
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(`飞书 API 返回 ${response.status} / ${result.code}。`);
  return result;
}

function eventDescription(event) {
  const input = event.tool_input || {};
  const parts = [event.description || event.message || event.prompt || input.description,
    event.command || input.command || (event.tool_name ? JSON.stringify(input) : '')];
  return parts.filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n\n').slice(0,10000) || '请查看电脑上的任务。';
}

function messageFromEvent(event) {
  if (agent === 'test') return 'Agent Phone 测试通知\n这台电脑的飞书通知通道已连接。发送“菜单”选择 Agent 和项目。';
  const status = mode === 'attention' ? '需要你的操作' : event.status === 'error' ? '失败' : '完成';
  const lines = [`${label} ${status}`, `项目：${event.cwd ? path.basename(event.cwd) : '未知项目'}`];
  if (event.cwd) lines.push(`目录：${event.cwd}`);
  const id = event.session_id || event.thread_id || event.conversation_id;
  if (id) lines.push(`会话：${String(id).slice(0,120)}`);
  const text = mode === 'attention' ? eventDescription(event) : event.last_assistant_message;
  if (text) lines.push(`摘要：${String(text).replace(/\s+/g,' ').slice(0,800)}`);
  lines.push(mode === 'attention' ? '本机工作台当前未连接；请在电脑处理此提示。' : '继续：向统一机器人发送“菜单”，选择 Agent、项目和已有会话。');
  return lines.join('\n');
}

function readRuntime() {
  const info = JSON.parse(fs.readFileSync(path.join(locations.dataDir, 'hub-runtime.json'),'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(info.url) || typeof info.token !== 'string' || !info.token) throw new Error('无效的本机服务地址。');
  return info;
}

async function hub(route, method = 'GET', body) {
  const response = await fetch(runtime.url + route, {
    method, headers: { 'Content-Type': 'application/json', 'x-agent-phone-token': runtime.token },
    ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(2000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`本机工作台返回 ${response.status}。`);
  return result;
}

async function cancelRequest() {
  if (runtime && requestId) try { await hub('/api/requests/' + encodeURIComponent(requestId) + '/cancel', 'POST', {}); } catch {}
}

async function waitForResponse(event) {
  runtime = readRuntime();
  const result = await hub('/api/hooks', 'POST', {
    ...event, agent, event:'attention', kind:mode === 'permission' ? 'approval' : 'input', blocking:true,
    request_id:event.request_id || randomUUID(), title:event.title || `${label} ${mode === 'permission' ? '请求批准' : '需要你的回复'}`,
    description:eventDescription(event),
    options:mode === 'permission' ? [{id:'allow',label:'批准本次操作'},{id:'deny',label:'拒绝本次操作'}] : event.options || event.choices || [],
  });
  if (result.managed) return null;
  if (typeof result.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.requestId)) throw new Error('本机工作台没有创建有效请求。');
  requestId = result.requestId;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const request = await hub('/api/requests/' + encodeURIComponent(requestId));
    if (request.status === 'answered') {
      if (!request.response || request.response.cancelled) throw new Error('请求已取消。');
      return request.response;
    }
    if (!['pending','responding'].includes(request.status)) throw new Error('请求已取消或失效。');
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error('等待手机回复超时，本次操作已拒绝。');
}

function permissionOutput(allow, reason) {
  if (agent === 'cursor') return { permission:allow ? 'allow' : 'deny', user_message:reason, agent_message:reason };
  const decision = allow ? {behavior:'allow'} : {behavior:'deny',message:reason};
  // Both native PermissionRequest Hook protocols accept this shape. Do not
  // persist a permission rule or rewrite the original command.
  if (agent === 'codex' || agent === 'claude') return {hookSpecificOutput:{hookEventName:'PermissionRequest',decision}};
  return {decision};
}

async function notify(event) {
  if (agent !== 'test') {
    try {
      runtime = readRuntime();
      const result = await hub('/api/hooks','POST',{...event,agent,...(mode === 'attention' ? {event:'attention',blocking:false,description:eventDescription(event)} : {event:'completed'})});
      if (result.accepted || result.managed || result.duplicate) return;
      throw new Error('本机工作台未接受通知。');
    } catch { /* Advisory notices can fall back to the user's Feishu binding. */ }
  }
  const provider = readProvider();
  const access = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:provider.appId,app_secret:provider.appSecret});
  const delivered = await postJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id:provider.recipient,msg_type:'text',content:JSON.stringify({text:messageFromEvent(event)}),
  },access.tenant_access_token);
  try {
    fs.mkdirSync(locations.dataDir,{recursive:true});
    fs.appendFileSync(path.join(locations.dataDir,'notifications.jsonl'),JSON.stringify({ts:new Date().toISOString(),agent,event:mode,sessionId:event.session_id || event.thread_id || event.conversation_id || null,messageId:delivered.data?.message_id || null})+'\n');
  } catch {}
}

async function main() {
  if (process.env.AGENT_PHONE_MANAGED === '1') return {};
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input)>1024*1024) throw new Error('Hook 输入超过 1 MB。'); }
  const event = input.trim() ? JSON.parse(input.replace(/^\uFEFF/,'')) : {};
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Hook 输入必须是 JSON 对象。');
  mode ||= ['PermissionRequest','beforeShellExecution','beforeMCPExecution'].includes(event.hook_event_name) ? 'permission' : event.hook_event_name === 'Notification' || event.event === 'attention' ? 'attention' : 'completion';
  if (!['completion','attention','permission','input'].includes(mode)) throw new Error('不支持的 Hook 模式。');
  event.cwd ||= event.workspace_roots?.[0];
  if (event.hook_event_name === 'StopFailure') event.status = 'error';
  if (event.status === 'aborted') return mode === 'permission' ? permissionOutput(false,'任务已中止。') : {};
  prepareLocations();
  if (mode === 'permission' || mode === 'input') {
    const response = await waitForResponse(event);
    if (response === null) return {}; // A managed Agent has its own live request handler.
    if (mode === 'input') return {response};
    return permissionOutput(response.optionId === 'allow','手机已' + (response.optionId === 'allow' ? '批准' : '拒绝') + '本次操作。');
  }
  await notify(event); return {};
}

main().then(output => process.stdout.write(JSON.stringify(output)+'\n')).catch(async error => {
  process.stderr.write(`Agent Phone: ${error.message}\n`);
  await cancelRequest();
  const output = mode === 'permission' ? permissionOutput(false,error.message) : mode === 'input' ? {response:{cancelled:true,text:''},error:error.message} : {};
  process.stdout.write(JSON.stringify(output)+'\n');
  // Permission hooks must exit successfully with an explicit deny; a nonzero
  // status can make an Agent ignore the hook's decision and allow the action.
  if (process.env.AGENT_PHONE_STRICT === '1' && !['permission','input'].includes(mode)) process.exitCode=1;
});
