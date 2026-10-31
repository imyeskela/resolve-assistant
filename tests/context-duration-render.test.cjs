'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {normalizeMotion}=require('../lib/motion.cjs');
const {normalizeReactComposition}=require('../lib/remotion.cjs');
const {prepareComposition,renderMotion,FFPROBE}=require('../lib/render.cjs');
const {run}=require('../lib/process.cjs');

test('both engines render short and long context MOVs at the chosen output frame count',{timeout:240000},async t=>{
  const root=path.resolve(__dirname,'../.tmp');await fs.mkdir(root,{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'context-render-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}));
  for(const engine of ['remotion','hyperframes']){
    for(const [requestedDuration,fps,frames]of [[1.542,24,37],[23.7,4,95]]){
      const settings={width:360,height:360,fps,duration:5,durationMode:'videoContext',requestedDuration,engine};
      const plan=engine==='remotion'?normalizeReactComposition({source:"export default function Scene(){return <div style={{position:'absolute',left:20,top:20,width:80,height:80,background:'#F39B59'}}/>}"},settings):normalizeMotion({elements:[{type:'rect',x:20,y:20,width:80,height:80,end:requestedDuration}]},settings);
      const jobDir=path.join(dir,engine+'-'+fps);
      await prepareComposition(jobDir,plan);
      const output=await renderMotion(jobDir,plan);
      const info=JSON.parse(await run(FFPROBE,['-v','error','-show_streams','-show_format','-of','json',output.file]));
      const stream=info.streams.find(value=>value.codec_type==='video');
      assert.equal(Number(stream.nb_frames),frames,engine+' frame count');
      assert.ok(Math.abs(Number(stream.duration)-requestedDuration)<=0.5/fps,engine+' duration within half an output frame');
      assert.equal(stream.codec_name,'prores');assert.match(stream.pix_fmt,/^yuva/);
      assert.equal(output.durationMode,'videoContext');assert.equal(output.requestedDuration,requestedDuration);assert.equal(output.frameCount,frames);
    }
  }
});

test('both engines retain decimal and exact NTSC fractional FPS in real MOV streams',{timeout:120000},async t=>{
  const root=path.resolve(__dirname,'../.tmp');await fs.mkdir(root,{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'fractional-render-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}));
  for(const engine of ['remotion','hyperframes'])for(const fps of [29.97,30000/1001]){
    const settings={width:360,height:360,fps,durationMode:'videoContext',requestedDuration:0.2,engine};
    const plan=engine==='remotion'?normalizeReactComposition({source:"export default function Scene(){return <div style={{width:80,height:80,background:'#F39B59'}}/>}"},settings):normalizeMotion({elements:[{type:'rect',x:20,y:20,width:80,height:80,end:0.2}]},settings);
    const jobDir=path.join(dir,engine+'-'+fps);await fs.mkdir(jobDir);
    const output=await renderMotion(jobDir,plan);
    const info=JSON.parse(await run(FFPROBE,['-v','error','-show_streams','-of','json',output.file]));
    const stream=info.streams.find(s=>s.codec_type==='video'),[n,d]=stream.avg_frame_rate.split('/').map(Number);
    assert.ok(Math.abs(n/d-fps)<1e-9,engine+' must preserve requested FPS without NTSC snapping');
    assert.equal(Number(stream.nb_frames),6);assert.match(stream.pix_fmt,/^yuva/);
  }
});
