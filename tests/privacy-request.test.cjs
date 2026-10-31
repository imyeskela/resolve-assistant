'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildChatRequest}=require('../lib/codex.cjs');

const privatePath='C:/Users/PRIVATE_OWNER/PRIVATE_PROJECT/media.mov';
const options=()=>({models:[{id:'test-model',reasoningEfforts:['low'],defaultReasoningEffort:'low',inputModalities:['text','image']}],model:'test-model',effort:'low',prompt:'Сделай титр',settings:{engine:'remotion',width:640,height:360,fps:24,duration:2},history:[]});
const range=()=>({timelineName:'Таймлайн',inTimecode:'00:00:00:00',outTimecode:'00:00:01:23',duration:2,projectId:'PRIVATE_PROJECT_ID',timelineId:'PRIVATE_TIMELINE_ID',key:'PRIVATE_RANGE_KEY',mediaPath:privatePath});

test('AI input excludes local diagnostic and untyped metadata while preserving intended speech and images',()=>{
  const o=options();
  o.videoContext={range:range(),frames:[{path:'C:/prepared/current.jpg',seconds:0,timecode:'00:00:00:00'}],speechStatus:'ready',speechSource:'timeline',speechError:'Cannot open '+privatePath,transcript:[{start:0,end:1,text:'Рост 35%',file:privatePath}]};
  o.inheritedContext={snapshots:[{id:'saved',range:range(),speechStatus:'unavailable',speechSource:privatePath,speechError:'Cannot open '+privatePath,transcript:[{start:1,end:2,text:'Сохранённая речь',file:privatePath}]}],frames:[{snapshotId:'saved',path:'C:/prepared/saved.jpg',seconds:1,timecode:'00:00:01:00'}],warnings:['Cannot read '+privatePath]};
  o.assetManifest=[{path:privatePath,metadata:{directory:privatePath}}];
  const request=buildChatRequest(o),wireText=request.input[0].text,data=JSON.parse(wireText);
  assert.equal(wireText.includes('PRIVATE_'),false,'machine diagnostics, project identifiers and untyped local metadata must not enter model text');
  assert.deepEqual(data.videoContext.transcript,[{start:0,end:1,text:'Рост 35%'}]);
  assert.deepEqual(data.savedContext.snapshots[0].transcript,[{start:1,end:2,text:'Сохранённая речь'}]);
  assert.equal(data.savedContext.snapshots[0].speechStatus,'unavailable');
  assert.equal(data.savedContext.snapshots[0].range.timelineName,'Таймлайн');
  assert.deepEqual(request.input.filter(x=>x.type==='localImage').map(x=>x.path),['C:/prepared/current.jpg','C:/prepared/saved.jpg'],'image paths remain local app-server inputs');
  assert.equal(o.videoContext.speechError,'Cannot open '+privatePath,'local diagnostic must remain available in the application');
});

test('privacy filtering does not silently rewrite user text, scene source or transcript contents',()=>{
  const o=options();o.prompt='Нарисуй текст '+privatePath;o.previous={source:'const title="'+privatePath+'";'};
  const request=buildChatRequest(o),data=JSON.parse(request.input[0].text);
  assert.equal(data.request,o.prompt);assert.deepEqual(data.previousComposition,o.previous);
});

test('malformed scalar metadata cannot smuggle nested fields into model text',()=>{
  const o=options(),bad={privatePath};
  o.videoContext={range:{timelineName:bad,inTimecode:bad,outTimecode:bad,duration:bad},frames:[{path:'C:/prepared/current.jpg',seconds:bad,timecode:bad}]};
  o.inheritedContext={snapshots:[{id:bad,range:null,transcript:[]}],frames:[{path:'C:/prepared/saved.jpg',snapshotId:bad,seconds:bad,timecode:bad}]};
  const request=buildChatRequest(o),data=JSON.parse(request.input[0].text);
  assert.equal(request.input[0].text.includes('PRIVATE_'),false);
  assert.deepEqual(data.savedContext.snapshots[0].range,{});
});
