import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HUB_STATE, cleanPath } from './config.mjs';
import { initializeRegistry, listAgents, getAgent } from './registry.mjs';

export class Store extends EventEmitter {
  constructor(file = HUB_STATE) {
    super(); this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { projects: [], sessions: [], contexts: {}, notifications: [] };
    this.data.notifications ||= [];
    this.data.outbox ||= [];
    initializeRegistry(this, false);
    for (const s of this.data.sessions) {
      if (['running','waiting'].includes(s.status) && (s.source==='hub' || s.managedRunning)) {s.status='interrupted';s.error='服务重启，任务已中断。';}
      s.managedRunning=false;
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
    fs.renameSync(temp, this.file); this.emit('change');
  }
  addProject(directory, label, persist = true) {
    const cwd = cleanPath(directory);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('请选择文件夹。');
    let p = this.data.projects.find(p => p.path.toLowerCase() === cwd.toLowerCase());
    if (!p) { p = { id: randomUUID(), name: label || path.basename(cwd) || cwd, path: cwd }; this.data.projects.push(p); if (persist) this.save(); }
    return p;
  }
  project(id) { const p = this.data.projects.find(p => p.id === id); if (!p) throw new Error('项目不存在，请重新选择。'); return p; }
  session(id) { const s = this.data.sessions.find(s => s.id === id); if (!s) throw new Error('会话不存在，请重新选择。'); return s; }
  createSession(agentId, projectId) {
    const agent=getAgent(this,agentId);
    if(agent.enabled===false)throw new Error('这个 Agent 已停用。');
    if(agent.kind==='hook')throw new Error('通知接入用于接收已有程序的事件，请从原程序启动任务。');
    const project = this.project(projectId);
    const session = { id: randomUUID(), agentId, projectId, cwd: project.path, title: '新任务', status: 'idle', messages: [], remoteId: null, source: 'hub', createdAt: Date.now(), updatedAt: Date.now() };
    this.data.sessions.unshift(session); this.save(); return session;
  }
  context(chatId) { return this.data.contexts[chatId] ||= { agentId: 'codex-cli', projectId: null, sessionId: null, files: [] }; }
  addNotification(notification) {
    const item={ id: randomUUID(), ts: Date.now(), ...notification };
    this.data.notifications.unshift(item);
    this.data.notifications = this.data.notifications.slice(0, 80); this.save();
    return item;
  }
  publicState(connection) {
    return { agents: listAgents(this).map(a=>({...a,connection:this.data.agentConnections?.[a.id]})), projects: this.data.projects, sessions: this.data.sessions.map(({ messages, ...s }) => ({ ...s, messageCount: messages?.length || 0 })), notifications: this.data.notifications, requests:(this.data.requests || []).filter(r=>r.status==='pending'), connection };
  }
}
