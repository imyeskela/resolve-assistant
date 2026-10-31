const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {randomUUID}=require('node:crypto');const puppeteer=require('puppeteer-core');
const {normalizeReactComposition,prepareRemotionComposition}=require('../lib/remotion.cjs');
const {demoMotion}=require('../lib/motion.cjs');const {prepareComposition,startPreviewServer,renderEnvironment}=require('../lib/render.cjs');
const {createPreviewPolicy}=require('../plugin/preview-policy.cjs');
test('shared preview policy blocks real meta-refresh and redirect requests while native and legacy previews work',async()=>{
  let browser,preview,observer;const dirs=[];let observed=0;const blocked=[];
  try{
    observer=http.createServer((req,res)=>{observed++;res.end('probe');});await new Promise(r=>observer.listen(0,'127.0.0.1',r));
    const target='http://127.0.0.1:'+observer.address().port+'/navigation-probe';const jobs=new Map();const settings={width:640,height:360,fps:30,duration:2};
    for(const kind of ['hostile','native','legacy']){
      const id=randomUUID(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'preview-network-'));dirs.push(dir);
      if(kind==='legacy')await prepareComposition(dir,demoMotion(settings));
      else await prepareRemotionComposition(dir,normalizeReactComposition({source:kind==='hostile'?`export default function Scene(){return <meta httpEquiv="refresh" content="0;url=${target}"/>}`:"import {useCurrentFrame} from 'remotion';export default function Scene(){return <div id='frame'>{useCurrentFrame()}</div>}"},settings));
      jobs.set(id,{id,dir,kind});
    }
    preview=await startPreviewServer(async id=>jobs.get(id));
    const policy=createPreviewPolicy(path.resolve(__dirname,'..'));
    policy.registerControllerResult('status',{jobs:[...jobs.values()].map(j=>({id:j.id,previewUrl:preview.url(j.id)}))});
    const redirectId=randomUUID();const redirectUrl=preview.url(redirectId);policy.registerControllerResult('demo',{id:redirectId,previewUrl:redirectUrl});
    const originalHandlers=preview.server.listeners('request');preview.server.removeAllListeners('request');
    preview.server.on('request',(req,res)=>{if(req.url===new URL(redirectUrl).pathname+'?preview=1'){res.writeHead(302,{Location:target});res.end();}else for(const handler of originalHandlers)handler(req,res);});
    browser=await puppeteer.launch({executablePath:renderEnvironment().HYPERFRAMES_BROWSER_PATH,headless:true,pipe:true});const page=await browser.newPage();
    await page.setRequestInterception(true);page.on('request',request=>{
      const resourceType=request.resourceType()==='document'?(request.frame()===page.mainFrame()?'mainFrame':'subFrame'):request.resourceType();
      const previous=request.redirectChain().at(-1)?.response();
      const allowed=policy.allowsRequest({url:request.url(),method:request.method(),resourceType})&&(!previous||policy.allowsResponse({statusCode:previous.status()}));
      if(allowed)request.continue();else{blocked.push(request.url());request.abort();}
    });
    const hostile=[...jobs.values()].find(j=>j.kind==='hostile');
    await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src http://127.0.0.1:*"><iframe sandbox="allow-scripts" src="'+preview.url(hostile.id)+'"></iframe>');
    await new Promise(r=>setTimeout(r,800));assert.equal(observed,0,'Meta refresh must never contact an unrelated local service');
    assert.ok(blocked.includes(target),'The browser actually attempted the meta refresh');
    async function select(url){await page.evaluate(url=>document.querySelector('iframe').src=url,url);return page.waitForFrame(frame=>frame.url()===url);}
    const native=[...jobs.values()].find(j=>j.kind==='native');let frame=await select(preview.url(native.id));await frame.waitForFunction('window.__motionReady === true');
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage('pause','*'));await new Promise(r=>setTimeout(r,60));assert.equal(await frame.evaluate(()=>window.__motionSeek(10)),10);
    await new Promise(r=>setTimeout(r,80));assert.equal(await frame.$eval('#frame',e=>e.textContent),'10');
    const legacy=[...jobs.values()].find(j=>j.kind==='legacy');frame=await select(preview.url(legacy.id));await frame.waitForFunction('window.__timelines && window.__timelines.root');
    await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage('pause','*'));await new Promise(r=>setTimeout(r,60));assert.equal(await frame.evaluate(()=>window.__timelines.root.paused()),true);
    frame=await select(preview.url(native.id));await frame.waitForFunction('window.__motionReady === true');assert.equal(await frame.evaluate(()=>window.__motionSeek(20)),20);
    await page.evaluate(url=>document.querySelector('iframe').src=url,redirectUrl);await new Promise(r=>setTimeout(r,500));assert.equal(observed,0,'A redirect from even an authorized document must not contact the observer');
  }finally{if(browser)await browser.close();if(preview)await new Promise(r=>preview.server.close(r));if(observer)await new Promise(r=>observer.close(r));for(const dir of dirs)await fs.rm(dir,{recursive:true,force:true});}
});
