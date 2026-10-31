const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const engine=()=>require('../lib/remotion.cjs');
const settings={width:640,height:360,fps:29.97,duration:2,engine:'remotion'};
const source=`import React from 'react'; import {AbsoluteFill,useCurrentFrame} from 'remotion'; export default function Scene(){const frame=useCurrentFrame();return <AbsoluteFill><svg><circle cx={frame+20} cy={40} r={12} fill="orange"/></svg></AbsoluteFill>}`;
test('native TSX keeps source and derives canvas exclusively from trusted settings',()=>{
  const {normalizeReactComposition}=engine();
  const p=normalizeReactComposition({name:'Кривая',source,width:1,fps:1,duration:99},settings);
  assert.equal(p.source,source);assert.equal(p.width,640);assert.equal(p.fps,29.97);assert.equal(p.frameCount,60);assert.equal(p.duration,60/29.97);assert.equal(p.engine,'remotion');
});
test('native bundler rejects privileged imports and dynamic dependency loading',async()=>{
  const {normalizeReactComposition,prepareRemotionComposition}=engine();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remotion-deny-'));
  try{for(const bad of ["import fs from 'node:fs';", "import x from '../lib/auth.cjs';", "import x from 'https://evil.test/x.js';", "const p='node:fs'; import(p);", "require('fs');", "fetch('https://evil.test')"]){
    await assert.rejects(async()=>prepareRemotionComposition(dir,normalizeReactComposition({source:bad+'; export default function Scene(){return null;}'},settings)),/запрещ|разреш|импорт/i);
  }}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('native bundle contains only served assets and never executes source in Node',async()=>{
  const {normalizeReactComposition,prepareRemotionComposition}=engine();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remotion-build-'));
  try{
    await prepareRemotionComposition(dir,normalizeReactComposition({source:source+'\nthrow new Error("browser-only-marker")'},settings));
    assert.ok((await fs.stat(path.join(dir,'assets/remotion.js'))).size>10000);
    const html=await fs.readFile(path.join(dir,'index.html'),'utf8');assert.match(html,/assets\/remotion.js/);assert.doesNotMatch(html,/browser-only-marker/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('cancelled native render does not launch browser or write output',async()=>{
  const {demoRemotion,renderRemotion}=engine();const signal=AbortSignal.abort();
  await assert.rejects(renderRemotion(os.tmpdir(),demoRemotion(settings),{signal}),/отмен/);
});
test('native source accepts CSS top and harmless capability words in text and templates',async()=>{
  const {normalizeReactComposition,prepareRemotionComposition}=engine();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remotion-syntax-'));
  try{await prepareRemotionComposition(dir,normalizeReactComposition({source:"// window document fetch require\nexport default function Scene(){const top=20;const caption=`The world outside your window`;return <div style={{position:'absolute',top}} title='document fetch'>{caption}</div>}"},settings));assert.ok((await fs.stat(path.join(dir,'assets/remotion.js'))).size>0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('native source rejects actual capability references including template expressions and computed access',async()=>{
  const {normalizeReactComposition,prepareRemotionComposition}=engine();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remotion-capability-'));
  try{for(const statement of ['const x=window;', 'const x=`${location.href}`;', 'const x=globalThis["fetch"];', 'const x=(()=>{}).constructor;', 'const x=(function(){return this})();', 'const x=import("react");'])await assert.rejects(prepareRemotionComposition(dir,normalizeReactComposition({source:statement+'export default function Scene(){return null;}'},settings)),/запрещ|разреш|импорт/i,statement);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
