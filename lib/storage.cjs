'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {run}=require('./process.cjs');
async function atomicWrite(file,data) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(tmp,data,{mode:0o600});
    for(let attempt=0;;attempt++){
      try{await fs.rename(tmp,file);return;}
      catch(error){
        // Windows sharing restrictions can briefly deny rename. Never remove
        // the destination to work around a lock, and never retry other errors.
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;
        await delay(25*2**attempt);
      }
    }
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
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
