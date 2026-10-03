import fs from 'node:fs';
import path from 'node:path';
import { createLarkChannel } from '@larksuite/channel';
import { readFeishuCredentials, cleanPath, log } from './config.mjs';
import { browse } from './catalog.mjs';
import {listAgents,getAgent} from './registry.mjs';

const button = (label, value, primary = false) => ({ tag: 'button', text: { tag: 'plain_text', content: label }, type: primary ? 'primary' : 'default', value });
const md = content => ({ tag: 'div', text: { tag: 'lark_md', content } });
const row = actions => ({ tag: 'action', actions });
const card = (title, elements) => ({ config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: title }, template: 'blue' }, elements });
const safeMarkdown = text => String(text).replace(/[\r\n]+/g, ' ').replace(/[*`<>]/g, '').slice(0, 120);

export class FeishuHub {
  constructor(store, engine, catalog, options={}) {
    this.store = store; this.engine = engine; this.catalog = catalog;
    this.createChannel=options.createChannel || createLarkChannel;this.readCredentials=options.readCredentials || readFeishuCredentials;
    this.channel = null; this.credentials = null; this.connection = { connected: false, botName: 'Agent助手', error: null };
    this.flushing = false;
    this.retryTimer=setInterval(()=>{void this.flushOutbox();},5000);
    engine.on('finished', s => this.notifySession(s).catch(error => log('feishu.notify-error', { message: error.message })));
    engine.on('attention', r=>this.notifyRequest(r).catch(error=>log('feishu.attention-error',{message:error.message})));
  }
  async connect() {
    if(!this.retryTimer)this.retryTimer=setInterval(()=>{void this.flushOutbox();},5000);
    const generation=(this.generation || 0)+1;this.generation=generation;
    const previous=this.channel;this.channel=null;this.connection.connected=false;
    await previous?.disconnect().catch(()=>{});
    if(this.generation!==generation)return;
    this.credentials = this.readCredentials();
    this.channel = this.createChannel({
      appId: this.credentials.appId, appSecret: this.credentials.appSecret,
      policy: { requireMention: true, dmMode: 'allowlist', dmAllowlist: [this.credentials.ownerId] },
      safety: { chatQueue: { enabled: true, mergeWhileBusy: false } },
      loggerLevel: 'error', source: 'agent-phone-hub',
    });
    const channel=this.channel,credentials=this.credentials;const active=()=>this.generation===generation && this.channel===channel;
    this.channel.on('message', msg => {
      if (!active() || msg.senderId !== credentials.ownerId) return;
      if(msg.chatType==='p2p' && this.store.data.ownerChatId!==msg.chatId){this.store.data.ownerChatId=msg.chatId;this.store.save();}
      return this.handleMessage(msg).catch(error => this.send(msg.chatId, { text: error.message }).catch(e=>log('feishu.reply-error',{message:e.message})));
    });
    this.channel.on('cardAction', evt => {
      if (!active() || evt.operator.openId !== credentials.ownerId) return;
      // 卡片回调须立即返回；耗时操作在后台进行。
      void this.handleAction(evt).catch(error => { log('feishu.action-error', { message: error.message }); return this.send(evt.chatId, { text: error.message }).catch(e=>log('feishu.reply-error',{message:e.message})); });
      return { toast: { type: 'success', content: '已选择' } };
    });
    this.channel.on('reconnecting', () => { if(active())this.connection.connected = false; });
    this.channel.on('reconnected', () => { if(!active())return;this.connection.connected = true; this.connection.error = null; void this.flushOutbox(); });
    this.channel.on('error', error => { if(!active())return;this.connection.error = error.message; log('feishu.error', { message: error.message }); });
    await channel.connect();
    if(!active()){await channel.disconnect().catch(()=>{});return;}
    this.connection.connected = true; this.connection.error=null;this.connection.botName = channel.botIdentity?.name || 'Agent助手';
    void this.flushOutbox();
    log('feishu.connected');
  }
  async send(to, input, opts = {}) {
    if (!this.channel || !this.connection.connected) throw new Error('飞书连接暂不可用，请在电脑界面操作或稍后重试。');
    return this.channel.send(to, input, opts);
  }
  async menu(chatId = this.store.data.ownerChatId || this.credentials.ownerId) {
    const ctx = this.store.context(chatId);
    const agent = listAgents(this.store).find(a=>a.id===ctx.agentId);
    const project = this.store.data.projects.find(p=>p.id===ctx.projectId);
    const current = this.store.data.sessions.find(s=>s.id===ctx.sessionId);
    const elements = [md(`**当前 Agent：** ${agent?.name || '请选择'}\n**项目：** ${project ? safeMarkdown(project.name) : '尚未选择'}${current ? `\n**会话：** ${safeMarkdown(current.title)}` : ''}\n选好后直接发送任务，后续消息继续当前会话。`),
      row(listAgents(this.store).filter(a=>a.enabled!==false).slice(0,5).map(a=>button(a.name,{action:'agent',id:a.id},a.id===ctx.agentId))),
      row([button('选择项目',{action:'projects'}),button('浏览目录 / 文件',{action:'browse',path:null}),button('已有会话',{action:'sessions'})]),
      row([button('全部 Agent',{action:'agents'}),button('待我操作',{action:'pending'}),button('新会话',{action:'new'}),button('停止当前任务',{action:'stop'})])];
    if (ctx.files.length) elements.push(md(`已选文件：${ctx.files.map(f=>safeMarkdown(path.basename(f))).join('、')}`),row([button('清空文件',{action:'clearFiles'})]));
    return this.send(chatId,{card:card('Agent Phone · 统一控制台',elements)});
  }
  async agents(chatId,offset=0) {
    const agents=listAgents(this.store).filter(a=>a.enabled!==false);const elements=[md('电脑管理界面添加的 Agent 会显示在这里。')];
    for(const a of agents.slice(offset,offset+8))elements.push(row([button(a.name,{action:'agent',id:a.id},true)]));
    const controls=[button('主菜单',{action:'menu'})];if(offset>0)controls.push(button('上一页',{action:'agents',offset:Math.max(0,offset-8)}));if(offset+8<agents.length)controls.push(button('下一页',{action:'agents',offset:offset+8}));elements.push(row(controls));return this.send(chatId,{card:card('选择 Agent',elements)});
  }
  async pending(chatId) {
    const requests=this.engine.requests?.pending() || [];if(!requests.length)return this.send(chatId,{text:'当前没有等待你操作的请求。'});
    for(const request of requests.slice(0,8))await this.send(chatId,{card:this.requestCard(request)});
  }
  requestCard(request) {
    const session=this.store.data.sessions.find(s=>s.id===request.sessionId);
    const elements=[md(`${session ? `**${safeMarkdown(session.title)}**\n` : ''}${request.description.slice(0,3500)}`)];
    for(let i=0;i<request.options.length;i+=4)elements.push(row(request.options.slice(i,i+4).map(o=>button(o.label.slice(0,60),{action:'respond',requestId:request.id,optionId:o.id},i===0))));
    const approval=request.kind==='approval' && request.options.length;
    const controls=approval?[]:[button('输入回复',{action:'replyRequest',requestId:request.id})];if(request.sessionId)controls.push(button('查看会话',{action:'session',id:request.sessionId}));
    elements.push(md(approval?'请点击上方选项确认；文字回复不会批准操作。':'可在这条消息的回复中发送文字，或点击“输入回复”后直接给机器人发送。'));if(controls.length)elements.push(row(controls));
    return card(request.title,elements);
  }
  async notifyRequest(request) {
    const session=this.store.data.sessions.find(s=>s.id===request.sessionId);
    const notification=this.store.addNotification({requestId:request.id,sessionId:request.sessionId,agentId:session?.agentId,title:request.title,status:'waiting',messageId:null,delivery:'pending'});
    this.store.data.outbox.push({notificationId:notification.id,to:session?.notifyChatId || this.store.data.ownerChatId || this.credentials?.ownerId,card:this.requestCard(request)});
    this.store.save();void this.flushOutbox();return notification;
  }
  async projects(chatId, offset = 0) {
    const projects=this.store.data.projects.slice(offset,offset+8);
    const elements=[md('点击项目名称即可选择。没有所需项目时，点“浏览电脑目录”。')];
    for (const p of projects) elements.push(md(`**${safeMarkdown(p.name)}**\n${safeMarkdown(p.path)}`),row([button('选择这个项目',{action:'project',id:p.id},true)]));
    const controls=[button('浏览电脑目录',{action:'browse',path:null}),button('主菜单',{action:'menu'})];
    if (offset>0) controls.push(button('上一页',{action:'projects',offset:Math.max(0,offset-8)}));
    if (offset+8<this.store.data.projects.length) controls.push(button('下一页',{action:'projects',offset:offset+8}));
    elements.push(row(controls)); return this.send(chatId,{card:card('选择项目目录',elements)});
  }
  async directory(chatId, directory, offset = 0) {
    const b=browse(directory,offset,true);
    const elements=[md(b.path?`当前位置：${safeMarkdown(b.path)}\n点击文件夹进入；点击文件将它加入下一条任务。`:'从电脑目录开始浏览：')];
    for (const item of b.entries) elements.push(row([button(`${item.kind==='directory'?'📁':'📄'} ${item.name.slice(0,40)}`,{action:item.kind==='directory'?'browse':'file',path:item.path})]));
    if (b.path) elements.push(row([button('使用这个目录作为项目',{action:'directory',path:b.path},true)]));
    const controls=[button('常用项目',{action:'projects'})];
    if (b.parent) controls.push(button('上一级',{action:'browse',path:b.parent}));
    if (b.offset>0) controls.push(button('上一页',{action:'browse',path:b.path,offset:Math.max(0,b.offset-12)}));
    if (b.offset+12<b.total) controls.push(button('下一页',{action:'browse',path:b.path,offset:b.offset+12}));
    elements.push(row(controls)); return this.send(chatId,{card:card('点选电脑目录和文件',elements)});
  }
  async sessions(chatId, offset = 0) {
    this.catalog.refresh();
    const ctx=this.store.context(chatId);
    const matches=this.store.data.sessions.filter(s=>s.agentId===ctx.agentId && (!ctx.projectId||s.projectId===ctx.projectId)).sort((a,b)=>b.updatedAt-a.updatedAt);
    const elements=[md(`当前 Agent：${listAgents(this.store).find(a=>a.id===ctx.agentId)?.name || '已移除的 Agent'}。点击会话继续上下文。`)];
    for (const s of matches.slice(offset,offset+8)) elements.push(md(`**${safeMarkdown(s.title)}**\n${safeMarkdown(path.basename(s.cwd))} · ${s.status==='running'?'运行中':'可选择'}`),row([button('选择会话',{action:'session',id:s.id},true)]));
    if (!matches.length) elements.push(md('这个 Agent 和项目下还没有会话。选择项目后直接发送任务即可创建。'));
    const controls=[button('主菜单',{action:'menu'})];
    if (offset>0) controls.push(button('上一页',{action:'sessions',offset:Math.max(0,offset-8)}));
    if (offset+8<matches.length) controls.push(button('下一页',{action:'sessions',offset:offset+8}));
    elements.push(row(controls)); return this.send(chatId,{card:card('选择已有会话',elements)});
  }
  async handleMessage(msg) {
    const text=msg.content.trim(); const ctx=this.store.context(msg.chatId);
    if (!text || /^(\/菜单|\/menu|\/help|\/status|菜单|帮助)$/i.test(text)) return this.menu(msg.chatId);
    if (/^(\/项目|\/project|\/projects|\/cd|选择项目)/i.test(text)) return this.projects(msg.chatId);
    if (/^(\/agent|\/agents|选择agent)$/i.test(text)) return this.agents(msg.chatId);
    if (/^(\/pending|\/待操作|待我操作)$/i.test(text)) return this.pending(msg.chatId);
    if (/^(\/resume|\/会话)$/i.test(text)) return this.sessions(msg.chatId);
    if (/^\/stop$/i.test(text)) { const stopped=ctx.sessionId && await this.engine.stop(ctx.sessionId); return this.send(msg.chatId,{text:stopped?'已请求停止当前任务。':'当前没有由控制台运行的任务；原应用中的任务请到原应用停止。'}); }
    if (/^\/new$/i.test(text)) { ctx.sessionId=null;ctx.requestId=null; ctx.files=[]; this.store.save(); return this.menu(msg.chatId); }
    // 完成卡片的消息串或引用回复，优先继续那条通知对应的会话。
    const notification=this.store.data.notifications.find(n=>n.messageId && [msg.rootId,msg.replyToMessageId].includes(n.messageId));
    if(ctx.requestId && !this.engine.requests?.pending().some(r=>r.id===ctx.requestId)){ctx.requestId=null;this.store.save();}
    const requestId=notification?.requestId || (!notification?.sessionId && ctx.requestId);
    if(requestId){const r=await this.engine.requests.respond(requestId,{text,source:'feishu'});ctx.requestId=null;this.store.save();return this.send(msg.chatId,{text:r.status==='answered'?'已将回复发送给 Agent。':'请求已结束。'});}
    if (notification?.sessionId) {
      const s=this.store.session(notification.sessionId); ctx.sessionId=s.id; ctx.agentId=s.agentId; ctx.projectId=s.projectId;
    }
    if (!ctx.projectId) { ctx.pendingPrompt=text; this.store.save(); return this.projects(msg.chatId); }
    return this.run(msg.chatId,text);
  }
  async run(chatId,text) {
    const ctx=this.store.context(chatId);
    if (!ctx.sessionId) ctx.sessionId=this.store.createSession(ctx.agentId,ctx.projectId).id;
    const current=this.store.session(ctx.sessionId);
    const waiting=this.engine.requests?.pending(current.id) || [];
    if(waiting.length===1){await this.engine.requests.respond(waiting[0].id,{text,source:'feishu'});return this.send(chatId,{text:'已将回复发送给 Agent。'});}
    if(current.managedRunning && ['terminal','line-json','dsh'].includes(getAgent(this.store,current.agentId).kind)){await this.engine.input(current.id,text);return this.send(chatId,{text:'已发送到当前 Agent。'});}
    const session=this.engine.start(ctx.sessionId,text,ctx.files); ctx.files=[]; ctx.pendingPrompt=null;ctx.requestId=null;
    session.notifyChatId=chatId; this.store.save();
    return this.send(chatId,{card:card('任务已开始',[md(`**${listAgents(this.store).find(a=>a.id===session.agentId)?.name || session.agentId}** · ${safeMarkdown(path.basename(session.cwd))}\n${safeMarkdown(text)}`),row([button('停止任务',{action:'stopSession',id:session.id}),button('主菜单',{action:'menu'})])])});
  }
  async handleAction(evt) {
    const value=evt.action.value || {}; const ctx=this.store.context(evt.chatId); const chat=evt.chatId;
    switch(value.action) {
      case 'agents':return this.agents(chat,Number(value.offset)||0);
      case 'pending':return this.pending(chat);
      case 'respond': {const r=await this.engine.requests.respond(value.requestId,{optionId:value.optionId,source:'feishu'});if(ctx.requestId===value.requestId)ctx.requestId=null;this.store.save();return this.send(chat,{text:r.status==='answered'?'已将选择发送给 Agent。':'请求已结束。'});}
      case 'replyRequest': {const r=this.engine.requests.pending().find(r=>r.id===value.requestId);if(!r)throw new Error('这个请求已经处理或失效。');ctx.requestId=r.id;this.store.save();return this.send(chat,{text:`请发送回复：${r.title}`});}
      case 'agent': if (!listAgents(this.store).some(a=>a.id===value.id)) throw new Error('Agent 不存在。'); ctx.requestId=null;ctx.agentId=value.id;ctx.sessionId=null;this.store.save();return this.menu(chat);
      case 'projects': return this.projects(chat,Number(value.offset)||0);
      case 'browse': return this.directory(chat,value.path,Number(value.offset)||0);
      case 'project': this.store.project(value.id);ctx.requestId=null;ctx.projectId=value.id;ctx.sessionId=null;this.store.save();break;
      case 'directory': ctx.projectId=this.store.addProject(value.path).id;ctx.requestId=null;ctx.sessionId=null;this.store.save();break;
      case 'file': { const file=cleanPath(value.path);if(!fs.statSync(file).isFile())throw new Error('文件不存在。');if(!ctx.files.includes(file))ctx.files.push(file);if(ctx.files.length>20){ctx.files.pop();throw new Error('一次最多选择 20 个文件。');}this.store.save();return this.menu(chat); }
      case 'sessions': return this.sessions(chat,Number(value.offset)||0);
      case 'session': {const s=this.store.session(value.id);ctx.requestId=null;ctx.sessionId=s.id;ctx.agentId=s.agentId;ctx.projectId=s.projectId;ctx.files=[];this.store.save();return this.menu(chat);}
      case 'stopSession': if(!await this.engine.stop(value.id))return this.send(chat,{text:'当前没有由控制台运行的任务；原应用中的任务请到原应用停止。'});return this.menu(chat);
      case 'stop': if(!ctx.sessionId || !await this.engine.stop(ctx.sessionId))return this.send(chat,{text:'当前没有由控制台运行的任务；原应用中的任务请到原应用停止。'});return this.menu(chat);
      case 'new':ctx.requestId=null;ctx.sessionId=null;ctx.files=[];this.store.save();return this.menu(chat);
      case 'clearFiles':ctx.files=[];this.store.save();return this.menu(chat);
      default:return this.menu(chat);
    }
    if(ctx.pendingPrompt)return this.run(chat,ctx.pendingPrompt);
    return this.menu(chat);
  }
  async notifySession(session, externalKey = null) {
    externalKey ||= session.agentId.startsWith('codex') && session.remoteId && session.lastTurnId ? `${session.remoteId}:${session.lastTurnId}` : null;
    if(!externalKey && listAgents(this.store).find(a=>a.id===session.agentId)?.kind==='dsh')externalKey=session.lastTurnId || null;
    if(externalKey){const existing=this.store.data.notifications.find(n=>n.externalKey===externalKey);if(existing)return existing;}
    const answer=session.error || session.messages?.filter(m=>m.role==='assistant').at(-1)?.text || '任务已结束。';
    const status={done:'任务完成',error:'任务失败',interrupted:'任务已停止'}[session.status] || '任务更新';
    const notification=this.store.addNotification({agentId:session.agentId,sessionId:session.id,title:session.title,status:session.status,messageId:null,delivery:'pending',externalKey});
    this.store.data.outbox.push({notificationId:notification.id,to:session.notifyChatId || this.store.data.ownerChatId || this.credentials?.ownerId,
      card:card(status,[md(`**${listAgents(this.store).find(a=>a.id===session.agentId)?.name || session.agentId}** · ${safeMarkdown(path.basename(session.cwd))}`),md(answer.slice(0,2500)),row([button('继续这个会话',{action:'session',id:session.id},true),button('选择其他 Agent / 项目',{action:'menu'})])])});
    this.store.save();void this.flushOutbox();return notification;
  }
  async notifyGeneric(event, externalKey=null) {
    const name=event.agent || 'Agent';
    const notification=this.store.addNotification({agentId:name,title:'电脑任务完成',status:event.status==='error'?'error':'done',messageId:null,delivery:'pending',externalKey});
    this.store.data.outbox.push({notificationId:notification.id,to:this.store.data.ownerChatId || this.credentials?.ownerId,
      card:card(`${name} ${event.status==='error'?'失败':'完成'}`,[md(safeMarkdown(event.cwd || event.workspace_roots?.[0] || '')),md(String(event.last_assistant_message || '任务已结束。').slice(0,2500)),row([button('选择 Agent / 项目',{action:'menu'})])])});
    this.store.save();void this.flushOutbox();return notification;
  }
  async flushOutbox() {
    if(this.flushing || !this.connection.connected || !this.credentials)return;
    this.flushing=true;
    try{
      while(this.store.data.outbox.length){
        const item=this.store.data.outbox[0];
        const queuedNotification=this.store.data.notifications.find(n=>n.id===item.notificationId);
        if(queuedNotification?.requestId){const request=this.store.data.requests?.find(r=>r.id===queuedNotification.requestId);if(!request || !['pending','responding'].includes(request.status)){queuedNotification.delivery='superseded';this.store.data.outbox.shift();this.store.save();continue;}}
        try{
          const message=await this.send(item.to || this.credentials.ownerId,item.text ? {text:item.text} : {card:item.card});
          const notification=this.store.data.notifications.find(n=>n.id===item.notificationId);
          if(notification){notification.messageId=message.messageId;notification.delivery='sent';}
          this.store.data.outbox.shift();this.store.save();log('notification.sent',{notificationId:item.notificationId,messageId:message.messageId});
        }catch(error){
          const permanent=['target_revoked','permission_denied','format_error'].includes(error.code);
          if(!permanent){log('notification.retry',{message:error.message});break;}
          const owner=this.store.data.ownerChatId || this.credentials.ownerId;
          if(['target_revoked','permission_denied'].includes(error.code) && item.to!==owner && !item.forwarded){
            item.to=owner;item.forwarded=true;this.store.save();continue;
          }
          if(error.code==='format_error' && !item.text){
            item.text=[item.card.header?.title?.content,...item.card.elements.filter(e=>e.text?.content).map(e=>e.text.content)].filter(Boolean).join('\n\n').slice(0,4000);
            this.store.save();continue;
          }
          const notification=this.store.data.notifications.find(n=>n.id===item.notificationId);
          if(notification){notification.delivery='failed';notification.deliveryError=error.message;}
          this.store.data.outbox.shift();this.store.save();log('notification.failed',{notificationId:item.notificationId,message:error.message});
        }
      }
    }finally{this.flushing=false;}
  }
  async disconnect() {this.generation=(this.generation || 0)+1;clearInterval(this.retryTimer);this.retryTimer=null;const channel=this.channel;this.channel=null;this.connection.connected=false;await channel?.disconnect();}
}
