const {test}=require('node:test');const assert=require('node:assert/strict');
const runtime=()=>require('../lib/generation-runtime.cjs');
test('real activity extends idle allowance past the old cutoff but never the total bound',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const errors=[];const {createGenerationWatchdog}=runtime();
  const w=createGenerationWatchdog({idleMs:50,totalMs:250,onTimeout:e=>errors.push(e.code)});
  for(let i=0;i<6;i++){t.mock.timers.tick(40);w.activity();}assert.deepEqual(errors,[]);t.mock.timers.tick(10);assert.deepEqual(errors,['GENERATION_TOTAL_TIMEOUT']);w.stop();
});
test('silence expires independently and stopping watchdog removes pending callbacks',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const errors=[];const {createGenerationWatchdog}=runtime();
  createGenerationWatchdog({idleMs:50,totalMs:250,onTimeout:e=>errors.push(e.code)});t.mock.timers.tick(50);assert.deepEqual(errors,['GENERATION_IDLE_TIMEOUT']);
  const w=createGenerationWatchdog({idleMs:50,totalMs:250,onTimeout:e=>errors.push(e.code)});w.stop();t.mock.timers.tick(300);assert.equal(errors.length,1);
});
test('diagnostics contain only bounded event metadata and never provider text or credentials',()=>{
  const {createGenerationDiagnostics}=runtime();const d=createGenerationDiagnostics({model:'chosen',effort:'high',engine:'remotion'});
  d.record('item/agentMessage/delta',{delta:'PRIVATE PROMPT Bearer TOKEN',itemId:'secret',other:'private'});d.record('error',{error:{message:'Bearer TOKEN',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}}},willRetry:true});
  const text=JSON.stringify(d.snapshot());assert.doesNotMatch(text,/PRIVATE|TOKEN|secret|private/);assert.match(text,/429/);assert.match(text,/delta/);
});
