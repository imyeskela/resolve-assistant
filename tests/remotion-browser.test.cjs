const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {normalizeReactComposition,prepareRemotionComposition,renderRemotion}=require('../lib/remotion.cjs');
const {startPreviewServer,renderEnvironment}=require('../lib/render.cjs');
const puppeteer=require('puppeteer-core');
test('isolated native preview uses actual frames, toolbar messages, and denies network',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remotion-browser-'));let server,browser;
  try{
    const plan=normalizeReactComposition({source:"import React from 'react';import {useCurrentFrame} from 'remotion';export default function Scene(){const frame=useCurrentFrame();return <svg><text>{frame}</text><circle cx={frame+30} cy={40} r={10}/></svg>}"},{width:640,height:360,fps:29.97,duration:2});await prepareRemotionComposition(dir,plan);
    const id=randomUUID();const preview=await startPreviewServer(async found=>found===id?{dir,plan}:null);server=preview.server;
    browser=await puppeteer.launch({executablePath:renderEnvironment().HYPERFRAMES_BROWSER_PATH,headless:true,pipe:true});
    const page=await browser.newPage();await page.setContent('<iframe sandbox="allow-scripts" src="'+preview.url(id)+'"></iframe>');
    const frame=page.mainFrame().childFrames()[0];await frame.waitForFunction('window.__motionReady === true');
    await frame.evaluate(()=>{
      window.__testPlayback={command:null,frames:[]};
      addEventListener('message',event=>{if(event.source===parent){window.__testPlayback.command=event.data;window.__testPlayback.frames=[];}});
      new MutationObserver(()=>window.__testPlayback.frames.push(Number(document.querySelector('svg text').textContent))).observe(document.querySelector('svg text'),{childList:true,characterData:true,subtree:true});
    });
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage('pause','*'));
    await frame.waitForFunction('window.__testPlayback.command === "pause"',{timeout:5000});
    const actual=await frame.evaluate(()=>window.__motionSeek(30));assert.equal(actual,30);
    const pausedFrames=await frame.evaluate(async()=>{const samples=[];for(let i=0;i<8;i++){await new Promise(requestAnimationFrame);samples.push(Number(document.querySelector('svg text').textContent));}return samples;});
    assert.deepEqual(pausedFrames,Array(8).fill(30));
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage('play','*'));
    // Observe actual rendered progress in the browser, including valid 59→0 loop wraps.
    await frame.waitForFunction('window.__testPlayback.command === "play" && window.__testPlayback.frames.some(value => value !== 30)',{timeout:5000});
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage('restart','*'));
    await frame.waitForFunction('window.__testPlayback.command === "restart" && window.__testPlayback.frames.includes(0) && window.__testPlayback.frames.some(value => value > 0)',{timeout:5000});
    assert.equal(await frame.evaluate(async()=>{try{await fetch('https://example.com');return 'allowed'}catch{return 'blocked'}}),'blocked');
    assert.equal(await frame.evaluate(()=>{try{return parent.document.body.tagName}catch{return 'isolated'}}),'isolated');
  }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
test('cancellation interrupts a generated infinite loop in the isolated render worker',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remotion-cancel-'));
  try{
    const plan=normalizeReactComposition({source:'export default function Scene(){while(true){} return null;}'},{width:360,height:360,fps:30,duration:2});
    await prepareRemotionComposition(dir,plan);const started=Date.now();
    await assert.rejects(renderRemotion(dir,plan,{signal:AbortSignal.timeout(1800)}),/отмен/);
    assert.ok(Date.now()-started<8000,'Cancellation must not wait for generated JavaScript');
    assert.equal(await fs.stat(path.join(dir,'motion.mov')).then(()=>true,()=>false),false);
  }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
