'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {Controller}=require('../lib/controller.cjs');const {WorkspaceStore}=require('../lib/workspaces.cjs');const {demoMotion}=require('../lib/motion.cjs');const {normalizeRange}=require('../lib/video-context.cjs');
const settings={engine:'hyperframes',width:640,height:360,fps:30,duration:2};
async function setup(t,generator){const parent=path.resolve(__dirname,'../.tmp');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'versions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const media=path.join(root,'Media');await fs.mkdir(media);const c=new Controller(root,()=>{},{chatGenerator:generator});c.workspace=await new WorkspaceStore(root).init();c.loadedDirs=new Set();c.preview={url:id=>'http://127.0.0.1/test/'+id};await c.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});return{c,root,media};}
test('only explicit plus creates visible versions; each version keeps a separate chat and immutable basis',async t=>{
 const seen=[];let count=0;const {c}=await setup(t,async x=>{seen.push(x);return {message:x.prompt==='Почему?'?'Пояснение':'Готово',plan:x.prompt==='Почему?'?null:demoMotion({...settings,name:'Scene '+(++count)})};});
 const chat=await c.handle('conversation.create',{settings});assert.equal(chat.versions.length,1);const v1=chat.selectedVersionId;
 const first=await c.handle('chat.send',{conversationId:chat.id,versionId:v1,prompt:'Создай',settings});assert.equal(first.conversation.versions.length,1);
 const plus={compositionId:chat.id,baseVersionId:v1,requestId:'plus-1'};const second=await c.handle('version.create',plus);const v2=second.selectedVersionId;assert.notEqual(v1,v2);assert.equal(second.versions.length,2);assert.equal(seen.length,1);assert.deepEqual(second.messages,[]);
 assert.equal((await c.handle('version.create',plus)).versions.length,2);
 await c.handle('version.update',{compositionId:chat.id,versionId:v2,draft:'Черновик V2',manualDurationSeconds:5,videoContextEnabled:false});
 const q=await c.handle('chat.send',{conversationId:chat.id,versionId:v2,prompt:'Почему?',settings});assert.equal(q.job,null);assert.equal(q.conversation.versions.length,2);
 const edit=await c.handle('chat.send',{conversationId:chat.id,versionId:v2,prompt:'Синий',settings});assert.equal(edit.job.logicalVersionId,v2);assert.equal(edit.job.parentId,first.job.id);assert.equal(edit.conversation.versions.length,2);
 await c.handle('chat.send',{conversationId:chat.id,versionId:v1,prompt:'Другой V1',settings});
 const own1=await c.handle('version.get',{compositionId:chat.id,versionId:v1}),own2=await c.handle('version.get',{compositionId:chat.id,versionId:v2});
 assert.equal(own1.messages.some(m=>m.text==='Почему?'),false);assert.equal(own2.messages.some(m=>m.text==='Другой V1'),false);
 const inner=c.conversations.getVersion(c.conversation(chat.id),v2);assert.equal(inner.baseRevisionId,first.job.id);assert.deepEqual(inner.baseSnapshot.plan,first.job.plan);
 const third=await c.handle('version.create',{compositionId:chat.id,baseVersionId:v1,requestId:'plus-2'});assert.equal(third.versions.length,3);assert.equal(third.versions.at(-1).parentVersionId,v1);
});
test('a persisted context survives a text-only answer and is inherited after restart',async t=>{
 const seen=[];const {c,root,media}=await setup(t,async x=>{seen.push(x);return{message:'Это красный кадр',plan:null};});const range=normalizeRange({projectId:'a',timelineId:'t',timelineName:'Тест',fps:24,timelineStart:0,timelineEnd:1000,markIn:0,markOut:36});
 await c.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media,videoContext:range}});const chat=await c.handle('conversation.create',{settings});const capture=await c.handle('videoContext.prepare',{range});
 const {run}=require('../lib/process.cjs');for(const f of capture.exports)await run(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x64','-frames:v','1','-y',f.file]);
 const answer=await c.handle('chat.send',{conversationId:chat.id,versionId:chat.selectedVersionId,prompt:'Что здесь?',settings,contextId:capture.id,contextTranscript:[{start:0,end:.5,text:'Привет'}],contextSpeechStatus:'ready',contextSpeechSource:'timeline'});
 assert.equal(answer.job,null);assert.equal(answer.conversation.contextSnapshots.length,1);const snap=answer.conversation.contextSnapshots[0];assert.equal(snap.transcript[0].text,'Привет');assert.equal(seen[0].settings.frameCount,46);assert.equal(seen[0].settings.requestedDuration,37/24);
 const persisted=c.conversations.getVersion(c.conversation(chat.id)).contextSnapshotIds[0];assert.ok(persisted);await assert.rejects(fs.access(capture.directory));
 const restored=new Controller(root,()=>{},{chatGenerator:async x=>{seen.push(x);return{message:'Продолжаем',plan:null};}});restored.workspace=await new WorkspaceStore(root).init();restored.loadedDirs=new Set();restored.preview=c.preview;await restored.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});
 const plus=await restored.handle('version.create',{compositionId:chat.id,baseVersionId:chat.selectedVersionId,requestId:'inherit'});await restored.handle('chat.send',{conversationId:chat.id,versionId:plus.selectedVersionId,prompt:'Продолжим',settings});
 assert.ok(seen.at(-1).inheritedContext.snapshots.some(s=>s.transcript.some(p=>p.text==='Привет')));assert.ok(seen.at(-1).inheritedContext.frames.length);await fs.access(seen.at(-1).inheritedContext.frames[0].path);
});
test('controller rejects another version, another revision and untrusted duration claims',async t=>{
 const {c}=await setup(t,async x=>({message:'ok',plan:demoMotion(x.settings)}));const a=await c.handle('conversation.create',{settings}),b=await c.handle('conversation.create',{settings});
 await assert.rejects(c.handle('chat.send',{conversationId:a.id,versionId:b.selectedVersionId,prompt:'x',settings}),/верс|композ/i);
 const result=await c.handle('chat.send',{conversationId:a.id,versionId:a.selectedVersionId,prompt:'x',settings:{...settings,durationMode:'videoContext',requestedDuration:1000,duration:5}});assert.equal(result.job.plan.duration,5);assert.notEqual(result.job.plan.durationMode,'videoContext');
 await assert.rejects(c.handle('chat.send',{conversationId:b.id,versionId:b.selectedVersionId,previousId:result.job.id,prompt:'x',settings}),/верс|композ/i);
});
test('an explicit send binds an unscoped legacy composition and its revisions to the current project',async t=>{
 const {c}=await setup(t,async()=>({message:'Только проект A',plan:null}));const job=await c.handle('demo',{settings});const doc=c.conversation(job.conversationId);doc.projectId=null;c.jobs.get(job.id).projectId=null;await c.conversations.save(doc);await c.save(c.jobs.get(job.id));
 assert.equal((await c.handle('conversation.get',{id:doc.id})).projectId,null);
 const result=await c.handle('chat.send',{conversationId:doc.id,versionId:doc.selectedVersionId,prompt:'Продолжаем в A',settings});assert.equal(result.conversation.projectId,'a');
 await c.handle('workspace.project',{project:{id:'b',name:'B'}});await assert.rejects(c.handle('conversation.get',{id:doc.id}),/Проект/);await assert.rejects(c.handle('job',{id:job.id}),/Проект/);assert.equal(c.listJobs().length,0);
});
test('raw manual 15 seconds survives fractional FPS, restart-style update and sending',async t=>{
 const seen=[];const {c}=await setup(t,async x=>{seen.push(x);return{message:'ok',plan:null};});const chat=await c.handle('conversation.create',{settings:{...settings,engine:'remotion',fps:29.97,duration:15}});assert.equal(chat.manualDurationSeconds,15);
 const updated=await c.handle('conversation.update',{id:chat.id,versionId:chat.selectedVersionId,settings:chat.settings,manualDurationSeconds:chat.manualDurationSeconds});assert.equal(updated.manualDurationSeconds,15);
 await c.handle('chat.send',{conversationId:chat.id,versionId:chat.selectedVersionId,prompt:'Почему?',settings:updated.settings});assert.equal(seen[0].settings.frameCount,450);
});
test('render and import reject a revision other than the selected one in the addressed logical version',async t=>{
 const {c}=await setup(t,async()=>({message:'ok',plan:demoMotion(settings)}));const chat=await c.handle('conversation.create',{settings});const a=await c.handle('chat.send',{conversationId:chat.id,prompt:'Первый',settings});await c.handle('chat.send',{conversationId:chat.id,prompt:'Второй',settings});const params={id:a.job.id,compositionId:chat.id,versionId:chat.selectedVersionId};
 await assert.rejects(c.handle('render',params),/ревиз|верс/i);await assert.rejects(c.handle('artifact',params),/ревиз|верс/i);
});
