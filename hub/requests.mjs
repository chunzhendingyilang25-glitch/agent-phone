import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

export class RequestBroker extends EventEmitter {
  constructor(store) {
    super();this.store=store;this.handlers=new Map();store.data.requests ||= [];
    for(const request of store.data.requests)if(['pending','responding'].includes(request.status)){request.status='expired';request.response={cancelled:true};}
  }
  create(spec, handler=null) {
    const request={id:randomUUID(),createdAt:Date.now(),status:'pending',kind:'input',blocking:true,...spec};
    request.title=String(request.title || 'Agent 需要你的操作').slice(0,200);
    request.description=String(request.description || '').slice(0,10000);
    request.options=(request.options || []).slice(0,12).map((o,i)=>typeof o==='string'?{id:String(i),label:o}:{id:String(o.id),label:String(o.label)});
    if(handler)this.handlers.set(request.id,handler);
    this.store.data.requests.unshift(request);let closedCount=0;this.store.data.requests=this.store.data.requests.filter(r=>['pending','responding'].includes(r.status) || closedCount++<150);this.store.save();
    this.emit('request',request);return request;
  }
  wait(spec) {return new Promise(resolve=>this.create(spec,resolve));}
  async respond(id,answer={}) {
    const request=this.store.data.requests.find(r=>r.id===id);
    if(!request || request.status!=='pending')throw new Error('这个请求已经处理或失效。');
    if(answer.text!==undefined && typeof answer.text!=='string')throw new Error('回复必须是文字。');
    const option=answer.optionId===undefined?null:request.options.find(o=>o.id===String(answer.optionId));
    if(answer.optionId!==undefined && !option)throw new Error('无效的操作选项。');
    if(request.kind==='approval' && request.options.length && !option)throw new Error('请点击授权选项；文字回复不会批准操作。');
    if(!option && (typeof answer.text!=='string' || !answer.text.trim()))throw new Error('请选择操作或填写回复。');
    if((answer.text || '').length>50000)throw new Error('回复过长。');
    const response={optionId:option?.id,text:answer.text || option?.label || '',source:answer.source || 'desktop'};
    request.status='responding';this.store.save();
    const handler=this.handlers.get(id);
    try{await handler?.(response);}catch(error){if(request.status==='responding')request.status='pending';this.store.save();throw error;}
    if(request.status==='cancelled' || request.status==='expired')return request;
    request.status='answered';request.answeredAt=Date.now();request.response=response;this.handlers.delete(id);this.store.save();
    this.emit('resolved',request);return request;
  }
  cancelSession(sessionId) {
    for(const request of this.store.data.requests)if(request.sessionId===sessionId && ['pending','responding'].includes(request.status)) {
      this.cancel(request.id);
    }
    this.store.save();
  }
  cancel(id,status='cancelled') {
    const request=this.store.data.requests.find(r=>r.id===id);if(!request || !['pending','responding'].includes(request.status))return false;
    const wasResponding=request.status==='responding';
    request.status=status;request.response={optionId:'cancel',text:'',cancelled:true};
    const handler=this.handlers.get(id);this.handlers.delete(id);this.store.save();
    if(!wasResponding){try{Promise.resolve(handler?.(request.response)).catch(()=>{});}catch{}}
    this.emit('resolved',request);return true;
  }
  pending(sessionId=null) {return this.store.data.requests.filter(r=>r.status==='pending' && (!sessionId || r.sessionId===sessionId));}
}
