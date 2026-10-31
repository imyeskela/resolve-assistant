const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {pathToFileURL}=require('node:url');const Module=require('node:module');
const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');
const {Controller}=require('../lib/controller.cjs');const {GENERATION_LIMITS}=require('../lib/generation-runtime.cjs');
test('host installs guards in a persistent dedicated session before load and registers only correlated controller results',async t=>{
  const root=path.resolve(__dirname,'..');const id='00000000-0000-4000-8000-000000000001';const previewUrl='http://127.0.0.1:47821/'+ 'a'.repeat(48)+'/'+id+'/index.html?preview=1';
  let onBeforeRequest,onHeadersReceived,call,win,partition,loaded=false,holdGeneration=false;const controller=new Controller(root);const commands=[];
  const dedicated={webRequest:{onBeforeRequest(fn){onBeforeRequest=fn;},onHeadersReceived(fn){onHeadersReceived=fn;}}};
  const allow=(url,resourceType='subFrame',method='GET')=>{let result;onBeforeRequest({url,resourceType,method},r=>result=!r.cancel);return result;};
  const app=new EventEmitter();app.whenReady=()=>Promise.resolve();app.quit=()=>{};
  const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  child.stdin=new Writable({write(chunk,_encoding,callback){const request=JSON.parse(String(chunk));commands.push(request.method);
    if(holdGeneration&&request.method==='generate'){controller.exclusive(signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))).catch(error=>child.stdout.write(JSON.stringify({id:request.id,error:error.message})+'\n'));callback();return;}
    if(request.method==='cancel')controller.handle('cancel');
    queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result:{workspace:{projectId:'project'},jobs:[{id,previewUrl}]}})+'\n'));callback();}});
  class BrowserWindow extends EventEmitter{constructor(options){super();win=this;this.options=options;this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=fn=>{this.open=fn;};}loadFile(file){assert.ok(onBeforeRequest);assert.ok(onHeadersReceived);assert.ok(this.webContents.listenerCount('will-frame-navigate'));assert.equal(this.options.webPreferences.session,dedicated);assert.equal(allow(pathToFileURL(file).href,'mainFrame'),true);loaded=true;}}
  const electron={app,BrowserWindow,ipcMain:{handle(_name,handler){call=handler;}},shell:{},dialog:{},session:{fromPartition(name){partition=name;return dedicated;},get defaultSession(){throw new Error('Must not touch the shared default session');}}};
  const oldLoad=Module._load;const hostPath=require.resolve('../plugin/host.cjs');delete require.cache[hostPath];
  try{
    Module._load=function(name,parent,isMain){if(name==='electron')return electron;if(name==='node:child_process')return {spawn:()=>child};if(name==='./bridge.cjs'&&parent?.filename===hostPath)return {ResolveBridge:class{async context(){return {connected:true,project:{id:'project'}}}close(){}}};if(name.endsWith('WorkflowIntegration.node'))return {};return oldLoad.call(this,name,parent,isMain);};
    require('../plugin/host.cjs').start({projectRoot:root,nodePath:process.execPath},root);await new Promise(r=>setImmediate(r));
    assert.equal(loaded,true);assert.ok(partition.startsWith('persist:'));assert.notEqual(partition,'persist:default');assert.equal(allow(previewUrl),false);
    // Uncorrelated messages and controller events cannot register URLs.
    child.stdout.write(JSON.stringify({id:999,result:{id,previewUrl}})+'\n');child.stdout.write(JSON.stringify({event:'stage',data:{id,previewUrl}})+'\n');assert.equal(allow(previewUrl),false);
    const result=await call({sender:win.webContents,senderFrame:win.webContents.mainFrame},'status',{previewUrl:'http://127.0.0.1:9999/probe'});
    assert.equal(result.ok,true);assert.equal(allow(result.result.jobs[0].previewUrl),true);assert.equal(allow('http://127.0.0.1:9999/probe'),false);
    let prevented=false;win.webContents.emit('will-frame-navigate',{url:'http://127.0.0.1:9999/probe',isMainFrame:false,preventDefault(){prevented=true;}});assert.equal(prevented,true);
    prevented=false;win.webContents.emit('will-frame-navigate',{url:previewUrl,isMainFrame:false,preventDefault(){prevented=true;}});assert.equal(prevented,false);
    let cancelled;onHeadersReceived({statusCode:302},r=>cancelled=r.cancel);assert.equal(cancelled,true);assert.deepEqual(win.open(),{action:'deny'});
    t.mock.timers.enable({apis:['setTimeout']});holdGeneration=true;
    const generation=call({sender:win.webContents,senderFrame:win.webContents.mainFrame},'generate',{});
    await new Promise(r=>setImmediate(r));assert.ok(controller.active);assert.equal(commands.at(-1),'generate');
    t.mock.timers.tick(GENERATION_LIMITS.hostMs);const timedOut=await generation;await new Promise(r=>setImmediate(r));
    assert.equal(timedOut.ok,false);assert.match(timedOut.error,/время/);assert.ok(commands.includes('cancel'));assert.equal(controller.active,null);t.mock.timers.reset();
  }finally{Module._load=oldLoad;delete require.cache[hostPath];child.stdout.end();child.stderr.end();child.stdin.end();}
});
