import fs from 'node:fs';
import path from 'node:path';
import {registerApp} from '@larksuite/channel';
import {getLocations} from './paths.cjs';

export function saveCredentials(credentials,env=process.env) {
  const {appId,appSecret,ownerId}=credentials;
  if(![appId,appSecret,ownerId].every(v=>typeof v==='string' && v.trim() && v.length<2000))throw new Error('请填写完整的 App ID、App Secret 和接收者 Open ID。');
  const {dataDir,routerConfig}=getLocations(env);fs.mkdirSync(dataDir,{recursive:true});
  const contents=`[[providers]]\nid = "feishu_lark"\napp_id = ${JSON.stringify(appId.trim())}\napp_secret = ${JSON.stringify(appSecret.trim())}\noperator_open_id = ${JSON.stringify(ownerId.trim())}\n`;
  fs.writeFileSync(routerConfig+'.tmp',contents,{mode:0o600});fs.renameSync(routerConfig+'.tmp',routerConfig);
  fs.rmSync(path.join(dataDir,'binding-disabled'),{force:true});return {configured:true};
}
export class SetupManager {
  constructor(onBound,options={}) {this.onBound=onBound;this.registration=options.registerApp || registerApp;this.env=options.env || process.env;this.pairing=null;this.controller=null;}
  state() {
    const {routerConfig,dataDir}=getLocations(this.env);
    return {configured:fs.existsSync(routerConfig) && !fs.existsSync(path.join(dataDir,'binding-disabled')),pairing:this.pairing, pairingStatus:this.pairing?.status || null};
  }
  async startPairing() {
    this.controller?.abort();const controller=new AbortController();this.controller=controller;
    this.pairing={status:'preparing'};
    const ready=new Promise((resolve,reject)=>{
      void this.registration({signal:controller.signal,source:'agent-phone',createOnly:true,appPreset:{name:'Agent Phone 助手',description:'电脑上的 Agent 与手机沟通'},
        onQRCodeReady:info=>{
          if(this.controller!==controller)return;
          const url=info.url;const code=new URL(url).searchParams.get('user_code');
          this.pairing={status:'waiting',url,code,expiresAt:Date.now()+(info.expireIn || 600)*1000};
          resolve(this.pairing);void import('qrcode').then(({default:qr})=>qr.toDataURL(url)).then(qrUrl=>{if(this.controller===controller)this.pairing.qrUrl=qrUrl;}).catch(()=>{});
        },
        onStatusChange:info=>{if(this.controller===controller && this.pairing)this.pairing.status=info.status || this.pairing.status;}
      }).then(async result=>{
        if(this.controller!==controller)return;
        if(!result.user_info?.open_id)throw new Error('绑定没有返回接收者身份，请使用已有凭据填写接收者 Open ID。');
        saveCredentials({appId:result.client_id,appSecret:result.client_secret,ownerId:result.user_info.open_id},this.env);
        this.pairing={status:'bound'};await this.onBound();resolve(this.pairing);
      }).catch(error=>{if(this.controller===controller)this.pairing={status:'error',error:error.message};reject(error);});
    });
    return ready;
  }
  async credentials(body){this.controller?.abort();this.controller=null;saveCredentials(body,this.env);this.pairing={status:'bound'};await this.onBound();return this.state();}
  disconnect(){this.controller?.abort();this.controller=null;this.pairing=null;const {dataDir}=getLocations(this.env);fs.mkdirSync(dataDir,{recursive:true});fs.writeFileSync(path.join(dataDir,'binding-disabled'),'disabled');return this.state();}
  close(){this.controller?.abort();this.controller=null;}
}
