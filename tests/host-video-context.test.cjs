'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const Module=require('node:module');
const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');

test('host only captures explicitly requested current In/Out and strips renderer-supplied attachments',async()=>{
  const root=path.resolve(__dirname,'..'),commands=[];const range={key:'a'.repeat(64),projectId:'project',timelineId:'t'};let call,win,captures=0,cancelCapture=false;
  const app=new EventEmitter();app.whenReady=()=>Promise.resolve();app.quit=()=>{};
  const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  child.stdin=new Writable({write(chunk,_enc,callback){const m=JSON.parse(String(chunk));commands.push(m);let result={};
    if(m.method==='workspace.project')result={workspace:{projectId:'project'},jobs:[]};
    if(m.method==='videoContext.prepare')result={id:'controlled-context',range,directory:'controlled',exports:[]};
    if(m.method==='generate')result={id:'generated'};
    queueMicrotask(()=>child.stdout.write(JSON.stringify({id:m.id,result})+'\n'));callback();}});
  class BrowserWindow extends EventEmitter{constructor(){super();win=this;this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=()=>{};}loadFile(){}}
  const electron={app,BrowserWindow,ipcMain:{handle(_name,handler){call=handler;}},shell:{},dialog:{},session:{fromPartition:()=>({webRequest:{onBeforeRequest(){},onHeadersReceived(){}}})}};
  const hostPath=require.resolve('../plugin/host.cjs'),oldLoad=Module._load;delete require.cache[hostPath];
  try{
    Module._load=function(name,parent,isMain){if(name==='electron')return electron;if(name==='node:child_process')return {spawn:()=>child};if(name==='./bridge.cjs'&&parent?.filename===hostPath)return {ResolveBridge:class{async context(){return {connected:true,project:{id:'project',videoContext:range}};}async captureVideoContext(_range,_exports,{signal}){captures++;if(cancelCapture){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('Отменено');}return {transcript:[]};}close(){}}};if(name.endsWith('WorkflowIntegration.node'))return {};return oldLoad.call(this,name,parent,isMain);};
    require('../plugin/host.cjs').start({projectRoot:root,nodePath:process.execPath},root);await new Promise(r=>setImmediate(r));
    const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
    const noVideo=await call(event,'generate',{prompt:'no video',contextId:'attacker',contextTranscript:[{text:'secret'}],videoContext:{frames:[{path:'session.dpapi'}]}});
    assert.equal(noVideo.ok,true);assert.equal(captures,0);const forwarded=commands.find(c=>c.method==='generate').params;
    assert.equal(forwarded.contextId,undefined);assert.equal(forwarded.contextTranscript,undefined);assert.equal(forwarded.videoContext,undefined);
    const chat=await call(event,'chat.send',{conversationId:'chat-id',previousId:'selected-version',prompt:'Почему?',settings:{engine:'remotion'},videoContext:{frames:[{path:'session.dpapi'}]},contextId:'attacker'});
    assert.equal(chat.ok,true);const chatForwarded=commands.find(c=>c.method==='chat.send').params;
    assert.equal(chatForwarded.conversationId,'chat-id');assert.equal(chatForwarded.previousId,'selected-version');assert.equal(chatForwarded.projectId,'project');assert.equal(chatForwarded.contextId,undefined);assert.equal(chatForwarded.videoContext,undefined);
    const stale=await call(event,'generate',{prompt:'stale',videoContextKey:'b'.repeat(64)});assert.equal(stale.ok,false);assert.equal(captures,0);
    const withVideo=await call(event,'generate',{prompt:'video',videoContextKey:range.key});assert.equal(withVideo.ok,true);assert.equal(captures,1);
    assert.equal(commands.filter(c=>c.method==='generate').at(-1).params.contextId,'controlled-context');assert.ok(commands.some(c=>c.method==='videoContext.discard'));
    cancelCapture=true;const pending=call(event,'generate',{prompt:'cancel',videoContextKey:range.key});await new Promise(r=>setImmediate(r));await call(event,'cancel',{});assert.equal((await pending).ok,false);
    assert.equal(commands.filter(c=>c.method==='generate').length,2);
    assert.equal((await call(event,'videoContext.prepare',{})).ok,false);
  }finally{Module._load=oldLoad;delete require.cache[hostPath];child.stdout.end();child.stderr.end();child.stdin.end();}
});
