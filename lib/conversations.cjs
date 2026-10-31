'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {atomicWrite}=require('./storage.cjs');
const {normalizeRange}=require('./video-context.cjs');
const {loadContext}=require('./context-snapshots.cjs');
const {checkedJobsRoot}=require('./storage-boundaries.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_FIELDS=['draft','settings','manualDurationSeconds','videoContextEnabled','durationMode','manualSize','manualFps'];
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const ids=value=>Array.isArray(value)&&value.every(id=>typeof id==='string'&&UUID.test(id));
const messages=value=>Array.isArray(value)&&value.every(m=>m&&['user','assistant'].includes(m.role)&&typeof m.text==='string'&&(m.contextSnapshotId==null||UUID.test(m.contextSnapshotId))&&(m.contextSnapshotIds===undefined||ids(m.contextSnapshotIds)));
const unique=value=>[...new Set(value)];
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function contextIds(version){return unique([...(version.baseSnapshot?.contextSnapshotIds||[]),...(version.contextSnapshotIds||[]),...version.messages.flatMap(m=>[m.contextSnapshotId,...(m.contextSnapshotIds||[])]).filter(id=>typeof id==='string'&&UUID.test(id))]);}
function state(value={}){
  const settings=clone(value.settings||{}),raw=value.manualDurationSeconds??settings.manualDurationSeconds;let manual=Number(raw??settings.duration??5);
  const mode=value.durationMode??settings.durationMode??'manual';
  if(raw===undefined&&mode==='manual'&&Number.isFinite(settings.fps)&&settings.fps>0&&Number.isSafeInteger(settings.frameCount)&&settings.frameCount>0&&Math.abs(manual-settings.frameCount/settings.fps)<1e-8){
    if(manual>15&&settings.frameCount===Math.round(15*settings.fps))manual=15;
    if(manual<2&&settings.frameCount===Math.round(2*settings.fps))manual=2;
  }
  return {draft:typeof value.draft==='string'?value.draft:'',settings,manualDurationSeconds:Number.isFinite(manual)&&manual>0?manual:5,videoContextEnabled:value.videoContextEnabled!==false,durationMode:typeof mode==='string'?mode:'manual',manualSize:value.manualSize===true,manualFps:value.manualFps===true};
}
function emptySnapshot(){return {plan:null,history:[],contextSnapshotIds:[],assetManifest:[]};}
function newVersion(number,value={}){return {id:randomUUID(),number,parentVersionId:null,baseRevisionId:null,baseSnapshot:emptySnapshot(),revisionIds:[],selectedRevisionId:null,messages:[],contextSnapshotIds:[],...state(value),status:'draft'};}
function interrupt(list){for(const m of list)if(m.status==='pending'){m.status='interrupted';m.error='Ответ был прерван при закрытии приложения';}}
function completeJob(job,id){
  const plan=job?.plan;
  return job?.id===id&&plan&&typeof plan.name==='string'&&['width','height','fps','duration'].every(key=>Number.isFinite(plan[key])&&plan[key]>0)&&(typeof plan.source==='string'&&plan.source.trim()||Array.isArray(plan.elements)||plan.scene&&typeof plan.scene==='object')&&typeof job.createdAt==='string'&&typeof job.status==='string'&&(job.contextSnapshotIds===undefined||ids(job.contextSnapshotIds));
}
function validate(doc,id){
  if(!doc||doc.id!==id||typeof doc.name!=='string'||typeof doc.updatedAt!=='string'||!ids(doc.jobIds))throw new Error('Некорректные данные чата');
  if(doc.schemaVersion===undefined||doc.schemaVersion===1){if(!messages(doc.messages)||doc.settings!==undefined&&(!doc.settings||typeof doc.settings!=='object'||Array.isArray(doc.settings)))throw new Error('Некорректная история или параметры чата');return;}
  if(doc.schemaVersion!==2||!Array.isArray(doc.versions)||!doc.versions.length)throw new Error('Неизвестная схема чата');
  const seenIds=new Set(),seenNumbers=new Set();
  for(const v of doc.versions){
    if(!v||!UUID.test(v.id)||seenIds.has(v.id)||!Number.isSafeInteger(v.number)||v.number<1||seenNumbers.has(v.number)||!ids(v.revisionIds)||!messages(v.messages)||!['draft','ready'].includes(v.status)||!v.settings||typeof v.settings!=='object'||Array.isArray(v.settings))throw new Error('Некорректная версия');
    if(v.parentVersionId!==null&&!UUID.test(v.parentVersionId)||v.baseRevisionId!==null&&!UUID.test(v.baseRevisionId)||v.selectedRevisionId!==null&&(!UUID.test(v.selectedRevisionId)||!v.revisionIds.includes(v.selectedRevisionId)))throw new Error('Некорректная связь версии');
    const snapshot=v.baseSnapshot;
    if(!snapshot||!messages(snapshot.history)||!ids(snapshot.contextSnapshotIds)||snapshot.plan!==null&&(!snapshot.plan||typeof snapshot.plan!=='object'||Array.isArray(snapshot.plan))||v.contextSnapshotIds!==undefined&&!ids(v.contextSnapshotIds))throw new Error('Некорректная основа версии');
    seenIds.add(v.id);seenNumbers.add(v.number);
  }
  if(!seenIds.has(doc.selectedVersionId)||doc.versions.some(v=>v.parentVersionId&&!seenIds.has(v.parentVersionId)))throw new Error('Некорректный выбор версии');
  if(doc.legacyHistory!==undefined&&!messages(doc.legacyHistory))throw new Error('Некорректная старая история');
}
function freezeSnapshots(doc){for(const v of doc.versions){v.contextSnapshotIds??=[];freeze(v.baseSnapshot);}return doc;}
function jobSettings(job){const settings=clone(job?.plan||{});for(const key of ['source','elements','scene','assetManifest'])delete settings[key];return settings;}
function boundLegacy(doc){return doc.legacyBinding?.fromProjectId===null&&doc.legacyBinding?.toProjectId===doc.projectId;}
function legacyScope(doc){return boundLegacy(doc)?null:doc.projectId;}
function legacyContextId(doc,job){const hex=createHash('sha256').update(JSON.stringify(['resolve-legacy-context-v1',legacyScope(doc),doc.id,job.id])).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
async function directChild(parent,file,name){const canonical=await fs.realpath(file);if(path.relative(parent,canonical)!==name)throw new Error('Путь выходит за пределы сохранённого контекста');return canonical;}

class ConversationStore {
  constructor(){this.items=new Map();this.loaded=new Set();this.invalid=new Set();this.warnings=new Map();this.jobs=new Map();this.versionWrites=new Map();}
  async savedJobs(jobsDir,jobs){
    const saved=new Map();
    for(const candidate of jobs.values()){
      if(!candidate||typeof candidate.dir!=='string'||path.resolve(path.dirname(candidate.dir))!==path.resolve(jobsDir)||!UUID.test(candidate.id)||path.basename(candidate.dir)!==candidate.id)continue;
      const file=path.join(candidate.dir,'job.json');let job;
      try{const root=await checkedJobsRoot(jobsDir),directory=await directChild(root,candidate.dir,candidate.id),metadata=await directChild(directory,file,'job.json');job=JSON.parse(await fs.readFile(metadata,'utf8'));}catch(error){if(error.code!=='ENOENT')this.warnings.set(file,`Результат ${candidate.id} не удалось прочитать. Метаданные сохранены: ${file}.`);continue;}
      if(!completeJob(job,candidate.id)){
        this.warnings.set(file,`Результат ${candidate.id} не завершил сохранение метаданных и не добавлен к версиям.`);continue;
      }
      saved.set(job.id,{...job,dir:candidate.dir});
    }
    return saved;
  }
  migrate(old,jobs){
    const recovered=[...jobs.values()].filter(job=>(job.conversationId||job.id)===old.id&&!job.logicalVersionId&&!job.versionId&&(!old.projectId||!job.projectId||old.projectId===job.projectId)).sort((a,b)=>(a.version||1)-(b.version||1)||a.createdAt.localeCompare(b.createdAt));
    const jobIds=unique([...old.jobIds,...recovered.map(job=>job.id)]);
    const doc={...clone(old),jobIds,schemaVersion:2,legacyHistory:clone(old.messages),versions:[]};delete doc.messages;
    const jobToVersion=new Map();
    for(const [index,jobId] of jobIds.entries()){
      const job=jobs.get(jobId),v=newVersion(index+1,{settings:job?jobSettings(job):old.settings});
      v.revisionIds=[jobId];v.selectedRevisionId=jobId;v.status=job?'ready':'draft';
      v.messages=clone(old.messages.filter(m=>m.versionId===jobId||m.revisionId===jobId));
      v.contextSnapshotIds=unique([...(job?.contextSnapshotIds||[]),...contextIds(v)]);
      doc.versions.push(v);jobToVersion.set(jobId,v);
    }
    if(!doc.versions.length){const v=newVersion(1,old);v.messages=clone(old.messages);doc.versions.push(v);}
    const selected=jobToVersion.get(old.selectedJobId)||doc.versions.at(-1);Object.assign(selected,state(old));
    doc.selectedVersionId=selected.id;
    for(const v of doc.versions){
      const parentId=jobs.get(v.selectedRevisionId)?.parentId,parent=jobToVersion.get(parentId);
      if(parent&&parent!==v){v.parentVersionId=parent.id;v.baseRevisionId=parentId;v.baseSnapshot=this.snapshot(parent,jobs.get(parentId));}
    }
    return freezeSnapshots(doc);
  }
  snapshot(version,job){
    return freeze({plan:clone(job?.plan||version.baseSnapshot?.plan||null),history:clone([...(version.baseSnapshot?.history||[]),...version.messages]),contextSnapshotIds:unique([...contextIds(version),...(job?.contextSnapshotIds||[])]),assetManifest:clone(job?.assetManifest||version.baseSnapshot?.assetManifest||[])});
  }
  async migrateLegacyContext(doc,version,job){
    const legacy=job.videoContext;if(!legacy||job.logicalVersionId||job.versionId)return null;
    if((job.conversationId||job.id)!==doc.id||job.projectId&&job.projectId!==doc.projectId||doc.projectId&&legacy.projectId!==doc.projectId&&!(boundLegacy(doc)&&!job.projectId))throw new Error('Контекст относится к другому проекту или композиции');
    const jobsRoot=await checkedJobsRoot(path.dirname(doc.directory)),jobRoot=await directChild(jobsRoot,job.dir,job.id),id=legacyContextId(doc,job);
    const basePath=path.join(jobsRoot,'.contexts'),directoryPath=path.join(basePath,id);let base=null,directory=null;
    try{base=await directChild(jobsRoot,basePath,'.contexts');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(base){
      try{directory=await directChild(base,directoryPath,id);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(directory){
        let metadata=null;try{metadata=await directChild(directory,path.join(directory,'snapshot.json'),'snapshot.json');}catch(error){if(error.code!=='ENOENT')throw error;}
        if(metadata){const existing=await loadContext(doc,id);if(existing.legacyRevisionId!==job.id||existing.versionId!==version.id)throw new Error('Снимок уже принадлежит другому результату');return id;}
      }
    }
    const range=normalizeRange({...legacy,timelineEnd:legacy.endFrame,markIn:legacy.startFrame-legacy.timelineStart,markOut:legacy.endFrame-legacy.timelineStart});
    if(!range||legacy.key&&legacy.key!==range.key||legacy.duration!==undefined&&(!Number.isFinite(legacy.duration)||Math.abs(legacy.duration-range.duration)>1e-8))throw new Error('Некорректный сохранённый диапазон');
    if(!Array.isArray(legacy.frames)||legacy.frames.length>12||legacy.transcript!==undefined&&!Array.isArray(legacy.transcript))throw new Error('Некорректные материалы контекста');
    const source=await directChild(jobRoot,path.join(jobRoot,'context'),'context'),frames=[],frameData=[],names=new Set();
    for(const frame of legacy.frames){
      if(!frame||typeof frame.file!=='string'||!/^image-(?:[0-9]|1[01])\.jpg$/.test(frame.file)||names.has(frame.file)||!Number.isFinite(frame.seconds)||frame.seconds<0||frame.seconds>=range.duration||typeof frame.timecode!=='string'||!/^\d{2,}:\d{2}:\d{2}[:;]\d{2,3}$/.test(frame.timecode))throw new Error('Некорректный путь или время кадра');
      const file=await directChild(source,path.join(source,frame.file),frame.file),stat=await fs.stat(file);if(!stat.isFile()||stat.size<4||stat.size>2*1024*1024)throw new Error('Некорректный размер кадра');
      const bytes=await fs.readFile(file);if(bytes.length>2*1024*1024||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)throw new Error('Кадр не является сохранённым JPEG');
      names.add(frame.file);frames.push({file:frame.file,seconds:frame.seconds,timecode:frame.timecode});frameData.push(bytes);
    }
    const transcript=[];
    if((legacy.transcript||[]).length>300)throw new Error('Слишком большая сохранённая расшифровка');
    for(const segment of legacy.transcript||[]){
      if(!segment||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<=segment.start||segment.start>=range.duration||typeof segment.text!=='string'||segment.text.length>500)throw new Error('Некорректное время или текст речи');
      if(segment.text.trim())transcript.push({start:segment.start,end:Math.min(range.duration,segment.end),text:segment.text,...(typeof segment.speaker==='string'?{speaker:segment.speaker.slice(0,200)}:{})});
    }
    // All source paths and bytes are checked before creating any destination.
    await fs.mkdir(basePath,{recursive:true});base=await directChild(jobsRoot,basePath,'.contexts');await fs.mkdir(directoryPath,{recursive:true});directory=await directChild(base,directoryPath,id);
    for(const [index,frame]of frames.entries())await atomicWrite(path.join(directory,frame.file),frameData[index]);
    const snapshot={id,projectId:legacyScope(doc),compositionId:doc.id,versionId:version.id,messageId:null,legacy:true,legacyRevisionId:job.id,range,frames,transcript,speechIncluded:!!transcript.length,speechStatus:typeof legacy.speechStatus==='string'?legacy.speechStatus.slice(0,80):transcript.length?'ready':'unavailable',speechSource:typeof legacy.speechSource==='string'?legacy.speechSource.slice(0,300):null,speechError:typeof legacy.speechError==='string'?legacy.speechError.slice(0,600):null,createdAt:job.createdAt};
    await atomicWrite(path.join(directory,'snapshot.json'),JSON.stringify(snapshot,null,2));return id;
  }
  inheritedRevisionContexts(doc,revisionId,jobs,seen=new Set()){
    if(!revisionId||seen.has(revisionId))return [];seen.add(revisionId);const job=jobs.get(revisionId);
    if(!job||(job.conversationId||job.id)!==doc.id||doc.projectId&&job.projectId&&doc.projectId!==job.projectId)return [];
    return unique([...(job.contextSnapshotIds||[]),...this.inheritedRevisionContexts(doc,job.parentId,jobs,seen)]);
  }
  async load(jobsDir,jobs){
    try{jobsDir=await checkedJobsRoot(jobsDir);}catch(error){if(error.code==='ERR_STORAGE_BOUNDARY'){this.warnings.set(jobsDir,error.message);return;}if(error.code==='ENOENT')return;throw error;}
    const directory=path.join(jobsDir,'.conversations'),saved=await this.savedJobs(jobsDir,jobs);this.jobs=jobs;
    try{await directChild(await fs.realpath(jobsDir),directory,'.conversations');}catch(error){if(error.code!=='ENOENT'){this.warnings.set(directory,'Папка чатов выходит за пределы выбранной папки проекта.');return;}}
    if(!this.loaded.has(directory)){
      let names;try{names=await fs.readdir(directory);}catch(e){if(e.code!=='ENOENT')throw e;names=[];}
      for(const file of names){
        const id=file.replace(/\.json$/,'');if(!UUID.test(id)||file!==id+'.json')continue;
        const location=path.join(directory,file);let doc,raw;
        try{const metadata=await directChild(await fs.realpath(directory),location,file);raw=await fs.readFile(metadata,'utf8');doc=JSON.parse(raw);validate(doc,id);}
        catch{
          this.invalid.add(location);this.warnings.set(location,`Не удалось открыть чат ${id}. Файл сохранён без изменений: ${location}. Остальные композиции доступны.`);continue;
        }
        const existing=this.items.get(id);
        if(existing&&existing.directory!==directory){this.warnings.set(location,`Найдены две папки с ID чата ${id}. Дубликат сохранён без изменений: ${location}.`);continue;}
        if(doc.schemaVersion!==2){
          // The backup is exclusive and unique: a prior task's backup is never replaced.
          await fs.writeFile(path.join(directory,`${id}.pre-v2-${randomUUID()}.bak`),raw,{flag:'wx',mode:0o600});
          doc=this.migrate(doc,saved);doc.directory=directory;await this.save(doc);
        }else{doc.directory=directory;freezeSnapshots(doc);}
        for(const v of doc.versions)interrupt(v.messages);
        if(doc.legacyHistory)interrupt(doc.legacyHistory);
        this.items.set(id,doc);
      }
      this.loaded.add(directory);
    }
    const groups=new Map();
    for(const job of saved.values()){
      const id=job.conversationId||job.id;
      if(!UUID.test(id)||this.invalid.has(path.join(directory,id+'.json')))continue;
      if(!groups.has(id))groups.set(id,[]);groups.get(id).push(job);
    }
    for(const [id,group]of groups){
      group.sort((a,b)=>(a.version||1)-(b.version||1)||a.createdAt.localeCompare(b.createdAt));
      let doc=this.items.get(id);
      if(!doc){
        const legacy=group.filter(job=>!job.logicalVersionId&&!job.versionId);
        if(!legacy.length){for(const job of group)this.orphanWarning(job);continue;}
        const first=legacy[0],stamp=first.createdAt;
        doc={id,directory,projectId:first.projectId||null,name:first.plan.name,createdAt:stamp,updatedAt:legacy.at(-1).createdAt,jobIds:legacy.map(j=>j.id),selectedJobId:legacy.at(-1).id,messages:[],settings:jobSettings(legacy.at(-1)),draft:'',videoContextEnabled:true};
        doc=this.migrate(doc,saved);await this.save(doc);this.items.set(id,doc);
      }
      if(doc.directory!==directory)continue;
      let changed=false;
      for(const job of group){
        if(doc.projectId&&job.projectId&&doc.projectId!==job.projectId){this.orphanWarning(job);continue;}
        const logicalId=job.logicalVersionId||job.versionId;
        let v=logicalId?doc.versions.find(v=>v.id===logicalId):doc.versions.find(v=>v.revisionIds.includes(job.id));
        // Once migrated, an unlinked result must never create a visible version.
        if(!v){this.orphanWarning(job);continue;}
        if(job.videoContext&&!job.logicalVersionId&&!job.versionId){
          const warning=path.join(job.dir,'context');
          try{const contextId=await this.migrateLegacyContext(doc,v,job);if(contextId)job.contextSnapshotIds=unique([...(job.contextSnapshotIds||[]),contextId]);this.warnings.delete(warning);}
          catch(error){this.warnings.set(warning,`Видеоконтекст результата ${job.id} не перенесён: ${error.message}. Исходные файлы сохранены.`);}
        }
        const recovered=!v.revisionIds.includes(job.id)||!doc.jobIds.includes(job.id);
        if(!v.revisionIds.includes(job.id)){v.revisionIds.push(job.id);changed=true;}
        if(!doc.jobIds.includes(job.id)){doc.jobIds.push(job.id);changed=true;}
        const current=saved.get(v.selectedRevisionId)||this.jobs.get(v.selectedRevisionId);
        if(!v.selectedRevisionId||recovered&&(!current||job.createdAt>=current.createdAt)){v.selectedRevisionId=job.id;changed=true;}
        if(v.status!=='ready'){v.status='ready';changed=true;}
        for(const contextId of job.contextSnapshotIds||[])if(UUID.test(contextId)&&!v.contextSnapshotIds.includes(contextId)){v.contextSnapshotIds.push(contextId);changed=true;}
        const turn=job.turn;
        if(turn?.assistant&&turn.assistant.role==='assistant'&&typeof turn.assistant.text==='string'){
          if(!v.messages.some(m=>m.id&&m.id===turn.assistant.id||m.revisionId===job.id||m.versionId===job.id)){v.messages.push({...clone(turn.assistant),revisionId:job.id,versionId:job.id});changed=true;}
          const user=v.messages.find(m=>m.role==='user'&&m.id===turn.userId);
          if(user&&user.status!=='completed'){user.status='completed';delete user.error;changed=true;}
        }
      }
      for(const v of doc.versions){
        const inherited=unique([...v.baseSnapshot.contextSnapshotIds,...this.inheritedRevisionContexts(doc,v.baseRevisionId,saved)]);
        if(inherited.length!==v.baseSnapshot.contextSnapshotIds.length){v.baseSnapshot=freeze({...clone(v.baseSnapshot),contextSnapshotIds:inherited});changed=true;}
      }
      if(changed)await this.save(doc);
    }
  }
  orphanWarning(job){this.warnings.set(path.join(job.dir,'job.json'),`Сохранённый результат ${job.id} не связан с существующей логической версией. Файлы сохранены для восстановления.`);}
  async create(target,settings){
    const stamp=new Date().toISOString(),v=newVersion(1,{settings});freeze(v.baseSnapshot);
    const doc={schemaVersion:2,id:randomUUID(),directory:path.join(target.jobsDir,'.conversations'),projectId:target.projectId||null,name:'Новая композиция',createdAt:stamp,updatedAt:stamp,jobIds:[],selectedVersionId:v.id,versions:[v]};
    await this.save(doc);this.items.set(doc.id,doc);return doc;
  }
  getVersion(doc,id=doc.selectedVersionId){const version=doc.versions?.find(v=>v.id===id);if(!version)throw new Error('Версия не принадлежит композиции');return version;}
  async createVersion(doc,{baseVersionId,baseRevisionId,requestId}={}){
    if(requestId!==undefined&&(typeof requestId!=='string'||!requestId.trim()||requestId.length>200))throw new Error('Некорректный ID запроса версии');
    const prior=this.versionWrites.get(doc.id)||Promise.resolve();
    const pending=prior.catch(()=>{}).then(async()=>{
      const current=this.items.get(doc.id)||doc;
      const duplicate=requestId&&current.versions.find(v=>v.requestId===requestId);if(duplicate)return duplicate;
      const base=this.getVersion(current,baseVersionId||current.selectedVersionId),revision=baseRevisionId===undefined?base.selectedRevisionId||base.baseRevisionId:baseRevisionId;
      if(revision!==null&&(!UUID.test(revision)||!base.revisionIds.includes(revision)&&revision!==base.baseRevisionId))throw new Error('Ревизия не принадлежит выбранной версии');
      let job=null;
      // The directory may have been created after the controller's background load.
      // Read the authoritative saved revision even if its map was never populated.
      if(revision){const jobsDir=path.dirname(current.directory),candidate={id:revision,dir:path.join(jobsDir,revision)};const saved=await this.savedJobs(jobsDir,new Map([[revision,candidate]]));job=saved.get(revision);}
      if(job&&((job.conversationId||job.id)!==current.id||current.projectId&&job.projectId&&current.projectId!==job.projectId))throw new Error('Ревизия не принадлежит композиции');
      const v=newVersion(Math.max(...current.versions.map(v=>v.number))+1,base);
      v.parentVersionId=base.id;v.baseRevisionId=revision;v.baseSnapshot=this.snapshot(base,job);v.contextSnapshotIds=[...v.baseSnapshot.contextSnapshotIds];v.draft='';if(requestId)v.requestId=requestId;
      const next={...current,versions:[...current.versions,v],selectedVersionId:v.id,updatedAt:new Date().toISOString()};
      await this.save(next);Object.assign(current,next);if(doc!==current)Object.assign(doc,next);this.items.set(current.id,current);return v;
    });
    this.versionWrites.set(doc.id,pending);try{return await pending;}finally{if(this.versionWrites.get(doc.id)===pending)this.versionWrites.delete(doc.id);}
  }
  get(id,projectId){
    if(typeof id!=='string'||!UUID.test(id)||!this.items.has(id))throw new Error('Чат композиции не найден');
    const doc=this.items.get(id);if(doc.projectId&&doc.projectId!==projectId)throw new Error('Проект изменился. Откройте чат нужного проекта.');return doc;
  }
  list(projectId){return [...this.items.values()].filter(d=>!d.projectId||d.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  async save(doc){
    if(!UUID.test(doc.id))throw new Error('Некорректный ID чата');
    const root=await checkedJobsRoot(path.dirname(doc.directory),{create:true});
    await fs.mkdir(path.join(root,'.conversations'),{recursive:true});const directory=await directChild(root,doc.directory,'.conversations'),file=path.join(directory,doc.id+'.json');
    try{await directChild(directory,file,doc.id+'.json');}catch(error){if(error.code!=='ENOENT')throw error;}
    await atomicWrite(file,JSON.stringify(doc,null,2));if(doc.schemaVersion===2)freezeSnapshots(doc);
  }
  public(doc,full=false){
    const {directory,versions,messages:legacyMessages,...data}=doc,v=this.getVersion(doc),selected={};
    for(const key of VERSION_FIELDS)selected[key]=clone(v[key]);
    const summaries=versions.map(version=>({id:version.id,number:version.number,parentVersionId:version.parentVersionId,baseRevisionId:version.baseRevisionId,revisionIds:[...version.revisionIds],selectedRevisionId:version.selectedRevisionId,status:version.status,contextSnapshotIds:contextIds(version),baseVersionNumber:versions.find(v=>v.id===version.parentVersionId)?.number||null,hasBaseScene:!!version.baseSnapshot.plan,messageCount:version.messages.length}));
    return {...data,...selected,versions:summaries,selectedVersionId:v.id,selectedJobId:v.selectedRevisionId||v.baseRevisionId||null,contextSnapshotIds:contextIds(v),messageCount:v.messages.length,...(full?{messages:clone(v.messages)}:{})};
  }
}
module.exports={ConversationStore};
