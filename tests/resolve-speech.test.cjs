'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ResolveBridge}=require('../plugin/bridge.cjs');

// The external Resolve SDK is the only test double. Capture/filtering and
// cancellation below execute the real bridge, with hand-derived timestamps.
function fixture({fps='25',dropFrame=false}={}){
  let timecode='01:00:00:00',marks={in:300,out:499},projectId='p';
  const timeline={GetUniqueId:async()=>'t',GetName:async()=>'Speech',GetSettings:async()=>({timelineFrameRate:fps,timelineDropFrameTimecode:dropFrame?'1':'0'}),GetStartFrame:async()=>90000,GetEndFrame:async()=>100000,GetStartTimecode:async()=>'01:00:00:00',GetMarkInOut:async()=>({video:marks}),GetCurrentTimecode:async()=>timecode,SetCurrentTimecode:async value=>{timecode=value;return true;}};
  const project={GetUniqueId:async()=>projectId,GetName:async()=>'Project',GetCurrentTimeline:async()=>timeline,ExportCurrentFrameAsStill:async()=>true};
  const resolve={GetProjectManager:async()=>({GetCurrentProject:async()=>project}),GetVersionString:async()=>'21.1',GetProductName:async()=>'Studio'};
  const bridge=new ResolveBridge({InitializePromise:async()=>true,SetAPITimeout:()=>{},GetResolvePromise:async()=>resolve},'speech.test');
  return {timeline,project,bridge,move:tc=>{timecode=tc;},position:()=>timecode,change:()=>{marks={in:301,out:499};},changeProject:()=>{projectId='other';},range:async()=>(await bridge.context()).project.videoContext};
}
const word=(start,end,text)=>({start,end,text});
const data=words=>({language:'ru',segments:[{start:words[0]?.start||'00:00:00:00',end:words.at(-1)?.end||'00:00:00:01',text:words.map(w=>w.text).join(' '),speaker:null,words}]});
const inside=data([word('01:00:12:00','01:00:13:00','Речь')]);

test('existing nested timeline speech is read without retranscribing or background polling',async()=>{
  const f=fixture();let transcriptions=0,reads=0;
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async nested=>{reads++;return nested?inside:null;},TranscribeAudio:async()=>{transcriptions++;return true;}});
  const range=await f.range();assert.equal(reads,0);
  const result=await f.bridge.captureVideoContext(range,[]);
  assert.deepEqual(result.transcript,[{start:0,end:1,text:'Речь'}]);
  assert.equal(result.speechStatus,'ready');assert.equal(result.speechSource,'timeline-nested');assert.equal(result.speechError,null);assert.equal(transcriptions,0);
});

test('words intersect In and inclusive Out, while silence and duplicate words are removed',async()=>{
  const f=fixture();const words=[word('01:00:11:20','01:00:12:05','Начало'),word('01:00:13:00','01:00:14:00','(...)'),word('01:00:19:24','01:00:20:05','Конец'),word('01:00:20:00','01:00:21:00','Снаружи')];
  const transcript=data(words);transcript.segments.push({...transcript.segments[0]});
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>transcript});
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.deepEqual(result.transcript,[{start:0,end:8,text:'Начало Конец'}]);assert.equal(result.speechIncluded,true);
});

test('a segment crossing In/Out is unavailable without word timestamps instead of leaking its full sentence',async()=>{
  const f=fixture();f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>({segments:[{start:'01:00:10:00',end:'01:00:21:00',text:'Secret outside selected interval',words:[]}]})});
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.deepEqual(result.transcript,[]);assert.equal(result.speechStatus,'unavailable');assert.match(result.speechError,/слов|границ/i);
});

test('explicit capture uses native nested transcription and distinguishes empty successful speech',async()=>{
  const f=fixture();let processed=false;const calls=[],stages=[];
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async nested=>processed&&nested?{segments:[]}:null,TranscribeAudio:async(...args)=>{calls.push(args);processed=true;return true;}});
  const range=await f.range();await f.bridge.context();assert.equal(calls.length,0);
  const result=await f.bridge.captureVideoContext(range,[],{onStage:stage=>stages.push(stage)});
  assert.deepEqual(calls,[[false,true]]);assert.equal(result.speechStatus,'no-speech');assert.equal(result.speechIncluded,false);assert.equal(result.speechSource,'timeline-nested');assert.equal(result.speechError,null);assert.ok(stages.some(s=>/DaVinci.*речь/.test(s)));
});

test('SDK failure remains unavailable rather than successful silence',async()=>{
  const f=fixture();f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>{throw new Error('SDK read failed');},TranscribeAudio:async()=>false});
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.equal(result.speechIncluded,false);assert.equal(result.speechStatus,'unavailable');assert.match(result.speechError,/SDK read failed|Resolve.*распозна/i);
});

test('native recognition is bounded and a late result cannot update returned evidence',async()=>{
  const f=fixture();let release;let processed=false;
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>processed?inside:null,TranscribeAudio:()=>new Promise(resolve=>{release=()=>{processed=true;resolve(true);};})});
  const result=await f.bridge.captureVideoContext(await f.range(),[],{speechTimeoutMs:20});
  assert.equal(result.speechStatus,'unavailable');assert.match(result.speechError,/время|ожидан/i);
  release();await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(result.transcript,[]);assert.equal(result.speechIncluded,false);
});

test('cancel immediately rejects recognition and a late SDK completion cannot continue preparation',{timeout:1000},async()=>{
  const f=fixture();const abort=new AbortController();let release;let started;
  const ready=new Promise(resolve=>{started=resolve;});
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>null,TranscribeAudio:()=>{started();return new Promise(resolve=>{release=resolve;});}});
  const pending=f.bridge.captureVideoContext(await f.range(),[],{signal:abort.signal,speechTimeoutMs:1000});
  await ready;abort.abort();await assert.rejects(pending,/отмен/i);release(true);
});

test('changed In/Out or project during recognition rejects the entire context',async()=>{
  for(const change of ['change','changeProject']){
    const f=fixture();let processed=false;
    f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async nested=>processed&&nested?inside:null,TranscribeAudio:async()=>{processed=true;f[change]();return true;}});
    await assert.rejects(f.bridge.captureVideoContext(await f.range(),[]),/изменил|изменён/i);
  }
});

function sourceFixture(){
  const f=fixture();const media={GetClipProperty:async()=>({FPS:'50','Start TC':'10:00:00:00',Type:'Audio'}),GetTranscription:async()=>data([word('10:00:01:40','10:00:02:10','Первое'),word('10:00:03:00','10:00:04:00','Второе'),word('10:00:06:00','10:00:07:00','После клипа')])};
  const clip={GetStart:async()=>90300,GetEnd:async()=>90400,GetClipEnabled:async()=>true,GetSpeed:async()=>({Percentage:100}),GetSourceStartFrame:async()=>100,GetSourceEndFrame:async()=>300,GetSourceStartTime:async()=>2,GetSourceEndTime:async()=>6,GetMediaPoolItem:async()=>media};
  f.timeline.GetTrackCount=async()=>1;f.timeline.GetIsTrackEnabled=async()=>true;f.timeline.GetItemListInTrack=async()=>[clip];
  return {...f,clip,media};
}
test('source fallback maps trimmed source timecode and different FPS to the timeline',async()=>{
  const f=sourceFixture();const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.deepEqual(result.transcript,[{start:0,end:2,text:'Первое Второе'}]);assert.equal(result.speechSource,'source-clips');assert.equal(result.speechStatus,'ready');
});

test('disabled audio tracks and disabled clips are never included as heard speech',async()=>{
  for(const disabled of ['track','clip']){
    const f=sourceFixture();if(disabled==='track')f.timeline.GetIsTrackEnabled=async()=>false;else f.clip.GetClipEnabled=async()=>false;
    const result=await f.bridge.captureVideoContext(await f.range(),[]);
    assert.deepEqual(result.transcript,[]);assert.equal(result.speechIncluded,false);assert.equal(result.speechStatus,'no-speech');
  }
});

test('retimed, reverse and compound source fallback explicitly reports unsupported mapping',async()=>{
  for(const modify of [f=>{f.clip.GetSpeed=async()=>({Percentage:50});},f=>{f.clip.GetSpeed=async()=>({Percentage:-100});},f=>{f.media.GetClipProperty=async()=>({FPS:'50','Start TC':'10:00:00:00',Type:'Compound'});}]){
    const f=sourceFixture();modify(f);const result=await f.bridge.captureVideoContext(await f.range(),[]);
    assert.deepEqual(result.transcript,[]);assert.equal(result.speechStatus,'unavailable');assert.match(result.speechError,/ретайм|reverse|compound|сложн/i);
  }
});

test('missing source trim or unknown track enable state refuses to guess word positions',async()=>{
  for(const modify of [f=>{delete f.clip.GetSourceStartFrame;delete f.clip.GetSourceStartTime;},f=>{delete f.timeline.GetIsTrackEnabled;}]){
    const f=sourceFixture();modify(f);const result=await f.bridge.captureVideoContext(await f.range(),[]);
    assert.deepEqual(result.transcript,[]);assert.equal(result.speechStatus,'unavailable');assert.ok(result.speechError);
  }
});

test('playhead is restored before slow speech preparation and later user seeks survive',async()=>{
  const f=fixture();let processed=false;
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>processed?inside:null,TranscribeAudio:async()=>{assert.equal(f.position(),'01:00:00:00');f.move('01:00:30:00');processed=true;return true;}});
  const result=await f.bridge.captureVideoContext(await f.range(),[{file:'frame.png',timecode:'01:00:12:00'}]);
  assert.equal(result.speechStatus,'ready');assert.equal(f.position(),'01:00:30:00');
});

test('drop-frame boundary words use the actual numbered frames and inclusive Out',async()=>{
  const f=fixture({fps:'29.97',dropFrame:true});
  f.timeline.GetStartFrame=async()=>107892;f.timeline.GetEndFrame=async()=>120000;
  f.timeline.GetStartTimecode=async()=>'01:00:00;00';f.timeline.GetMarkInOut=async()=>({video:{in:1798,out:1801}});
  f.timeline.GetMediaPoolItem=async()=>({GetTranscription:async()=>data([word('01:00:59;27','01:00:59;29','До минуты'),word('01:01:00;02','01:01:00;04','После минуты')])});
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.equal(result.speechStatus,'ready');assert.equal(result.transcript[0].text,'До минуты После минуты');
  assert.equal(result.transcript[0].start,0);assert.ok(Math.abs(result.transcript[0].end-4/29.97)<1e-9);
});

test('fallback transcribes only enabled intersecting source clips and does not repeat the same source',async()=>{
  const f=sourceFixture();let processed=false;const calls=[];
  f.media.GetUniqueId=async()=>'same-source';
  const transcript=await f.media.GetTranscription();f.media.GetTranscription=async()=>processed?transcript:null;
  f.media.TranscribeAudio=async(...args)=>{calls.push(args);processed=true;return true;};
  const disabled={...f.clip,GetClipEnabled:async()=>false,GetMediaPoolItem:async()=>{throw new Error('disabled clip must not be read');}};
  const outside={...f.clip,GetStart:async()=>91000,GetEnd:async()=>91100,GetMediaPoolItem:async()=>{throw new Error('outside clip must not be read');}};
  f.timeline.GetItemListInTrack=async()=>[f.clip,{...f.clip},disabled,outside];
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.deepEqual(calls,[[false]]);assert.equal(result.speechStatus,'ready');
  assert.deepEqual(result.transcript,[{start:0,end:2,text:'Первое Второе'}]);
});

test('successful source recognition clears an earlier transient read error',async()=>{
  const f=sourceFixture();let processed=false;
  f.media.GetTranscription=async()=>{if(!processed)throw new Error('not yet ready');return {segments:[]};};
  f.media.TranscribeAudio=async()=>{processed=true;return true;};
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.equal(result.speechStatus,'no-speech');assert.equal(result.speechError,null);
});

test('combined source transcript obeys the request text budget',async()=>{
  const f=sourceFixture();
  const makeData=prefix=>({segments:Array.from({length:24},(_,i)=>({start:'10:00:02:00',end:'10:00:03:00',text:`${prefix}${i}`.padEnd(500,'x'),words:[]}))});
  const second={...f.media,GetUniqueId:async()=>'second',GetTranscription:async()=>makeData('B')};
  f.media.GetUniqueId=async()=>'first';f.media.GetTranscription=async()=>makeData('A');
  f.timeline.GetItemListInTrack=async()=>[f.clip,{...f.clip,GetMediaPoolItem:async()=>second}];
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.equal(result.speechStatus,'ready');assert.ok(result.transcript.reduce((sum,row)=>sum+row.text.length,0)<=12000);
});

test('source seconds remain usable when optional source frame methods are unavailable',async()=>{
  const f=sourceFixture();delete f.clip.GetSourceStartFrame;delete f.clip.GetSourceEndFrame;
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.equal(result.speechStatus,'ready');assert.deepEqual(result.transcript,[{start:0,end:2,text:'Первое Второе'}]);
});

test('source drop-frame metadata and absolute start timecode map without a one-hour assumption',async()=>{
  const f=sourceFixture();
  f.media.GetClipProperty=async()=>({FPS:'29.97 DF','Start TC':'10:00:00;00',Type:'Audio'});
  f.media.GetTranscription=async()=>data([word('10:00:03;10','10:00:04;10','Дробная частота')]);
  f.clip.GetSourceStartFrame=async()=>100;f.clip.GetSourceEndFrame=async()=>220;
  f.clip.GetSourceStartTime=async()=>100/29.97;f.clip.GetSourceEndTime=async()=>220/29.97;
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.equal(result.speechStatus,'ready');assert.equal(result.transcript[0].start,0);
  assert.ok(Math.abs(result.transcript[0].end-30/29.97)<1e-9);assert.equal(result.transcript[0].text,'Дробная частота');
});

test('disagreeing source frame and second offsets are unavailable instead of guessed',async()=>{
  const f=sourceFixture();f.clip.GetSourceStartTime=async()=>20;
  const result=await f.bridge.captureVideoContext(await f.range(),[]);
  assert.deepEqual(result.transcript,[]);assert.equal(result.speechStatus,'unavailable');assert.match(result.speechError,/координат|ретайм/i);
});
