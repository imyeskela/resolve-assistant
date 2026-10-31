'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {startPreviewServer}=require('../lib/render.cjs');

test('preview serves only explicitly allowed composition assets with isolated CSP',async t=>{
  const parent=path.resolve(__dirname,'../workspace');await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'preview-test-'));const canonical=await fs.realpath(dir);
  assert.ok(canonical.startsWith(await fs.realpath(parent)+path.sep));
  await fs.mkdir(path.join(dir,'assets'));await fs.writeFile(path.join(dir,'index.html'),'<main>preview</main>');
  await fs.writeFile(path.join(dir,'assets/remotion.js'),'/* Remotion asset */');await fs.writeFile(path.join(dir,'job.json'),'private metadata');
  const id=randomUUID();const preview=await startPreviewServer(candidate=>candidate===id?{dir}:null);
  t.after(async()=>{preview.server.closeAllConnections();await new Promise(resolve=>preview.server.close(resolve));await fs.rm(canonical,{recursive:true,force:true});});
  const url=preview.url(id),asset=new URL('assets/remotion.js',url);
  const response=await fetch(asset);assert.equal(response.status,200);assert.equal(await response.text(),'/* Remotion asset */');assert.match(response.headers.get('content-type'),/javascript/);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(response.headers.get('content-security-policy'),/frame-src 'none'/);
  assert.equal((await fetch(new URL('job.json',url))).status,404);
  assert.equal((await fetch(new URL('../index.html',url))).status,404);
  assert.equal((await fetch(url,{method:'POST'})).status,403);
  assert.equal((await fetch(url.replace(id,randomUUID()))).status,404);
});
