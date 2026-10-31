'use strict';
const {install}=require('@puppeteer/browsers');
const {browserInstall}=require('../lib/browser.cjs');
(async()=>{
  console.log('Installing Chrome Headless Shell '+browserInstall.buildId+' for background rendering...');
  const browser=await install({...browserInstall,downloadProgressCallback:'default'});
  console.log('Background browser ready: '+browser.executablePath);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
