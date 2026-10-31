'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {normalizeMotion}=require('./motion.cjs');

// Saved JSON is input, never an executable artifact or a source of filesystem paths.
// Bound the snapshot before normalization, hashing or invoking the TSX compiler.
function normalizeScenePlan(raw){
  let bytes=0,nodes=0;
  function copy(value,depth=0){
    if(++nodes>4096||depth>12)throw new Error('Scene plan is too complex');
    if(typeof value==='string'){
      bytes+=Buffer.byteLength(value);if(bytes>1024*1024)throw new Error('Scene plan is too large');return value;
    }
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
    if(!value||typeof value!=='object'||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Invalid scene plan data');
    if(Array.isArray(value)){
      if(value.length>4096)throw new Error('Scene plan is too complex');
      return value.map(item=>copy(item,depth+1));
    }
    const result=Object.create(null);
    for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value))){
      if(!Object.hasOwn(descriptor,'value'))throw new Error('Invalid scene plan property');
      copy(key,depth+1);result[key]=copy(descriptor.value,depth+1);
    }
    return result;
  }
  const plan=copy(raw);
  if(!plan||Array.isArray(plan))throw new Error('Missing scene plan');
  if(plan.engine==='remotion')return require('./remotion.cjs').normalizeReactComposition(plan,plan);
  if(plan.engine!==undefined&&plan.engine!=='hyperframes')throw new Error('Unknown scene engine');
  return normalizeMotion(plan,plan);
}

// Callbacks are application-owned builders/renderers, never taken from saved jobs.
async function renderTrustedScene(jobDir,plan,{prepare,render,signal}){
  const checkCancelled=()=>{if(signal?.aborted)throw new Error('Задание отменено');};
  checkCancelled();
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'resolve-render-'));
  const destination=path.resolve(jobDir),staged=path.join(destination,'motion.'+randomUUID()+'.partial.mov');
  let stagedCreated=false;
  try{
    await fs.chmod(directory,0o700);
    await prepare(directory,plan);checkCancelled();
    const result=await render(directory,plan);checkCancelled();
    // Only the checked renderer output is published; preserve saved sources,
    // metadata and the previous MOV when preparation or rendering fails.
    if(path.resolve(result.file)!==path.join(directory,'motion.mov'))throw new Error('Invalid render output path');
    await fs.copyFile(result.file,staged,constants.COPYFILE_EXCL);stagedCreated=true;checkCancelled();
    const file=path.join(destination,'motion.mov');await fs.rename(staged,file);stagedCreated=false;
    return {...result,file};
  }finally{
    if(stagedCreated&&path.dirname(staged)===destination)await fs.rm(staged,{force:true});
    // directory is the exact path returned by mkdtemp, not a persisted job path.
    await fs.rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
}
module.exports={normalizeScenePlan,renderTrustedScene};
