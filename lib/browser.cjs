'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {Browser,computeExecutablePath}=require('@puppeteer/browsers');
const {PUPPETEER_REVISIONS}=require('puppeteer-core');

// Never fall back to desktop Edge/Chrome: headless desktop browsers still
// create native windows and may register tabs with the Windows shell.
const browserInstall={
  browser:Browser.CHROMEHEADLESSSHELL,
  buildId:PUPPETEER_REVISIONS['chrome-headless-shell'],
  cacheDir:path.resolve(__dirname,'../.data/browser')
};
function browserExecutable(){
  const executable=computeExecutablePath(browserInstall);
  if(!fs.existsSync(executable))throw new Error('Браузер фонового рендера не установлен. Выполните npm.cmd run browser:install в папке Resolve Assistant.');
  return executable;
}
module.exports={browserInstall,browserExecutable};
