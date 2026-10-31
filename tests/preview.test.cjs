'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {startPreviewServer}=require('../lib/render.cjs');
const {demoMotion}=require('../lib/motion.cjs');

test('preview serves only explicitly allowed composition assets with isolated CSP',async t=>{
  const parent=path.resolve(__dirname,'../workspace');await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'preview-test-'));const canonical=await fs.realpath(dir);
  assert.ok(canonical.startsWith(await fs.realpath(parent)+path.sep));
  await fs.mkdir(path.join(dir,'assets'));await fs.writeFile(path.join(dir,'index.html'),'<main>preview</main>');
  await fs.writeFile(path.join(dir,'assets/remotion.js'),'/* Remotion asset */');await fs.writeFile(path.join(dir,'job.json'),'private metadata');
  const id=randomUUID();const preview=await startPreviewServer(candidate=>candidate===id?{dir,plan:demoMotion({width:640,height:360,fps:30,duration:2})}:null);
  t.after(async()=>{preview.server.closeAllConnections();await new Promise(resolve=>preview.server.close(resolve));await fs.rm(canonical,{recursive:true,force:true});});
  const url=preview.url(id),asset=new URL('assets/gsap.min.js',url);
  const response=await fetch(asset);assert.equal(response.status,200);assert.match(await response.text(),/GSAP/);assert.match(response.headers.get('content-type'),/javascript/);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(response.headers.get('content-security-policy'),/frame-src 'none'/);
  assert.equal((await fetch(new URL('job.json',url))).status,404);
  assert.equal((await fetch(new URL('../index.html',url))).status,404);
  assert.equal((await fetch(url,{method:'POST'})).status,403);
  assert.equal((await fetch(url.replace(id,randomUUID()))).status,404);
});
