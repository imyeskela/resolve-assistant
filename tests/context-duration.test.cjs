'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {normalizeVideoSettings,normalizeMotion,buildComposition,demoMotion}=require('../lib/motion.cjs');
const {normalizeReactComposition,prepareRemotionComposition}=require('../lib/remotion.cjs');
const {prepareComposition}=require('../lib/render.cjs');
const {prepareContextImages,normalizeRange}=require('../lib/video-context.cjs');
const base={width:640,height:360,fps:24,duration:5};
const context=(requestedDuration,extra={})=>({...base,durationMode:'videoContext',requestedDuration,...extra});
const source='export default function Scene(){return <div>Context</div>}';
async function directory(t,name){const root=path.resolve(__dirname,'../.tmp');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,name));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return dir;}

test('context settings quantize unrounded seconds instead of the manual field or old limits',()=>{
  for(const [requestedDuration,fps,frameCount]of [[1.542,24,37],[23.7,30,711],[65,30,1950],[0.001,120,1]]){
    const actual=normalizeVideoSettings(context(requestedDuration,{fps}));
    assert.equal(actual.requestedDuration,requestedDuration);
    assert.equal(actual.durationMode,'videoContext');
    assert.equal(actual.frameCount,frameCount);
    assert.equal(actual.duration,frameCount/fps);
    assert.deepEqual(normalizeVideoSettings(JSON.parse(JSON.stringify(actual))),actual);
  }
});

test('changing output fps requantizes the original context seconds after persistence',()=>{
  const first=normalizeVideoSettings(context(1.542));
  const reloaded=JSON.parse(JSON.stringify(first));
  const second=normalizeVideoSettings({...reloaded,fps:30});
  assert.equal(second.requestedDuration,1.542);
  assert.equal(second.frameCount,46);
  assert.equal(second.duration,46/30);
  const third=normalizeVideoSettings({...second,fps:60});
  assert.equal(third.frameCount,93);
  assert.equal(third.duration,93/60);
});

test('manual settings retain their existing limits and model context claims confer no authority',()=>{
  for(const duration of [1.542,23.7]){
    assert.throws(()=>normalizeVideoSettings({...base,duration,requestedDuration:8}),/duration/);
    assert.throws(()=>normalizeVideoSettings({...base,duration,durationMode:'manual',requestedDuration:8}),/duration/);
  }
  for(const requestedDuration of [undefined,null,0,-1,'1.542',NaN,Infinity,Number.MAX_SAFE_INTEGER]){
    assert.throws(()=>normalizeVideoSettings(context(requestedDuration)),/duration/i);
  }
  const claimed={durationMode:'videoContext',requestedDuration:23.7,duration:23.7};
  const hyper=normalizeMotion({...claimed,elements:[{type:'text'}]},base);
  const native=normalizeReactComposition({...claimed,source},base);
  assert.equal(hyper.duration,5);assert.equal(native.duration,5);
  assert.notEqual(hyper.durationMode,'videoContext');assert.notEqual(native.durationMode,'videoContext');
});

test('HyperFrames rejects the installed renderer duration limit before preparation',()=>{
  assert.throws(()=>normalizeVideoSettings(context(86401,{engine:'hyperframes'})),/HyperFrames.*24|24.*HyperFrames/i);
  assert.equal(normalizeReactComposition({source},context(86401)).requestedDuration,86401);
});

test('both scene engines retain context timing through saved plan normalization',()=>{
  for(const requestedDuration of [1.542,23.7]){
    const settings=context(requestedDuration);
    const hyper=normalizeMotion({elements:[{type:'text',end:requestedDuration}]},settings);
    const native=normalizeReactComposition({source},settings);
    for(const plan of [hyper,native]){
      const saved=JSON.parse(JSON.stringify(plan));
      const reopened=plan.engine==='remotion'?normalizeReactComposition(saved,saved):normalizeMotion(saved,saved);
      assert.equal(reopened.requestedDuration,requestedDuration);
      assert.equal(reopened.durationMode,'videoContext');
      assert.equal(reopened.frameCount,requestedDuration===1.542?37:569);
      assert.equal(reopened.duration,reopened.frameCount/24);
    }
    assert.equal(hyper.elements[0].end,hyper.duration);
  }
});

test('one-frame HyperFrames contexts keep layers and animations inside the output interval',()=>{
  const plan=normalizeMotion({elements:[{type:'text',end:0.001}]},context(0.001,{fps:120}));
  assert.equal(plan.frameCount,1);
  assert.equal(plan.elements[0].start,0);
  assert.equal(plan.elements[0].end,1/120);
  const script=buildComposition(plan).match(/<script>\n([\s\S]*?)<\/script>/)[1];
  const tweens=[];const timeline={fromTo(selector,from,to,start){tweens.push({duration:to.duration,start});return this;},to(selector,to,start){tweens.push({duration:to.duration,start});return this;}};
  require('node:vm').runInNewContext(script,{gsap:{timeline:()=>timeline},window:{},URLSearchParams,location:{search:''}});
  for(const tween of tweens){assert.ok(tween.start>=0);assert.ok(tween.start+tween.duration<=plan.duration+1e-12);}
  assert.equal(demoMotion(context(0.001,{fps:120})).frameCount,1);
});

test('prepared artifacts retain quantized context duration for both renderers',async t=>{
  const dir=await directory(t,'duration-artifacts-');
  const hyper=normalizeMotion({elements:[{type:'text'}]},context(1.542));
  await prepareComposition(path.join(dir,'hyper'),hyper);
  assert.match(await fs.readFile(path.join(dir,'hyper/index.html'),'utf8'),/data-duration="1\.5416666666666667"/);
  const native=normalizeReactComposition({source},context(65));
  await prepareRemotionComposition(path.join(dir,'native'),native);
  const config=JSON.parse(await fs.readFile(path.join(dir,'native/remotion-render.json'),'utf8'));
  assert.equal(config.frameCount,1560);assert.equal(config.duration,65);
  assert.equal(config.requestedDuration,65);assert.equal(config.durationMode,'videoContext');
});

test('native worker accepts a valid context above its former 1800-frame cap',async t=>{
  const dir=await directory(t,'duration-worker-');
  await fs.writeFile(path.join(dir,'remotion-render.json'),JSON.stringify({...context(65,{fps:30}),engine:'remotion',duration:65,frameCount:1950}));
  // Browser startup is the external boundary; no generated scene executes here.
  const puppeteer=require('puppeteer-core'),dependency=require.resolve('puppeteer-core'),worker=require.resolve('../lib/remotion-worker.cjs');
  require.cache[dependency].exports={...puppeteer,launch:async()=>{throw new Error('test-browser-boundary');}};
  delete require.cache[worker];
  try{await assert.rejects(require(worker).main(dir),/test-browser-boundary/);}
  finally{require.cache[dependency].exports=puppeteer;delete require.cache[worker];}
});

test('frame preparation preserves speech availability details independently of attachments',async t=>{
  const dir=await directory(t,'duration-speech-');
  const {run}=require('../lib/process.cjs');
  const raw=path.join(dir,'still.png');
  await run(require('../lib/runtime.cjs').runtimeExecutable('ffmpeg'),['-v','error','-f','lavfi','-i','color=red:s=640x360','-frames:v','1','-y',raw]);
  const range=normalizeRange({projectId:'p',timelineId:'t',fps:24,timelineStart:0,timelineEnd:100,markIn:0,markOut:36});
  const prepared=await prepareContextImages({range,directory:dir,exports:[{file:raw,seconds:0}],transcript:[],speechStatus:'unavailable',speechSource:'davinci',speechError:'SDK unavailable'});
  assert.equal(prepared.speechIncluded,false);
  assert.equal(prepared.speechStatus,'unavailable');assert.equal(prepared.speechSource,'davinci');assert.equal(prepared.speechError,'SDK unavailable');
});
