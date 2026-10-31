'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {ConversationStore}=require('../lib/conversations.cjs');
const settings={engine:'remotion',width:640,height:360,fps:30,duration:5};
async function fixture(t){
  const parent=path.resolve(__dirname,'../workspace');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'version-store-test-'));t.after(async()=>{assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});});
  const jobsDir=path.join(root,'jobs');await fs.mkdir(jobsDir);return{root,jobsDir,directory:path.join(jobsDir,'.conversations')};
}
async function writeDoc(directory,doc){await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,doc.id+'.json'),JSON.stringify(doc,null,2));}
async function writeJob(jobsDir,extra={}){
  const id=extra.id||randomUUID(),dir=path.join(jobsDir,id);await fs.mkdir(dir,{recursive:true});
  const job={id,dir,projectId:'project-a',plan:{...settings,name:'Scene',source:'export const Scene=()=>null;'},createdAt:'2026-10-30T10:00:00.000Z',status:'preview_ready',imports:{},...extra};
  await fs.writeFile(path.join(dir,'job.json'),JSON.stringify(job));return job;
}
function legacyDoc(extra={}){return{id:randomUUID(),projectId:'project-a',name:'Old composition',createdAt:'2026-10-30T09:00:00.000Z',updatedAt:'2026-10-30T11:00:00.000Z',jobIds:[],selectedJobId:null,messages:[],settings:{...settings},draft:'old draft',videoContextEnabled:false,...extra};}

test('a new composition persists a draft V1 and its independent parameters',async t=>{
  const {jobsDir,directory}=await fixture(t),store=new ConversationStore(),input={...settings};
  const doc=await store.create({jobsDir,projectId:'project-a'},input);input.duration=99;
  assert.equal(doc.schemaVersion,2);assert.equal(doc.versions.length,1);const v=store.getVersion(doc);
  assert.equal(v.number,1);assert.equal(v.status,'draft');assert.equal(v.parentVersionId,null);assert.deepEqual(v.revisionIds,[]);assert.equal(v.settings.duration,5);assert.equal(v.manualDurationSeconds,5);
  const restored=new ConversationStore();await restored.load(jobsDir,new Map());assert.equal(restored.getVersion(restored.get(doc.id,'project-a')).id,v.id);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,doc.id+'.json'),'utf8')).schemaVersion,2);
});

test('branching snapshots the selected basis without a model call, new revision, or shared mutable history',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),v1=store.getVersion(doc),contextId=randomUUID();
  v1.messages.push({id:randomUUID(),role:'user',text:'Use this logo',status:'completed',contextSnapshotId:contextId});
  const job=await writeJob(jobsDir,{conversationId:doc.id,logicalVersionId:v1.id,assetManifest:[{file:'assets/logo.png'}],contextSnapshotIds:[contextId]});
  doc.jobIds.push(job.id);v1.revisionIds.push(job.id);v1.selectedRevisionId=job.id;v1.status='ready';await store.save(doc);await store.load(jobsDir,new Map([[job.id,job]]));
  const v2=await store.createVersion(doc,{baseVersionId:v1.id,baseRevisionId:job.id,requestId:'click-1'});
  assert.equal(v2.number,2);assert.equal(v2.parentVersionId,v1.id);assert.equal(v2.baseRevisionId,job.id);assert.equal(v2.baseSnapshot.plan.source,'export const Scene=()=>null;');assert.equal(v2.baseSnapshot.history[0].text,'Use this logo');assert.deepEqual(v2.baseSnapshot.contextSnapshotIds,[contextId]);assert.deepEqual(v2.baseSnapshot.assetManifest,[{file:'assets/logo.png'}]);
  assert.deepEqual(v2.messages,[]);assert.deepEqual(v2.revisionIds,[]);assert.equal(v2.status,'draft');assert.equal(doc.selectedVersionId,v2.id);assert.deepEqual(doc.jobIds,[job.id]);
  v1.messages[0].text='Changed later';job.plan.source='changed';v1.settings.duration=9;
  assert.equal(v2.baseSnapshot.history[0].text,'Use this logo');assert.equal(v2.baseSnapshot.plan.source,'export const Scene=()=>null;');assert.equal(v2.settings.duration,5);assert.throws(()=>{v2.baseSnapshot.history[0].text='mutated';},TypeError);
  const selected=store.public(doc,true);assert.equal(selected.selectedJobId,job.id);assert.deepEqual(selected.messages,[]);assert.equal(selected.versions[1].baseRevisionId,job.id);
});

test('version selection projects only that version chat, draft, and manual settings',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),v1=store.getVersion(doc);
  v1.messages.push({role:'user',text:'First',status:'completed'});v1.draft='V1 draft';v1.manualDurationSeconds=7;v1.videoContextEnabled=false;v1.manualSize=true;
  const v2=await store.createVersion(doc,{requestId:'click-2'});v2.messages.push({role:'assistant',text:'Second',status:'completed'});v2.draft='V2 draft';v2.manualDurationSeconds=12;v2.durationMode='context';
  doc.selectedVersionId=v1.id;assert.equal(store.public(doc,true).draft,'V1 draft');assert.equal(store.public(doc,true).manualDurationSeconds,7);assert.equal(store.public(doc,true).messages[0].text,'First');
  doc.selectedVersionId=v2.id;assert.equal(store.public(doc,true).draft,'V2 draft');assert.equal(store.public(doc,true).manualDurationSeconds,12);assert.equal(store.public(doc,true).messages[0].text,'Second');assert.equal(store.public(doc).messageCount,1);assert.equal(store.public(doc).messages,undefined);
  assert.throws(()=>store.getVersion(doc,randomUUID()),/верс/i);
});

test('repeated IPC requests create one version across concurrency and reload',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir},settings),baseVersionId=doc.selectedVersionId;
  const versions=await Promise.all(Array.from({length:3},()=>store.createVersion(doc,{baseVersionId,requestId:'same-click'})));
  assert.equal(new Set(versions.map(v=>v.id)).size,1);assert.equal(doc.versions.length,2);
  const restored=new ConversationStore();await restored.load(jobsDir,new Map());const loaded=restored.get(doc.id);assert.equal((await restored.createVersion(loaded,{baseVersionId,requestId:'same-click'})).id,versions[0].id);assert.equal(loaded.versions.length,2);
  const more=await Promise.all([store.createVersion(doc,{baseVersionId,requestId:'next-a'}),store.createVersion(doc,{baseVersionId,requestId:'next-b'})]);assert.deepEqual(more.map(v=>v.number),[3,4]);assert.equal(doc.versions.length,4);
});

test('a failed version write leaves the saved composition and live selection unchanged',async t=>{
  const {jobsDir,root}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir},settings),selected=doc.selectedVersionId;
  const blocker=path.join(root,'not-a-directory');await fs.writeFile(blocker,'block');const original=doc.directory;doc.directory=blocker;
  await assert.rejects(store.createVersion(doc,{requestId:'retry'}));assert.equal(doc.versions.length,1);assert.equal(doc.selectedVersionId,selected);
  doc.directory=original;const v=await store.createVersion(doc,{requestId:'retry'});assert.equal(v.number,2);
});

test('branching rejects a revision from another logical version or composition',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir},settings),v1=store.getVersion(doc),v2=await store.createVersion(doc,{requestId:'new'});
  await assert.rejects(store.createVersion(doc,{baseVersionId:v1.id,baseRevisionId:randomUUID(),requestId:'bad'}),/ревиз|верс/i);
  const other=await store.create({jobsDir},settings);await assert.rejects(store.createVersion(doc,{baseVersionId:other.selectedVersionId,requestId:'wrong'}),/верс/i);assert.equal(doc.versions.length,2);assert.equal(doc.selectedVersionId,v2.id);
});

test('legacy visible results migrate separately with exact metadata backup and full uncertain history',async t=>{
  const {jobsDir,directory}=await fixture(t),id=randomUUID(),a=await writeJob(jobsDir,{conversationId:id,version:1}),b=await writeJob(jobsDir,{conversationId:id,version:2,parentId:a?.id});
  const messages=[{role:'user',text:'Unattributed discussion',status:'completed'},{role:'assistant',text:'First result',versionId:a.id,status:'completed'},{role:'assistant',text:'Second result',versionId:b.id,status:'completed'}];
  const old=legacyDoc({id,jobIds:[a.id,b.id],selectedJobId:a.id,messages});await writeDoc(directory,old);const original=await fs.readFile(path.join(directory,id+'.json'),'utf8');
  const sentinel=path.join(directory,id+'.pre-v2-existing.bak');await fs.writeFile(sentinel,'previous backup');const jobs=new Map([[a.id,a],[b.id,b]]),store=new ConversationStore();await store.load(jobsDir,jobs);const doc=store.get(id,'project-a');
  assert.equal(doc.schemaVersion,2);assert.equal(doc.versions.length,2);assert.deepEqual(doc.versions.map(v=>v.revisionIds),[[a.id],[b.id]]);assert.equal(store.getVersion(doc).selectedRevisionId,a.id);assert.deepEqual(doc.legacyHistory,messages);assert.equal(store.getVersion(doc).draft,'old draft');assert.equal(store.getVersion(doc).videoContextEnabled,false);
  assert.equal(doc.versions[0].messages[0].text,'First result');assert.equal(doc.versions[1].messages[0].text,'Second result');
  const backups=(await fs.readdir(directory)).filter(n=>n.startsWith(id+'.pre-v2-')&&n.endsWith('.bak'));assert.equal(backups.length,2);assert.equal(await fs.readFile(sentinel,'utf8'),'previous backup');assert.ok((await Promise.all(backups.map(n=>fs.readFile(path.join(directory,n),'utf8')))).includes(original));
  const restored=new ConversationStore();await restored.load(jobsDir,jobs);assert.equal(restored.get(id,'project-a').versions.length,2);assert.equal((await fs.readdir(directory)).filter(n=>n.endsWith('.bak')).length,2);assert.equal(a.dir,path.join(jobsDir,a.id));
});

test('an empty legacy chat becomes V1 while preserving pending text and saved controls',async t=>{
  const {jobsDir,directory}=await fixture(t),old=legacyDoc({manualDurationSeconds:7,manualSize:true,manualFps:true,messages:[{role:'user',text:'Pending text',status:'pending'}]});await writeDoc(directory,old);
  const store=new ConversationStore();await store.load(jobsDir,new Map());const doc=store.get(old.id,'project-a'),v=store.getVersion(doc);assert.equal(v.number,1);assert.equal(v.draft,'old draft');assert.equal(v.manualDurationSeconds,7);assert.equal(v.manualSize,true);assert.equal(v.manualFps,true);assert.equal(v.messages[0].text,'Pending text');assert.equal(v.messages[0].status,'interrupted');assert.equal(doc.legacyHistory[0].text,'Pending text');
});

test('persisted revisions recover into their existing logical version without a new version or duplicate answer',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),v=store.getVersion(doc),job=await writeJob(jobsDir,{conversationId:doc.id,logicalVersionId:v.id});
  v.messages.push({role:'assistant',text:'Already saved answer',status:'completed',revisionId:job.id});await store.save(doc);
  const restored=new ConversationStore();await restored.load(jobsDir,new Map([[job.id,job]]));const loaded=restored.get(doc.id,'project-a');assert.equal(loaded.versions.length,1);assert.deepEqual(loaded.jobIds,[job.id]);assert.deepEqual(restored.getVersion(loaded).revisionIds,[job.id]);assert.equal(restored.getVersion(loaded).selectedRevisionId,job.id);assert.equal(restored.getVersion(loaded).messages.length,1);
  await restored.load(jobsDir,new Map([[job.id,job]]));assert.equal(restored.getVersion(loaded).messages.length,1);assert.equal(loaded.versions.length,1);
});

test('orphan v2 revisions remain recoverable warnings instead of becoming visible versions',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),job=await writeJob(jobsDir,{conversationId:doc.id,logicalVersionId:randomUUID()});
  await store.load(jobsDir,new Map([[job.id,job]]));assert.equal(doc.versions.length,1);assert.deepEqual(doc.jobIds,[]);assert.ok([...store.warnings.values()].some(w=>w.includes(job.id)));
});

test('only complete saved job metadata is reconciled and unscoped historical jobs stay unbound',async t=>{
  const {jobsDir}=await fixture(t),good=await writeJob(jobsDir,{projectId:null}),partial={id:randomUUID(),dir:path.join(jobsDir,randomUUID()),plan:{...settings,name:'Partial'}},bad=await writeJob(jobsDir);await fs.writeFile(path.join(bad.dir,'job.json'),'{broken');
  const store=new ConversationStore();await store.load(jobsDir,new Map([[good.id,good],[partial.id,partial],[bad.id,bad]]));assert.equal(store.items.size,1);const doc=store.get(good.id,'another-project');assert.equal(doc.projectId,null);assert.equal(store.getVersion(doc).selectedRevisionId,good.id);assert.equal(store.list('another-project')[0].projectId,null);
});

test('one corrupt v2 composition stays untouched while valid compositions remain usable',async t=>{
  const {jobsDir,directory}=await fixture(t),store=new ConversationStore(),good=await store.create({jobsDir},settings),badId=randomUUID(),file=path.join(directory,badId+'.json');
  const invalid={schemaVersion:2,...legacyDoc({id:badId}),versions:[{id:randomUUID(),number:1,messages:'bad'}],selectedVersionId:randomUUID()};const raw=JSON.stringify(invalid);await fs.writeFile(file,raw);
  const restored=new ConversationStore();await restored.load(jobsDir,new Map());assert.equal(restored.items.size,1);assert.equal(restored.get(good.id).id,good.id);assert.equal(await fs.readFile(file,'utf8'),raw);assert.ok(restored.warnings.size);
});

test('recovering a durable turn restores its answer once and completes the matching user',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),v=store.getVersion(doc),userId=randomUUID(),assistantId=randomUUID(),contextId=randomUUID();
  v.messages.push({id:userId,role:'user',text:'Make it blue',status:'pending',contextSnapshotId:contextId});await store.save(doc);
  const revisionId=randomUUID(),job=await writeJob(jobsDir,{id:revisionId,conversationId:doc.id,logicalVersionId:v.id,contextSnapshotIds:[contextId],turn:{userId,assistant:{id:assistantId,role:'assistant',text:'Made it blue',status:'completed',revisionId,versionId:revisionId,createdAt:'2026-10-30T10:00:00.000Z'}}});
  const restored=new ConversationStore();await restored.load(jobsDir,new Map([[job.id,job]]));const loaded=restored.getVersion(restored.get(doc.id,'project-a'));assert.equal(loaded.messages[0].status,'completed');assert.equal(loaded.messages[1].text,'Made it blue');assert.deepEqual(loaded.contextSnapshotIds,[contextId]);
  await restored.load(jobsDir,new Map([[job.id,job]]));assert.equal(loaded.messages.length,2);
});

test('an unindexed old-format job cannot fabricate a version in an already migrated composition',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),job=await writeJob(jobsDir,{conversationId:doc.id});
  await store.load(jobsDir,new Map([[job.id,job]]));const loaded=store.get(doc.id,'project-a');assert.equal(loaded.versions.length,1);assert.deepEqual(loaded.jobIds,[]);assert.ok([...store.warnings.values()].some(w=>w.includes(job.id)));
});

test('migration incorporates a complete legacy result saved just before its old index update',async t=>{
  const {jobsDir,directory}=await fixture(t),old=legacyDoc();await writeDoc(directory,old);const job=await writeJob(jobsDir,{conversationId:old.id});
  const store=new ConversationStore();await store.load(jobsDir,new Map([[job.id,job]]));const doc=store.get(old.id,'project-a');assert.equal(doc.versions.length,1);assert.deepEqual(doc.jobIds,[job.id]);assert.equal(store.getVersion(doc).selectedRevisionId,job.id);
});

test('corrupt nested legacy message metadata is isolated from other compositions',async t=>{
  const {jobsDir,directory}=await fixture(t),store=new ConversationStore(),good=await store.create({jobsDir},settings),bad=legacyDoc({messages:[{role:'user',text:'bad nested context',contextSnapshotIds:123}]});await writeDoc(directory,bad);
  const restored=new ConversationStore();await restored.load(jobsDir,new Map());assert.equal(restored.get(good.id).id,good.id);assert.equal(restored.items.has(bad.id),false);assert.ok(restored.warnings.size);
});

test('a child snapshots its durable base even when no prior job-directory load populated the store',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),base=store.getVersion(doc),job=await writeJob(jobsDir,{conversationId:doc.id,logicalVersionId:base.id});
  doc.jobIds=[job.id];base.revisionIds=[job.id];base.selectedRevisionId=job.id;base.status='ready';await store.save(doc);
  const child=await store.createVersion(doc,{requestId:'without-background-load'});assert.equal(child.baseSnapshot.plan.source,'export const Scene=()=>null;');
});

test('saving a cloned composition restores immutable inherited snapshots',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir},settings);await store.createVersion(doc,{requestId:'branch'});const next=structuredClone(doc);await store.save(next);
  assert.throws(()=>{store.getVersion(next).baseSnapshot.history.push({role:'user',text:'changed'});},TypeError);
});

test('malformed saved job context and incomplete plans cannot break project recovery',async t=>{
  const {jobsDir}=await fixture(t),good=await writeJob(jobsDir),bad=await writeJob(jobsDir,{contextSnapshotIds:123}),incomplete=await writeJob(jobsDir,{plan:{name:'Incomplete'}});
  const store=new ConversationStore();await store.load(jobsDir,new Map([[good.id,good],[bad.id,bad],[incomplete.id,incomplete]]));assert.equal(store.items.size,1);assert.equal(store.get(good.id,'project-a').jobIds[0],good.id);assert.ok(store.warnings.size>=2);
});

test('corrupt legacy settings are preserved on disk without poisoning a usable composition',async t=>{
  const {jobsDir,directory}=await fixture(t),store=new ConversationStore(),good=await store.create({jobsDir},settings),bad=legacyDoc({settings:'bad settings'});await writeDoc(directory,bad);const raw=await fs.readFile(path.join(directory,bad.id+'.json'),'utf8');
  const restored=new ConversationStore();await restored.load(jobsDir,new Map());assert.equal(restored.get(good.id).id,good.id);assert.equal(restored.items.has(bad.id),false);assert.equal(await fs.readFile(path.join(directory,bad.id+'.json'),'utf8'),raw);
});

async function writeLegacyContext(job,overrides={}){
  const {normalizeRange}=require('../lib/video-context.cjs'),{run}=require('../lib/process.cjs');
  const range=normalizeRange({projectId:job.projectId||'project-a',timelineId:'interview',timelineName:'Interview',fps:25,timelineStart:90000,timelineEnd:91000,markIn:100,markOut:299});
  const directory=path.join(job.dir,'context');await fs.mkdir(directory,{recursive:true});const file=path.join(directory,'image-0.jpg');
  await run(require('../lib/runtime.cjs').runtimeExecutable('ffmpeg'),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=16x16','-frames:v','1','-y',file]);
  job.videoContext={...range,frames:[{file:'image-0.jpg',seconds:0,timecode:range.inTimecode}],transcript:[{start:0,end:1.2,text:'Важная речь',speaker:'Speaker 1'}],speechIncluded:true,speechStatus:'ready',speechSource:'timeline',...overrides};
  await fs.writeFile(path.join(directory,'context.json'),JSON.stringify(job.videoContext));await fs.writeFile(path.join(job.dir,'job.json'),JSON.stringify(job));return{file,range};
}

test('legacy frame and speech evidence migrates to durable snapshots inherited by mapped and new versions',async t=>{
  const {jobsDir,directory}=await fixture(t),id=randomUUID(),a=await writeJob(jobsDir,{conversationId:id,version:1}),b=await writeJob(jobsDir,{conversationId:id,version:2,parentId:a.id});const {file,range}=await writeLegacyContext(a);
  const bytes=await fs.readFile(file),originalJob=await fs.readFile(path.join(a.dir,'job.json'),'utf8'),old=legacyDoc({id,jobIds:[a.id,b.id],selectedJobId:b.id});await writeDoc(directory,old);
  const jobs=new Map([[a.id,a],[b.id,b]]),store=new ConversationStore();await store.load(jobsDir,jobs);const doc=store.get(id,'project-a'),v1=doc.versions[0],v2=doc.versions[1];assert.equal(v1.contextSnapshotIds.length,1);const snapshotId=v1.contextSnapshotIds[0];assert.deepEqual(v2.baseSnapshot.contextSnapshotIds,[snapshotId]);
  const {loadContext,versionContext}=require('../lib/context-snapshots.cjs'),snapshot=await loadContext(doc,snapshotId);assert.equal(snapshot.legacyRevisionId,a.id);assert.equal(snapshot.versionId,v1.id);assert.deepEqual(snapshot.range,range);assert.equal(snapshot.transcript[0].text,'Важная речь');assert.equal(snapshot.transcript[0].speaker,'Speaker 1');assert.equal(snapshot.speechIncluded,true);assert.equal(snapshot.speechStatus,'ready');assert.equal(snapshot.speechSource,'timeline');assert.deepEqual(await fs.readFile(snapshot.frames[0].path),bytes);
  const child=await store.createVersion(doc,{baseVersionId:v1.id,requestId:'legacy-context-child'});assert.deepEqual(child.baseSnapshot.contextSnapshotIds,[snapshotId]);assert.equal((await versionContext(doc,child)).frames.length,1);
  const restored=new ConversationStore();await restored.load(jobsDir,jobs);const loaded=restored.get(id,'project-a');assert.deepEqual(restored.getVersion(loaded,child.id).baseSnapshot.contextSnapshotIds,[snapshotId]);assert.equal((await versionContext(loaded,restored.getVersion(loaded))).snapshots[0].transcript[0].text,'Важная речь');assert.equal((await fs.readdir(path.join(jobsDir,'.contexts'))).length,1);assert.deepEqual(await fs.readFile(file),bytes);assert.equal(await fs.readFile(path.join(a.dir,'job.json'),'utf8'),originalJob);
});

test('already migrated versions repair legacy evidence references idempotently using their exact saved basis',async t=>{
  const {jobsDir}=await fixture(t),store=new ConversationStore(),doc=await store.create({jobsDir,projectId:'project-a'},settings),v1=store.getVersion(doc),job=await writeJob(jobsDir,{conversationId:doc.id});await writeLegacyContext(job);doc.jobIds=[job.id];v1.revisionIds=[job.id];v1.selectedRevisionId=job.id;v1.status='ready';await store.save(doc);
  const child=await store.createVersion(doc,{requestId:'before-evidence-repair'});assert.deepEqual(child.baseSnapshot.contextSnapshotIds,[]);
  const jobs=new Map([[job.id,job]]),restored=new ConversationStore();await restored.load(jobsDir,jobs);const loaded=restored.get(doc.id,'project-a'),snapshotId=loaded.versions[0].contextSnapshotIds[0];assert.ok(snapshotId);assert.deepEqual(restored.getVersion(loaded,child.id).baseSnapshot.contextSnapshotIds,[snapshotId]);
  const file=path.join(jobsDir,'.contexts',snapshotId,'snapshot.json'),first=await fs.readFile(file,'utf8');await restored.load(jobsDir,jobs);assert.equal(await fs.readFile(file,'utf8'),first);assert.deepEqual((await fs.readdir(path.join(jobsDir,'.contexts'))),[snapshotId]);assert.equal(loaded.versions.length,2);
});

test('legacy context migration rejects frame traversal and a different project without reading arbitrary attachments',async t=>{
  for(const invalid of [{frames:[{file:'../private.jpg',seconds:0,timecode:'01:00:00:00'}]},{projectId:'other-project'}]){
    const {jobsDir,directory}=await fixture(t),job=await writeJob(jobsDir);await writeLegacyContext(job,invalid);await fs.writeFile(path.join(job.dir,'private.jpg'),'private material');const old=legacyDoc({id:job.id,jobIds:[job.id],selectedJobId:job.id});await writeDoc(directory,old);
    const store=new ConversationStore();await store.load(jobsDir,new Map([[job.id,job]]));const doc=store.get(job.id,'project-a');assert.deepEqual(store.getVersion(doc).contextSnapshotIds,[]);assert.ok([...store.warnings.values()].some(w=>w.includes(job.id)));assert.equal(await fs.readFile(path.join(job.dir,'private.jpg'),'utf8'),'private material');await assert.rejects(fs.access(path.join(jobsDir,'.contexts')),{code:'ENOENT'});
  }
});

test('legacy context migration refuses a context-directory junction outside its saved job',async t=>{
  const {jobsDir,directory,root}=await fixture(t),job=await writeJob(jobsDir);const {file}=await writeLegacyContext(job),outside=path.join(root,'outside-context');await fs.rename(path.dirname(file),outside);try{await fs.symlink(outside,path.join(job.dir,'context'),'junction');}catch(error){if(error.code==='EPERM'){t.skip('This sandbox does not allow directory junctions');return;}throw error;}
  const old=legacyDoc({id:job.id,jobIds:[job.id],selectedJobId:job.id});await writeDoc(directory,old);const store=new ConversationStore();await store.load(jobsDir,new Map([[job.id,job]]));assert.deepEqual(store.getVersion(store.get(job.id,'project-a')).contextSnapshotIds,[]);assert.ok([...store.warnings.values()].some(w=>w.includes(job.id)));await assert.rejects(fs.access(path.join(jobsDir,'.contexts')),{code:'ENOENT'});await fs.access(path.join(outside,'image-0.jpg'));
});

test('raw manual duration survives quantized settings and legacy boundary migration',async t=>{
  const {jobsDir,directory}=await fixture(t),store=new ConversationStore(),raw={...settings,fps:29.97,duration:450/29.97,frameCount:450,manualDurationSeconds:15};const fresh=await store.create({jobsDir,projectId:'project-a'},raw);assert.equal(store.getVersion(fresh).manualDurationSeconds,15);
  const old=legacyDoc({settings:{...raw,manualDurationSeconds:undefined}});await writeDoc(directory,old);const restored=new ConversationStore();await restored.load(jobsDir,new Map());assert.equal(restored.getVersion(restored.get(old.id,'project-a')).manualDurationSeconds,15);
  const child=await restored.createVersion(restored.get(old.id,'project-a'),{requestId:'raw-boundary'});assert.equal(child.manualDurationSeconds,15);
});

test('context timing is never clamped into an inferred manual boundary',async t=>{
  const {jobsDir,directory}=await fixture(t),effective=450/29.97,old=legacyDoc({settings:{...settings,fps:29.97,duration:effective,frameCount:450,durationMode:'videoContext'}});await writeDoc(directory,old);const store=new ConversationStore();await store.load(jobsDir,new Map());const version=store.getVersion(store.get(old.id,'project-a'));assert.equal(version.manualDurationSeconds,effective);assert.equal(version.durationMode,'videoContext');
});

test('explicit binding of an unscoped composition preserves the original legacy snapshot identity and provenance',async t=>{
  for(const projectId of ['project-a','project-b']){
    const {jobsDir,directory}=await fixture(t),job=await writeJob(jobsDir,{projectId:null});await writeLegacyContext(job);const old=legacyDoc({id:job.id,projectId:null,jobIds:[job.id],selectedJobId:job.id});await writeDoc(directory,old);const jobs=new Map([[job.id,job]]),store=new ConversationStore();await store.load(jobsDir,jobs);const doc=store.get(job.id),snapshotId=store.getVersion(doc).contextSnapshotIds[0];assert.ok(snapshotId);
    doc.projectId=projectId;doc.legacyBinding={fromProjectId:null,toProjectId:projectId,at:'2026-10-30T12:00:00.000Z'};await store.save(doc);
    const restored=new ConversationStore();await restored.load(jobsDir,jobs);const loaded=restored.get(doc.id,projectId),version=restored.getVersion(loaded);assert.deepEqual(version.contextSnapshotIds,[snapshotId]);assert.deepEqual(await fs.readdir(path.join(jobsDir,'.contexts')),[snapshotId]);assert.equal(restored.warnings.size,0);
    const {loadContext}=require('../lib/context-snapshots.cjs'),snapshot=await loadContext(loaded,snapshotId);assert.equal(snapshot.projectId,null);assert.equal(snapshot.range.projectId,'project-a');assert.equal(snapshot.transcript[0].text,'Важная речь');
  }
});
