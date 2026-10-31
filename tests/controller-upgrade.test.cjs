'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Controller}=require('../lib/controller.cjs');
const {WorkspaceStore}=require('../lib/workspaces.cjs');

async function fixture(t){
  const parent=path.resolve(__dirname,'../workspace');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'upgrade-test-'));const canonical=await fs.realpath(root);
  assert.ok(canonical.startsWith(await fs.realpath(parent)+path.sep));
  t.after(()=>fs.rm(canonical,{recursive:true,force:true}));
  const media=path.join(root,'Media');await fs.mkdir(media);
  const c=new Controller(root);c.workspace=await new WorkspaceStore(root).init();c.loadedDirs=new Set();c.preview={url:id=>'http://127.0.0.1/test/'+id};
  await c.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});
  return {c,root,media};
}
test('renaming persists while keeping exported media paths and imports intact',async t=>{
  const {c,root,media}=await fixture(t);
  const original=await c.handle('demo',{settings:{width:1920,height:1080,fps:30,duration:2,engine:'hyperframes'}});
  const saved=c.job(original.id),file=path.join(saved.dir,'motion.mov');await fs.writeFile(file,'existing MOV');saved.output={file,bytes:12};saved.imports={a:'existing-media-id'};await c.save(saved);
  const result=await c.handle('rename',{id:saved.id,name:'  Новый заголовок  '});
  assert.equal(result.name,'Новый заголовок');assert.equal(result.output.file,file);assert.equal(result.imports.a,'existing-media-id');assert.equal(result.createdAt,original.createdAt);
  const reloaded=new Controller(root);reloaded.workspace=await new WorkspaceStore(root).init();reloaded.loadedDirs=new Set();reloaded.preview=c.preview;
  await reloaded.handle('workspace.project',{project:{id:'a',name:'Renamed',mediaDirectory:media}});
  assert.equal(reloaded.listJobs()[0].name,'Новый заголовок');assert.equal((await reloaded.handle('artifact',{id:saved.id})).file,file);assert.equal(await fs.readFile(file,'utf8'),'existing MOV');
});
test('rename rejects invalid names and a different project without modifying the job',async t=>{
  const {c}=await fixture(t);const j=await c.handle('demo',{settings:{width:1920,height:1080,fps:30,duration:2,engine:'hyperframes'}});
  for(const name of ['', '   ', 'a'.repeat(121), 'line\nbreak', null])await assert.rejects(c.handle('rename',{id:j.id,name}),/назван|имя/i);
  await c.handle('workspace.project',{project:{id:'b',name:'B'}});
  await assert.rejects(c.handle('rename',{id:j.id,name:'Wrong project'}),/Проект изменился/);
  assert.equal(c.jobs.get(j.id).plan.name,j.name);
});
test('invalid engine fails clearly before a composition is created',async t=>{
  const {c}=await fixture(t);
  await assert.rejects(c.handle('demo',{settings:{width:1920,height:1080,fps:30,duration:2,engine:'unknown'}}),/движ|engine/i);
  assert.equal(c.listJobs().length,0);
});

test('controller creates its own context destinations and discards only a known pending context',async t=>{
  const {c,root}=await fixture(t);const {normalizeRange}=require('../lib/video-context.cjs');
  const range=normalizeRange({projectId:'a',timelineId:'t',timelineName:'A',fps:25,timelineStart:90000,timelineEnd:95000,markIn:0,markOut:199});
  const capture=await c.handle('videoContext.prepare',{range});
  assert.ok(capture.directory.startsWith(path.join(root,'.data','video-context')+path.sep));assert.equal(capture.exports.length,8);
  await fs.writeFile(capture.exports[0].file,'partial');await c.handle('videoContext.discard',{id:'../../unrelated'});assert.ok(await fs.stat(capture.directory));
  await c.handle('videoContext.discard',{id:capture.id});await assert.rejects(fs.stat(capture.directory),{code:'ENOENT'});
  await c.handle('workspace.project',{project:{id:'b',name:'B'}});
  await assert.rejects(c.handle('videoContext.prepare',{range}),/Проект изменился/);
});

test('native demo persists editable TSX and restores the correct engine without a model request',async t=>{
  const {c,root,media}=await fixture(t);
  const j=await c.handle('demo',{settings:{width:3840,height:2160,fps:29.97,duration:2,engine:'remotion'}});
  assert.equal(j.plan.engine,'remotion');assert.equal(j.plan.width,3840);assert.equal(j.plan.fps,29.97);assert.equal(j.plan.frameCount,60);
  assert.match(j.plan.source,/export default/);assert.equal(await fs.readFile(path.join(j.directory,'source.tsx'),'utf8'),j.plan.source);
  assert.ok((await fs.stat(path.join(j.directory,'assets/remotion.js'))).size>1000);
  const reloaded=new Controller(root);reloaded.workspace=await new WorkspaceStore(root).init();reloaded.loadedDirs=new Set();reloaded.preview=c.preview;
  await reloaded.handle('workspace.project',{project:{id:'a',name:'A',mediaDirectory:media}});
  assert.equal(reloaded.listJobs()[0].plan.engine,'remotion');assert.equal(reloaded.listJobs()[0].plan.source,j.plan.source);
});
