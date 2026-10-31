'use strict';
const {spawn}=require('node:child_process');
function cleanEnvironment(extra={}) {
  const env={};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATH','Path','PATHEXT','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','HOMEDRIVE','HOMEPATH','ProgramFiles','ProgramW6432','PROGRAMFILES(X86)','NUMBER_OF_PROCESSORS']) {
    if(process.env[key])env[key]=process.env[key];
  }
  return {...env,DO_NOT_TRACK:'1',HYPERFRAMES_NO_TELEMETRY:'1',...extra};
}
function killTree(child) {
  if(!child||child.exitCode!==null||!child.pid)return;
  if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  else child.kill('SIGTERM');
}
function run(executable,args,{cwd,env=cleanEnvironment(),signal,timeout=600000,onLine,input,binary=false,maxBytes=24*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new Error('Задание отменено'));
    const child=spawn(executable,args,{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let out=[],size=0,err='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{killTree(child);finish(new Error('Задание отменено'));};
    const timer=setTimeout(()=>{killTree(child);finish(new Error('Превышено время выполнения'))},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',d=>{size+=d.length;if(size>maxBytes){killTree(child);finish(new Error('Слишком большой ответ процесса'));return;}out.push(d);if(!binary)onLine?.(d.toString());});
    child.stderr.on('data',d=>{err=(err+d.toString()).slice(-6000);if(!binary)onLine?.(d.toString());});
    child.on('error',e=>finish(new Error(`Не удалось запустить ${require('node:path').basename(executable)}: ${e.code||'ошибка'}`)));
    child.on('close',code=>{if(code!==0)return finish(new Error(`Процесс завершился с кодом ${code}: ${(err+'\n'+(binary?'':Buffer.concat(out).toString())).slice(-2200)}`));const b=Buffer.concat(out);finish(null,binary?b:b.toString());});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
module.exports={run,cleanEnvironment,killTree};
