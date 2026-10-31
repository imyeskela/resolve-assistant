'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildChatRequest,normalizeChatResult}=require('../lib/codex.cjs');
const models=[{id:'chosen',reasoningEfforts:['low'],defaultReasoningEffort:'low'}];
const settings={engine:'remotion',width:640,height:360,fps:30,duration:2};

test('chat sends only this conversation, the selected source, and bounded successful history',()=>{
  const previous={engine:'remotion',source:'export default()=> <div>selected old version</div>'};
  const result=buildChatRequest({models,prompt:'Почему синий?',settings,previous,history:[{role:'user',text:'Синий акцент',status:'completed'},{role:'assistant',text:'Готово',status:'completed',versionId:'old'},{role:'user',text:'failed secret',status:'failed'}]});
  const body=JSON.parse(result.input[0].text);
  assert.equal(body.previousComposition.source,previous.source);assert.equal(body.request,'Почему синий?');
  assert.deepEqual(body.conversation.map(m=>({role:m.role,text:m.text})),[{role:'user',text:'Синий акцент'},{role:'assistant',text:'Готово'}]);
  assert.doesNotMatch(result.input[0].text,/failed secret/);assert.ok(result.outputSchema.properties.action);assert.ok(result.outputSchema.properties.composition);
  const many=buildChatRequest({models,prompt:'next',settings,history:Array.from({length:100},(_,i)=>({role:'user',text:String(i)+'x'.repeat(4000),status:'completed'}))});
  const bounded=JSON.parse(many.input[0].text);assert.ok(bounded.conversation.length<100);assert.equal(bounded.historyTruncated,true);assert.ok(many.input[0].text.length<100000);assert.match(bounded.conversation.at(-1).text,/^99/);
});

test('saved frame metadata identifies each originating snapshot alongside its actual attachment',()=>{
 const r=buildChatRequest({models,prompt:'Сравни',settings,inheritedContext:{snapshots:[{id:'a',transcript:[]},{id:'b',transcript:[]}],frames:[{path:'C:/trusted/a.jpg',seconds:0,snapshotId:'a'},{path:'C:/trusted/b.jpg',seconds:0,snapshotId:'b'}]}});const c=JSON.parse(r.input[0].text);assert.deepEqual(c.savedContext.frames.map(f=>f.snapshotId),['a','b']);assert.deepEqual(r.input.slice(1).map(f=>f.path),['C:/trusted/a.jpg','C:/trusted/b.jpg']);
});

test('saved context discloses attachments and transcript omitted by the request budget',()=>{
 const frames=Array.from({length:12},(_,i)=>({path:'C:/trusted/current-'+i+'.jpg',seconds:i}));const r=buildChatRequest({models,prompt:'Дальше',settings,videoContext:{range:{},frames,transcript:[]},inheritedContext:{snapshots:[{id:'old',transcript:[{start:0,end:1,text:'x'.repeat(25000)}]}],frames:[{path:'C:/trusted/old.jpg',seconds:0,snapshotId:'old'}]}});const c=JSON.parse(r.input[0].text);assert.equal(c.savedContext.truncated,true);assert.equal(c.savedContext.frames.length,0);assert.equal(r.input.filter(x=>x.type==='localImage').length,12);
});

test('text answers create no plan; malformed or conflicting replies are rejected',()=>{
  assert.deepEqual(normalizeChatResult({action:'reply',message:'Так читается лучше.',composition:null},settings),{message:'Так читается лучше.',plan:null});
  for(const value of [{action:'reply',message:'',composition:null},{action:'revise',message:'готово',composition:null},{action:'reply',message:'текст',composition:{name:'bad',source:'bad'}},{action:'unknown',message:'x',composition:null}])assert.throws(()=>normalizeChatResult(value,settings),/ответ|компози|формат/i);
});

test('revision validates native source and preserves chosen canvas parameters',()=>{
  const result=normalizeChatResult({action:'revise',message:'Сделал крупнее.',composition:{name:'Крупнее',source:"import React from 'react'; export default function Scene(){return <div>Текст</div>}"}},settings);
  assert.equal(result.message,'Сделал крупнее.');assert.equal(result.plan.width,640);assert.equal(result.plan.engine,'remotion');assert.equal(result.plan.frameCount,60);
  assert.throws(()=>normalizeChatResult({action:'revise',message:'x',composition:{name:'bad',source:''}},settings),/TSX/);
});

test('a child version sends fixed basis and persisted reference contents with real image attachments',()=>{
 const result=buildChatRequest({models:[{...models[0],inputModalities:['text','image']}],prompt:'Продолжим',settings,previous:{source:'export default()=> <div>Base</div>'},selectedVersionId:'v2',baseVersionId:'v1',baseRevisionId:'revision-1',inheritedContext:{snapshots:[{id:'context-1',transcript:[{start:0,end:1,text:'Важные слова'}],frames:[{seconds:0}]}],frames:[{path:'C:/trusted/context/image-0.jpg',seconds:0}],warnings:[]},history:[{role:'assistant',text:'Сохраняем красный акцент',status:'completed'}]});
 const content=JSON.parse(result.input[0].text);assert.equal(content.versionBasis.parentVersionId,'v1');assert.equal(content.versionBasis.baseRevisionId,'revision-1');assert.equal(content.savedContext.snapshots[0].transcript[0].text,'Важные слова');assert.equal(result.input[1].type,'localImage');assert.equal(result.input[1].path,'C:/trusted/context/image-0.jpg');
});
