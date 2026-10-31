'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');const {atomicWrite,readJson}=require('./storage.cjs');
const {checkedJobsRoot}=require('./storage-boundaries.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function directChild(parent,file,name){const canonical=await fs.realpath(file);if(path.relative(parent,canonical)!==name)throw new Error('Недопустимый путь снимка контекста');return canonical;}
async function contextBase(doc,create=false){
 const root=await checkedJobsRoot(path.dirname(doc.directory)),base=path.join(root,'.contexts');
 if(create)await fs.mkdir(base,{recursive:true});
 return directChild(root,base,'.contexts');
}
async function persistContext(doc,version,message,context){
 const id=randomUUID(),base=await contextBase(doc,true),target=path.join(base,id);await fs.mkdir(target);const directory=await directChild(base,target,id),frames=[];
 for(const [i,frame]of context.frames.entries()){const file=`image-${i}.jpg`;await fs.copyFile(frame.path,path.join(directory,file),fs.constants.COPYFILE_EXCL);frames.push({file,seconds:frame.seconds,timecode:frame.timecode});}
 const snapshot={id,projectId:doc.projectId,compositionId:doc.id,versionId:version.id,messageId:message.id,range:context.range,frames,transcript:context.transcript,speechIncluded:!!context.transcript?.length,speechStatus:context.speechStatus||'unavailable',speechSource:context.speechSource||null,speechError:context.speechError||null,createdAt:new Date().toISOString()};
 await atomicWrite(path.join(directory,'snapshot.json'),JSON.stringify(snapshot,null,2));return snapshot;
}
async function loadContext(doc,id){
 if(!UUID.test(id))throw new Error('Некорректный снимок контекста');const base=await contextBase(doc),directory=await directChild(base,path.join(base,id),id),metadata=await directChild(directory,path.join(directory,'snapshot.json'),'snapshot.json'),snapshot=await readJson(metadata);
 if(!snapshot||snapshot.id!==id||(snapshot.projectId!==doc.projectId&&!(snapshot.projectId===null&&doc.legacyBinding?.fromProjectId===null&&doc.legacyBinding?.toProjectId===doc.projectId))||snapshot.compositionId!==doc.id||!Array.isArray(snapshot.frames)||snapshot.frames.length>12||!Array.isArray(snapshot.transcript))throw new Error('Снимок контекста не принадлежит композиции');
 const frames=[];for(const frame of snapshot.frames){if(!/^image-\d+\.jpg$/.test(frame.file))throw new Error('Недопустимый файл снимка');const file=await directChild(directory,path.join(directory,frame.file),frame.file);frames.push({path:file,seconds:frame.seconds,timecode:frame.timecode});}return {...snapshot,frames};
}
async function versionContext(doc,version){
 const ids=[...new Set([...(version.baseSnapshot?.contextSnapshotIds||[]),...(version.contextSnapshotIds||[])])];const snapshots=[];const warnings=[];
 for(const id of ids.slice(-12)){try{snapshots.push(await loadContext(doc,id));}catch{warnings.push(`Сохранённый контекст ${id} недоступен`);}}
 return {snapshots:snapshots.map(({frames,...snapshot})=>({...snapshot,frames:frames.map(({path:ignored,...f})=>f)})),frames:snapshots.flatMap(s=>s.frames.map(f=>({...f,snapshotId:s.id}))).slice(-12),warnings,truncated:ids.length>12||snapshots.reduce((count,s)=>count+s.frames.length,0)>12};
}
module.exports={persistContext,loadContext,versionContext};
