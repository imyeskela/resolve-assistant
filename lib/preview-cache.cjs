'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {normalizeScenePlan}=require('./trusted-scene.cjs');

async function createPreviewCache({build,maxEntries=8,maxBytes=32*1024*1024,maxBuilds=2}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'resolve-preview-'));
  await fs.chmod(root,0o700);
  const entries=new Map();let totalBytes=0,building=0,closed=false,closing;
  function evict(){
    for(const [key,entry]of entries)if(entry.files){entries.delete(key);totalBytes-=entry.bytes;return true;}
    return false;
  }
  async function compile(plan){
    const directory=await fs.mkdtemp(path.join(root,'build-'));
    try{
      await build(directory,plan);
      const files=new Map();let bytes=0;
      for(const name of ['index.html',plan.engine==='remotion'?'assets/remotion.js':'assets/gsap.min.js']){
        const file=path.join(directory,name),stat=await fs.stat(file);
        if(!stat.isFile()||stat.size>8*1024*1024||bytes+stat.size>maxBytes)throw new Error('Preview artifact is too large');
        const content=await fs.readFile(file);bytes+=content.length;
        if(bytes>maxBytes)throw new Error('Preview artifact is too large');
        files.set(name,content);
      }
      return {files,bytes};
    }finally{
      // Only a freshly allocated child of our private cache can be removed.
      if(path.dirname(directory)!==root)throw new Error('Invalid preview cache path');
      await fs.rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:100});
    }
  }
  async function read(job,name){
    if(closed)throw new Error('Preview cache is closed');
    const plan=normalizeScenePlan(job?.plan),key=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    let entry=entries.get(key);
    if(!entry){
      if(building>=maxBuilds)throw new Error('Preview cache is busy');
      while(entries.size>=maxEntries)if(!evict())throw new Error('Preview cache is busy');
      entry={};entries.set(key,entry);building++;
      entry.promise=compile(plan).then(result=>{
        while(totalBytes+result.bytes>maxBytes)if(!evict())throw new Error('Preview cache is full');
        Object.assign(entry,result);totalBytes+=result.bytes;return entry;
      }).catch(error=>{entries.delete(key);throw error;}).finally(()=>{building--;});
    }else{entries.delete(key);entries.set(key,entry);}
    const ready=await entry.promise;
    if(closed)throw new Error('Preview cache is closed');
    const content=ready.files.get(name);if(!content)throw new Error('Unknown preview asset');
    return content;
  }
  function close(){
    if(closing)return closing;
    closed=true;
    closing=(async()=>{
      await Promise.allSettled([...entries.values()].map(entry=>entry.promise));
      entries.clear();totalBytes=0;
      // root is the exact path returned by mkdtemp, never derived from job metadata.
      await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
    })();
    return closing;
  }
  return {read,close};
}
module.exports={createPreviewCache};
