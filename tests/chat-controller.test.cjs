'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {Controller}=require('../lib/controller.cjs');const {WorkspaceStore}=require('../lib/workspaces.cjs');const {demoMotion}=require('../lib/motion.cjs');
const settings={engine:'hyperframes',width:640,height:360,fps:30,duration:2};
async function fixture(t,generator){
  const parent=path.resolve(__dirname,'../workspace');const root=await fs.mkdtemp(path.join(parent,'chat-test-'));t.after(async()=>{assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});});
  const media=path.join(root,'Media');await fs.mkdir(media);
  const c=new Controller(root,()=>{},{chatGenerator:generator});c.workspace=await new WorkspaceStore(root).init();c.loadedDirs=new Set();c.preview={url:id=>'http://127.0.0.1/test/'+id};
  await c.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});return{c,root,media};
}
test('empty chats persist after reload and remain isolated by Resolve project',async t=>{
  const {c,root,media}=await fixture(t);const chat=await c.handle('conversation.create',{settings});assert.equal(chat.jobIds.length,0);
  await c.handle('conversation.update',{id:chat.id,draft:'сохранённый черновик',settings:{...settings,duration:7}});
  const restored=new Controller(root);restored.workspace=await new WorkspaceStore(root).init();restored.loadedDirs=new Set();restored.preview=c.preview;
  await restored.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});
  const state=await restored.handle('conversation.get',{id:chat.id});assert.equal(state.draft,'сохранённый черновик');assert.equal(state.settings.duration,7);
  await restored.handle('workspace.project',{project:{id:'b',name:'B',mediaDirectory:media}});
  assert.equal(restored.listConversations().length,0);await assert.rejects(restored.handle('conversation.get',{id:chat.id}),/Проект/);
});
test('legacy jobs become one-version chats without moving MOV or losing imports',async t=>{
  const {c,root,media}=await fixture(t);const j=await c.handle('demo',{settings});const job=c.job(j.id);const file=path.join(job.dir,'motion.mov');await fs.writeFile(file,'MOV');job.output={file,bytes:3};job.imports={a:'media-id'};await c.save(job);
  const restored=new Controller(root);restored.workspace=await new WorkspaceStore(root).init();restored.loadedDirs=new Set();restored.preview=c.preview;await restored.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});
  const chats=restored.listConversations();assert.equal(chats.length,1);const chat=await restored.handle('conversation.get',{id:chats[0].id});assert.deepEqual(chat.jobIds,[j.id]);assert.equal(restored.job(j.id).output.file,file);assert.equal(restored.job(j.id).imports.a,'media-id');assert.equal(await fs.readFile(file,'utf8'),'MOV');
});
test('a question persists its answer without a version, while an old-version edit branches with its settings',async t=>{
  const seen=[];const replies=[{message:'Создал',plan:demoMotion(settings)},{message:'Крупнее',plan:demoMotion({...settings,duration:3})},{message:'Потому что так лучше видно',plan:null},{message:'Синий',plan:demoMotion(settings)}];
  const {c}=await fixture(t,async args=>{seen.push(args);return replies.shift();});const chat=await c.handle('conversation.create',{settings});
  const a=await c.handle('chat.send',{conversationId:chat.id,prompt:'Создай',settings});
  const b=await c.handle('chat.send',{conversationId:chat.id,prompt:'Крупнее',previousId:a.job.id,settings:{...settings,duration:3}});
  const q=await c.handle('chat.send',{conversationId:chat.id,prompt:'Почему?',previousId:b.job.id,settings:{...settings,duration:3}});
  assert.equal(q.job,null);assert.equal(q.conversation.jobIds.length,2);assert.equal(q.conversation.messages.at(-1).text,'Потому что так лучше видно');
  const plus=await c.handle('version.create',{compositionId:chat.id,baseVersionId:chat.selectedVersionId,baseRevisionId:a.job.id,requestId:'old-base'});
  const branch=await c.handle('chat.send',{conversationId:chat.id,versionId:plus.selectedVersionId,prompt:'Синий',previousId:a.job.id,settings});
  assert.equal(branch.job.parentId,a.job.id);assert.equal(branch.job.version,2);assert.equal(branch.conversation.versions.length,2);assert.equal(branch.job.plan.duration,2);assert.equal(c.job(b.job.id).plan.duration,3);
  assert.equal(seen.at(-1).previous.name,a.job.plan.name);assert.ok(seen.at(-1).history.some(m=>m.text==='Почему?'));assert.equal(c.listConversations().length,1);
  const other=await c.handle('conversation.create',{settings});await assert.rejects(c.handle('chat.send',{conversationId:other.id,prompt:'x',previousId:a.job.id,settings}),/верс|компози/i);
});
test('failed and cancelled model turns retain the user message and never produce a version',async t=>{
  let cancel=false;const {c}=await fixture(t,async({signal})=>{if(cancel)await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Отменено')),{once:true}));else throw new Error('provider failed');});
  const chat=await c.handle('conversation.create',{settings});await assert.rejects(c.handle('chat.send',{conversationId:chat.id,prompt:'Не потерять',settings}),/provider/);
  let state=await c.handle('conversation.get',{id:chat.id});assert.equal(state.messages[0].text,'Не потерять');assert.equal(state.messages[0].status,'failed');assert.equal(state.jobIds.length,0);
  cancel=true;const pending=c.handle('chat.send',{conversationId:chat.id,prompt:'Отменить',settings});while(!c.active)await new Promise(r=>setImmediate(r));await new Promise(r=>setTimeout(r,30));await c.handle('cancel');await assert.rejects(pending,/Отмен/);
  state=await c.handle('conversation.get',{id:chat.id});assert.equal(state.messages.at(-1).status,'cancelled');assert.equal(state.jobIds.length,0);
});

test('cancellation during source preparation publishes no durable job or version',async t=>{
  const {c,media}=await fixture(t,async()=>({message:'Готово',plan:demoMotion(settings)}));
  const chat=await c.handle('conversation.create',{settings});const create=c.create.bind(c);
  c.create=async(...args)=>{const preparing=create(...args);queueMicrotask(()=>c.active.abort());return preparing;};
  await assert.rejects(c.handle('chat.send',{conversationId:chat.id,prompt:'Создай',settings}),/отмен/i);
  assert.equal(c.listJobs().length,0);assert.equal((await c.handle('conversation.get',{id:chat.id})).jobIds.length,0);
  const entries=await fs.readdir(path.join(media,'jobs'));for(const entry of entries.filter(e=>!e.startsWith('.')))await assert.rejects(fs.access(path.join(media,'jobs',entry,'job.json')),{code:'ENOENT'});
});

test('an initial disk write failure leaves a retryable failed message and never calls the model',async t=>{
  let calls=0;const {c}=await fixture(t,async()=>{calls++;return{message:'x',plan:null};});const chat=await c.handle('conversation.create',{settings});
  const save=c.conversations.save.bind(c.conversations);let first=true;c.conversations.save=async d=>{if(first){first=false;throw new Error('disk unavailable');}return save(d);};
  await assert.rejects(c.handle('chat.send',{conversationId:chat.id,prompt:'Сохранить',settings}),/disk unavailable/);
  assert.equal(calls,0);assert.equal(c.active,null);assert.equal((await c.handle('conversation.get',{id:chat.id})).messages.at(-1).status,'failed');
});

test('a corrupt chat file stays intact while other chats and project folder recovery remain available',async t=>{
  const {c,root,media}=await fixture(t);const j=await c.handle('demo',{settings});const good=await c.handle('conversation.create',{settings});
  const file=path.join(media,'jobs','.conversations',j.conversationId+'.json');await fs.writeFile(file,'{broken');
  const restored=new Controller(root);restored.workspace=await new WorkspaceStore(root).init();restored.loadedDirs=new Set();restored.preview=c.preview;
  const result=await restored.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});
  assert.ok(result.conversations.some(d=>d.id===good.id));assert.equal(result.conversations.some(d=>d.id===j.conversationId),false);assert.ok(result.storageWarnings.length);assert.equal(await fs.readFile(file,'utf8'),'{broken');
  const replacement=path.join(root,'Replacement');await fs.mkdir(replacement);const changed=await restored.handle('workspace.select',{projectId:'a',directory:replacement});assert.equal(changed.workspace.directory,await fs.realpath(replacement));
});
