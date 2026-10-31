'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {startPreviewServer}=require('../lib/render.cjs');
const {demoMotion}=require('../lib/motion.cjs');
const {createPreviewCache}=require('../lib/preview-cache.cjs');
const settings={width:640,height:360,fps:30,duration:2};

test('preview rebuilds both engines and legacy jobs without reading or changing saved executable files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'preview-untrusted-'));
  const jobs=new Map();
  for(const engine of ['legacy','hyperframes','remotion']){
    const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(path.join(dir,'assets'),{recursive:true});
    const plan=engine==='remotion'?{...settings,engine,source:'export default function Scene(){return <div>TRUSTED SCENE</div>}'}:{...demoMotion(settings),...(engine==='legacy'?{}:{engine})};
    for(const name of ['index.html','assets/gsap.min.js','assets/remotion.js','source.tsx','motion.mov','job.json'])await fs.writeFile(path.join(dir,name),'SAVED ATTACK '+name);
    jobs.set(id,{id,dir,plan});
  }
  const preview=await startPreviewServer(id=>jobs.get(id));
  t.after(async()=>{await new Promise(r=>preview.server.close(r));await preview.closed;await fs.rm(root,{recursive:true,force:true});});
  for(const job of jobs.values()){
    const url=preview.url(job.id),html=await fetch(url);assert.equal(html.status,200);
    assert.doesNotMatch(await html.text(),/SAVED ATTACK/);
    const asset=job.plan.engine==='remotion'?'assets/remotion.js':'assets/gsap.min.js';
    const response=await fetch(new URL(asset,url));assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/SAVED ATTACK/);
    assert.equal((await fetch(new URL(asset==='assets/remotion.js'?'assets/gsap.min.js':'assets/remotion.js',url))).status,404);
    for(const name of ['index.html','assets/gsap.min.js','assets/remotion.js','source.tsx','motion.mov','job.json'])assert.equal(await fs.readFile(path.join(job.dir,name),'utf8'),'SAVED ATTACK '+name);
  }
});

test('preview rejects missing, oversized, malformed and hostile plans even if saved HTML exists',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-reject-'));await fs.writeFile(path.join(dir,'index.html'),'<script>ATTACK</script>');
  let plan;const id=randomUUID(),preview=await startPreviewServer(()=>({dir,plan}));
  t.after(async()=>{await new Promise(r=>preview.server.close(r));await preview.closed;await fs.rm(dir,{recursive:true,force:true});});
  for(plan of [undefined,{...settings,engine:'unknown'}, {...settings,elements:[{type:'script'}]}, {...settings,engine:'remotion',source:'a'.repeat(120001)}, {...settings,engine:'remotion',source:'new RTCPeerConnection();export default function Scene(){return null}'}, {...settings,engine:'remotion',source:"import x from './saved.js';export default function Scene(){return x}"}]){
    const response=await fetch(preview.url(id));assert.equal(response.status,404);assert.doesNotMatch(await response.text(),/ATTACK/);
  }
});

test('cache deduplicates concurrent rebuilds, invalidates revisions and evicts bounded entries',async t=>{
  let builds=0;const directories=[];
  const cache=await createPreviewCache({maxEntries:1,build:async(dir,plan)=>{
    builds++;directories.push(dir);await new Promise(r=>setTimeout(r,20));
    await fs.mkdir(path.join(dir,'assets'));await fs.writeFile(path.join(dir,'index.html'),plan.name);await fs.writeFile(path.join(dir,'assets/gsap.min.js'),'trusted');
  }});
  t.after(()=>cache.close());
  const job={plan:demoMotion(settings)};
  const first=await Promise.all(Array.from({length:10},()=>cache.read(job,'index.html')));
  assert.equal(builds,1);assert.ok(first.every(bytes=>bytes.toString()===job.plan.name));
  job.plan.name='Revised';assert.equal((await cache.read(job,'index.html')).toString(),'Revised');assert.equal(builds,2);
  assert.equal((await cache.read({plan:demoMotion(settings)},'index.html')).toString(),demoMotion(settings).name);assert.equal(builds,3);
  for(const dir of directories)await assert.rejects(fs.stat(dir),{code:'ENOENT'});
  const root=path.dirname(directories[0]);await cache.close();await cache.close();await assert.rejects(fs.stat(root),{code:'ENOENT'});
  await assert.rejects(cache.read(job,'index.html'),/closed/);
});

test('cache close waits for a pending build and rejects output without leaving temporary files',async()=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);let directory;
  const cache=await createPreviewCache({build:async dir=>{
    directory=dir;started();await gate;await fs.mkdir(path.join(dir,'assets'));
    await fs.writeFile(path.join(dir,'index.html'),'trusted');await fs.writeFile(path.join(dir,'assets/gsap.min.js'),'trusted');
  }});
  const read=cache.read({plan:demoMotion(settings)},'index.html');const rejected=assert.rejects(read,/closed/);
  await ready;const closing=cache.close();release();await closing;await rejected;
  await assert.rejects(fs.stat(path.dirname(directory)),{code:'ENOENT'});
});

test('failed or oversized rebuilds are removed and can be retried; compilation concurrency is bounded',async t=>{
  let builds=0,release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const directories=[];
  const cache=await createPreviewCache({maxBuilds:1,maxBytes:20,build:async dir=>{
    directories.push(dir);builds++;if(builds===1){started();await gate;throw new Error('synthetic compile failure');}
    await fs.mkdir(path.join(dir,'assets'));await fs.writeFile(path.join(dir,'index.html'),'x'.repeat(21));
  }});t.after(()=>cache.close());
  const job={plan:demoMotion(settings)},first=cache.read(job,'index.html');const rejected=assert.rejects(first,/synthetic/);
  await ready;await assert.rejects(cache.read({plan:{...job.plan,name:'other'}},'index.html'),/busy/);release();await rejected;
  await assert.rejects(cache.read(job,'index.html'),/too large/);assert.equal(builds,2);
  for(const dir of directories)await assert.rejects(fs.stat(dir),{code:'ENOENT'});
});
