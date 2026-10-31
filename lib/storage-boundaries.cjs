'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');

// Process-local trust only: never restore this map from job/conversation JSON.
// Canonical paths are also pinned so cloned documents retain the same boundary.
const roots=new Map();
const key=value=>process.platform==='win32'?value.toLowerCase():value;
function boundaryError(){return Object.assign(new Error('Папка jobs изменилась или выходит за пределы выбранной папки проекта'),{code:'ERR_STORAGE_BOUNDARY'});}
async function checkedJobsRoot(directory,{create=false}={}){
  const requested=path.resolve(directory),known=roots.get(key(requested));
  if(known){
    const current=await fs.realpath(requested);
    if(path.relative(known,current)!=='')throw boundaryError();
    return known;
  }
  if(create)await fs.mkdir(path.dirname(requested),{recursive:true});
  const parent=await fs.realpath(path.dirname(requested));
  if(create)await fs.mkdir(requested,{recursive:true});
  const canonical=await fs.realpath(requested);
  if(path.relative(path.join(parent,path.basename(requested)),canonical)!=='')throw boundaryError();
  const prior=roots.get(key(canonical));
  if(prior&&path.relative(prior,canonical)!=='')throw boundaryError();
  roots.set(key(requested),canonical);roots.set(key(canonical),canonical);
  return canonical;
}
module.exports={checkedJobsRoot};
