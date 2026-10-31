'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const manifest=require('../runtime-manifest.json');
const RUNTIME_ROOT=path.resolve(__dirname,'../.runtime');
function safeRelativePath(value){
  if(typeof value!=='string'||!value||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new Error('Unsafe runtime path');
  return value;
}
function plainPath(root,relative){
  root=path.resolve(root);safeRelativePath(relative);
  let current=root;
  for(const part of ['',...relative.split('/')]){
    if(part)current=path.join(current,part);
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink())throw new Error('Runtime path is a redirected link');
    if(current!==path.join(root,relative)&&!stat.isDirectory())throw new Error('Runtime parent is not a directory');
  }
  return current;
}
function sha256File(file){
  const hash=createHash('sha256');const fd=fs.openSync(file,'r');const buffer=Buffer.allocUnsafe(1024*1024);
  try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest('hex');}finally{fs.closeSync(fd);}
}
function verifyFile(root,file){
  if(!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid runtime checksum in manifest');
  const resolved=plainPath(root,file.path);
  if(!fs.lstatSync(resolved).isFile())throw new Error('Runtime entry is not a file');
  if(sha256File(resolved)!==file.sha256)throw new Error(`Runtime checksum mismatch: ${file.path}`);
  return resolved;
}
function configuration(options={}){
  const selected=options.manifest||manifest;
  if((options.platform||process.platform)!==selected.platform||(options.arch||process.arch)!==selected.arch||selected.platform!=='win32'||selected.arch!=='x64')throw new Error('Pinned runtime requires Windows x64');
  return {manifest:selected,runtimeRoot:path.resolve(options.runtimeRoot||RUNTIME_ROOT)};
}
function installedRoot(options={}){const config=configuration(options);return path.join(config.runtimeRoot,'win32-x64');}
function runtimeExecutable(name,options={}){
  const config=configuration(options);const file=config.manifest.artifacts.flatMap(a=>a.files).find(f=>f.executable===name);
  if(!file)throw new Error(`Unknown runtime executable: ${name}`);
  try{return verifyFile(config.runtimeRoot,{...file,path:'win32-x64/'+file.path});}
  catch(error){throw new Error(`Verified ${name} runtime unavailable; run npm run runtime:setup. ${error.message}`,{cause:error});}
}
function runtimePaths(options={}){return Object.fromEntries(configuration(options).manifest.artifacts.flatMap(a=>a.files).filter(f=>f.executable).map(f=>[f.executable,runtimeExecutable(f.executable,options)]));}
function verifyInstallation(root,selected=manifest){for(const artifact of selected.artifacts)for(const file of artifact.files)verifyFile(root,file);return true;}
function assertCurrentRuntime(){const expected=runtimeExecutable('node');if(fs.realpathSync(process.execPath).toLowerCase()!==fs.realpathSync(expected).toLowerCase())throw new Error('Start the application with the pinned private Node runtime (npm start / npm run check).');return expected;}
module.exports={runtimeExecutable,runtimePaths,assertCurrentRuntime,RUNTIME_ROOT,manifest,configuration,installedRoot,safeRelativePath,plainPath,sha256File,verifyFile,verifyInstallation};
