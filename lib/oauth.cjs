'use strict';
const crypto=require('node:crypto');
const RESOURCE='https://api.openai.com/v1';
function createAuthorization({hostId,port,clientId,idTokenHint}) {
  const verifier=crypto.randomBytes(48).toString('base64url');
  const state=crypto.randomBytes(32).toString('base64url');
  const nonce=crypto.randomBytes(32).toString('base64url');
  const redirectUri=`http://127.0.0.1:${port}/auth/callback`;
  const params=new URLSearchParams({client_id:clientId||'dynamic_agent_client',ext_agent_host_id:hostId,
    response_type:'code',redirect_uri:redirectUri,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url')});
  if(!clientId)params.set('agent_name_hint','Resolve Assistant');
  if(clientId&&idTokenHint)params.set('id_token_hint',idTokenHint);
  return {url:`https://auth.openai.com/api/accounts/authorize?${params}`,state,nonce,verifier,redirectUri,clientId:clientId||null};
}
function parseCallback(url,attempt) {
  const u=new URL(url,attempt.redirectUri);
  if(u.pathname!=='/auth/callback')throw new Error('Invalid callback path');
  const state=u.searchParams.get('state')||'';
  const a=Buffer.from(state),b=Buffer.from(attempt.state);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error('Invalid OAuth state');
  if(u.searchParams.has('error'))throw new Error('Вход не завершён: '+u.searchParams.get('error'));
  const clientId=u.searchParams.get('client_id')||attempt.clientId;
  if(!clientId||clientId==='dynamic_agent_client')throw new Error('Missing issued client ID');
  if(attempt.clientId&&clientId!==attempt.clientId)throw new Error('OAuth client ID changed');
  const code=u.searchParams.get('code');if(!code)throw new Error('Missing authorization code');
  return {code,clientId};
}
function hasPlanPermission(scope) {
  const scopes=new Set(Array.isArray(scope)?scope:String(scope||'').split(/\s+/));
  return scopes.has('chatgpt.tokens.use.direct')&&scopes.has('resource.invoke');
}
module.exports={createAuthorization,parseCallback,hasPlanPermission,RESOURCE};
