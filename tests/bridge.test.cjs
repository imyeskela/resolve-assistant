const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ResolveBridge}=require('../plugin/bridge.cjs');

function captureFixture(){
  let timecode='01:00:00:00';let fail=false;let changed=false;const files=[];
  const timeline={GetUniqueId:async()=>'t',GetName:async()=>'Монтаж',GetSettings:async()=>({timelineFrameRate:'25'}),GetStartFrame:async()=>90000,GetEndFrame:async()=>95000,GetStartTimecode:async()=>'01:00:00:00',GetMarkInOut:async()=>({video:{in:300,out:changed?600:499}}),GetCurrentTimecode:async()=>timecode,SetCurrentTimecode:async value=>{timecode=value;return true;}};
  const bridge=contextBridge({GetCurrentTimeline:async()=>timeline,ExportCurrentFrameAsStill:async file=>{files.push(file);if(fail)throw new Error('export failed');return true;}});
  return {bridge,files,timeline,timecode:()=>timecode,move:tc=>{timecode=tc;},fail:()=>{fail=true;},change:()=>{changed=true;}};
}
test('context reads valid video marks and capture restores the playhead on export failure',async()=>{
  const f=captureFixture();const range=(await f.bridge.context()).project.videoContext;
  assert.equal(range.inTimecode,'01:00:12:00');assert.equal(range.duration,8);
  f.fail();await assert.rejects(f.bridge.captureVideoContext(range,[{file:'frame.png',frame:90300,timecode:'01:00:12:00',seconds:0}]),/export failed/);
  assert.equal(f.timecode(),'01:00:00:00');
});
test('a stale In/Out key fails before any still is exported',async()=>{
  const f=captureFixture();const range=(await f.bridge.context()).project.videoContext;f.change();
  await assert.rejects(f.bridge.captureVideoContext(range,[{file:'frame.png',frame:90300,timecode:'01:00:12:00',seconds:0}]),/изменил|изменён/i);
  assert.equal(f.files.length,0);
});
test('cancelled context capture restores the playhead and never exports another sample',async()=>{
  const f=captureFixture();const range=(await f.bridge.context()).project.videoContext;const abort=new AbortController();
  await assert.rejects(f.bridge.captureVideoContext(range,[{file:'one.png',timecode:'01:00:12:00',seconds:0},{file:'two.png',timecode:'01:00:13:00',seconds:1}],{signal:abort.signal,onStage:()=>abort.abort()}),/отмен/i);
  assert.equal(f.files.length,0);assert.equal(f.timecode(),'01:00:00:00');
});
test('existing timeline transcription is clipped to In/Out with word timings',async()=>{
  const f=captureFixture();f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>({segments:[{start:'01:00:10:00',end:'01:00:21:00',text:'Вне диапазона Рост 35% После',words:[{start:'01:00:10:00',end:'01:00:11:00',text:'Вне диапазона'},{start:'01:00:12:00',end:'01:00:12:10',text:'Рост'},{start:'01:00:12:12',end:'01:00:13:00',text:'35%'},{start:'01:00:20:00',end:'01:00:21:00',text:'После'}]}]})});
  const range=(await f.bridge.context()).project.videoContext;
  const evidence=await f.bridge.captureVideoContext(range,[{file:'one.png',timecode:'01:00:12:00',seconds:0}]);
  assert.deepEqual(evidence.transcript,[{start:0,end:1,text:'Рост 35%'}]);assert.equal(evidence.speechIncluded,true);
});
test('capture aborts on an independent user seek without replacing their position',async()=>{
  const f=captureFixture(),range=(await f.bridge.context()).project.videoContext;
  const originalPush=f.files.push;f.files.push=function(file){originalPush.call(this,file);f.move('01:00:30:00');return this.length;};
  await assert.rejects(f.bridge.captureVideoContext(range,[{file:'one.png',timecode:'01:00:12:00',seconds:0},{file:'two.png',timecode:'01:00:13:00',seconds:1}]),/курсор|позици/i);
  assert.equal(f.files.length,1);assert.equal(f.timecode(),'01:00:30:00');
});

function contextBridge(properties={}){
  const project={GetUniqueId:async()=>'project-1',GetName:async()=>'Name',...properties};
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project}),GetVersionString:async()=>'21.1',GetProductName:async()=>'Studio'};
  return new ResolveBridge({InitializePromise:async()=>true,SetAPITimeout:()=>{},GetResolvePromise:async()=>resolve},'test.plugin');
}
test('active timeline settings override project defaults and expose timeline identity',async()=>{
  const timeline={GetUniqueId:async()=>'timeline-2',GetName:async()=>'Vertical',GetSettings:async()=>({timelineResolutionWidth:'2160',timelineResolutionHeight:'3840',timelineFrameRate:23.976})};
  const bridge=contextBridge({GetSettings:async()=>({timelineResolutionWidth:'1920',timelineResolutionHeight:'1080',timelineFrameRate:'30',projectMediaLocation:'D:\\Media'}),GetCurrentTimeline:async()=>timeline});
  assert.deepEqual((await bridge.context()).project.video,{width:2160,height:3840,fps:23.976,source:'timeline',timelineId:'timeline-2',timelineName:'Vertical'});
});
test('project settings are used when timeline is absent or its settings fail',async()=>{
  for(const timeline of [null,{GetUniqueId:async()=>'t-1',GetName:async()=>'Unavailable settings',GetSettings:async()=>{throw new Error('unsupported');}}]){
    const result=await contextBridge({GetSettings:async()=>({timelineResolutionWidth:'4096',timelineResolutionHeight:'2160',timelineFrameRate:'29.97 DF'}),GetCurrentTimeline:async()=>timeline}).context();
    assert.equal(result.connected,true);assert.equal(result.project.video.width,4096);assert.equal(result.project.video.fps,29.97);assert.equal(result.project.video.source,'project');
    if(timeline)assert.equal(result.project.video.timelineId,'t-1');
  }
});
test('legacy keyed settings remain usable with partial-invalid timeline metadata',async()=>{
  const projectSettings={timelineResolutionWidth:'3072',timelineResolutionHeight:'1728',timelineFrameRate:'25',projectMediaLocation:'D:\\Legacy'};
  const timeline={GetName:async()=>'Partial',GetSettings:async()=>({timelineResolutionWidth:'NaN',timelineResolutionHeight:'2160',timelineFrameRate:Infinity})};
  const result=await contextBridge({GetSetting:async key=>projectSettings[key],GetCurrentTimeline:async()=>timeline}).context();
  assert.deepEqual(result.project.video,{width:3072,height:2160,fps:25,source:'timeline',timelineName:'Partial'});
  assert.equal(result.project.mediaDirectory,'D:\\Legacy');
});
test('missing or malformed optional video SDK APIs do not disconnect Resolve',async()=>{
  for(const properties of [{},{GetCurrentTimeline:async()=>{throw new Error('unsupported');}},{GetSettings:async()=>({timelineResolutionWidth:'1920px',timelineResolutionHeight:0,timelineFrameRate:'oops'})}]){
    const result=await contextBridge(properties).context();
    assert.equal(result.connected,true);assert.equal(result.project.video,null);
  }
});
test('an empty media-directory snapshot still uses the legacy keyed path',async()=>{
  const result=await contextBridge({GetSettings:async()=>({projectMediaLocation:''}),GetSetting:async key=>key==='projectMediaLocation'?'D:\\Legacy Media':undefined}).context();
  assert.equal(result.project.mediaDirectory,'D:\\Legacy Media');
});

test('reads the project media directory without mistaking its name for a disk path',async()=>{
  const project={GetUniqueId:async()=>'project-1',GetName:async()=>'Name',GetSettings:async()=>({projectMediaLocation:'D:\\Video\\Project'})};
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project}),GetVersionString:async()=>'21.1',GetProductName:async()=>'Studio'};
  const sdk={InitializePromise:async()=>true,SetAPITimeout:()=>{},GetResolvePromise:async()=>resolve};
  const result=await new ResolveBridge(sdk,'test.plugin').context();assert.equal(result.project.mediaDirectory,'D:\\Video\\Project');
});
test('an SDK without media-directory settings still connects and allows manual folder choice',async()=>{
  const project={GetUniqueId:async()=>'project-1',GetName:async()=>'Name',GetSettings:async()=>{throw new Error('Unsupported');}};
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project}),GetVersionString:async()=>'21.1',GetProductName:async()=>'Studio'};
  const sdk={InitializePromise:async()=>true,SetAPITimeout:()=>{},GetResolvePromise:async()=>resolve};
  assert.equal((await new ResolveBridge(sdk,'test.plugin').context()).project.mediaDirectory,null);
});
test('initializes the SDK before setting its API timeout',async()=>{
  let initialized=false;
  const project={GetUniqueId:async()=>'project-1',GetName:async()=>'Test'};
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project}),GetVersionString:async()=>'21.1',GetProductName:async()=>'DaVinci Resolve Studio'};
  const sdk={InitializePromise:async()=>{initialized=true;return true;},SetAPITimeout:()=>{if(!initialized)throw new Error('Not initialized');},GetResolvePromise:async()=>resolve};
  const result=await new ResolveBridge(sdk,'test.plugin').context();
  assert.equal(result.project.id,'project-1');
});
test('a changed project blocks import before media pool mutations',async()=>{
  let requestedPool=false;
  const project={GetUniqueId:async()=>'other-project',GetMediaPool:async()=>{requestedPool=true;}};
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project})};
  const sdk={InitializePromise:async()=>true,SetAPITimeout:()=>{},GetResolvePromise:async()=>resolve};
  await assert.rejects(new ResolveBridge(sdk,'test.plugin').importArtifact('output.mov','expected-project'),/Проект изменился/);
  assert.equal(requestedPool,false);
});
test('whole MOV import uses the SDK file-list API without image-sequence indices',async()=>{
  const root={GetSubFolderList:async()=>[],GetClipList:async()=>[]};
  const pool={GetRootFolder:async()=>root,GetCurrentFolder:async()=>root,SetCurrentFolder:async()=>true,
    AddSubFolder:async(_parent,name)=>({GetName:async()=>name,GetSubFolderList:async()=>[],GetClipList:async()=>[]}),
    ImportMedia:async()=>{throw new Error("Invalid 'StartIndex' or 'EndIndex' input specified");}};
  const project={GetUniqueId:async()=>'project-1',GetMediaPool:async()=>pool};
  let imported=false;
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project}),GetMediaStorage:async()=>({AddItemListToMediaPool:async paths=>{
    assert.deepEqual(paths,['output.mov']);imported=true;return [{GetMediaId:async()=>'clip-1'}];
  }})};
  const sdk={InitializePromise:async()=>true,SetAPITimeout:()=>{},GetResolvePromise:async()=>resolve};
  const result=await new ResolveBridge(sdk,'test.plugin').importArtifact('output.mov','project-1');
  assert.equal(imported,true);assert.equal(result.mediaId,'clip-1');
});
