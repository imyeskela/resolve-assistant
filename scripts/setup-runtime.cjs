'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const https=require('node:https');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {configuration,verifyInstallation,safeRelativePath,plainPath,sha256File}=require('../lib/runtime.cjs');
const exec=promisify(execFile);
const ALLOWED_HOSTS=new Set(['nodejs.org','www.gyan.dev','github.com','release-assets.githubusercontent.com']);
async function download(url,destination,redirects=0){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||!ALLOWED_HOSTS.has(parsed.hostname)||parsed.port)throw new Error('Runtime download URL is not an approved HTTPS source');
  if(redirects>5)throw new Error('Too many runtime download redirects');
  const response=await new Promise((resolve,reject)=>{
    const request=https.get(parsed,{headers:{'User-Agent':'resolve-assistant-runtime-setup'}},resolve);
    request.setTimeout(30000,()=>request.destroy(new Error('Runtime download timed out')));request.once('error',reject);
  });
  if([301,302,303,307,308].includes(response.statusCode)){response.resume();return download(new URL(response.headers.location,parsed).href,destination,redirects+1);}
  if(response.statusCode!==200){response.resume();throw new Error(`Runtime download failed: HTTP ${response.statusCode}`);}
  let bytes=0;const limit=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>512*1024*1024?new Error('Runtime archive exceeds size limit'):null,chunk);}});
  const timeout=setTimeout(()=>response.destroy(new Error('Runtime download exceeded 15 minutes')),15*60*1000);
  try{await pipeline(response,limit,fs.createWriteStream(destination,{flags:'wx'}));}finally{clearTimeout(timeout);}
}
async function extract(zip,stage,artifact){
  for(const file of artifact.files){safeRelativePath(file.entry);safeRelativePath(file.path);}
  const spec=path.join(path.dirname(zip),artifact.name+'-entries.json');await fsp.writeFile(spec,JSON.stringify(artifact.files),{flag:'wx'});
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  await exec(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'extract-runtime.ps1'),'-Archive',zip,'-Destination',stage,'-Entries',spec],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
}
async function removeOwned(root,target){
  const relative=path.relative(root,target);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||relative.includes(path.sep))throw new Error('Unsafe runtime cleanup path');
  const stat=await fsp.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)return;if(stat.isSymbolicLink())throw new Error('Refusing runtime cleanup through a link');
  await fsp.rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
async function installRuntime(options={}){
  const {runtimeRoot,manifest}=configuration(options);
  if(!manifest.artifacts.length)throw new Error('Runtime manifest has no artifacts');
  await fsp.mkdir(runtimeRoot,{recursive:true});
  if((await fsp.lstat(runtimeRoot)).isSymbolicLink())throw new Error('Runtime root is a redirected link');
  const target=path.join(runtimeRoot,'win32-x64');
  try{plainPath(runtimeRoot,'win32-x64');verifyInstallation(target,manifest);return target;}catch(error){if(error.message.includes('redirected'))throw error;}
  const lock=path.join(runtimeRoot,'.setup-lock');await fsp.mkdir(lock).catch(error=>{throw new Error('Runtime setup is already running or its lock needs inspection',{cause:error});});
  let work,backup,moved=false,published=false;
  try{
    work=await fsp.mkdtemp(path.join(runtimeRoot,'.setup-'));const stage=path.join(work,'installed');await fsp.mkdir(stage);
    for(const artifact of manifest.artifacts){
      if(!/^[a-z0-9-]+$/.test(artifact.name)||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new Error('Invalid runtime artifact manifest');
      const zip=path.join(work,artifact.name+'.zip');
      // Cache is optional and is never trusted without the pinned archive digest.
      const cache=artifact.archiveName&&path.join(runtimeRoot,'downloads',safeRelativePath(artifact.archiveName));
      if(cache&&fs.existsSync(cache)&&sha256File(plainPath(runtimeRoot,'downloads/'+artifact.archiveName))===artifact.sha256)await fsp.copyFile(cache,zip);
      else await (options.download||download)(artifact.url,zip);
      if(sha256File(zip)!==artifact.sha256)throw new Error(`Runtime archive checksum mismatch: ${artifact.name}`);
      await (options.extract||extract)(zip,stage,artifact);
    }
    verifyInstallation(stage,manifest);
    await fsp.writeFile(path.join(stage,'provenance.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    if(fs.existsSync(target)){plainPath(runtimeRoot,'win32-x64');backup=path.join(work,'previous');await fsp.rename(target,backup);moved=true;}
    try{await fsp.rename(stage,target);published=true;}catch(error){if(moved){await fsp.rename(backup,target);moved=false;}throw error;}
    return target;
  }finally{
    // If rollback itself failed, retain the work directory and previous runtime for recovery.
    try{if(work&&(!moved||published))await removeOwned(runtimeRoot,work);}
    finally{await removeOwned(runtimeRoot,lock);}
  }
}
if(require.main===module)installRuntime().then(root=>console.log(`Verified private runtimes installed: ${root}`)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={installRuntime,download,extract};
