'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {renderEnvironment}=require('../lib/render.cjs');
const {browserExecutable}=require('../lib/browser.cjs');

test('background rendering never selects a desktop browser with shell tab integration',()=>{
  const executable=renderEnvironment().HYPERFRAMES_BROWSER_PATH;
  assert.equal(path.basename(executable),process.platform==='win32'?'chrome-headless-shell.exe':'chrome-headless-shell');
  assert.ok(require('node:fs').existsSync(executable),'The isolated browser must be installed');
});

test('missing render browser fails with installation guidance instead of opening Edge',t=>{
  t.mock.method(require('node:fs'),'existsSync',()=>false);
  assert.throws(()=>browserExecutable(),/browser:install/);
});

test('render browser creates no titled native browser windows and exits after close',{skip:process.platform!=='win32'},async()=>{
  const puppeteer=require('puppeteer-core');
  const {promisify}=require('node:util');
  const execFile=promisify(require('node:child_process').execFile);
  const server=require('node:http').createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end('<title>Resolve Assistant window regression</title><h1>Motion</h1>');
  });
  let browser,child;
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    browser=await puppeteer.launch({executablePath:browserExecutable(),headless:true,pipe:true});
    child=browser.process();
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:'+server.address().port);
    assert.ok((await page.screenshot()).length>0,'Offscreen rendering still works');
    const {stdout}=await execFile('powershell.exe',['-NoProfile','-File',path.join(__dirname,'fixtures/browser-windows.ps1'),'-BrowserProcessId',String(child.pid)],{windowsHide:true});
    assert.deepEqual(JSON.parse(stdout),[],'No hidden desktop browser window should be created');
  }finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
  assert.notEqual(child.exitCode,null,'The owned browser process must be reaped');
});
