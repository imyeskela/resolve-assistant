'use strict';
const {spawnSync}=require('node:child_process');
const {runtimeExecutable}=require('../lib/runtime.cjs');
const {cleanEnvironment}=require('../lib/process.cjs');
try{
  if(!process.argv.slice(2).length)throw new Error('Укажите скрипт или аргументы Node.js');
  const child=spawnSync(runtimeExecutable('node'),process.argv.slice(2),{cwd:process.cwd(),env:cleanEnvironment(),stdio:'inherit',windowsHide:true,shell:false});
  if(child.error)throw child.error;
  process.exitCode=child.status??1;
}catch(error){console.error(error.message);process.exitCode=1;}
