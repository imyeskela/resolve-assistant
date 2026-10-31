const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {WorkspaceStore}=require('../lib/workspaces.cjs');
const {Controller}=require('../lib/controller.cjs');

async function fixture(t){
  const parent=path.resolve(__dirname,'../workspace');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'storage-test-'));
  const canonical=await fs.realpath(root),tempRoot=await fs.realpath(parent);
  assert.ok(canonical.startsWith(tempRoot+path.sep));
  t.after(()=>fs.rm(canonical,{recursive:true,force:true}));
  const store=await new WorkspaceStore(root).init();
  return {root,store};
}
test('uses Resolve project media location and creates jobs beside the media',async t=>{
  const {root,store}=await fixture(t);
  const media=path.join(root,'Проект с пробелами');await fs.mkdir(media);
  store.setProject({id:'project-a',name:'A',mediaDirectory:media});
  const target=await store.prepareTarget();
  assert.equal(target.jobsDir,path.join(await fs.realpath(media),'jobs'));
  assert.equal(target.projectId,'project-a');assert.equal(target.source,'project');
  assert.ok((await fs.stat(target.jobsDir)).isDirectory());
});
test('database projects without a media directory require a one-time folder choice',async t=>{
  const {root,store}=await fixture(t);
  store.setProject({id:'project-a',name:'Database project'});
  await assert.rejects(store.prepareTarget(),/Выберите папку проекта/);
  const selected=path.join(root,'Chosen');await fs.mkdir(selected);
  await store.selectDirectory('project-a',selected);
  const reloaded=await new WorkspaceStore(root).init();
  reloaded.setProject({id:'project-a',name:'Renamed project'});
  assert.equal((await reloaded.prepareTarget()).jobsDir,path.join(await fs.realpath(selected),'jobs'));
});
test('folder choice belongs to project ID, independently of name and other projects',async t=>{
  const {root,store}=await fixture(t);
  const a=path.join(root,'A'),b=path.join(root,'B');await fs.mkdir(a);await fs.mkdir(b);
  store.setProject({id:'id-a',name:'Same name'});await store.selectDirectory('id-a',a);
  store.setProject({id:'id-b',name:'Same name'});await store.selectDirectory('id-b',b);
  assert.equal((await store.prepareTarget()).jobsDir,path.join(await fs.realpath(b),'jobs'));
  store.setProject({id:'id-a',name:'Renamed'});
  assert.equal((await store.prepareTarget()).jobsDir,path.join(await fs.realpath(a),'jobs'));
});
test('changing storage preserves old outputs and remembers their job root',async t=>{
  const {root,store}=await fixture(t);const a=path.join(root,'A'),b=path.join(root,'B');await fs.mkdir(a);await fs.mkdir(b);
  store.setProject({id:'project-a',name:'A'});await store.selectDirectory('project-a',a);
  const first=await store.prepareTarget();const file=path.join(first.jobsDir,'existing.mov');await fs.writeFile(file,'existing media');
  await store.selectDirectory('project-a',b);const second=await store.prepareTarget();
  assert.notEqual(first.jobsDir,second.jobsDir);assert.equal(await fs.readFile(file,'utf8'),'existing media');
  assert.ok(store.directoriesForProject().includes(first.jobsDir));assert.ok(store.directoriesForProject().includes(second.jobsDir));
});
test('captured job target stays in its original project after project switch',async t=>{
  const {root,store}=await fixture(t);const a=path.join(root,'A'),b=path.join(root,'B');await fs.mkdir(a);await fs.mkdir(b);
  store.setProject({id:'a',name:'A',mediaDirectory:a});const captured=await store.prepareTarget();
  store.setProject({id:'b',name:'B',mediaDirectory:b});
  assert.equal(captured.projectId,'a');assert.equal(captured.jobsDir,path.join(await fs.realpath(a),'jobs'));
});
test('missing configured storage reports an error instead of falling back into the application',async t=>{
  const {root,store}=await fixture(t);const media=path.join(root,'Missing');
  store.setProject({id:'a',name:'A',mediaDirectory:media});
  await assert.rejects(store.prepareTarget(),/недоступна/);
  assert.equal(store.info().jobsDir,path.join(media,'jobs'));
});
test('rejects a stale project selection and relative folder paths',async t=>{
  const {store}=await fixture(t);store.setProject({id:'a',name:'A'});
  await assert.rejects(store.selectDirectory('b','relative'),/Проект изменился/);
  await assert.rejects(store.selectDirectory('a','relative'),/абсолютный/);
});
test('controller creates jobs in project folders, restores history, and retains old MOV paths',async t=>{
  const {root,store}=await fixture(t);const a=path.join(root,'A'),b=path.join(root,'B');await fs.mkdir(a);await fs.mkdir(b);
  function controller(workspace){const c=new Controller(root);c.workspace=workspace;c.loadedDirs=new Set();c.preview={url:id=>'http://127.0.0.1/test/'+id};return c;}
  const c=controller(store);
  await c.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:a}});
  const job=await c.handle('demo',{settings:{width:1920,height:1080,fps:30,duration:5}});
  assert.equal(job.projectId,'a');assert.equal(path.dirname(job.directory),path.join(await fs.realpath(a),'jobs'));
  const saved=c.job(job.id);const movie=path.join(saved.dir,'motion.mov');await fs.writeFile(movie,'existing MOV');saved.output={file:movie};await c.save(saved);
  await c.handle('workspace.project',{project:{id:'b',name:'B',mediaDirectory:b}});
  assert.equal(c.listJobs().length,0);
  await assert.rejects(c.handle('demo',{projectId:'a'}),/Проект изменился/);
  await assert.rejects(c.handle('generate',{projectId:'a',prompt:'test'}),/Проект изменился/);
  await c.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:a}});
  await c.handle('workspace.select',{projectId:'a',directory:b});
  assert.equal((await c.handle('artifact',{id:job.id})).file,movie);
  const reloaded=controller(await new WorkspaceStore(root).init());
  await reloaded.handle('workspace.project',{project:{id:'a',name:'Renamed'}});
  assert.equal(reloaded.listJobs()[0].id,job.id);
  assert.equal((await reloaded.handle('artifact',{id:job.id})).file,movie);
  assert.equal(await fs.readFile(movie,'utf8'),'existing MOV');
});
test('Windows case aliases do not replace canonical job paths or break MOV import', {skip:process.platform!=='win32'}, async t=>{
  const {root,store}=await fixture(t);const media=path.join(root,'MixedCase');await fs.mkdir(media);
  const c=new Controller(root);c.workspace=store;c.loadedDirs=new Set();c.preview={url:id=>'http://127.0.0.1/test/'+id};
  const project={id:'case-test',name:'Test',mediaDirectory:media.toLowerCase()};
  await c.handle('workspace.project',{project});const job=await c.handle('demo',{settings:{width:1920,height:1080,fps:30,duration:5}});
  const saved=c.job(job.id),file=path.join(saved.dir,'motion.mov');await fs.writeFile(file,'MOV');saved.output={file};await c.save(saved);
  c.jobs.clear();c.loadedDirs.clear();await c.handle('workspace.project',{project});
  assert.equal((await c.handle('artifact',{id:job.id})).file,file);
  assert.equal(c.job(job.id).dir,path.join(await fs.realpath(media),'jobs',job.id));
  c.job(job.id).output.file=file.toLowerCase();await c.save(c.job(job.id));c.jobs.clear();c.loadedDirs.clear();
  await c.handle('workspace.project',{project});
  assert.equal((await c.handle('artifact',{id:job.id})).file,file);
});
