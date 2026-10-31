'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const video=require('../lib/video-context.cjs');
const metadata={projectId:'p',timelineId:'t',timelineName:'Монтаж',fps:25,timelineStart:90000,timelineEnd:95000,markIn:300,markOut:499,dropFrame:false};

test('relative inclusive In/Out produces an eight-second timeline context',()=>{
  const range=video.normalizeRange(metadata);
  assert.equal(range.startFrame,90300);assert.equal(range.endFrame,90499);assert.equal(range.duration,8);
  assert.equal(range.inTimecode,'01:00:12:00');assert.equal(range.outTimecode,'01:00:19:24');
  assert.equal(video.normalizeRange({...metadata,markIn:undefined}),null);
  assert.equal(video.normalizeRange({...metadata,markOut:30000}),null);
  assert.equal(video.normalizeRange({...metadata,markOut:299}),null);
  assert.notEqual(video.normalizeRange({...metadata,markOut:500}).key,range.key);
});
test('drop-frame samples use legal timecodes and fractional playback rate',()=>{
  assert.equal(video.frameToTimecode(1800,29.97,true),'00:01:00;02');
  assert.equal(video.frameToTimecode(17982,29.97,true),'00:10:00;00');
  assert.equal(video.timecodeToFrame('00:01:00;02',29.97,true),1800);
  assert.equal(video.timecodeToFrame('00:01:00;00',29.97,true),null);
  assert.equal(video.frameToTimecode(3600,59.94,true),'00:01:00;04');
  assert.equal(video.frameToTimecode(24,23.976,false),'00:00:01:00');
});
test('sampling covers both ends, stays inside the range and is bounded for long clips',()=>{
  const frames=video.sampleFrames(video.normalizeRange({...metadata,markIn:0,markOut:4999}));
  assert.equal(frames.length,12);assert.equal(frames[0].frame,90000);assert.equal(frames.at(-1).frame,94999);
  assert.equal(new Set(frames.map(f=>f.frame)).size,12);
  assert.equal(video.sampleFrames(video.normalizeRange({...metadata,markOut:300})).length,1);
});
test('real FFmpeg preparation emits bounded JPEG attachments and rejects missing stills',async t=>{
  const base=path.resolve(__dirname,'../.tmp');await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'context-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {run}=require('../lib/process.cjs');
  const raw=path.join(dir,'frame-0.png');await run(require('../lib/runtime.cjs').runtimeExecutable('ffmpeg'),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=1920x1080','-frames:v','1','-y',raw]);
  const prepared=await video.prepareContextImages({range:video.normalizeRange(metadata),directory:dir,exports:[{file:raw,frame:90300,seconds:0,timecode:'01:00:12:00'}]});
  assert.equal(prepared.frames.length,1);assert.equal(prepared.frames[0].seconds,0);
  assert.ok((await fs.stat(prepared.frames[0].path)).size<1024*1024);
  const info=JSON.parse(await run(require('../lib/runtime.cjs').runtimeExecutable('ffprobe'),['-v','error','-show_streams','-of','json',prepared.frames[0].path]));
  assert.equal(info.streams[0].width,1280);assert.equal(info.streams[0].height,720);
  await assert.rejects(video.prepareContextImages({range:video.normalizeRange(metadata),directory:dir,exports:[{file:path.join(dir,'missing.png'),seconds:0}]}));
});
