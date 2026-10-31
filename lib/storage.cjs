'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {run}=require('./process.cjs');
async function atomicWrite(file,data) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(tmp,data,{mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}
async function readJson(file,fallback=null) {try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error('Не удалось прочитать данные приложения: '+path.basename(file));}}
async function protect(data,unprotect=false) {
  if(process.platform!=='win32')throw new Error('Защищённое хранилище этого прототипа требует Windows');
  const operation=unprotect?'Unprotect':'Protect';
  const script=`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const output=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:Buffer.from(data).toString('base64'),timeout:15000});
  return Buffer.from(output.trim(),'base64');
}
module.exports={atomicWrite,readJson,protect};
