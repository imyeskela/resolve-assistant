'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const Module=require('node:module');
const storage=require('../lib/storage.cjs');
const authPath=require.resolve('../lib/auth.cjs');
const oldLoad=Module._load;
// Replace only OS encryption: production file reads, writes and lifecycle stay real.
let ChatGPTAuth;
try{
  delete require.cache[authPath];
  Module._load=function(name,parent,isMain){if(parent?.filename===authPath&&name==='./storage.cjs')return {...storage,protect:async value=>Buffer.from(value)};return oldLoad.call(this,name,parent,isMain);};
  ({ChatGPTAuth}=require('../lib/auth.cjs'));
}finally{Module._load=oldLoad;delete require.cache[authPath];}
const scope='resource.invoke chatgpt.tokens.use.direct';
const token=(name='OLD',expiresAt=0)=>({access_token:'FAKE_ACCESS_'+name,refresh_token:'FAKE_REFRESH_'+name,id_token:'FAKE_ID',scope,expires_in:3600,expiresAt});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const settled=promise=>promise.then(value=>({value}),error=>({error}));
const response=body=>({ok:true,status:200,json:async()=>body});
async function fixture(t){
  const base=path.resolve(__dirname,'../.tmp/security-audit');await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'auth-session-'));
  await fs.writeFile(path.join(directory,'account.json'),JSON.stringify({hostId:'urn:uuid:00000000-0000-4000-8000-000000000000',clientId:'FAKE_CLIENT',subject:'FAKE_SUB'}));
  const events=[],a=await new ChatGPTAuth(directory,(event,data)=>events.push({event,data})).init();
  a.discovery=async()=>({});
  a.verify=async()=>({sub:'FAKE_SUB',email:'test@example.invalid'});
  const originalFetch=global.fetch;global.fetch=async()=>{throw new Error('Unexpected network request in auth test');};
  t.after(async()=>{a.cancel();global.fetch=originalFetch;await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
  return {a,events};
}
async function loginCallback(a){
  await a.begin();const pending=a.pending,port=pending.server.address().port,done=deferred();
  pending.server.emit('request',{method:'GET',headers:{host:'127.0.0.1:'+port},url:'/auth/callback?state='+encodeURIComponent(pending.attempt.state)+'&code=FAKE_CODE&client_id=FAKE_CLIENT'},
    {setHeader(){},writeHead(){},end(){done.resolve();}});
  return done.promise;
}

test('concurrent expired credential reads share one refresh request',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token());let requests=0;
  global.fetch=async(url,options)=>{assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');assert.equal(options.body.get('grant_type'),'refresh_token');requests++;return response(token('NEW'));};
  const results=await Promise.allSettled([a.access(),a.access(),a.access()]);
  assert.equal(requests,1);assert.deepEqual(results.map(r=>r.value),['FAKE_ACCESS_NEW','FAKE_ACCESS_NEW','FAKE_ACCESS_NEW']);
});

test('sign out prevents a late refresh from recreating stored credentials',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token());const entered=deferred(),release=deferred();
  global.fetch=async()=>{entered.resolve();return release.promise;};
  const pending=settled(a.access());await entered.promise;await a.signOut();release.resolve(response(token('LATE')));
  const result=await pending;assert.equal(await a.readCredentials(),null);assert.ok(result.error);
});

test('sign out invalidates access that is still reading an unexpired token',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token('OLD',Date.now()+3600000));
  const read=a.readCredentials.bind(a),entered=deferred(),release=deferred();let first=true;
  a.readCredentials=async()=>{const credentials=await read();if(first){first=false;entered.resolve();await release.promise;}return credentials;};
  const pending=settled(a.access());await entered.promise;await a.signOut();release.resolve();
  const result=await pending;assert.ok(result.error);assert.equal(await read(),null);
});

for(const action of ['cancel','signOut'])test(action+' prevents an in-flight code exchange from signing in afterwards',async t=>{
  const {a,events}=await fixture(t),entered=deferred(),release=deferred();
  global.fetch=async()=>{entered.resolve();return release.promise;};
  const callback=loginCallback(a);await entered.promise;await a[action]();release.resolve(response(token('LATE')));await callback;
  assert.equal(await a.readCredentials(),null);assert.equal(events.some(e=>e.event==='authChanged'),false);
});

test('cancel invalidates a refresh already underway',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token());const entered=deferred(),release=deferred();
  global.fetch=async()=>{entered.resolve();return release.promise;};
  const pending=settled(a.access());await entered.promise;a.cancel();release.resolve(response(token('LATE')));
  const result=await pending;assert.ok(result.error);assert.equal((await a.readCredentials()).access_token,'FAKE_ACCESS_OLD');
});

test('logout waits for an in-flight credential write and removes its late result',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token());const save=a.saveCredentials.bind(a),entered=deferred(),release=deferred();
  a.saveCredentials=async value=>{entered.resolve();await release.promise;return save(value);};
  global.fetch=async()=>response(token('LATE'));
  const pending=settled(a.access());await entered.promise;const logout=a.signOut();release.resolve();await logout;const result=await pending;
  assert.equal(await a.readCredentials(),null);assert.ok(result.error);
});

test('stale refresh cleanup cannot remove credentials from a newer login',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token());const save=a.saveCredentials.bind(a),entered=deferred(),release=deferred();
  a.saveCredentials=async value=>{if(value.access_token==='FAKE_ACCESS_OLD_REFRESH'){entered.resolve();await release.promise;}return save(value);};
  global.fetch=async(_url,options)=>response(token(options.body.get('grant_type')==='refresh_token'?'OLD_REFRESH':'NEW_LOGIN'));
  const pending=settled(a.access());await entered.promise;const logout=a.signOut();
  const callback=loginCallback(a);release.resolve();await Promise.all([logout,callback,pending]);
  assert.equal((await a.readCredentials()).access_token,'FAKE_ACCESS_NEW_LOGIN');
});

test('cancel while begin reads credentials does not open a new callback listener',async t=>{
  const {a}=await fixture(t),read=a.readCredentials.bind(a),entered=deferred(),release=deferred();
  a.readCredentials=async()=>{entered.resolve();await release.promise;return read();};
  const pending=settled(a.begin());await entered.promise;a.cancel();release.resolve();const result=await pending;
  assert.ok(result.error);assert.equal(a.pending,null);
});

test('access started during logout cannot reuse credentials awaiting deletion',async t=>{
  const {a}=await fixture(t);await a.saveCredentials(token());
  const save=a.saveCredentials.bind(a),entered=deferred(),release=deferred();
  a.saveCredentials=async value=>{entered.resolve();await release.promise;return save(value);};
  global.fetch=async()=>response(token('REFRESH'));
  const first=settled(a.access());await entered.promise;const logout=a.signOut();
  const second=settled(a.access());await new Promise(resolve=>setTimeout(resolve,30));release.resolve();
  await Promise.all([logout,first]);const result=await second;
  assert.ok(result.error);assert.equal(await a.readCredentials(),null);
});
