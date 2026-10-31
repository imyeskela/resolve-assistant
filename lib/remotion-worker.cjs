'use strict';
// Trusted worker. Model-authored code is only ever served as a browser script.
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const puppeteer=require('puppeteer-core');
const {cleanEnvironment,killTree}=require('./process.cjs');
const {normalizeVideoSettings}=require('./motion.cjs');
const {browserExecutable}=require('./browser.cjs');
const {installBrowserIsolation,ISOLATION_HASH,isolatedDocument}=require('./browser-isolation.cjs');
async function main(jobDir){
  const plan=normalizeVideoSettings({...JSON.parse(await fs.readFile(path.join(jobDir,'remotion-render.json'),'utf8')),engine:'remotion'});
  const executablePath=browserExecutable();
  const token=randomBytes(24).toString('hex');let origin;let browser;let encoder;
  const server=http.createServer(async(req,res)=>{
    if(req.method!=='GET'||req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return;}
    const url=new URL(req.url,origin);const base='/'+token;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const csp="default-src 'none'; script-src "+origin+' '+ISOLATION_HASH+"; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
    try{
      if(url.pathname===base+'/host'){
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-src "+origin);
        res.end('<!doctype html><style>html,body{margin:0;background:transparent}iframe{border:0;width:'+plan.width+'px;height:'+plan.height+'px;display:block}</style><iframe sandbox="allow-scripts" src="'+base+'/index.html?render=1"></iframe>');return;
      }
      const file=url.pathname===base+'/index.html'?'index.html':url.pathname===base+'/assets/remotion.js'?'assets/remotion.js':null;
      if(!file){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Security-Policy',csp);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');const content=await fs.readFile(path.join(jobDir,file));res.end(file==='index.html'?isolatedDocument(content.toString('utf8')):content);
    }catch{res.writeHead(404);res.end();}
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
    const base=origin+'/'+token;const permitted=new Set([base+'/host',base+'/index.html?render=1',base+'/assets/remotion.js']);
    browser=await puppeteer.launch({executablePath,headless:true,pipe:true,timeout:30000,protocolTimeout:20000,env:cleanEnvironment(),args:['--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--disable-features=Translate','--js-flags=--max-old-space-size=256']});
    const page=await browser.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);
    await page.evaluateOnNewDocument(installBrowserIsolation);
    await page.setViewport({width:plan.width,height:plan.height,deviceScaleFactor:1});
    await page.setRequestInterception(true);page.on('request',request=>{if(permitted.has(request.url())&&request.method()==='GET')request.continue();else request.abort();});
    const errors=[];page.on('pageerror',e=>errors.push(String(e.message).slice(0,400)));
    await page.goto(base+'/host',{waitUntil:'load'});
    const frame=page.mainFrame().childFrames()[0];if(!frame)throw new Error('Не удалось открыть изолированную React-композицию');
    await frame.waitForFunction('window.__motionReady === true');
    if(errors.length)throw new Error('Ошибка React-композиции: '+errors[0]);
    encoder=spawn(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(plan.fps),'-vcodec','png','-i','pipe:0','-an','-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le','-alpha_bits','16','-threads','2','-frames:v',String(plan.frameCount),path.join(jobDir,'render.partial.mov')],{windowsHide:true,shell:false,env:cleanEnvironment(),stdio:['pipe','ignore','pipe']});
    let stderr='';encoder.stderr.on('data',b=>{stderr=(stderr+b).slice(-3000);});encoder.stdin.on('error',()=>{});
    const encoded=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(new Error('Ошибка кодирования MOV: '+stderr)));});encoded.catch(()=>{});
    for(let index=0;index<plan.frameCount;index++){
      if(errors.length)throw new Error('Ошибка React-композиции: '+errors[0]);
      const actual=await frame.evaluate(index=>window.__motionSeek(index),index);
      if(actual!==index)throw new Error('Remotion не переключился на кадр '+index);
      const png=await page.screenshot({type:'png',omitBackground:true,captureBeyondViewport:false});
      if(encoder.exitCode!==null)await encoded;
      if(!encoder.stdin.write(png))await Promise.race([once(encoder.stdin,'drain'),encoded.then(()=>{throw new Error('Кодирование прервано')})]);
      if(index%Math.max(1,Math.round(plan.frameCount/10))===0)process.stdout.write('PROGRESS '+Math.round((index+1)/plan.frameCount*100)+'%\n');
    }
    encoder.stdin.end();await encoded;
  }finally{if(encoder)killTree(encoder);if(browser)await browser.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)main(path.resolve(process.argv[2])).catch(error=>{console.error(String(error.message||error));process.exitCode=1;});
module.exports={main};
