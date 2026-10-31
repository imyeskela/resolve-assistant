'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {normalizeMotion}=require('../lib/motion.cjs');
const {normalizeReactComposition,renderRemotion}=require('../lib/remotion.cjs');
const {renderMotion}=require('../lib/render.cjs');
const {normalizeScenePlan,renderTrustedScene}=require('../lib/trusted-scene.cjs');
const settings={width:360,height:360,fps:1,duration:2};

test('both render entrypoints rebuild saved plans and publish only the verified MOV',{timeout:120000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'render-untrusted-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
  for(const kind of ['hyperframes','remotion','remotion-direct']){
    const dir=path.join(root,kind);await fs.mkdir(path.join(dir,'assets'),{recursive:true});
    const plan=kind==='hyperframes'?normalizeMotion({elements:[{type:'rect',x:20,y:20,width:80,height:80}]},settings):normalizeReactComposition({source:'export default function Scene(){return <div>Trusted render</div>}'},settings);
    const names=['index.html','source.tsx','assets/remotion.js','assets/gsap.min.js','remotion-render.json','hyperframes.json','job.json'];
    for(const name of names)await fs.writeFile(path.join(dir,name),'UNTRUSTED SAVED '+name);
    await fs.writeFile(path.join(dir,'motion.mov'),'PREVIOUS MOV');
    const output=await (kind==='remotion-direct'?renderRemotion:renderMotion)(dir,plan);
    assert.equal(output.file,path.join(dir,'motion.mov'));assert.ok(output.bytes>100);assert.equal(output.codec,'prores');
    for(const name of names)assert.equal(await fs.readFile(path.join(dir,name),'utf8'),'UNTRUSTED SAVED '+name);
    assert.deepEqual((await fs.readdir(dir)).sort(),[...names.filter(name=>!name.includes('/')),'assets','motion.mov'].sort());
  }
});

test('invalid saved plans leave an earlier MOV and job artifacts intact',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'render-reject-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'motion.mov'),'PREVIOUS MOV');
  for(const [render,plan]of [
    [renderMotion,{...settings,elements:[{type:'script'}]}],
    [renderMotion,{...settings,engine:'remotion',source:'new RTCPeerConnection();export default function Scene(){return null}'}],
    [renderRemotion,{...settings,engine:'remotion',width:'360;throw 1',source:'export default function Scene(){return null}'}]
  ]){
    await assert.rejects(render(dir,plan));assert.equal(await fs.readFile(path.join(dir,'motion.mov'),'utf8'),'PREVIOUS MOV');assert.deepEqual(await fs.readdir(dir),['motion.mov']);
  }
});

test('failed and cancelled private renders clean up without replacing an earlier MOV',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'render-lifecycle-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'motion.mov'),'PREVIOUS MOV');
  for(const cancelled of [false,true]){
    const abort=new AbortController();let temporary;
    await assert.rejects(renderTrustedScene(dir,normalizeScenePlan({...settings,elements:[{type:'rect'}]}),{
      signal:abort.signal,prepare:async root=>{temporary=root;await fs.writeFile(path.join(root,'index.html'),'trusted');},
      render:async root=>{const file=path.join(root,'motion.mov');await fs.writeFile(file,'PARTIAL RENDER');if(cancelled){abort.abort();return {file};}throw new Error('synthetic render failure');}
    }),cancelled?/отмен/:/synthetic render failure/);
    await assert.rejects(fs.stat(temporary),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(dir,'motion.mov'),'utf8'),'PREVIOUS MOV');assert.deepEqual(await fs.readdir(dir),['motion.mov']);
  }
});

test('normalization preserves legacy visuals, fractional FPS and context frame counts',()=>{
  for(const fps of [23.976,29.97,60])for(const requestedDuration of [1.542,23.7]){
    const video={...settings,fps,engine:'hyperframes',durationMode:'videoContext',requestedDuration};
    const legacy=normalizeMotion({name:'Legacy',background:'#112233',elements:[{type:'text',text:'Сохранённый титр',x:12,y:23,width:250,height:100,end:requestedDuration,color:'#123456',enter:'slide'}]},video);
    assert.deepEqual(normalizeScenePlan(legacy),legacy);
    const native=normalizeReactComposition({name:'Native',source:'export default function Scene(){return <div>Original</div>}'},{...video,engine:'remotion'});
    assert.deepEqual(normalizeScenePlan(native),native);
  }
});
