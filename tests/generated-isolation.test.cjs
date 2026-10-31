'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const dgram=require('node:dgram');const {randomUUID}=require('node:crypto');
const puppeteer=require('puppeteer-core');
const {normalizeReactComposition,prepareRemotionComposition,renderRemotion}=require('../lib/remotion.cjs');
const {startPreviewServer}=require('../lib/render.cjs');const {browserExecutable}=require('../lib/browser.cjs');
const {createPreviewPolicy}=require('../plugin/preview-policy.cjs');
const base=path.resolve(__dirname,'../.tmp/security-audit');
const settings={width:360,height:360,fps:1,duration:2,engine:'remotion'};
async function directory(){await fs.mkdir(base,{recursive:true});return fs.mkdtemp(path.join(base,'isolation-'));}
test('generated source rejects ambient capabilities and reflection but retains computed arrays/maps',async()=>{
 const dir=await directory();
 try{
  for(const code of ['new RTCPeerConnection();','new webkitRTCPeerConnection();','new EventSource("http://127.0.0.1");','const {constructor:C}=()=>{};','try{throw ()=>{};}catch({constructor:C}){}','const C=Reflect.get(()=>{},"constructor");','const C=Object.getPrototypeOf(()=>{});']){
   await assert.rejects(prepareRemotionComposition(dir,normalizeReactComposition({source:code+'export default function Scene(){return null;}'},settings)),/запрещ|разреш|импорт/i,code);
  }
  await prepareRemotionComposition(dir,normalizeReactComposition({source:`import React from 'react';export default function Scene(){const colors=['red','blue'];const map={red:'RED',blue:'BLUE'};const i=1;return <div>{map[colors[i]]}</div>;}`},settings));
  for(const body of ["for(var i=0;i<2;i++){}return <div>{i}</div>;","if(true){var label='SAFE';}return <div>{label}</div>;","switch(1){case 1:const label='SAFE';return <div>{label}</div>;default:return null;}"]){
   await prepareRemotionComposition(dir,normalizeReactComposition({source:'export default function Scene(){'+body+'}'},settings));
  }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('preview discards saved inline, bundle and self-copying srcdoc attacks; ordinary render works',async()=>{
 const dir=await directory();const udp=dgram.createSocket('udp4');let packets=0,browser,preview;
 udp.on('message',()=>packets++);await new Promise(r=>udp.bind(0,'127.0.0.1',r));
 try{
  const plan=normalizeReactComposition({source:`export default function Scene(){const colors=['red','blue'];const labels={blue:'SAFE RENDER'};let i=0;let blocked=false;const key=['con','structor'].join('');try{const C=(()=>{})[key];}catch{blocked=true;}return <div id="canary">{blocked?labels[colors[(i++,1)]]:'UNSAFE ACCESS'}</div>;}`},settings);
  await prepareRemotionComposition(dir,plan);
  const attack=`(()=>{for(const name of ['RTCPeerConnection','webkitRTCPeerConnection']){const C=globalThis[name];if(typeof C==='function'){const p=new C({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});p.createDataChannel('local-canary');p.createOffer().then(o=>p.setLocalDescription(o));}}})();`;
  const html=await fs.readFile(path.join(dir,'index.html'),'utf8');
  // The saved script can copy its own CSP-authorized bytes into srcdoc. This is
  // the audit's bypass: the child has native APIs even when its parent is guarded.
  // Only inspect the child's API type; do not create a peer or send any packets.
  const selfCopy=`(()=>{if(parent===top){globalThis.__savedSelfCopyStarted=true;addEventListener('message',e=>{if(e.data?.auditCanary)globalThis.__savedChildAPI=e.data.auditCanary;});const child=document.createElement('iframe');child.srcdoc='<script>'+document.currentScript.textContent+'</'+'script>';document.body.append(child);}else{parent.postMessage({auditCanary:typeof RTCPeerConnection},'*');}})();`;
  await fs.writeFile(path.join(dir,'index.html'),'<script>globalThis.__syntheticInlineRan=true;'+attack+'</script>'+html.replace('</body>','<script>'+selfCopy+'</script></body>'));
  await fs.writeFile(path.join(dir,'assets/remotion.js'),'globalThis.__savedBundleRan=true;'+attack+await fs.readFile(path.join(dir,'assets/remotion.js'),'utf8'));
  const result=await renderRemotion(dir,plan);assert.ok(result.bytes>0);
  const renderPackets=packets;
  const id=randomUUID();preview=await startPreviewServer(j=>j===id?{id,dir,plan}:null);
  const policy=createPreviewPolicy(path.resolve(__dirname,'..'));policy.registerControllerResult('demo',{id,previewUrl:preview.url(id)});
  browser=await puppeteer.launch({executablePath:browserExecutable(),headless:true,pipe:true});const page=await browser.newPage();const cspMessages=[];page.on('console',m=>{if(m.text().includes('Content Security Policy'))cspMessages.push(m.text());});
  // A failed optional request must never leave generated scripts unprotected.
  await page.setRequestInterception(true);page.on('request',r=>{if(r.url().endsWith('/assets/isolation.js')){r.abort();return;}const resourceType=r.resourceType()==='document'?(r.frame()===page.mainFrame()?'mainFrame':'subFrame'):r.resourceType();policy.allowsRequest({url:r.url(),method:r.method(),resourceType})?r.continue():r.abort();});
  await page.setContent('<iframe sandbox="allow-scripts" src="'+preview.url(id)+'"></iframe>');
  const frame=await page.waitForFrame(f=>f.url()===preview.url(id));await frame.waitForFunction('window.__motionReady === true');
  await new Promise(r=>setTimeout(r,700));
  assert.equal(await frame.$eval('#canary',e=>e.textContent),'SAFE RENDER');
  assert.deepEqual({renderPackets,previewPackets:packets-renderPackets},{renderPackets:0,previewPackets:0},'inline and bundled generated scripts must not send UDP');
  assert.equal(await frame.evaluate(()=>globalThis.__syntheticInlineRan),undefined,'saved inline code is never executed in preview');
  assert.deepEqual(await frame.evaluate(()=>[typeof globalThis.__savedSelfCopyStarted,typeof globalThis.__savedChildAPI,typeof globalThis.__savedBundleRan]),['undefined','undefined','undefined'],'saved CSP self-copy and bundled scripts are excluded');
  assert.equal(await frame.evaluate(()=>typeof RTCPeerConnection),'undefined');
  assert.equal(await frame.evaluate(()=>{try{Object.defineProperty(globalThis,'RTCPeerConnection',{value:()=>{}});return 'changed';}catch{return 'locked';}}),'locked');
  const initialRealm=await frame.evaluate(()=>{
   globalThis.__nestedCanary=false;
   addEventListener('message',e=>{if(e.data==='synthetic-nested-frame')globalThis.__nestedCanary=true;});
   const child=document.createElement('iframe');document.body.append(child);
   let initial;try{initial=typeof child.contentWindow.RTCPeerConnection;}catch(e){initial=e.name;}
   child.srcdoc='<script>parent.postMessage("synthetic-nested-frame","*")</script>';
   return initial;
  });
  assert.equal(initialRealm,'SecurityError','opaque sandbox prevents recovering constructors from initial about:blank');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await frame.evaluate(()=>globalThis.__nestedCanary),false);
  assert.ok(cspMessages.some(m=>m.includes('script-src')),'inherited CSP rejects the arbitrary srcdoc inline script');
 }finally{if(browser)await browser.close();if(preview)await new Promise(r=>preview.server.close(r));udp.close();await fs.rm(dir,{recursive:true,force:true});}
});
