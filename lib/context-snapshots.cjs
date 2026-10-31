'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');const {atomicWrite,readJson}=require('./storage.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function persistContext(doc,version,message,context){
 const id=randomUUID(),directory=path.join(path.dirname(doc.directory),'.contexts',id);await fs.mkdir(directory,{recursive:true});const frames=[];
 for(const [i,frame]of context.frames.entries()){const file=`image-${i}.jpg`;await fs.copyFile(frame.path,path.join(directory,file));frames.push({file,seconds:frame.seconds,timecode:frame.timecode});}
 const snapshot={id,projectId:doc.projectId,compositionId:doc.id,versionId:version.id,messageId:message.id,range:context.range,frames,transcript:context.transcript,speechIncluded:!!context.transcript?.length,speechStatus:context.speechStatus||'unavailable',speechSource:context.speechSource||null,speechError:context.speechError||null,createdAt:new Date().toISOString()};
 await atomicWrite(path.join(directory,'snapshot.json'),JSON.stringify(snapshot,null,2));return snapshot;
}
async function loadContext(doc,id){
 if(!UUID.test(id))throw new Error('Некорректный снимок контекста');const base=path.join(path.dirname(doc.directory),'.contexts'),directory=path.join(base,id),snapshot=await readJson(path.join(directory,'snapshot.json'));
 if(!snapshot||snapshot.id!==id||(snapshot.projectId!==doc.projectId&&!(snapshot.projectId===null&&doc.legacyBinding?.fromProjectId===null&&doc.legacyBinding?.toProjectId===doc.projectId))||snapshot.compositionId!==doc.id||!Array.isArray(snapshot.frames)||snapshot.frames.length>12||!Array.isArray(snapshot.transcript))throw new Error('Снимок контекста не принадлежит композиции');
 const canonical=await fs.realpath(directory);if(path.dirname(canonical)!==await fs.realpath(base))throw new Error('Недопустимый путь снимка контекста');
 const frames=[];for(const frame of snapshot.frames){if(!/^image-\d+\.jpg$/.test(frame.file))throw new Error('Недопустимый файл снимка');const file=await fs.realpath(path.join(directory,frame.file));if(path.dirname(file)!==canonical)throw new Error('Недопустимый путь кадра');frames.push({path:file,seconds:frame.seconds,timecode:frame.timecode});}return {...snapshot,frames};
}
async function versionContext(doc,version){
 const ids=[...new Set([...(version.baseSnapshot?.contextSnapshotIds||[]),...(version.contextSnapshotIds||[])])];const snapshots=[];const warnings=[];
 for(const id of ids.slice(-12)){try{snapshots.push(await loadContext(doc,id));}catch{warnings.push(`Сохранённый контекст ${id} недоступен`);}}
 return {snapshots:snapshots.map(({frames,...snapshot})=>({...snapshot,frames:frames.map(({path:ignored,...f})=>f)})),frames:snapshots.flatMap(s=>s.frames.map(f=>({...f,snapshotId:s.id}))).slice(-12),warnings,truncated:ids.length>12||snapshots.reduce((count,s)=>count+s.frames.length,0)>12};
}
module.exports={persistContext,loadContext,versionContext};
