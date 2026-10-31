const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAuthorization, parseCallback, hasPlanPermission}=require('../lib/oauth.cjs');

test('authorization uses independent state and nonce, PKCE and an app-owned host',()=>{
  const a=createAuthorization({hostId:'urn:uuid:123',port:1455});
  const b=createAuthorization({hostId:'urn:uuid:123',port:1456});
  const u=new URL(a.url);
  assert.equal(u.origin,'https://auth.openai.com');
  assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(u.searchParams.get('ext_agent_host_id'),'urn:uuid:123');
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.notEqual(a.state,a.nonce); assert.notEqual(a.state,b.state);
  assert.equal(u.searchParams.get('redirect_uri'),'http://127.0.0.1:1455/auth/callback');
  assert.equal(a.verifier.length>=43,true);
});
test('callback rejects wrong state and substituted registration',()=>{
  const a=createAuthorization({hostId:'urn:uuid:123',port:1455,clientId:'oaiapp_saved'});
  assert.throws(()=>parseCallback('/auth/callback?code=c&state=wrong',a),/state/i);
  assert.throws(()=>parseCallback('/auth/callback?code=c&state='+a.state+'&client_id=oaiapp_other',a),/client/i);
});
test('first registration must return its issued client ID',()=>{
  const a=createAuthorization({hostId:'urn:uuid:123',port:1455});
  assert.throws(()=>parseCallback('/auth/callback?code=c&state='+a.state,a),/client/i);
  const result=parseCallback('/auth/callback?code=c&state='+a.state+'&client_id=oaiapp_new',a);
  assert.equal(result.clientId,'oaiapp_new');
});
test('identity-only sign-in never enables plan inference',()=>{
  assert.equal(hasPlanPermission('openid profile email'),false);
  assert.equal(hasPlanPermission('openid resource.invoke chatgpt.tokens.use.direct'),true);
});
