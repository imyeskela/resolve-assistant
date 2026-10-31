const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');const fs=require('node:fs/promises');const Module=require('node:module');const childProcess=require('node:child_process');
const runtime=require('../lib/generation-runtime.cjs');
test('complete generation session handles active streams, silence, total cap, abort, child exit and incomplete output',async()=>{
  const oldLoad=Module._load;const codexPath=require.resolve('../lib/codex.cjs');const auth={models:async()=>[{id:'test',reasoningEfforts:['low'],defaultReasoningEffort:'low'}],access:async()=>'test-only'};
  for(const scenario of ['active','idle','total','abort','exit','partial','commentary']){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'generation-session-'));const abort=new AbortController();let summary;
    try{
      delete require.cache[codexPath];Module._load=function(name,parent,isMain){
        if(parent?.filename===codexPath&&name==='node:child_process')return {...childProcess,spawn:(_exe,_args,opts)=>childProcess.spawn(process.execPath,[path.join(__dirname,'fixtures/fake-generation-server.cjs'),scenario],opts)};
        if(parent?.filename===codexPath&&name==='./generation-runtime.cjs')return {...runtime,createGenerationWatchdog:options=>runtime.createGenerationWatchdog({...options,idleMs:100,totalMs:scenario==='active'?500:180})};
        return oldLoad.call(this,name,parent,isMain);
      };
      const {generatePlan}=require('../lib/codex.cjs');Module._load=oldLoad;
      const promise=generatePlan({auth,prompt:'test',model:'test',effort:'low',profileDir:dir,settings:{engine:'remotion',width:640,height:360,fps:30,duration:2},signal:abort.signal,onStage:stage=>{if(scenario==='abort'&&stage.startsWith('Модель продумывает'))abort.abort();},onDiagnostic:d=>summary=d});
      if(scenario==='active'){const plan=await promise;assert.equal(plan.name,'complete');assert.equal(plan.engine,'remotion');assert.ok(summary.counts['item/completed']>=4);}
      else if(['idle','total','abort'].includes(scenario)){const codes={idle:'GENERATION_IDLE_TIMEOUT',total:'GENERATION_TOTAL_TIMEOUT',abort:'GENERATION_CANCELLED'};await assert.rejects(promise,e=>e.code===codes[scenario],scenario);assert.equal(summary.outcome,codes[scenario]);}
      else await assert.rejects(promise,scenario==='exit'?/заверш|closed/:/полного|ответ/);
      assert.doesNotMatch(JSON.stringify(summary),/test-only|export default/);
    }finally{Module._load=oldLoad;delete require.cache[codexPath];await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  }
});
