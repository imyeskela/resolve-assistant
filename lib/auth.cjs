'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const {atomicWrite,readJson,protect}=require('./storage.cjs');
const {createAuthorization,parseCallback,hasPlanPermission,RESOURCE}=require('./oauth.cjs');
function normalizeModelCatalog(data){
  const list=Array.isArray(data?.models)?data.models:Array.isArray(data?.data)?data.data:[];
  const result=[],seen=new Set();
  const validEffort=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,24}$/.test(value);
  for(const m of list){
    if(!m||typeof m!=='object'||m.hidden||(m.visibility&&m.visibility!=='list'))continue;
    const id=m.slug||m.model||m.id;
    if(typeof id!=='string'||!id.trim()||seen.has(id))continue;
    const advertised=m.supportedReasoningEfforts??m.supported_reasoning_efforts??m.supported_reasoning_levels??m.reasoning_efforts;
    const reasoningEfforts=[...new Set((Array.isArray(advertised)?advertised:[]).map(e=>typeof e==='string'?e:e?.reasoningEffort??e?.effort).filter(validEffort))];
    const preferred=m.defaultReasoningEffort??m.default_reasoning_effort??m.default_reasoning_level;
    const defaultReasoningEffort=reasoningEfforts.includes(preferred)?preferred:reasoningEfforts[0]||null;
    const name=m.displayName||m.display_name||id;
    const modalities=m.inputModalities??m.input_modalities;
    result.push({id,name:typeof name==='string'?name:id,reasoningEfforts,defaultReasoningEffort,...(Array.isArray(modalities)?{inputModalities:modalities.filter(v=>['text','image','audio'].includes(v))}:{})});seen.add(id);
  }
  return result;
}
async function requestJson(url,options={}) {
  const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok){const e=new Error(`OpenAI: HTTP ${response.status}. ${response.status===429?'Достигнут лимит использования.':response.status===401?'Требуется повторный вход.':'Проверьте доступность сервиса и разрешения приложения.'}`);e.status=response.status;throw e;}
  return response.json();
}
class ChatGPTAuth {
  constructor(dataDir,emit=()=>{}){this.dir=dataDir;this.emit=emit;this.pending=null;this.refreshing=null;}
  async init(){await fs.mkdir(this.dir,{recursive:true});this.meta=await readJson(path.join(this.dir,'account.json'),{});if(!this.meta.hostId){this.meta.hostId='urn:uuid:'+randomUUID();await this.saveMeta();}return this;}
  async saveMeta(){await atomicWrite(path.join(this.dir,'account.json'),JSON.stringify(this.meta,null,2));}
  async readCredentials(){try{return JSON.parse((await protect(await fs.readFile(path.join(this.dir,'session.dpapi')),true)).toString());}catch(e){if(e.code==='ENOENT')return null;throw new Error('Не удалось открыть защищённую сессию. Выполните вход заново.');}}
  async saveCredentials(tokens){await atomicWrite(path.join(this.dir,'session.dpapi'),await protect(Buffer.from(JSON.stringify(tokens))));}
  async state(){const credentials=await this.readCredentials();return {connected:!!credentials&&hasPlanPermission(credentials.scope),email:this.meta.email||null,waiting:!!this.pending,route:'Подписка ChatGPT'};}
  async discovery(){if(!this.oidc){this.oidc=await requestJson('https://auth.openai.com/.well-known/openid-configuration');if(this.oidc.issuer!=='https://auth.openai.com'||new URL(this.oidc.jwks_uri).origin!=='https://auth.openai.com')throw new Error('Некорректный OpenID discovery');}return this.oidc;}
  async verify(idToken,clientId,nonce){const {jwtVerify,createRemoteJWKSet}=await import('jose');const oidc=await this.discovery();this.jwks??=createRemoteJWKSet(new URL(oidc.jwks_uri));const {payload}=await jwtVerify(idToken,this.jwks,{issuer:oidc.issuer,audience:clientId,requiredClaims:['sub','exp','iat'],clockTolerance:5});if(nonce&&payload.nonce!==nonce)throw new Error('ID token nonce не совпал');if(typeof payload.sub!=='string'||!payload.sub)throw new Error('ID token без личности');return payload;}
  async begin(){
    if(this.pending)throw new Error('Вход уже открыт в браузере');
    const existing=await this.readCredentials();
    const server=http.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    const attempt=createAuthorization({hostId:this.meta.hostId,port,clientId:this.meta.clientId,idTokenHint:existing?.id_token});
    const pending={server,attempt,exchanging:false};this.pending=pending;
    const close=()=>{clearTimeout(pending.timer);server.close();if(this.pending===pending)this.pending=null;};
    pending.timer=setTimeout(()=>{close();this.emit('authError',{message:'Время входа истекло. Нажмите «Продолжить с ChatGPT» ещё раз.'});},300000);
    server.on('request',async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
      if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${port}`||!req.url.startsWith('/auth/callback?')){res.writeHead(404);res.end();return;}
      if(pending.exchanging){res.writeHead(409);res.end('Вход уже обрабатывается');return;}
      let callback;try{callback=parseCallback(req.url,attempt);}catch(e){res.writeHead(400);res.end('Не удалось проверить вход. Вернитесь в Resolve.');if(req.url.includes('error=')){close();this.emit('authError',{message:e.message});}return;}
      pending.exchanging=true;
      try{
        this.meta.clientId=callback.clientId;await this.saveMeta();
        const tokens=await requestJson('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:callback.clientId,code:callback.code,code_verifier:attempt.verifier,redirect_uri:attempt.redirectUri,resource:RESOURCE})});
        const identity=await this.verify(tokens.id_token,callback.clientId,attempt.nonce);
        if(this.meta.subject&&identity.sub!==this.meta.subject)throw new Error('Выбран другой аккаунт. Используйте регистрацию исходного аккаунта.');
        if(!hasPlanPermission(tokens.scope))throw new Error('Разрешение использовать подписку ChatGPT не выдано');
        if(typeof tokens.access_token!=='string'||!Number.isFinite(tokens.expires_in))throw new Error('Некорректный ответ авторизации');
        this.meta={...this.meta,email:identity.email||identity.sub,subject:identity.sub};await this.saveMeta();
        await this.saveCredentials({...tokens,expiresAt:Date.now()+tokens.expires_in*1000});
        res.end('Подписка ChatGPT подключена. Вернитесь в Resolve Assistant.');close();this.emit('authChanged',await this.state());
      }catch(e){res.writeHead(400);res.end('Вход не завершён. Подробности доступны в Resolve Assistant.');close();this.emit('authError',{message:e.message});}
    });
    return {url:attempt.url};
  }
  cancel(){if(this.pending){clearTimeout(this.pending.timer);this.pending.server.close();this.pending=null;}}
  async access(){
    if(this.refreshing)return this.refreshing;
    const c=await this.readCredentials();if(!c||!hasPlanPermission(c.scope))throw new Error('Сначала подключите подписку ChatGPT');
    if(c.expiresAt>Date.now()+60000)return c.access_token;
    this.refreshing=(async()=>{
      if(!c.refresh_token)throw new Error('Требуется повторный вход в ChatGPT');
      const t=await requestJson('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:this.meta.clientId,refresh_token:c.refresh_token,resource:RESOURCE})});
      if(t.id_token){const identity=await this.verify(t.id_token,this.meta.clientId);if(identity.sub!==this.meta.subject)throw new Error('Личность сессии изменилась');}
      const next={...c,...t,scope:t.scope||c.scope,expiresAt:Date.now()+t.expires_in*1000};
      if(!hasPlanPermission(next.scope)||typeof next.access_token!=='string'||!Number.isFinite(next.expiresAt))throw new Error('Обновление сессии не разрешило использование подписки');
      await this.saveCredentials(next);return next.access_token;
    })();
    try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async models(){const access=await this.access();return normalizeModelCatalog(await requestJson(RESOURCE+'/models',{headers:{Authorization:'Bearer '+access}}));}
  async signOut(){this.cancel();const c=await this.readCredentials();let revoked=false;try{if(c?.refresh_token){const oidc=await this.discovery();const endpoint=oidc.revocation_endpoint;if(endpoint&&new URL(endpoint).origin==='https://auth.openai.com'){const r=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:c.refresh_token,token_type_hint:'refresh_token',client_id:this.meta.clientId})});revoked=r.status===200;}}}catch{}await fs.rm(path.join(this.dir,'session.dpapi'),{force:true});return {revoked,message:revoked?'Сессия завершена':'Локальный выход выполнен. Отзыв сессии на сервере не подтверждён; доступ можно отключить в настройках ChatGPT.'};}
}
module.exports={ChatGPTAuth,requestJson,normalizeModelCatalog};
