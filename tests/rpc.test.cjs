const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RpcClient,createTurnResult}=require('../lib/codex.cjs');
const childCode=`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.method==='echo')process.stdout.write(JSON.stringify({id:m.id,result:m.params})+'\\n');if(m.method==='die')process.exit(2);});`;
test('stdio RPC matches responses and rejects requests when the child exits',async()=>{
  const c=new RpcClient(process.execPath,['-e',childCode]);
  try{assert.deepEqual(await c.request('echo',{value:'кириллица'}),{value:'кириллица'});await assert.rejects(c.request('die',{}),/заверш|closed|exit/i);}finally{c.close();}
});
test('stdio RPC timeout does not leave an unresolved promise',async()=>{
  const c=new RpcClient(process.execPath,['-e',childCode]);
  try{await assert.rejects(c.request('ignore',{},30),/время|timeout/i);}finally{c.close();}
});
test('recoverable server errors allow the eventual successful turn to finish',async()=>{
  const result=createTurnResult();
  result.handle('error',{willRetry:true,error:{message:'temporary transport error'}});
  result.handle('item/completed',{item:{type:'agentMessage',text:'{"name":"done"}'}});
  result.handle('turn/completed',{turn:{status:'completed'}});
  assert.equal(await result.promise,'{"name":"done"}');
});
test('real reasoning/text events report activity; retry notifications do not impersonate model progress',async()=>{
  let activity=0;const stages=[];const result=createTurnResult(s=>stages.push(s),{onActivity:()=>activity++});
  result.handle('item/started',{item:{type:'reasoning'}});result.handle('item/reasoning/summaryTextDelta',{delta:'private reasoning'});result.handle('item/agentMessage/delta',{delta:'{"partial":'});
  assert.equal(activity,3);result.handle('error',{willRetry:true,error:{message:'temporary'}});assert.equal(activity,3);assert.ok(stages.length);assert.ok(!stages.some(s=>s.includes('private')));
  result.handle('item/completed',{item:{type:'agentMessage',text:'{"name":"done"}'}});result.handle('turn/completed',{turn:{status:'completed'}});assert.equal(await result.promise,'{"name":"done"}');
});
test('partial deltas never become a successful final composition',async()=>{
  const r=createTurnResult();r.handle('item/agentMessage/delta',{delta:'{"name":"partial"}'});r.handle('turn/completed',{turn:{status:'completed'}});await assert.rejects(r.promise,/полного|полный|ответ/);
});
test('permanent provider errors stop even when marked retryable; repeated transient retries are bounded',{timeout:1000},async()=>{
  for(const status of [401,403,429]){const r=createTurnResult();r.handle('error',{willRetry:true,error:{message:'Bearer secret',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:status}}}});await assert.rejects(r.promise,e=>!e.message.includes('secret'));}
  const r=createTurnResult();for(let i=0;i<4;i++)r.handle('error',{willRetry:true,error:{message:'network'}});await assert.rejects(r.promise,/соедин|повтор|связ/);
});
test('closing an RPC process immediately rejects pending requests and is idempotent',async()=>{
  const c=new RpcClient(process.execPath,['-e',childCode]);const response=c.request('ignore',{},5000);c.close();c.close();await assert.rejects(response,/closed|заверш|останов/i);
});
