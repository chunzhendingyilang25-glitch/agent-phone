import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { cleanPath, log } from './config.mjs';

const textContent = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => ['text', 'input_text', 'output_text'].includes(c.type)).map(c => c.text).join('\n') : '';

export function codexRolloutStatus(file) {
  let fd;
  try {
    fd=fs.openSync(file,'r');let position=fs.fstatSync(fd).size,carry=Buffer.alloc(0);
    while(position>0){
      const length=Math.min(position,1024*1024);position-=length;
      const chunk=Buffer.alloc(length);fs.readSync(fd,chunk,0,length,position);
      const buffer=Buffer.concat([chunk,carry]);let end=buffer.length;
      while(end>0){
        const newline=buffer.lastIndexOf(10,end-1);
        if(newline<0)break;
        const line=buffer.subarray(newline+1,end).toString('utf8');end=newline;
        if(!line.includes('event_msg'))continue;
        try{
          const event=JSON.parse(line);
          if(event.type!=='event_msg')continue;
          const status={task_started:'running',task_complete:'done',turn_aborted:'interrupted'}[event.payload?.type];
          if(status)return status;
        }catch{}
      }
      carry=buffer.subarray(0,end);
    }
    if(carry.length){const event=JSON.parse(carry.toString('utf8'));if(event.type==='event_msg')return {task_started:'running',task_complete:'done',turn_aborted:'interrupted'}[event.payload?.type] || null;}
  }catch{}finally{if(fd!==undefined)fs.closeSync(fd);}
  return null;
}

export class Catalog {
  constructor(store, notify) { this.store = store; this.notify = notify; this.offsets = new Map(); this.polling = false; this.timer = null; }
  refresh() {
    let changed = false;
    const add = (agentId, remoteId, cwd, title, updatedAt, extra = {}) => {
      try {
        cwd = cleanPath(cwd); if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return;
        const project = this.store.addProject(cwd, null, false);
        let session = this.store.data.sessions.find(s => s.remoteId === remoteId && (s.agentId === agentId || s.agentId.startsWith('codex') && agentId.startsWith('codex')));
        if (!session) {
          session = { id: randomUUID(), agentId, remoteId, projectId: project.id, cwd, title: String(title || '已有会话').slice(0, 90), status: 'idle', source: 'external', messages: [], createdAt: updatedAt, updatedAt, ...extra };
          this.store.data.sessions.push(session); changed = true;
        } else if (session.source === 'external' && extra.rolloutPath) session.rolloutPath = extra.rolloutPath;
        if (extra.rolloutPath && !this.offsets.has(extra.rolloutPath)) {
          try {
            if(session.source==='external'){const status=codexRolloutStatus(extra.rolloutPath);if(status){session.status=status;if(session.error==='服务重启，任务已中断。')session.error=null;changed=true;}}
            this.offsets.set(extra.rolloutPath, { offset: fs.statSync(extra.rolloutPath).size, carry: '', decoder:new StringDecoder('utf8') });
          } catch {}
        }
      } catch {}
    };
    const dbFile = path.join(process.env.USERPROFILE, '.codex', 'state_5.sqlite');
    if (fs.existsSync(dbFile)) {
      let db;
      try {
        db = new DatabaseSync(dbFile, { readOnly: true });
        const rows = db.prepare('SELECT id,cwd,source,substr(title,1,90) title,updated_at,rollout_path FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 200').all();
        for (const row of rows) {
          if (row.source.includes('subagent')) continue;
          add(row.source === 'vscode' || row.source === 'app-server' ? 'codex-desktop' : 'codex-cli', row.id, row.cwd, row.title, row.updated_at * 1000, { rolloutPath: cleanPath(row.rollout_path) });
        }
      } catch (error) { log('catalog.codex-error', { message: error.message }); } finally { db?.close(); }
    }
    const claudeRoot = path.join(process.env.USERPROFILE, '.claude', 'projects');
    if (fs.existsSync(claudeRoot)) for (const directory of fs.readdirSync(claudeRoot, { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 100)) {
      const base = path.join(claudeRoot, directory.name);
      const files = fs.readdirSync(base).filter(n => /^[\da-f-]+\.jsonl$/i.test(n)).map(n => path.join(base, n))
        .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 8);
      for (const file of files) {
        try {
          const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(65536); const count = fs.readSync(fd, buffer, 0, buffer.length, 0); fs.closeSync(fd);
          const events = buffer.subarray(0,count).toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
          const first = events.find(e => e.cwd && e.sessionId);
          const user = events.find(e => e.type === 'user' && e.message?.role === 'user');
          if (first) add('claude', first.sessionId, first.cwd, textContent(user?.message?.content).slice(0, 90), fs.statSync(file).mtimeMs, { transcriptPath: file });
        } catch {}
      }
    }
    if (changed) this.store.save();
    return this.store.data.sessions;
  }
  loadHistory(session) {
    if (session.source === 'hub') return;
    const file = session.rolloutPath || session.transcriptPath; if (!file) return;
    try {
      const size = fs.statSync(file).size;
      if(session.historySize===size)return;
      const start = Math.max(0, size - 512000), fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(size-start); fs.readSync(fd, buffer, 0, buffer.length, start); fs.closeSync(fd);
      const messages = [];
      for (const line of buffer.toString('utf8').split('\n')) {
        let e; try { e=JSON.parse(line); } catch { continue; }
        const message = e.type === 'response_item' ? e.payload : ['user','assistant'].includes(e.type) ? e.message : null;
        if (message && ['user','assistant'].includes(message.role)) {
          if(message.role==='assistant' && message.phase==='analysis')continue;
          const text = textContent(message.content).slice(0, 20000);
          if (text) messages.push({ role: message.role, text, ts: Date.parse(e.timestamp || e.ts) || session.updatedAt });
        }
      }
      session.messages = messages.slice(-30); session.historySize=size; this.store.save();
    } catch {}
  }
  start() {
    this.refresh(); let tick = 0;
    this.timer = setInterval(async () => {
      if (this.polling) return; this.polling = true;
      try { if (++tick % 5 === 0) this.refresh(); await this.poll(); } catch (error) { log('catalog.poll-error',{message:error.message}); }
      finally { this.polling = false; }
    }, 2000);
  }
  async poll() {
    for (const s of this.store.data.sessions) {
      if (s.source !== 'external' || !s.rolloutPath) continue;
      const pos = this.offsets.get(s.rolloutPath); if (!pos) continue;
      try {
        const size = fs.statSync(s.rolloutPath).size; if (size === pos.offset) continue;
        if (size < pos.offset) { pos.offset = 0; pos.carry = '';pos.decoder=new StringDecoder('utf8'); }
        const length = Math.min(size-pos.offset, 2*1024*1024), buffer = Buffer.alloc(length), fd = fs.openSync(s.rolloutPath,'r');
        fs.readSync(fd, buffer, 0, length, pos.offset); fs.closeSync(fd); pos.offset += length;
        const lines = (pos.carry + (pos.decoder ||= new StringDecoder('utf8')).write(buffer)).split('\n'); pos.carry = lines.pop();
        for (const line of lines) {
          let e; try { e=JSON.parse(line); } catch { continue; }
          if (e.type !== 'event_msg') continue;
          if (e.payload?.type === 'task_started') { s.status='running'; s.updatedAt=Date.now(); this.store.save(); }
          if (e.payload?.type === 'turn_aborted') { s.status='interrupted'; s.updatedAt=Date.now(); this.store.save(); }
          if (e.payload?.type === 'task_complete') {
            s.status='done'; s.updatedAt=Date.now();
            await this.notify({ agent: s.agentId, session_id: s.remoteId, turn_id: e.payload.turn_id, cwd: s.cwd, last_assistant_message: e.payload.last_agent_message || '' });
          }
        }
      } catch {}
    }
  }
  close() { clearInterval(this.timer); }
}

export function browse(directory, offset = 0, includeFiles = true) {
  const roots = [path.join(process.env.USERPROFILE,'Desktop'), path.join(process.env.USERPROFILE,'Documents')];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${letter}:\\`)) roots.push(`${letter}:\\`);
  if (!directory) return { path: null, parent: null, entries: [...new Set(roots)].filter(p=>fs.existsSync(p)).map(p=>({name:path.basename(p)||p,path:p,kind:'directory'})), total: roots.length, offset:0 };
  const cwd=cleanPath(directory); if (!fs.statSync(cwd).isDirectory()) throw new Error('目录不存在。');
  const all=fs.readdirSync(cwd,{withFileTypes:true}).filter(d=>!d.name.startsWith('.') && d.name!=='node_modules' && (d.isDirectory()||includeFiles&&d.isFile()))
    .map(d=>({name:d.name,path:path.join(cwd,d.name),kind:d.isDirectory()?'directory':'file'}))
    .sort((a,b)=>(a.kind===b.kind?0:a.kind==='directory'?-1:1)||a.name.localeCompare(b.name,'zh-CN'));
  offset=Math.max(0,Math.floor(Number(offset)||0));
  return {path:cwd,parent:path.dirname(cwd)===cwd?null:path.dirname(cwd),entries:all.slice(offset,offset+12),offset,total:all.length};
}
