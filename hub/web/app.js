'use strict';

const $ = id => document.getElementById(id);
const el = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
const statusNames = { idle: '待开始', unknown: '已有会话', running: '运行中', waiting: '待你操作', ready: '可继续', done: '已完成', error: '失败', interrupted: '已中断', stopped: '已停止' };
const safeStatus = status => Object.hasOwn(statusNames, status) ? status : status ? 'unknown' : 'idle';
let data = { agents: [], projects: [], sessions: [], notifications: [], requests: [], connection: {}, setup: {} };
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('agent-phone-selection') || '{}'); } catch {}
let agentId = preferences.agentId || 'codex-desktop';
let projectId = preferences.projectId || null;
let sessionId = preferences.sessionId || null;
let activeSession = null;
let busy = false;
let polling = false;
let initial = true;
let detailRevision = 0;
let chatSignature = '';
let listSignatures = {};
const drafts = new Map();
let draft = { prompt: '', files: [] };
let toastTimer;
let picker = null;
let browseRevision = 0;
let agentExecutable = '';
let agentEndpoint = null;
let discoveredAgents = [];
let discoverRevision = 0;
let agentSaving = false;
let pairingBusy = false;
let localPairing = null;
let setupOpened = false;
let hookStatuses = [];
let hooksBusy = false;
let hookStatusLoading = false;
let hookLoadRevision = 0;
let hookStatusError = '';
const requestDrafts = new Map();
const requestBusy = new Set();

async function api(url, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(url, method === 'GET' ? { cache: 'no-store' } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败，请重试。');
  return value;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 7000 : 4000);
}

function handle(action) {
  return async event => {
    if (event) event.preventDefault();
    try { await action(event); } catch (error) { toast(error.message || '操作失败，请重试。', true); }
  };
}

function shortPath(file) { return String(file || '').split(/[\\/]/).filter(Boolean).at(-1) || file; }
function clock(ts) {
  const time = new Date(ts);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function relativeTime(ts) {
  const time = new Date(ts), elapsed = Date.now() - time.getTime();
  if (Number.isNaN(elapsed)) return '';
  if (elapsed < 60000) return '刚刚';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
  return time.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function currentAgent() { return data.agents.find(a => a.id === agentId); }
function agentAvailable(agent) {
  if (!agent) return false;
  return agent.enabled !== false && agent.available !== false && agent.availability !== false && agent.availability?.available !== false && !['missing', 'unavailable'].includes(agent.availability?.status || agent.availability);
}
function agentAvailabilityText(agent) { return !agent ? '正在读取 Agent 配置…' : agent.enabled === false ? '已停用' : agent.availability?.reason || agent.availability?.message || (typeof agent.availability === 'string' && !['ready', 'available', 'missing', 'unavailable'].includes(agent.availability) ? agent.availability : '') || agent.unavailableReason || '这台电脑上未找到程序，请添加或重新选择程序文件。'; }
function canInput(agent) { return agent?.capabilities?.input === true || ['terminal', 'line-json', 'dsh'].includes(agent?.kind); }
function pendingRequests() { return (data.requests || []).filter(r => r.status === 'pending'); }
function currentProject() { return data.projects.find(p => p.id === projectId); }
function matchingSessions() { return data.sessions.filter(s => s.agentId === agentId && s.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt); }
function draftKey() { return sessionId || `${agentId}:${projectId || 'none'}`; }
function remember() {
  try { localStorage.setItem('agent-phone-selection', JSON.stringify({ agentId, projectId, sessionId })); } catch {}
}
function saveDraft() {
  draft.prompt = $('task-input').value;
  drafts.set(draftKey(), { prompt: draft.prompt, files: [...draft.files] });
}
function restoreDraft() {
  const saved = drafts.get(draftKey());
  draft = saved ? { prompt: saved.prompt, files: [...saved.files] } : { prompt: '', files: [] };
  $('task-input').value = draft.prompt;
  renderAttachments();
}
function invalidateLists() { listSignatures = {}; }

function renderAgents() {
  const signature = JSON.stringify([data.agents, agentId]);
  if (listSignatures.agents === signature) return;
  listSignatures.agents = signature;
  $('agent-list').replaceChildren(...data.agents.map(agent => {
    const available = agentAvailable(agent);
    const button = el('button', `agent-card${agent.id === agentId ? ' selected' : ''}${available ? '' : ' unavailable'}`);
    button.type = 'button'; button.dataset.agent = agent.id; button.setAttribute('aria-pressed', String(agent.id === agentId));
    const copy = el('span', 'agent-copy');
    copy.append(el('strong', '', agent.name), el('small', '', available ? agent.description || '电脑与飞书共用的 Agent' : agentAvailabilityText(agent)));
    button.append(el('span', 'agent-avatar', agent.short || agent.name?.slice(0, 2) || 'AI'), copy, el('span', 'agent-check', '✓'));
    button.addEventListener('click', handle(() => selectContext(agent.id, projectId)));
    return button;
  }));
  $('agent-summary').textContent = `${data.agents.length} 个 Agent · 选择任务执行程序`;
  renderRegisteredAgents();
}

function renderProjects() {
  const query = $('project-search').value.trim().toLocaleLowerCase();
  const signature = JSON.stringify([data.projects, projectId, query]);
  if (listSignatures.projects === signature) return;
  listSignatures.projects = signature;
  const projects = data.projects.filter(p => p.name.toLocaleLowerCase().includes(query) || p.path.toLocaleLowerCase().includes(query));
  $('project-list').replaceChildren(...projects.map(project => {
    const button = el('button', `project-button${project.id === projectId ? ' selected' : ''}`);
    button.type = 'button'; button.title = project.path; button.setAttribute('aria-current', project.id === projectId ? 'true' : 'false');
    const copy = el('span', 'project-copy'); copy.append(el('span', 'project-name', project.name), el('span', 'project-path', project.path));
    button.append(el('span', 'project-symbol', '▱'), copy);
    button.addEventListener('click', handle(() => selectContext(agentId, project.id)));
    return button;
  }));
  if (!projects.length) $('project-list').append(el('div', 'empty-list', query ? '没有匹配的项目' : '点击 ＋ 选择项目文件夹'));
}

function renderSessions() {
  const sessions = matchingSessions();
  $('session-count').textContent = currentProject() ? `${sessions.length} 个会话 · ${currentProject().name}` : '请选择项目';
  const signature = JSON.stringify([sessions.map(s => [s.id, s.title, s.status, s.updatedAt, s.source]), sessionId, projectId, agentId]);
  if (listSignatures.sessions === signature) return;
  listSignatures.sessions = signature;
  $('session-list').replaceChildren(...sessions.map(session => {
    const button = el('button', `session-button${session.id === sessionId ? ' selected' : ''}`);
    button.type = 'button'; button.title = `${session.title || '新任务'}\n${session.source === 'external' ? '电脑上已有的会话' : '工作台创建的会话'}`;
    if (session.id === sessionId) button.setAttribute('aria-current', 'true');
    const status = safeStatus(session.status);
    const meta = el('span', 'session-meta');
    meta.append(el('span', `session-status ${status}`, statusNames[status]), el('span', '', relativeTime(session.updatedAt)));
    button.append(el('span', 'session-title', session.title || '新任务'), meta);
    button.addEventListener('click', handle(() => selectSession(session.id)));
    return button;
  }));
  if (!sessions.length) $('session-list').append(el('div', 'empty-list', currentProject() ? '暂无会话\n发送任务或点击 ＋ 新建' : '先选择项目文件夹'));
}

function renderConnection() {
  const connection = data.connection || {};
  const configured = data.setup?.configured !== false;
  $('connection-dot').className = `connection-dot ${connection.connected ? 'online' : connection.error ? 'offline' : ''}`;
  $('connection-label').textContent = connection.connected ? '飞书机器人已连接' : !configured ? '连接你的手机飞书' : connection.error ? '飞书连接待恢复' : '正在连接飞书';
  $('connection-detail').textContent = !configured ? '点击“飞书设置”完成绑定' : connection.error || connection.botName || '统一入口 · 选择 Agent 和项目';
  $('phone-menu').disabled = busy || !connection.connected;
  const signature = JSON.stringify(data.notifications?.slice(0, 3));
  if (listSignatures.notifications !== signature) {
    listSignatures.notifications = signature;
    $('notification-list').replaceChildren(...(data.notifications || []).slice(0, 3).map(notification => {
      const item = el('div', 'notification-item'), copy = el('div', 'notification-copy');
      copy.append(el('strong', '', notification.title || '任务完成'), el('small', '', relativeTime(notification.ts)));
      item.append(el('span', 'notification-indicator'), copy); return item;
    }));
    if (!data.notifications?.length) $('notification-list').append(el('div', 'small-label', '完成与待操作通知会出现在这里'));
  }
  renderSetup();
}

function renderRequests() {
  const requests = pendingRequests();
  $('attention-section').classList.toggle('hidden', !requests.length);
  $('attention-title').textContent = `等待你的操作 · ${requests.length} 项`;
  const signature = JSON.stringify([requests, [...requestBusy]]);
  if (listSignatures.requests === signature) return;
  listSignatures.requests = signature;
  $('request-list').replaceChildren(...requests.map(request => {
    const card = el('article', 'request-card');
    const session = data.sessions.find(s => s.id === request.sessionId);
    const heading = el('div', 'request-heading');
    heading.append(el('strong', '', request.title || 'Agent 需要你的操作'));
    if (session) {
      const view = el('button', 'text-button', `${data.agents.find(a => a.id === session.agentId)?.name || 'Agent'} · 查看会话 →`);
      view.type = 'button';
      view.addEventListener('click', handle(async () => { await selectContext(session.agentId, session.projectId); await selectSession(session.id); }));
      heading.append(view);
    }
    card.append(heading);
    if (request.description) card.append(el('p', 'request-description', request.description));
    if (request.options?.length) {
      const options = el('div', 'request-options');
      for (const option of request.options) {
        const button = el('button', 'button', option.label || option.id);
        button.type = 'button'; button.disabled = requestBusy.has(request.id);
        button.addEventListener('click', handle(() => respondRequest(request.id, { optionId: option.id })));
        options.append(button);
      }
      card.append(options);
    }
    if (request.kind === 'approval' && request.options?.length) {
      card.append(el('p', 'field-help', '请点选上方操作，确认你的决定。'));
      return card;
    }
    const form = el('form', 'request-form');
    const input = el('input'); input.type = 'text'; input.placeholder = request.options?.length ? '或输入其他回应…' : '输入你的回应…';
    input.setAttribute('aria-label', `回应：${request.title || 'Agent 请求'}`); input.value = requestDrafts.get(request.id) || ''; input.disabled = requestBusy.has(request.id);
    input.addEventListener('input', () => requestDrafts.set(request.id, input.value));
    const send = el('button', 'button primary', requestBusy.has(request.id) ? '发送中…' : '发送回应'); send.type = 'submit'; send.disabled = requestBusy.has(request.id);
    form.append(input, send);
    form.addEventListener('submit', handle(async () => { const text = input.value.trim(); if (!text) { input.focus(); return; } await respondRequest(request.id, { text }); }));
    card.append(form); return card;
  }));
}

async function respondRequest(id, response) {
  if (requestBusy.has(id)) return;
  requestBusy.add(id); renderRequests();
  try { await api(`/api/requests/${encodeURIComponent(id)}/respond`, response); requestDrafts.delete(id); await refresh(); toast('回应已交给 Agent'); }
  finally { requestBusy.delete(id); renderRequests(); }
}

function messageNode(message, live = false) {
  const role = message.role === 'user' ? 'user' : message.role === 'error' ? 'error' : 'assistant';
  const row = el('article', `message ${role}${live ? ' live' : ''}`);
  const copy = el('div', 'message-content');
  const heading = el('div', 'message-heading', role === 'user' ? '你' : role === 'error' ? '任务提示' : currentAgent()?.name || 'Agent');
  if (message.ts && !Number.isNaN(new Date(message.ts).getTime())) { const time = el('time', '', clock(message.ts)); time.dateTime = new Date(message.ts).toISOString(); heading.append(time); }
  copy.append(heading, el('p', 'message-text', message.text || (live ? '正在处理任务…' : '')));
  if (message.files?.length) {
    const files = el('div', 'message-files');
    for (const file of message.files) { const chip = el('span', 'message-file', `▤ ${shortPath(file)}`); chip.title = file; files.append(chip); }
    copy.append(files);
  }
  row.append(el('span', 'message-avatar', role === 'user' ? '你' : role === 'error' ? '!' : currentAgent()?.short || 'AI'), copy);
  return row;
}

function welcomeNode() {
  const container = el('div', 'welcome-state');
  container.append(el('span', 'welcome-icon', '✳'), el('h3', '', currentProject() ? `交给 ${currentAgent()?.name || 'Agent'} 来做` : '选择项目，开始协作'));
  container.append(el('p', '', currentProject() ? '输入任务，或选择一个已有会话继续对话。\n完成后，结果会同步到手机飞书。' : '在电脑上管理任务，在飞书里查看结果和继续对话。\n目录和附件都通过选择器添加。'));
  if (!currentProject()) { const button = el('button', 'button primary', '选择项目文件夹'); button.type = 'button'; button.addEventListener('click', handle(() => openPicker('folder'))); container.append(button); }
  return container;
}

function renderChat(force = false) {
  const session = activeSession?.id === sessionId ? activeSession : data.sessions.find(s => s.id === sessionId);
  const status = safeStatus(session?.status);
  $('chat-title').textContent = session?.title || (currentProject() ? '新任务' : '开始一个任务');
  $('chat-path').textContent = currentProject()?.path || '先选择左侧项目，再选择 Agent';
  $('chat-path').title = currentProject()?.path || '';
  $('chat-status').textContent = statusNames[status]; $('chat-status').className = `status-pill ${status}`;
  const messages = session?.messages || [];
  const signature = JSON.stringify([sessionId, agentId, projectId, messages, session?.liveText, session?.error, status]);
  if (force || signature !== chatSignature) {
    const area = $('chat-messages');
    const bottom = force || !chatSignature || area.scrollHeight - area.scrollTop - area.clientHeight < 90;
    const oldTop = area.scrollTop;
    chatSignature = signature;
    const nodes = messages.map(message => messageNode(message));
    if (['running', 'waiting', 'ready'].includes(status) && session?.managedRunning) nodes.push(messageNode({ role: 'assistant', text: session?.liveText || (status === 'waiting' ? '等待你的操作，请回应上方请求。' : status === 'ready' ? 'Agent 已准备好，发送下一步指令继续。' : '正在处理任务…') }, status === 'running'));
    else if (status === 'running') nodes.push(messageNode({ role: 'assistant', text: session?.liveText || '正在处理任务…' }, true));
    if (session?.error) nodes.push(messageNode({ role: 'error', text: session.error }));
    area.replaceChildren(...(nodes.length ? nodes : [welcomeNode()]));
    if (bottom) area.scrollTop = area.scrollHeight; else area.scrollTop = oldTop;
  }
  renderControls();
}

function renderControls() {
  const session = activeSession?.id === sessionId ? activeSession : data.sessions.find(s => s.id === sessionId);
  const running = ['running', 'waiting', 'ready'].includes(session?.status);
  const managedRunning = running && session?.managedRunning === true;
  const interactive = managedRunning && canInput(currentAgent());
  const awaitingApproval = pendingRequests().some(r => r.sessionId === session?.id && r.kind === 'approval' && r.options?.length);
  const hook = currentAgent()?.kind === 'hook';
  $('new-session').disabled = busy || !currentProject() || hook || !agentAvailable(currentAgent());
  $('send-task').disabled = busy || awaitingApproval || running && !interactive || !currentProject() || !$('task-input').value.trim() || hook || !agentAvailable(currentAgent());
  $('send-task').firstChild.textContent = busy ? '正在发送 ' : interactive ? '发送输入 ' : '发送任务 ';
  $('stop-task').classList.toggle('hidden', !managedRunning);
  $('stop-task').disabled = busy;
  $('composer-note').textContent = !agentAvailable(currentAgent()) ? agentAvailabilityText(currentAgent()) : awaitingApproval ? '当前任务在等待批准，请使用上方操作卡片作出决定。' : hook ? '此 Agent 接收外部任务事件。发起与继续任务需要对应的控制适配。' : interactive ? '输入会发送到当前 Agent 进程；需要确认时，也可使用上方操作卡片。' : running && !managedRunning ? '此会话正在原应用中运行，完成后可继续；如需停止请到原应用操作。' : '任务完成、出错或需要你操作时，会发送到手机飞书。电脑需要保持运行。';
  $('refresh-button').disabled = busy;
  $('attach-files').disabled = busy || !currentProject();
  $('phone-menu').disabled = busy || !data.connection?.connected;
}

function renderAttachments() {
  $('attachment-list').replaceChildren(...draft.files.map(file => {
    const chip = el('span', 'attachment-chip'), name = el('span', 'attachment-name', `▤ ${shortPath(file)}`);
    name.title = file; const remove = el('button', 'attachment-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${shortPath(file)}`);
    remove.addEventListener('click', () => { draft.files = draft.files.filter(p => p !== file); saveDraft(); renderAttachments(); });
    chip.append(name, remove); return chip;
  }));
}

function renderAll(forceChat = false) { renderAgents(); renderProjects(); renderSessions(); renderConnection(); renderRequests(); renderChat(forceChat); }

async function loadDetail(id = sessionId, force = false) {
  if (!id) { activeSession = null; renderChat(force); return; }
  const revision = ++detailRevision;
  const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if (revision !== detailRevision || id !== sessionId) return;
  activeSession = session; renderChat(force);
}

async function selectContext(nextAgent, nextProject) {
  if (busy || nextAgent === agentId && nextProject === projectId) return;
  saveDraft(); agentId = nextAgent; projectId = nextProject;
  sessionId = matchingSessions()[0]?.id || null; activeSession = null; chatSignature = ''; detailRevision++;
  restoreDraft(); remember(); renderAll(true); await loadDetail(sessionId, true);
}

async function selectSession(id) {
  if (busy || id === sessionId) return;
  saveDraft(); sessionId = id; activeSession = null; chatSignature = ''; detailRevision++;
  restoreDraft(); remember(); renderSessions(); renderChat(true); await loadDetail(id, true);
}

function absorbState(value) {
  data = { agents: [], projects: [], sessions: [], notifications: [], requests: [], connection: {}, setup: {}, ...value };
  if (!data.agents.some(a => a.id === agentId)) agentId = data.agents[0]?.id || null;
  if (!data.projects.some(p => p.id === projectId)) projectId = data.projects[0]?.id || null;
  if (sessionId && !data.sessions.some(s => s.id === sessionId && s.agentId === agentId && s.projectId === projectId)) {
    saveDraft(); sessionId = null; activeSession = null; detailRevision++; restoreDraft();
  }
  if (initial) { sessionId ||= matchingSessions()[0]?.id || null; restoreDraft(); initial = false; }
  remember(); renderAll();
  if (data.setup?.configured === false && !setupOpened) { setupOpened = true; openSetup(); }
  $('last-sync').textContent = `最近同步 ${clock(Date.now())}`;
}

async function refresh(force = false) {
  if (polling) return false;
  polling = true;
  try {
    absorbState(await api(force ? '/api/refresh' : '/api/state', force ? {} : undefined));
    await loadDetail();
    return true;
  } catch (error) {
    $('last-sync').textContent = '服务连接中断';
    $('connection-label').textContent = '本机服务未连接';
    $('connection-detail').textContent = error.message;
    $('connection-dot').className = 'connection-dot offline';
    if (force || initial) toast('无法连接本机工作台，请检查程序是否运行。', true);
    return false;
  } finally { polling = false; }
}

async function createSession(carryDraft = false) {
  if (!currentProject()) throw new Error('请先选择项目文件夹。');
  saveDraft(); const previousDraft = { prompt: draft.prompt, files: [...draft.files] };
  const session = await api('/api/sessions', { agentId, projectId });
  sessionId = session.id; activeSession = session; data.sessions.unshift(session); detailRevision++;
  if (carryDraft) drafts.set(draftKey(), previousDraft);
  restoreDraft(); remember(); renderAll(true); return session;
}

async function submitTask() {
  if (busy) return;
  const prompt = $('task-input').value.trim();
  if (!prompt) return;
  const current = activeSession || data.sessions.find(s => s.id === sessionId);
  const running = ['running', 'waiting', 'ready'].includes(current?.status);
  const interactive = running && current?.managedRunning && canInput(currentAgent());
  if (pendingRequests().some(r => r.sessionId === current?.id && r.kind === 'approval' && r.options?.length)) {
    toast('请在待操作卡片中选择允许或拒绝。', true);
    return;
  }
  if (running && !interactive || currentAgent()?.kind === 'hook' || !agentAvailable(currentAgent())) return;
  busy = true; renderControls();
  try {
    if (!sessionId) await createSession(true);
    const inputText = draft.files.length ? `${prompt}\n\n附件文件：\n${draft.files.join('\n')}` : prompt;
    const session = await api(`/api/sessions/${encodeURIComponent(sessionId)}/${interactive ? 'input' : 'run'}`, interactive ? { text: inputText } : { prompt, files: draft.files });
    if (session?.id) activeSession = session;
    draft = { prompt: '', files: [] }; drafts.delete(draftKey()); $('task-input').value = ''; renderAttachments();
    await refresh(); renderChat(true);
  } finally { busy = false; renderControls(); }
}

function addAttachments(paths) {
  const files = [...new Set([...draft.files, ...paths])];
  if (files.length > 20) throw new Error('一次最多选择 20 个文件，请减少选择。');
  draft.files = files; saveDraft(); renderAttachments();
}

async function openPicker(kind) {
  picker = { kind, path: null, parent: null, offset: 0, total: 0, entries: [], selected: new Set(), busy: false };
  $('picker-title').textContent = kind === 'folder' ? '选择项目文件夹' : kind === 'executable' ? '选择 Agent 程序' : '选择任务文件';
  $('native-picker').textContent = kind === 'folder' ? '打开系统文件夹选择器' : '打开系统文件选择器';
  $('picker-help').textContent = kind === 'folder' ? '进入文件夹后，点击“选择此文件夹”。' : kind === 'executable' ? '选择已安装 Agent 的程序文件，如 .exe、.cmd 或脚本。' : '点击文件勾选；点击文件夹进入。最多 20 个文件。';
  $('picker-dialog').showModal();
  await browseTo(kind === 'files' ? currentProject()?.path || null : null);
}

async function browseTo(directory, offset = 0) {
  if (!picker) return;
  const revision = ++browseRevision;
  $('browser-entries').replaceChildren(el('div', 'empty-list', '正在读取目录…'));
  $('picker-confirm').disabled = true;
  const query = new URLSearchParams({ offset: String(offset), files: String(picker.kind !== 'folder') });
  if (directory) query.set('path', directory);
  const result = await api(`/api/browse?${query}`);
  if (!picker || revision !== browseRevision) return;
  Object.assign(picker, result); renderBrowser();
}

function renderBrowser() {
  if (!picker) return;
  $('browser-path').textContent = picker.path || '常用目录'; $('browser-path').title = picker.path || '';
  $('browser-up').disabled = !picker.path || picker.busy;
  $('browser-home').disabled = picker.busy;
  $('native-picker').disabled = picker.busy;
  $('browser-entries').replaceChildren(...picker.entries.map(entry => {
    const directory = entry.kind === 'directory';
    const button = el('button', `browser-entry${picker.selected.has(entry.path) ? ' selected' : ''}`); button.type = 'button'; button.title = entry.path; button.disabled = picker.busy;
    if (!directory) button.setAttribute('aria-pressed', String(picker.selected.has(entry.path)));
    button.append(el('span', 'browser-entry-icon', directory ? '▱' : '▤'), el('span', 'browser-entry-name', entry.name), el('span', 'browser-entry-tail', directory ? '›' : picker.selected.has(entry.path) ? '✓' : ''));
    button.addEventListener('click', handle(async () => {
      if (directory) return browseTo(entry.path);
      if (picker.selected.has(entry.path)) picker.selected.delete(entry.path);
      else { if (picker.kind === 'executable') picker.selected.clear(); else if (!draft.files.includes(entry.path) && picker.selected.size + draft.files.filter(f => !picker.selected.has(f)).length >= 20) throw new Error('一次最多选择 20 个文件。'); picker.selected.add(entry.path); }
      renderBrowser();
    }));
    return button;
  }));
  if (!picker.entries.length) $('browser-entries').append(el('div', 'empty-list', '这个目录中没有可选择的内容'));
  $('browser-prev').disabled = picker.busy || picker.offset === 0;
  $('browser-next').disabled = picker.busy || picker.offset + picker.entries.length >= picker.total;
  $('browser-page').textContent = picker.total ? `${picker.offset + 1}–${Math.min(picker.offset + picker.entries.length, picker.total)} / ${picker.total}` : '0 项';
  $('picker-selection').replaceChildren(...[...picker.selected].map(file => { const chip = el('span', 'attachment-chip', shortPath(file)); chip.title = file; return chip; }));
  $('picker-confirm').textContent = picker.kind === 'folder' ? '选择此文件夹' : picker.kind === 'executable' ? '选择此程序' : `添加所选文件${picker.selected.size ? ` (${picker.selected.size})` : ''}`;
  $('picker-confirm').disabled = picker.busy || (picker.kind === 'folder' ? !picker.path : !picker.selected.size);
}

function closePicker() { browseRevision++; picker = null; $('picker-dialog').close(); }

async function acceptProject(directory) {
  const project = await api('/api/projects', { path: directory });
  if (!data.projects.some(p => p.id === project.id)) data.projects.push(project);
  closePicker(); await selectContext(agentId, project.id); invalidateLists(); renderAll(); toast(`已选择项目：${project.name}`);
}

async function useNativePicker() {
  const opened = picker;
  if (!opened || opened.busy) return;
  opened.busy = true; renderBrowser(); $('native-picker').textContent = '请在系统选择器中选择…';
  try {
    const paths = await nativePaths(opened.kind);
    if (picker !== opened || !paths?.length) return;
    if (opened.kind === 'folder') await acceptProject(paths[0]);
    else if (opened.kind === 'executable') { setExecutable(paths[0]); closePicker(); }
    else { addAttachments(paths); closePicker(); toast(`已添加 ${paths.length} 个文件`); }
  } finally {
    if (picker === opened) { opened.busy = false; $('native-picker').textContent = opened.kind === 'folder' ? '打开系统文件夹选择器' : '打开系统文件选择器'; renderBrowser(); }
  }
}

async function nativePaths(kind) {
  const result = window.agentPhoneDesktop?.pick ? await window.agentPhoneDesktop.pick(kind) : await api('/api/picker', { kind });
  return Array.isArray(result) ? result : result?.paths || [];
}

function setExecutable(file) {
  agentExecutable = file || '';
  $('agent-executable').textContent = agentExecutable || '尚未选择程序';
  $('agent-executable').title = agentExecutable;
}

const kindDescriptions = {
  terminal: '通过工作台启动命令行程序，发送任务与输入。程序退出时通知完成；持续运行的程序可配置识别提示。',
  dsh: '连接 DSH Desktop 的本机接口，在电脑与飞书之间继续对话，接收完成、审批和问题通知。请在 DSH 开启仅本机的浏览器访问。',
  'line-json': '程序按每行一个 JSON 输出任务事件，能准确区分完成、待操作与普通输出。',
  hook: '接收 Agent 主动发送的完成与待操作通知；控制下一步需要该 Agent 接入回应接口。'
};

function renderAgentKind() {
  const kind = $('agent-kind').value;
  $('agent-kind-description').textContent = kindDescriptions[kind] || kindDescriptions.terminal;
  $('agent-program-fields').classList.toggle('hidden', kind === 'hook');
  $('agent-hook-help').classList.toggle('hidden', kind !== 'hook');
}

async function openAgentDialog() {
  $('agent-dialog').showModal();
  renderRegisteredAgents(); renderAgentKind();
  if (!discoveredAgents.length) await discoverAgents();
}

async function discoverAgents() {
  const revision = ++discoverRevision;
  $('discover-agents').disabled = true;
  $('discovered-agents').replaceChildren(el('p', 'field-help', '正在查找这台电脑上的 Agent…'));
  try {
    const result = await api('/api/agents/discover');
    if (revision !== discoverRevision) return;
    discoveredAgents = result.agents || []; renderDiscoveredAgents();
  } finally { if (revision === discoverRevision) $('discover-agents').disabled = false; }
}

function renderDiscoveredAgents() {
  $('discovered-agents').replaceChildren(...discoveredAgents.map(agent => {
    const available = agentAvailable(agent);
    const card = el('button', 'discovered-agent'); card.type = 'button'; card.disabled = !available;
    const copy = el('span', 'discovered-copy');
    copy.append(el('strong', '', agent.name || 'Agent'), el('small', '', available ? agent.description || shortPath(agent.executable) : agentAvailabilityText(agent)));
    card.append(copy, el('span', 'discovered-tail', available ? '选择 →' : '未安装'));
    card.addEventListener('click', () => {
      $('agent-name').value = agent.name || '';
      $('agent-kind').value = Object.hasOwn(kindDescriptions, agent.kind) ? agent.kind : 'terminal';
      $('agent-args').value = (agent.args || []).join('\n');
      $('agent-completion-pattern').value = agent.completionPattern || agent.completionMarker || '';
      $('agent-attention-pattern').value = agent.attentionPattern || agent.attentionMarker || '';
      agentEndpoint = agent.endpoint || null;
      setExecutable(agent.executable || agent.command); renderAgentKind();
      $('agent-form-note').textContent = `已选择 ${agent.name || 'Agent'}，确认接入方式后添加。`;
      $('agent-name').focus();
    });
    return card;
  }));
  if (!discoveredAgents.length) $('discovered-agents').append(el('p', 'field-help', '没有自动发现其他程序。可以在下方选择已安装的程序文件。'));
}

function renderRegisteredAgents() {
  const custom = data.agents.filter(a => a.custom || a.builtin === false || ['terminal', 'line-json', 'hook', 'dsh'].includes(a.kind));
  $('registered-section').classList.toggle('hidden', !custom.length);
  $('registered-agents').replaceChildren(...custom.map(agent => {
    const row = el('div', 'registered-agent');
    const copy = el('div'); copy.append(el('strong', '', agent.name), el('small', '', agent.kind === 'hook' ? '外部通知接入' : agent.executable || agent.description || '自定义 Agent'));
    const remove = el('button', 'text-button', '移除'); remove.type = 'button';
    remove.addEventListener('click', handle(async () => {
      if (!window.confirm(`从工作台移除“${agent.name}”？电脑上的程序仍会保留。`)) return;
      remove.disabled = true;
      try { await api(`/api/agents/${encodeURIComponent(agent.id)}`, {}, 'DELETE'); await refresh(); toast('Agent 已移除'); }
      finally { remove.disabled = false; }
    }));
    row.append(copy, remove); return row;
  }));
}

async function saveAgent() {
  if (agentSaving) return;
  const name = $('agent-name').value.trim(); const kind = $('agent-kind').value;
  if (!name) { $('agent-name').focus(); return; }
  if (kind !== 'hook' && !agentExecutable) throw new Error('请选择 Agent 的程序文件。');
  const completionPattern = $('agent-completion-pattern').value.trim();
  const attentionPattern = $('agent-attention-pattern').value.trim();
  agentSaving = true; $('save-agent').disabled = true; $('save-agent').textContent = '正在添加…';
  try {
    const created = await api('/api/agents', { name, kind, executable: kind === 'hook' ? '' : agentExecutable, command: kind === 'hook' ? undefined : agentExecutable, endpoint: kind === 'dsh' ? agentEndpoint || 'http://127.0.0.1:43120' : undefined, args: $('agent-args').value.split(/\r?\n/).map(a => a.trim()).filter(Boolean), completionPattern: completionPattern || undefined, attentionPattern: attentionPattern || undefined, completionMarker: completionPattern || undefined, attentionMarker: attentionPattern || undefined, completionMode: kind === 'line-json' || kind === 'dsh' ? 'json' : completionPattern ? 'marker' : 'exit', inputMode: kind === 'line-json' || kind === 'dsh' ? 'json' : 'line' });
    $('agent-form').reset(); agentEndpoint = null; setExecutable(''); renderAgentKind();
    $('agent-form-note').textContent = '添加后即可在工作台和飞书菜单中选择。';
    await refresh();
    const added = created.agent || created;
    if (added.id) await selectContext(added.id, projectId);
    $('agent-dialog').close(); toast(`已添加 ${name}，手机菜单也已更新`);
  } finally { agentSaving = false; $('save-agent').disabled = false; $('save-agent').textContent = '添加 Agent'; }
}

function safeImageUrl(value) { return typeof value === 'string' && (value.startsWith('data:image/') || value.startsWith('/')) ? value : ''; }
function safePairingUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'open.feishu.cn' || url.hostname === 'open.larksuite.com') ? url.href : ''; } catch { return ''; } }

function renderSetup() {
  const setup = data.setup || {}; const connection = data.connection || {};
  const configured = setup.configured === true || setup.configured !== false && connection.connected;
  const status = $('setup-status'); status.className = `setup-status ${connection.connected ? 'connected' : ''}`;
  status.replaceChildren(el('strong', '', connection.connected ? '飞书已连接' : configured ? '机器人已绑定，正在连接' : '尚未绑定飞书机器人'), el('p', '', connection.connected ? '任务完成与待操作消息将发送到你的飞书。' : connection.error || (configured ? '程序会自动重试连接。' : '首次使用，请绑定你自己的飞书账号。')));
  $('connected-actions').classList.toggle('hidden', !configured);
  $('setup-send-menu').disabled = !connection.connected;
  $('begin-pairing').textContent = pairingBusy ? '正在生成绑定链接…' : configured ? '重新绑定机器人' : '绑定飞书机器人';
  $('begin-pairing').disabled = pairingBusy;
  const pairing = setup.pairing || localPairing;
  const showPairing = pairing && !['complete', 'completed', 'bound', 'success', 'idle'].includes(pairing.status);
  $('pairing-details').classList.toggle('hidden', !showPairing);
  if (!showPairing) { if (configured) localPairing = null; return; }
  const states = { starting: '正在生成绑定链接…', pending: '请用手机飞书扫码，或打开链接完成绑定。', waiting: '等待你在手机飞书完成绑定…', polling: '等待你在手机飞书完成绑定…', expired: '绑定链接已过期，请重新生成。', failed: '绑定未完成，请重试。', error: '绑定遇到问题，请重试。' };
  $('pairing-state').textContent = pairing.error || states[pairing.status] || '请用手机飞书扫码，或打开链接完成绑定。';
  const qr = safeImageUrl(pairing.qrUrl || pairing.qrDataUrl);
  $('pairing-qr').classList.toggle('hidden', !qr); if (qr) $('pairing-qr').src = qr; else $('pairing-qr').removeAttribute('src');
  $('pairing-code-box').classList.toggle('hidden', !pairing.code); $('pairing-code').textContent = pairing.code || '';
  const url = safePairingUrl(pairing.url);
  $('pairing-link').classList.toggle('hidden', !url); if (url) $('pairing-link').href = url; else $('pairing-link').removeAttribute('href');
}

function openSetup() { setupOpened = true; renderSetup(); $('setup-dialog').showModal(); loadDesktopSettings(); loadHookStatus(); }

const hookNames = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };

function renderHooks() {
  const choices = Object.keys(hookNames).filter(id => $('hook-' + id).checked);
  $('refresh-hooks').disabled = hookStatusLoading || hooksBusy;
  $('install-hooks').disabled = hooksBusy || !choices.length;
  $('install-hooks').textContent = hooksBusy ? '正在安装通知…' : '安装所选应用的通知';
  for (const id of Object.keys(hookNames)) $('hook-' + id).disabled = hooksBusy;
  $('hook-cursor-approval').disabled = hooksBusy || !$('hook-cursor').checked;
  const list = $('hook-status-list');
  if (hookStatusError) {
    list.replaceChildren(el('p', 'hook-error field-help', hookStatusError));
    return;
  }
  if (!hookStatuses.length) {
    list.replaceChildren(el('p', 'field-help', hookStatusLoading ? '正在读取原应用的通知设置…' : '尚未读取通知状态。'));
    return;
  }
  list.replaceChildren(...hookStatuses.map(item => {
    const row = el('div', 'hook-status-row');
    const copy = el('div');
    copy.append(el('strong', '', hookNames[item.agent] || item.agent));
    const detail = item.error ? item.error : !item.installed ? '尚未接入原应用通知' : `${item.completion ? '完成通知已安装' : '完成通知未安装'} · ${item.attention ? '待操作回应已安装' : '仅完成通知'}${item.trustRequired ? ' · 需在 /hooks 核对信任' : ''}`;
    copy.append(el('small', item.error ? 'hook-error' : '', detail));
    const status = el('span', `hook-status-badge${item.error ? ' error' : item.installed ? ' installed' : ''}`, item.error ? '读取失败' : item.installed ? '已安装' : '未接入');
    row.append(copy, status); return row;
  }));
}

async function loadHookStatus() {
  const revision = ++hookLoadRevision;
  hookStatusLoading = true; hookStatusError = ''; renderHooks();
  try {
    const result = await api('/api/hooks/status');
    if (revision === hookLoadRevision) hookStatuses = result.hooks || result.status || [];
  } catch (error) {
    if (revision === hookLoadRevision) hookStatusError = error.message || '无法读取通知设置。';
  } finally {
    if (revision === hookLoadRevision) { hookStatusLoading = false; renderHooks(); }
  }
}

async function installSelectedHooks() {
  if (hooksBusy) return;
  const agents = Object.keys(hookNames).filter(id => $('hook-' + id).checked);
  if (!agents.length) return;
  hooksBusy = true; ++hookLoadRevision; hookStatusLoading = false; renderHooks();
  const notes = $('hook-install-notes'); notes.classList.add('hidden');
  try {
    const result = await api('/api/hooks/install', { agents, cursorApproval: agents.includes('cursor') && $('hook-cursor-approval').checked });
    hookStatuses = result.status || result.hooks || hookStatuses; hookStatusError = '';
    const messages = result.notes || [];
    notes.replaceChildren(el('strong', '', '通知设置已保存'));
    if (messages.length) { const list = el('ul'); for (const text of messages) list.append(el('li', '', text)); notes.append(list); }
    if (result.backups?.length) notes.append(el('p', 'field-help', `已备份 ${result.backups.length} 份原设置。`));
    notes.classList.remove('hidden');
    toast(agents.includes('codex') ? '已安装通知，请在 Codex /hooks 核对信任' : '通知已安装，请让原应用重新加载设置');
  } finally { hooksBusy = false; renderHooks(); }
}

async function beginPairing() {
  if (pairingBusy) return;
  pairingBusy = true; localPairing = { status: 'starting' }; renderSetup();
  try {
    const result = await api('/api/setup/pairing', {});
    localPairing = result.pairing || result;
    await refresh(); renderSetup();
  } finally { pairingBusy = false; renderSetup(); }
}

async function saveCredentials() {
  const button = $('save-credentials'); button.disabled = true;
  try {
    await api('/api/setup/credentials', { appId: $('setup-app-id').value.trim(), appSecret: $('setup-app-secret').value.trim(), ownerId: $('setup-owner-id').value.trim() });
    $('credentials-form').reset(); $('credentials-details').open = false; localPairing = null;
    await refresh(); toast('凭证已保存，正在连接飞书');
  } finally { button.disabled = false; }
}

async function loadDesktopSettings() {
  const desktop = window.agentPhoneDesktop;
  $('desktop-settings').classList.toggle('hidden', !desktop?.getSettings);
  if (!desktop?.getSettings) return;
  try {
    const settings = await desktop.getSettings();
    $('start-at-login').checked = typeof settings === 'boolean' ? settings : Boolean(settings?.autostart ?? settings?.openAtLogin ?? settings?.startAtLogin);
    $('start-at-login').disabled = !desktop.setAutostart;
    $('keep-awake').checked = settings?.keepAwake !== false;
    $('keep-awake').disabled = !desktop.setKeepAwake;
    $('open-data-folder').disabled = !desktop.showDataFolder;
  } catch (error) { toast(error.message || '无法读取桌面设置。', true); }
}

$('project-search').addEventListener('input', renderProjects);
$('task-input').addEventListener('input', () => { saveDraft(); renderControls(); });
$('task-input').addEventListener('keydown', async event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    try { await submitTask(); } catch (error) { toast(error.message || '操作失败，请重试。', true); }
  }
});
$('task-form').addEventListener('submit', handle(submitTask));
$('add-project').addEventListener('click', handle(() => openPicker('folder')));
$('welcome-project').addEventListener('click', handle(() => openPicker('folder')));
$('attach-files').addEventListener('click', handle(() => openPicker('files')));
$('refresh-button').addEventListener('click', handle(async () => { if (await refresh(true)) toast('项目和已有会话已同步'); }));
$('phone-menu').addEventListener('click', handle(async () => { await api('/api/menu', {}); toast('选择菜单已发送到手机飞书'); }));
$('new-session').addEventListener('click', handle(async () => { if (busy) return; busy = true; renderControls(); try { await createSession(); $('task-input').focus(); } finally { busy = false; renderControls(); } }));
$('stop-task').addEventListener('click', handle(async () => { if (busy || !sessionId) return; busy = true; renderControls(); try { const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {}); await refresh(); toast(result.stopped ? '任务已停止' : '当前没有可由工作台停止的任务。'); } finally { busy = false; renderControls(); } }));
$('picker-close').addEventListener('click', closePicker);
$('picker-dialog').addEventListener('cancel', () => { browseRevision++; picker = null; });
$('picker-dialog').addEventListener('click', event => { if (event.target === $('picker-dialog')) { const rect = $('picker-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePicker(); } });
$('native-picker').addEventListener('click', handle(useNativePicker));
$('browser-home').addEventListener('click', handle(() => browseTo(null)));
$('browser-up').addEventListener('click', handle(() => browseTo(picker?.parent || null)));
$('browser-prev').addEventListener('click', handle(() => browseTo(picker.path, Math.max(0, picker.offset - 12))));
$('browser-next').addEventListener('click', handle(() => browseTo(picker.path, picker.offset + 12)));
$('picker-confirm').addEventListener('click', handle(async () => {
  if (!picker || picker.busy) return;
  if (picker.kind === 'folder') { picker.busy = true; renderBrowser(); try { await acceptProject(picker.path); } finally { if (picker) { picker.busy = false; renderBrowser(); } } }
  else if (picker.kind === 'executable') { setExecutable([...picker.selected][0]); closePicker(); }
  else { const files = [...picker.selected]; addAttachments(files); closePicker(); toast(`已添加 ${files.length} 个文件`); }
}));
$('add-agent').addEventListener('click', handle(openAgentDialog));
$('agent-close').addEventListener('click', () => $('agent-dialog').close());
$('discover-agents').addEventListener('click', handle(discoverAgents));
$('agent-kind').addEventListener('change', renderAgentKind);
$('choose-executable').addEventListener('click', handle(async () => {
  const button = $('choose-executable'); button.disabled = true;
  try { const paths = await nativePaths('executable'); if (paths[0]) setExecutable(paths[0]); }
  catch { await openPicker('executable'); }
  finally { button.disabled = false; }
}));
$('agent-form').addEventListener('submit', handle(saveAgent));
$('open-settings').addEventListener('click', openSetup);
$('setup-close').addEventListener('click', () => $('setup-dialog').close());
$('refresh-hooks').addEventListener('click', handle(loadHookStatus));
$('install-hooks').addEventListener('click', handle(installSelectedHooks));
for (const id of Object.keys(hookNames)) $('hook-' + id).addEventListener('change', renderHooks);
$('begin-pairing').addEventListener('click', handle(beginPairing));
$('credentials-form').addEventListener('submit', handle(saveCredentials));
$('setup-send-menu').addEventListener('click', handle(async () => { await api('/api/menu', {}); toast('手机操作菜单已发送'); }));
$('disconnect-feishu').addEventListener('click', handle(async () => {
  if (!window.confirm('解除这台电脑的飞书绑定？之后可以重新绑定。')) return;
  await api('/api/setup/disconnect', {}); localPairing = null; await refresh(); toast('本机飞书绑定已解除');
}));
$('start-at-login').addEventListener('change', handle(async () => {
  const input = $('start-at-login'); const desired = input.checked; input.disabled = true;
  try { await window.agentPhoneDesktop.setAutostart(desired); toast(desired ? '已开启登录后启动' : '已关闭登录后启动'); }
  catch (error) { input.checked = !desired; throw error; }
  finally { input.disabled = false; }
}));
$('open-data-folder').addEventListener('click', handle(() => window.agentPhoneDesktop.showDataFolder()));
$('keep-awake').addEventListener('change', handle(async () => {
  const input = $('keep-awake'); const desired = input.checked; input.disabled = true;
  try { await window.agentPhoneDesktop.setKeepAwake(desired); toast(desired ? '程序运行时保持电脑唤醒' : '已恢复系统睡眠设置'); }
  catch (error) { input.checked = !desired; throw error; }
  finally { input.disabled = false; }
}));

renderControls();
refresh();
setInterval(() => { if (!document.hidden && !picker?.busy) refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
