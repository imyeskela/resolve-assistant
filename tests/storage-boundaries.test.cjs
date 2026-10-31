'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {loadContext,persistContext}=require('../lib/context-snapshots.cjs');
const {Controller}=require('../lib/controller.cjs');
const {ConversationStore}=require('../lib/conversations.cjs');
const {WorkspaceStore}=require('../lib/workspaces.cjs');

async function fixture(t){
  const root=path.resolve(__dirname,'../.tmp/security-audit/paths');await fs.mkdir(root,{recursive:true});
  const base=await fs.mkdtemp(path.join(root,'test-'));
  t.after(async()=>{assert.equal(path.dirname(base),root);await fs.rm(base,{recursive:true,force:true});});
  const jobs=path.join(base,'selected','jobs'),outside=path.join(base,'outside');
  await fs.mkdir(jobs,{recursive:true});await fs.mkdir(outside);
  const doc={id:randomUUID(),projectId:'project',directory:path.join(jobs,'.conversations')};
  return {base,jobs,outside,doc};
}
async function link(t,target,dest,type='junction'){
  try{await fs.symlink(target,dest,type);return true;}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Filesystem links unavailable: '+e.code);return false;}throw e;}
}
async function context(directory,doc){
  const id=randomUUID(),dir=path.join(directory,id);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'image-0.jpg'),Buffer.from([255,216,255,217]));
  const data={id,projectId:doc.projectId,compositionId:doc.id,frames:[{file:'image-0.jpg',seconds:0}],transcript:[]};
  await fs.writeFile(path.join(dir,'snapshot.json'),JSON.stringify(data));return {id,dir,data};
}
function job(id){return {id,projectId:'project',createdAt:'2026-01-01',status:'preview_ready',plan:{name:'Synthetic',width:100,height:100,fps:30,duration:1,elements:[]}};}
function controller(base){const c=new Controller(base);c.loadedDirs=new Set();return c;}

test('context loading rejects a .contexts junction outside the selected jobs root',async t=>{
  const f=await fixture(t),s=await context(f.outside,f.doc);
  if(!await link(t,f.outside,path.join(f.jobs,'.contexts')))return;
  await assert.rejects(loadContext(f.doc,s.id));
});
test('context persistence rejects a .contexts junction without writing to its target',async t=>{
  const f=await fixture(t);if(!await link(t,f.outside,path.join(f.jobs,'.contexts')))return;
  await assert.rejects(persistContext(f.doc,{id:randomUUID()},{id:randomUUID()},{frames:[],transcript:[]}));
  assert.deepEqual(await fs.readdir(f.outside),[]);
});
test('snapshot metadata cannot be read through a file symlink outside its snapshot',async t=>{
  const f=await fixture(t),s=await context(path.join(f.jobs,'.contexts'),f.doc),outsideFile=path.join(f.outside,'snapshot.json');
  await fs.writeFile(outsideFile,JSON.stringify(s.data));await fs.unlink(path.join(s.dir,'snapshot.json'));
  if(!await link(t,outsideFile,path.join(s.dir,'snapshot.json'),'file'))return;
  await assert.rejects(loadContext(f.doc,s.id));
});
test('an explicitly selected external project root may itself be a junction',async t=>{
  const f=await fixture(t),alias=path.join(f.base,'project-alias');if(!await link(t,path.dirname(f.jobs),alias))return;
  const store=await new WorkspaceStore(f.base).init();store.setProject({id:'project'});await store.selectDirectory('project',alias);
  assert.equal((await store.prepareTarget()).directory,path.join(f.base,'selected'));
  const doc={...f.doc,directory:path.join(alias,'jobs','.conversations')};
  const saved=await persistContext(doc,{id:randomUUID()},{id:randomUUID()},{frames:[],transcript:[]});
  assert.equal((await loadContext(doc,saved.id)).compositionId,doc.id);
  const id=randomUUID();await fs.mkdir(path.join(f.jobs,id));await fs.writeFile(path.join(f.jobs,id,'job.json'),JSON.stringify(job(id)));
  const c=controller(f.base);await c.loadJobs(path.join(alias,'jobs'));assert.equal(c.jobs.get(id)?.plan.name,'Synthetic');
});
test('job loading ignores UUID directories that escape the selected root through junctions',async t=>{
  const f=await fixture(t),id=randomUUID();await fs.writeFile(path.join(f.outside,'job.json'),JSON.stringify(job(id)));
  if(!await link(t,f.outside,path.join(f.jobs,id)))return;
  const c=controller(f.base);await c.loadJobs(f.jobs);assert.equal(c.jobs.has(id),false);
});
test('job loading ignores job.json symlinks outside their job directory',async t=>{
  const f=await fixture(t),id=randomUUID(),dir=path.join(f.jobs,id);await fs.mkdir(dir);
  const file=path.join(f.outside,'job.json');await fs.writeFile(file,JSON.stringify(job(id)));
  if(!await link(t,file,path.join(dir,'job.json'),'file'))return;
  const c=controller(f.base);await c.loadJobs(f.jobs);assert.equal(c.jobs.has(id),false);
});
test('saved revision recovery rejects a job directory junction',async t=>{
  const f=await fixture(t),id=randomUUID(),dir=path.join(f.jobs,id);await fs.writeFile(path.join(f.outside,'job.json'),JSON.stringify(job(id)));
  if(!await link(t,f.outside,dir))return;
  const saved=await new ConversationStore().savedJobs(f.jobs,new Map([[id,{id,dir}]]));assert.equal(saved.size,0);
});
test('conversation loading does not follow a .conversations junction',async t=>{
  const f=await fixture(t),store=new ConversationStore();
  await fs.writeFile(path.join(f.outside,f.doc.id+'.json'),JSON.stringify({...f.doc,name:'Synthetic',updatedAt:'2026-01-01',jobIds:[],messages:[]}));
  if(!await link(t,f.outside,f.doc.directory))return;
  await store.load(f.jobs,new Map());assert.equal(store.items.size,0);
  assert.deepEqual(await fs.readdir(f.outside),[f.doc.id+'.json']);
});
test('conversation creation cannot write through a .conversations junction',async t=>{
  const f=await fixture(t);if(!await link(t,f.outside,f.doc.directory))return;
  await assert.rejects(new ConversationStore().create({jobsDir:f.jobs,projectId:'project'},{}));
  assert.deepEqual(await fs.readdir(f.outside),[]);
});
test('job saves reject a job directory that was replaced by a junction',async t=>{
  const f=await fixture(t),id=randomUUID(),dir=path.join(f.jobs,id),c=controller(f.base);
  await fs.mkdir(dir);await fs.writeFile(path.join(dir,'job.json'),JSON.stringify(job(id)));await c.loadJobs(f.jobs);
  await fs.unlink(path.join(dir,'job.json'));await fs.rmdir(dir);
  if(!await link(t,f.outside,dir))return;
  await assert.rejects(c.save(c.jobs.get(id)));assert.deepEqual(await fs.readdir(f.outside),[]);
});
test('preparing storage rejects a jobs junction outside the selected project directory',async t=>{
  const f=await fixture(t);await fs.rmdir(f.jobs);if(!await link(t,f.outside,f.jobs))return;
  const store=await new WorkspaceStore(f.base).init();store.setProject({id:'project',mediaDirectory:path.dirname(f.jobs)});
  await assert.rejects(store.prepareTarget());assert.deepEqual(store.data.roots,[]);
});
test('selecting storage rejects a jobs junction without recording that directory',async t=>{
  const f=await fixture(t);await fs.rmdir(f.jobs);if(!await link(t,f.outside,f.jobs))return;
  const store=await new WorkspaceStore(f.base).init();store.setProject({id:'project'});
  await assert.rejects(store.selectDirectory('project',path.dirname(f.jobs)));assert.deepEqual(store.data.projects,{});
});
test('loading remembered storage does not treat a replaced jobs junction as a new trusted root',async t=>{
  const f=await fixture(t),id=randomUUID();await fs.mkdir(path.join(f.outside,id));await fs.writeFile(path.join(f.outside,id,'job.json'),JSON.stringify(job(id)));
  await fs.rmdir(f.jobs);if(!await link(t,f.outside,f.jobs))return;
  const c=controller(f.base);await c.loadJobs(f.jobs);assert.equal(c.jobs.size,0);
});
async function swappedRoot(t){
  const f=await fixture(t),id=randomUUID(),dir=path.join(f.jobs,id);await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'job.json'),JSON.stringify({...job(id),trustedJobsRoot:f.outside}));
  const c=controller(f.base);await c.loadJobs(f.jobs);const doc=c.conversations.items.get(id);
  const saved=await persistContext(doc,{id:randomUUID()},{id:randomUUID()},{frames:[],transcript:[]});
  await fs.cp(f.jobs,f.outside,{recursive:true});
  const original=path.join(f.base,'original-jobs');assert.equal(path.dirname(original),f.base);await fs.rename(f.jobs,original);
  if(!await link(t,f.outside,f.jobs))return null;
  return {...f,c,id,doc,snapshotId:saved.id};
}
test('job save refuses a previously trusted jobs root replaced between operations',async t=>{
  const f=await swappedRoot(t);if(!f)return;
  const file=path.join(f.outside,f.id,'job.json'),before=await fs.readFile(file,'utf8');
  f.c.jobs.get(f.id).prompt='must not reach outside';await assert.rejects(f.c.save(f.c.jobs.get(f.id)));
  assert.equal(await fs.readFile(file,'utf8'),before);
});
test('conversation save refuses a root swap even for a cloned document',async t=>{
  const f=await swappedRoot(t);if(!f)return;
  const file=path.join(f.outside,'.conversations',f.doc.id+'.json'),before=await fs.readFile(file,'utf8');
  await assert.rejects(f.c.conversations.save({...structuredClone(f.doc),name:'must not reach outside',trustedJobsRoot:f.outside}));
  assert.equal(await fs.readFile(file,'utf8'),before);
});
test('context loading refuses a previously trusted jobs root replaced between operations',async t=>{
  const f=await swappedRoot(t);if(!f)return;
  await assert.rejects(loadContext(f.doc,f.snapshotId));
});
test('context persistence refuses a root swap without creating an outside snapshot',async t=>{
  const f=await swappedRoot(t);if(!f)return;const directory=path.join(f.outside,'.contexts'),before=await fs.readdir(directory);
  await assert.rejects(persistContext(f.doc,{id:randomUUID()},{id:randomUUID()},{frames:[],transcript:[]}));
  assert.deepEqual(await fs.readdir(directory),before);
});
