import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import { findCodex, log } from './config.mjs';
import { codexRolloutStatus } from './catalog.mjs';
import { getAgent } from './registry.mjs';
import { RequestBroker } from './requests.mjs';
import { TerminalRunner } from './terminal.mjs';
import { DshRunner,DshClient } from './dsh.mjs';

export class CodexRpc extends EventEmitter {
  constructor(binary, options={}) { super(); this.binary = binary; this.spawnArgs=options.args || ['app-server','--listen','stdio://']; this.pending = new Map(); this.nextId = 1; this.child = null; this.ready = null; }
  connect() {
    if (this.ready) return this.ready;
    const ready=this.initialize();this.ready=ready;
    ready.catch(()=>{if(this.ready===ready)this.ready=null;});
    return ready;
  }
  async initialize() {
    this.child = spawn(this.binary || findCodex(), this.spawnArgs, {
      windowsHide: true, env: { ...process.env, AGENT_PHONE_MANAGED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child=this.child;let failed=false;
    const fail = error => {
      if(failed || this.child!==child)return;failed=true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.ready = null; this.child=null; this.emit('disconnected', error);
    };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error(`Codex 服务退出（${code}）。`)));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (/ERROR/.test(text)) log('codex.stderr', { text: text.slice(0, 500) });
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      if(this.child!==child)return;
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.id !== undefined && !value.method) {
        const p = this.pending.get(value.id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(value.id);
        value.error ? p.reject(new Error(value.error.message)) : p.resolve(value.result);
      } else if (value.id !== undefined && value.method) {
        let answered=false;
        const respond=(result,error)=>{if(answered || this.child!==child || !child.stdin.writable)return;answered=true;this.write({id:value.id,...(error?{error}:{result})});};
        if(this.listenerCount('interaction'))this.emit('interaction',value,respond);
        else respond(null,{code:-32601,message:'交互处理器未连接。'});
      } else if (value.method) this.emit('notification', value);
    });
    try{
      await this.request('initialize', { clientInfo: { name: 'agent-phone', version: '0.3.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
    }catch(error){child.kill();fail(error);throw error;}
  }
  write(value) { if (!this.child?.stdin.writable) throw new Error('Codex 服务未连接。'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params = {}, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.child?.kill(); }
}

export class AgentEngine extends EventEmitter {
  constructor(store, rpc = new CodexRpc(), options={}) {
    super(); this.store = store; this.rpc = rpc; this.jobs = new Map(); this.codexJobs = new Map();this.runners=new Map();this.options=options;
    this.requests=options.requests || new RequestBroker(store);
    this.requests.on('request',r=>{const s=store.data.sessions.find(s=>s.id===r.sessionId);if(s && r.blocking!==false){s.status='waiting';store.save();}this.emit('attention',r);});
    this.requests.on('resolved',r=>{const s=store.data.sessions.find(s=>s.id===r.sessionId);if(s?.status==='waiting' && !this.requests.pending(s.id).length && (this.jobs.has(s.id) || r.status==='answered')){s.status='running';store.save();}});
    rpc.on('notification', value => this.onCodexNotification(value));
    rpc.on('interaction',(value,respond)=>{void this.onCodexInteraction(value,respond).catch(error=>{log('codex.interaction-error',{message:error.message});respond?.(null,{code:-32603,message:error.message});});});
    rpc.on('disconnected', error => { for (const job of this.codexJobs.values()) {this.requests.cancelSession(job.session.id);job.reject(error);} });
  }
  async askQuestions(job,questions,extra={}) {
    const answers=[];
    for(const question of questions || []) {
      if(job.stopped)return null;
      const response=await this.requests.wait({sessionId:job.session.id,kind:'question',title:question.header || 'Agent 需要你的回复',description:String(question.question || '')+(question.multiSelect?'\n可输入多个选项，用逗号分隔。':''),options:(question.options || []).map((o,i)=>({id:String(i),label:o.label})),...extra});
      if(response.cancelled || job.stopped)return null;
      const option=response.optionId===undefined ? null : question.options?.[Number(response.optionId)];
      answers.push({question,value:option?.label || response.text,selected:option ? [option.label] : []});
    }
    return answers;
  }
  async onCodexInteraction(value,respond) {
    const {method,params={}}=value;const job=this.codexJobs.get(params.threadId);
    if(!job){respond?.(null,{code:-32602,message:'这个任务不由 Agent Phone 管理，请回到原应用处理。'});return;}
    if(job.stopped || (job.turnId && params.turnId && job.turnId!==params.turnId)){respond?.(null,{code:-32602,message:'这个交互所属的任务已经结束。'});return;}
    const spec={sessionId:job.session.id,nativeRequestId:String(value.id)};
    if(method.endsWith('/requestUserInput')) {
      const values=await this.askQuestions(job,params.questions,spec);
      const answers={};for(const {question,value} of values || [])answers[question.id]={answers:[value]};
      respond?.({answers});return;
    }
    if(method==='item/permissions/requestApproval') {
      const response=await this.requests.wait({...spec,kind:'approval',title:'Codex 申请额外权限',description:params.reason || JSON.stringify(params.permissions,null,2),options:[{id:'accept',label:'允许本轮'},{id:'decline',label:'拒绝'}]});
      respond?.({permissions:response.optionId==='accept'?params.permissions:{},scope:'turn'});return;
    }
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)) {
      const command=Array.isArray(params.command)?params.command.join(' '):params.command;
      const response=await this.requests.wait({...spec,kind:'approval',title:method.includes('commandExecution')?'Codex 请求执行命令':'Codex 请求修改文件',description:[params.reason,command,params.cwd,params.grantRoot && `目录：${params.grantRoot}`].filter(Boolean).join('\n'),options:[{id:'accept',label:'允许一次'},{id:'decline',label:'拒绝'},{id:'cancel',label:'停止本轮'}]});
      respond?.({decision:response.cancelled?'cancel':['accept','decline','cancel'].includes(response.optionId)?response.optionId:'decline'});return;
    }
    // Unknown interactions remain visible; never report an action as approved without a valid adapter.
    this.requests.create({...spec,kind:'manual',blocking:false,title:'Codex 需要在电脑上处理',description:`${method}\n这个交互尚不支持远程提交，请回到电脑处理或停止任务。`,options:[{id:'ack',label:'知道了'}]});
    respond?.(null,{code:-32601,message:'这个交互尚不支持远程提交。'});
  }
  start(sessionId, prompt, files = []) {
    const s = this.store.session(sessionId);
    const profile=getAgent(this.store,s.agentId);if(profile.enabled===false)throw new Error('这个 Agent 已停用。');
    if(profile.kind==='hook')throw new Error('这个 Agent 通过事件通知接入，请从原程序启动任务。');
    if (this.jobs.has(s.id)) throw new Error('这个会话仍在运行，请等待完成或点击停止。');
    if(s.source==='external' && s.agentId.startsWith('codex') && s.rolloutPath && codexRolloutStatus(s.rolloutPath)==='running')throw new Error('原 Codex 聊天正在运行，请等它完成后再继续。');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('请输入任务。');
    if (prompt.length > 50000) throw new Error('任务描述过长，请缩短后再发送。');
    const text = files.length ? `${prompt}\n\n用户选择的文件：\n${files.map(f => `- ${f}`).join('\n')}` : prompt;
    s.messages ||= []; s.messages.push({ role: 'user', text: prompt, files, ts: Date.now() });
    s.title = s.title === '新任务' ? prompt.trim().slice(0, 60) : s.title;
    s.status = 'running'; s.managedRunning=true; s.liveText = ''; s.error = null; s.lastTurnId=null; s.updatedAt = Date.now();
    const job = { session: s, stopped: false, child: null, turnId: null, finalText: '' };
    this.jobs.set(s.id, job); this.store.save();
    queueMicrotask(async () => {
      try {
        const answer = profile.kind==='builtin' ? s.agentId === 'claude' ? await this.runClaude(job, text) : await this.runCodex(job, text) : await this.runCustom(job,profile,prompt,files);
        s.status = job.stopped ? 'interrupted' : 'done';
        if (answer && !(s.messages.at(-1)?.role==='assistant' && s.messages.at(-1)?.text===answer)) s.messages.push({ role: 'assistant', text: answer, ts: Date.now() });
      } catch (error) { s.status = job.stopped ? 'interrupted' : 'error'; s.error = job.stopped ? null : error.message; }
      finally {
        this.jobs.delete(s.id);this.requests.cancelSession(s.id);s.liveText = ''; s.managedRunning=false; s.updatedAt = Date.now();
        if (s.remoteId) this.codexJobs.delete(s.remoteId);
        this.store.save(); this.emit('finished', s);
      }
    });
    return s;
  }
  async runCodex(job, prompt) {
    if(job.session.source==='external' && job.session.rolloutPath && codexRolloutStatus(job.session.rolloutPath)==='running')throw new Error('原 Codex 聊天正在运行，请等它完成后再继续。');
    await this.rpc.connect(); const s = job.session;
    if (job.stopped) return '';
    if (s.remoteId) {
      const read = await this.rpc.request('thread/read', { threadId: s.remoteId, includeTurns: false });
      if (read.thread?.status?.type === 'active') throw new Error('原 Codex 聊天正在运行，请等它完成后再继续。');
      await this.rpc.request('thread/resume', { threadId: s.remoteId, excludeTurns: true, approvalPolicy:'on-request',sandbox:'workspace-write' });
    } else {
      const result = await this.rpc.request('thread/start', { cwd: s.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
      s.remoteId = result.thread.id; this.store.save();
    }
    if (job.stopped) return '';
    const completed = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    completed.catch(() => {});
    job.pendingNotifications = [];
    // 提前挂载处理器，兼容 turn/start 响应之前收到的完成事件。
    this.codexJobs.set(s.remoteId, job);
    try {
      const result = await this.rpc.request('turn/start', { threadId: s.remoteId, input: [{ type: 'text', text: prompt }] });
      job.turnId = result.turn.id;
      s.lastTurnId=job.turnId;
      for (const value of job.pendingNotifications.splice(0)) this.onCodexNotification(value);
      if (job.stopped) await this.rpc.request('turn/interrupt', { threadId: s.remoteId, turnId: job.turnId });
      return await completed;
    } catch (error) { this.codexJobs.delete(s.remoteId); throw error; }
  }
  onCodexNotification({ method, params }) {
    if(method==='serverRequest/resolved'){for(const r of this.requests.pending())if(r.nativeRequestId===String(params.requestId))this.requests.cancel(r.id);return;}
    const job = this.codexJobs.get(params?.threadId); if (!job) return;
    const notificationTurnId = params.turnId || params.turn?.id;
    if (job.turnId && notificationTurnId && notificationTurnId !== job.turnId) return;
    if (!job.turnId && notificationTurnId && method !== 'turn/started') {
      job.pendingNotifications.push({ method, params }); return;
    }
    if (method === 'turn/started') {job.turnId = params.turn.id;job.session.lastTurnId=job.turnId;}
    if (method === 'item/agentMessage/delta') { job.session.liveText += params.delta; this.store.emit('change'); }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') job.finalText = params.item.text || job.finalText;
    if (method === 'turn/completed') {
      const turn = params.turn;
      const last = turn.items?.filter(i => i.type === 'agentMessage').at(-1);
      if (turn.status === 'failed') job.reject(new Error(turn.error?.message || 'Codex 任务失败。'));
      else { if (turn.status === 'interrupted') job.stopped = true; job.resolve(last?.text || job.finalText || job.session.liveText); }
    }
    if (method === 'error' && !params.willRetry) job.reject(new Error(params.error?.message || 'Codex 任务出错。'));
  }
  async claudePermission(job,toolName,input,{signal}={}) {
    if(job.stopped || signal?.aborted)return {behavior:'deny',message:'用户停止了任务。'};
    if(toolName==='AskUserQuestion') {
      const values=await this.askQuestions(job,input.questions);
      if(!values)return {behavior:'deny',message:'用户取消了问题。'};
      return {behavior:'allow',updatedInput:{...input,answers:Object.fromEntries(values.map(v=>[v.question.question,v.value]))}};
    }
    let request;
    const aborted=()=>{if(request)this.requests.cancel(request.id);};
    signal?.addEventListener('abort',aborted,{once:true});
    const answer=await new Promise(resolve=>{request=this.requests.create({sessionId:job.session.id,kind:'approval',title:`Claude 请求使用 ${toolName}`,description:typeof input.command==='string'?input.command:JSON.stringify(input,null,2),options:[{id:'allow',label:'允许一次'},{id:'deny',label:'拒绝'}]},resolve);if(signal?.aborted)aborted();});
    signal?.removeEventListener('abort',aborted);
    if(job.stopped || answer.cancelled || signal?.aborted)return {behavior:'deny',message:'用户取消了操作。'};
    return answer.optionId==='allow' ? {behavior:'allow',updatedInput:input} : {behavior:'deny',message:answer.text || '用户拒绝了操作。'};
  }
  async runClaude(job,prompt) {
    const {query}=await import('@anthropic-ai/claude-agent-sdk');const s=job.session;
    if(job.stopped)return '';
    const controller=new AbortController();job.controller=controller;
    const q=(this.options.claudeQuery || query)({prompt,options:{cwd:s.cwd,resume:s.remoteId || undefined,permissionMode:'default',includePartialMessages:true,abortController:controller,env:{...process.env,AGENT_PHONE_MANAGED:'1'},canUseTool:(tool,input,options)=>this.claudePermission(job,tool,input,options),settingSources:['user','project','local']}});
    job.query=q;let result;
    try{
      for await(const e of q) {
        if(e.session_id && !s.remoteId){s.remoteId=e.session_id;this.store.save();}
        if(e.type==='stream_event' && e.event?.delta?.type==='text_delta'){s.liveText+=e.event.delta.text;this.store.emit('change');}
        if(e.type==='assistant'){const text=e.message?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(text)job.finalText=text;}
        if(e.type==='result'){result=e;break;}
      }
      if(job.stopped)return job.finalText;
      if(!result || result.is_error)throw new Error(result?.result || result?.errors?.join('\n') || 'Claude 没有返回任务结果。');
      return result.result || job.finalText || s.liveText;
    }finally{q.close?.();}
  }
  async runCustom(job,profile,prompt,files) {
    const s=job.session;let runner=this.runners.get(s.id);
    if(!runner || runner.closed){runner=profile.kind==='dsh'?new DshRunner(profile):new TerminalRunner(profile);this.runners.set(s.id,runner);
      runner.on('remote-id',id=>{s.remoteId=id;this.store.save();});
      runner.on('output',e=>{s.liveText=(e.replace?'':s.liveText)+e.text;s.liveText=s.liveText.slice(-200000);this.store.emit('change');});
      runner.on('attention',e=>{void this.customAttention(s,runner,e).catch(error=>{const current=this.jobs.get(s.id);current?.reject?.(error);});});
      runner.on('attention-resolved',e=>{for(const r of this.requests.pending(s.id))if(r.nativeRequestId===e.id)this.requests.cancel(r.id);});
    }
    job.runner=runner;
    const completed=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});completed.catch(()=>{});
    const done=e=>{if(e.status==='interrupted')job.stopped=true;s.lastTurnId=e.turnId || null;job.resolve(e.text);};
    const failed=error=>job.reject(error);runner.on('completed',done);runner.on('failed',failed);
    try{if(job.stopped)return '';await runner.start({cwd:s.cwd,prompt,files,sessionId:s.id,remoteId:s.remoteId});if(job.stopped){await runner.stop();return '';}return await completed;}
    finally{runner.off('completed',done);runner.off('failed',failed);}
  }
  async customAttention(s,runner,e) {
    const job=this.jobs.get(s.id);if(!job || job.stopped)return;
    if(e.questions?.length>1){const values=await this.askQuestions(job,e.questions,{nativeRequestId:e.id});if(!values)return;
      await runner.respond(e.id,{answers:values.map(v=>({id:v.question.id,selected:v.selected,...(v.selected.length?{}:{custom:v.value})}))});return;}
    this.requests.create({sessionId:s.id,nativeRequestId:e.id,kind:e.kind,title:'Agent 需要你的操作',description:e.message,options:e.choices || []},answer=>answer.cancelled ? undefined : runner.respond(e.id,answer));
  }
  async input(sessionId,text) {
    const job=this.jobs.get(sessionId);if(!job?.runner)throw new Error('当前 Agent 没有正在运行的终端。');
    if(typeof text!=='string' || !text.trim() || text.length>50000)throw new Error('请输入不超过 50000 字的内容。');
    const pending=this.requests.pending(sessionId);if(pending.length===1)return this.requests.respond(pending[0].id,{text});
    await job.runner.input(text);job.session.messages.push({role:'user',text,ts:Date.now(),interactive:true});this.store.save();return job.session;
  }
  async stop(sessionId) {
    const job = this.jobs.get(sessionId);
    if(!job){const s=this.store.session(sessionId),profile=getAgent(this.store,s.agentId);if(profile.kind==='dsh' && s.remoteId && ['running','waiting'].includes(s.status)){const client=new DshClient(profile.endpoint);await client.rpc('session.cancel',{sessionId:s.remoteId});this.requests.cancelSession(s.id);s.status='interrupted';s.updatedAt=Date.now();this.store.save();return true;}return false;}
    job.stopped = true;
    this.requests.cancelSession(sessionId);
    job.controller?.abort();
    if(job.runner){await job.runner.stop();job.resolve?.('');}
    else if (job.child) killTree(job.child);
    else if (job.turnId) await this.rpc.request('turn/interrupt', { threadId: job.session.remoteId, turnId: job.turnId });
    return true;
  }
  async close() { await Promise.allSettled([...this.jobs.keys()].map(id => this.stop(id)));await Promise.allSettled([...this.runners.values()].map(runner=>runner.close()));this.rpc.close(); }
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}
