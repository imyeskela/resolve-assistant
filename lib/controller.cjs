'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const readline=require('node:readline');
const {randomUUID}=require('node:crypto');
const {checkedJobsRoot}=require('./storage-boundaries.cjs');
const {ChatGPTAuth}=require('./auth.cjs');
const {atomicWrite,readJson}=require('./storage.cjs');
const {WorkspaceStore}=require('./workspaces.cjs');
const {normalizeVideoSettings,demoMotion}=require('./motion.cjs');
const {generatePlan,generateChatTurn}=require('./codex.cjs');
const {ConversationStore}=require('./conversations.cjs');
const {persistContext,versionContext}=require('./context-snapshots.cjs');
const {prepareComposition,renderMotion,startPreviewServer}=require('./render.cjs');
const {normalizeRange,sampleFrames,prepareContextImages}=require('./video-context.cjs');
const ROOT=path.resolve(__dirname,'..');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function directJobChild(parent,file,name){const canonical=await fs.realpath(file);if(path.relative(parent,canonical)!==name)throw new Error('Недопустимый путь результата');return canonical;}
function engineFor(settings){const engine=settings?.engine??'hyperframes';if(!['hyperframes','remotion'].includes(engine))throw new Error('Неизвестный движок композиции');return engine;}
class Controller {
  constructor(root=ROOT,emit=()=>{},{chatGenerator=generateChatTurn}={}){this.root=root;this.emit=emit;this.jobs=new Map();this.contexts=new Map();this.active=null;this.conversations=new ConversationStore();this.conversations.jobs=this.jobs;this.chatGenerator=chatGenerator;this.currentRange=null;}
  async init(){
    this.workspace=await new WorkspaceStore(this.root).init();this.loadedDirs=new Set();
    this.jobsDir=path.join(this.root,'workspace/jobs');await fs.mkdir(this.jobsDir,{recursive:true});
    this.auth=await new ChatGPTAuth(path.join(this.root,'.data/auth'),this.emit).init();
    await this.loadJobs(this.jobsDir);
    this.preview=await startPreviewServer(id=>this.jobs.get(id));return this;
  }
  async loadJobs(jobsDir){
    let names;try{jobsDir=await checkedJobsRoot(jobsDir);if(this.loadedDirs.has(jobsDir))return;names=await fs.readdir(jobsDir);}catch(e){if(e.code==='ERR_STORAGE_BOUNDARY'){this.conversations.warnings.set(jobsDir,e.message);return;}if(['ENOENT','EACCES','EPERM','ENOTDIR'].includes(e.code))return;throw e;}
    for(const name of names){
      if(!UUID.test(name))continue;let dir,j;try{dir=await directJobChild(jobsDir,path.join(jobsDir,name),name);const file=await directJobChild(dir,path.join(dir,'job.json'),'job.json');j=await readJson(file);}catch{continue;}
      if(j&&j.id===name){
        j.dir=dir;const expected=path.join(dir,'motion.mov');
        if(j.output?.file&&j.output.file!==expected)try{if(await fs.realpath(j.output.file)===await fs.realpath(expected))j.output.file=expected;}catch{}
        if(j.status==='rendering')j.status='interrupted';this.jobs.set(name,j);
      }
    }
    await this.conversations.load(jobsDir,this.jobs);this.loadedDirs.add(jobsDir);
  }
  jobProject(j){return j.projectId||this.conversations.items.get(j.conversationId||j.id)?.projectId||null;}
  listJobs(){const id=this.workspace.project?.id;return [...this.jobs.values()].filter(j=>!this.jobProject(j)||this.jobProject(j)===id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>this.publicJob(j));}
  listConversations(){return this.conversations.list(this.workspace.project?.id).map(d=>this.conversations.public(d));}
  workspaceState(){return {workspace:this.workspace.info(),jobs:this.listJobs(),conversations:this.listConversations(),storageWarnings:[...this.conversations.warnings.values()]};}
  job(id){if(typeof id!=='string'||!UUID.test(id)||!this.jobs.has(id))throw new Error('Композиция не найдена');const j=this.jobs.get(id);if(this.jobProject(j)&&this.jobProject(j)!==this.workspace.project?.id)throw new Error('Проект изменился. Откройте результат нужного проекта.');return j;}
  scopedJob(params){const j=this.job(params.id);if(params.compositionId||params.versionId){const d=this.conversation(params.compositionId),v=this.conversations.getVersion(d,params.versionId);if((j.conversationId||j.id)!==d.id||v.selectedRevisionId!==j.id||!v.revisionIds.includes(j.id))throw new Error('Ревизия не является текущим результатом выбранной версии');}return j;}
  publicJob(j){return {id:j.id,name:j.plan.name,prompt:j.prompt,plan:j.plan,conversationId:j.conversationId||j.id,parentId:j.parentId||null,logicalVersionId:j.logicalVersionId||null,contextSnapshotIds:j.contextSnapshotIds||[],version:j.version||1,model:j.model||null,effort:j.effort||null,createdAt:j.createdAt,status:j.status,projectId:this.jobProject(j),directory:j.dir,output:j.output||null,imports:j.imports||{},videoContext:j.videoContext||null,previewUrl:this.preview.url(j.id)};}
  async save(j){
    if(!UUID.test(j.id))throw new Error('Некорректный ID результата');
    const root=await checkedJobsRoot(path.dirname(j.dir)),directory=await directJobChild(root,j.dir,j.id),file=path.join(directory,'job.json');
    try{await directJobChild(directory,file,'job.json');}catch(error){if(error.code!=='ENOENT')throw error;}
    await atomicWrite(file,JSON.stringify(j,null,2));
  }
  async create(plan,prompt,target,metadata={}){target={...target,jobsDir:await checkedJobsRoot(target.jobsDir,{create:true})};const id=randomUUID();const j={id,dir:path.join(target.jobsDir,id),projectId:target.projectId,projectName:target.projectName,plan,prompt,conversationId:metadata.conversationId||id,parentId:metadata.parentId||null,version:metadata.version||1,logicalVersionId:metadata.logicalVersionId||null,contextSnapshotIds:metadata.contextSnapshotIds||[],turn:metadata.turn||null,model:metadata.model||null,effort:metadata.effort||null,createdAt:new Date().toISOString(),status:'preview_ready',imports:{}};await prepareComposition(j.dir,plan);
    const assertActive=()=>{if(metadata.signal?.aborted)throw new Error('Отправка отменена');if(metadata.signal&&target.projectId&&this.workspace.project?.id!==target.projectId)throw new Error('Проект изменился во время подготовки версии');};assertActive();
    if(metadata.videoContext){const context=metadata.videoContext;const directory=path.join(j.dir,'context');await fs.mkdir(directory,{recursive:true});const frames=[];for(const [i,frame]of context.frames.entries()){const file=`image-${i}.jpg`;await fs.copyFile(frame.path,path.join(directory,file));frames.push({file,seconds:frame.seconds,timecode:frame.timecode});}j.videoContext={...context.range,frames,speechIncluded:context.speechIncluded,transcript:context.transcript,speechStatus:context.speechStatus,speechSource:context.speechSource,speechError:context.speechError};await atomicWrite(path.join(directory,'context.json'),JSON.stringify(j.videoContext,null,2));}
    assertActive();await this.save(j);this.jobs.set(id,j);if(!metadata.conversationId)await this.conversations.load(target.jobsDir,this.jobs);return this.publicJob(j);}
  conversation(id){return this.conversations.get(id,this.workspace.project?.id);}
  normalizedSettings(value,range=null){
    const input={...value};const manualDurationSeconds=input.manualDurationSeconds??input.duration??5;input.duration=manualDurationSeconds;delete input.durationMode;delete input.requestedDuration;delete input.frameCount;
    if(range){input.durationMode='videoContext';input.requestedDuration=(range.endFrame-range.startFrame+1)/range.fps;input.duration=input.requestedDuration;}
    return {...normalizeVideoSettings(input),engine:engineFor(value),...(!range?{manualDurationSeconds}:{})};
  }
  async bindLegacyConversation(doc){
    if(doc.projectId)return;
    const projectId=this.workspace.project?.id;if(!projectId)throw new Error('Откройте проект Resolve для привязки композиции');
    const file=path.join(doc.directory,doc.id+'.json');const raw=await fs.readFile(file,'utf8');await fs.writeFile(path.join(doc.directory,doc.id+'.pre-bind-'+randomUUID()+'.bak'),raw,{flag:'wx',mode:0o600});
    const binding={fromProjectId:null,toProjectId:projectId,at:new Date().toISOString()};const next={...doc,projectId,legacyBinding:binding};await this.conversations.save(next);doc.projectId=projectId;doc.legacyBinding=binding;
  }
  async publicConversation(doc,versionId=doc.selectedVersionId){
    const selected={...doc,selectedVersionId:versionId},v=this.conversations.getVersion(doc,versionId),evidence=await versionContext(doc,v);
    return {...this.conversations.public(selected,true),contextSnapshots:evidence.snapshots,contextWarnings:evidence.warnings};
  }
  async updateConversation(params){
    const d=this.conversation(params.id||params.compositionId),next=structuredClone(d);
    if(params.selectedVersionId!==undefined){this.conversations.getVersion(next,params.selectedVersionId);next.selectedVersionId=params.selectedVersionId;}
    const v=this.conversations.getVersion(next,params.versionId||next.selectedVersionId);
    if(params.selectedJobId!==undefined){if(params.selectedJobId!==null&&!v.revisionIds.includes(params.selectedJobId)&&params.selectedJobId!==v.baseRevisionId)throw new Error('Ревизия не принадлежит версии');if(params.selectedJobId!==v.baseRevisionId)v.selectedRevisionId=params.selectedJobId;}
    if(params.settings!==undefined){v.settings=this.normalizedSettings({...params.settings,duration:params.manualDurationSeconds??params.settings.duration??v.manualDurationSeconds,...(params.manualDurationSeconds!==undefined?{manualDurationSeconds:params.manualDurationSeconds}:{})});if(params.manualDurationSeconds===undefined)v.manualDurationSeconds=v.settings.manualDurationSeconds;}
    if(params.manualDurationSeconds!==undefined){v.manualDurationSeconds=this.normalizedSettings({...v.settings,duration:params.manualDurationSeconds,manualDurationSeconds:params.manualDurationSeconds}).manualDurationSeconds;}
    if(params.draft!==undefined){if(typeof params.draft!=='string'||params.draft.length>4000)throw new Error('Сообщение должно быть длиной до 4000 символов');v.draft=params.draft;}
    if(params.name!==undefined){if(typeof params.name!=='string'||!params.name.trim()||params.name.trim().length>120||/[\x00-\x1f\x7f]/.test(params.name))throw new Error('Введите название длиной от 1 до 120 символов');next.name=params.name.trim();}
    if(params.videoContextEnabled!==undefined)v.videoContextEnabled=!!params.videoContextEnabled;
    v.durationMode=v.videoContextEnabled?'videoContext':'manual';
    for(const key of ['manualSize','manualFps'])if(params[key]!==undefined){if(typeof params[key]!=='boolean')throw new Error('Некорректный режим видеопараметров');v[key]=params[key];}
    await this.conversations.save(next);this.conversations.items.set(next.id,next);return this.publicConversation(next);
  }
  async sendChat(params,signal){
    if(params.projectId&&params.projectId!==this.workspace.project?.id)throw new Error('Проект изменился. Повторите отправку сообщения.');
    if(typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>4000)throw new Error('Введите сообщение длиной до 4000 символов');
    const d=this.conversation(params.conversationId),v=this.conversations.getVersion(d,params.versionId||d.selectedVersionId);
    const baseId=v.selectedRevisionId||v.baseRevisionId||null;
    if(params.previousId!==undefined&&params.previousId!==baseId)throw new Error('Ревизия не принадлежит выбранной версии');
    const previous=baseId?this.job(baseId):null,capture=params.contextId?this.contexts.get(params.contextId):null;
    if(params.contextId&&(!capture||capture.range.projectId!==(d.projectId||this.workspace.project?.id)||this.currentRange?.key!==capture.range.key))throw new Error('Видеоконтекст устарел. Повторите отправку.');
    if(capture&&capture.used)throw new Error('Видеоконтекст уже использован');if(capture)capture.used=true;
    await this.bindLegacyConversation(d);
    const settings=this.normalizedSettings(params.settings||v.settings,capture?.range);
    const inheritedContext=await versionContext(d,v),history=[...(d.legacyHistory||[]),...(v.baseSnapshot?.history||[]),...v.messages];
    const user={id:randomUUID(),role:'user',text:params.prompt.trim(),baseVersionId:v.id,baseRevisionId:baseId,status:'pending',createdAt:new Date().toISOString()};
    v.messages.push(user);v.draft='';v.settings=settings;v.contextSnapshotIds??=[];d.updatedAt=user.createdAt;
    const assertActive=()=>{if(signal.aborted)throw new Error('Отправка отменена');if(d.projectId&&this.workspace.project?.id!==d.projectId)throw new Error('Проект изменился во время ответа. Повторите отправку.');if(capture&&this.currentRange?.key!==capture.range.key)throw new Error('In/Out изменились. Повторите отправку.');};
    try{
      await this.conversations.save(d);assertActive();
      if(capture){capture.transcript=Array.isArray(params.contextTranscript)?params.contextTranscript.slice(0,300).filter(s=>typeof s.text==='string'&&s.text.trim()&&s.text.trim()!=='(...)'&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.end>s.start&&s.start<capture.range.duration).map(s=>({start:s.start,end:Math.min(s.end,capture.range.duration),text:s.text.slice(0,500)})):[];capture.speechStatus=capture.transcript.length?'ready':['no-speech','unavailable'].includes(params.contextSpeechStatus)?params.contextSpeechStatus:'unavailable';capture.speechSource=typeof params.contextSpeechSource==='string'?params.contextSpeechSource.slice(0,80):null;capture.speechError=typeof params.contextSpeechError==='string'?params.contextSpeechError.slice(0,600):null;}
      const videoContext=capture?await prepareContextImages(capture,{signal,onStage:stage=>this.emit('stage',{stage})}):null;assertActive();
      if(videoContext){const snapshot=await persistContext(d,v,user,videoContext);user.contextSnapshotId=snapshot.id;v.contextSnapshotIds.push(snapshot.id);await this.conversations.save(d);assertActive();}
      const result=await this.chatGenerator({auth:this.auth,prompt:user.text,history,previous:previous?.plan||v.baseSnapshot?.plan||null,selectedVersionId:v.id,baseVersionId:v.parentVersionId||null,baseRevisionId:v.baseRevisionId||null,settings,videoContext,inheritedContext,assetManifest:v.baseSnapshot?.assetManifest||[],model:params.model,effort:params.effort,profileDir:path.join(this.root,'.data/codex-profile'),signal,onStage:stage=>this.emit('stage',{stage})});assertActive();
      let job=null;const assistant={id:randomUUID(),role:'assistant',text:result.message,status:'completed',createdAt:new Date().toISOString()};
      if(result.plan){
        const plan=(settings.engine==='remotion'?require('./remotion.cjs').normalizeReactComposition:require('./motion.cjs').normalizeMotion)(result.plan,settings);
        const target={jobsDir:path.dirname(d.directory),projectId:d.projectId,projectName:this.workspace.project?.name};
        job=await this.create(plan,user.text,target,{conversationId:d.id,logicalVersionId:v.id,parentId:baseId,version:v.number,contextSnapshotIds:[...new Set([...(v.baseSnapshot?.contextSnapshotIds||[]),...v.contextSnapshotIds])],turn:{userId:user.id,assistant},model:params.model,effort:params.effort,videoContext,signal});
        assistant.revisionId=job.id;assistant.versionId=job.id;v.revisionIds.push(job.id);v.selectedRevisionId=job.id;v.status='ready';d.jobIds.push(job.id);if(d.name==='Новая композиция')d.name=job.name;
      }
      user.status='completed';v.messages.push(assistant);d.updatedAt=new Date().toISOString();await this.conversations.save(d);
      return {conversation:await this.publicConversation(d,v.id),job};
    }catch(error){user.status=signal.aborted?'cancelled':'failed';user.error=String(error.message).slice(0,600);d.updatedAt=new Date().toISOString();await this.conversations.save(d).catch(()=>{});throw error;}
    finally{if(capture)await this.discardContext(capture.id);}
  }
  async discardContext(id){const snapshot=this.contexts.get(id);if(!snapshot)return;this.contexts.delete(id);const base=path.resolve(this.root,'.data/video-context');if(path.dirname(snapshot.directory)!==base||!UUID.test(path.basename(snapshot.directory)))throw new Error('Недопустимая папка контекста');await fs.rm(snapshot.directory,{recursive:true,force:true});}
  async exclusive(fn){if(this.active)throw new Error('Дождитесь текущей задачи или отмените её');const abort=new AbortController();this.active=abort;try{return await fn(abort.signal);}finally{this.active=null;}}
  async handle(method,params={}){
    switch(method){
      case 'status':return {auth:await this.auth.state(),...this.workspaceState(),engines:[{id:'remotion',name:'Remotion'},{id:'hyperframes',name:'HyperFrames',version:'0.8.221'}],busy:!!this.active};
      case 'conversation.create':return this.exclusive(async()=>{if(params.projectId&&params.projectId!==this.workspace.project?.id)throw new Error('Проект изменился');const target=await this.workspace.prepareTarget();const d=await this.conversations.create(target,this.normalizedSettings(params.settings||{engine:'remotion'}));return this.conversations.public(d,true);});
      case 'conversation.get':return this.publicConversation(this.conversation(params.id));
      case 'version.get':return this.publicConversation(this.conversation(params.compositionId),params.versionId);
      case 'version.update':return this.exclusive(()=>this.updateConversation({...params,id:params.compositionId}));
      case 'version.create':return this.exclusive(async()=>{const d=this.conversation(params.compositionId);await this.bindLegacyConversation(d);await this.conversations.createVersion(d,params);return this.publicConversation(d);});
      case 'conversation.update':return this.exclusive(()=>this.updateConversation(params));
      case 'chat.send':return this.exclusive(signal=>this.sendChat(params,signal));
      case 'videoContext.prepare':return this.exclusive(async()=>{
        const input=params.range;const range=input&&normalizeRange({...input,markIn:input.startFrame-input.timelineStart,markOut:input.endFrame-input.timelineStart,timelineEnd:input.endFrame});
        if(!range||range.key!==input.key)throw new Error('Некорректный диапазон видеоконтекста');
        if(range.projectId!==this.workspace.project?.id)throw new Error('Проект изменился. Обновите контекст.');
        const id=randomUUID(),directory=path.resolve(this.root,'.data/video-context',id);await fs.mkdir(directory,{recursive:true});
        const snapshot={id,directory,range,exports:sampleFrames(range).map((sample,i)=>({...sample,file:path.join(directory,`frame-${i}.png`)}))};this.contexts.set(id,snapshot);return snapshot;
      });
      case 'videoContext.discard':await this.discardContext(params.id);return {};
      case 'workspace.project':{
        this.workspace.setProject(params.project);this.currentRange=params.project?.videoContext||null;
        for(const dir of this.workspace.directoriesForProject())await this.loadJobs(dir);
        return this.workspaceState();
      }
      case 'workspace.select':return this.exclusive(async()=>{
        await this.workspace.selectDirectory(params.projectId,params.directory);
        for(const dir of this.workspace.directoriesForProject())await this.loadJobs(dir);
        return this.workspaceState();
      });
      case 'workspace.folder':return {directory:params.id?this.job(params.id).dir:this.workspace.info().jobsDir};
      case 'auth.begin':if(this.active)throw new Error('Дождитесь текущей задачи');return this.auth.begin();
      case 'auth.cancel':this.auth.cancel();return {};
      case 'auth.models':return this.auth.models();
      case 'auth.signOut':if(this.active)throw new Error('Сначала остановите текущую задачу');return this.auth.signOut();
      case 'demo':return this.exclusive(async()=>{if(params.projectId&&params.projectId!==this.workspace.project?.id)throw new Error('Проект изменился. Повторите создание композиции.');const engine=engineFor(params.settings);const target=await this.workspace.prepareTarget();const plan=engine==='remotion'?require('./remotion.cjs').demoRemotion(this.normalizedSettings(params.settings)):demoMotion(this.normalizedSettings(params.settings));return this.create(plan,'Тестовая композиция, без AI',target);});
      case 'generate':return this.exclusive(async signal=>{
        if(params.projectId&&params.projectId!==this.workspace.project?.id)throw new Error('Проект изменился. Повторите создание композиции.');
        if(typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>4000)throw new Error('Введите команду длиной до 4000 символов');
        const engine=engineFor(params.settings);
        let settings=this.normalizedSettings(params.settings);
        const previous=params.previousId?this.job(params.previousId).plan:null;
        const target=await this.workspace.prepareTarget();
        const capture=params.contextId?this.contexts.get(params.contextId):null;
        if(params.contextId&&(!capture||capture.range.projectId!==target.projectId))throw new Error('Видеоконтекст устарел. Повторите генерацию.');
        const onStage=stage=>this.emit('stage',{stage});
        try{
          if(capture)capture.transcript=Array.isArray(params.contextTranscript)?params.contextTranscript.slice(0,300).filter(s=>typeof s.text==='string'&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.end>s.start&&s.start<capture.range.duration).map(s=>({start:s.start,end:Math.min(s.end,capture.range.duration),text:s.text.slice(0,500)})):[];
          const videoContext=capture?await prepareContextImages(capture,{signal,onStage}):null;if(capture)settings=this.normalizedSettings(params.settings,capture.range);
          const plan=await generatePlan({auth:this.auth,prompt:params.prompt,settings:{...settings,engine},previous,videoContext,model:params.model,effort:params.effort,profileDir:path.join(this.root,'.data/codex-profile'),signal,onStage});
          return await this.create(plan,params.prompt,target,{model:params.model,effort:params.effort,videoContext});
        }finally{if(capture)await this.discardContext(capture.id);}
      });
      case 'render':return this.exclusive(async signal=>{
        const j=this.scopedJob(params);if(j.output){await fs.access(j.output.file);return this.publicJob(j);}
        j.status='rendering';await this.save(j);
        try{j.output=await renderMotion(j.dir,j.plan,{signal,onStage:stage=>this.emit('stage',{stage})});j.status='ready_for_import';await this.save(j);return this.publicJob(j);}catch(e){j.status=signal.aborted?'cancelled':'failed';await this.save(j);throw e;}
      });
      case 'rename':return this.exclusive(async()=>{
        const j=this.job(params.id);
        if(this.jobProject(j)&&this.jobProject(j)!==this.workspace.project?.id)throw new Error('Проект изменился. Обновите сведения о проекте.');
        if(typeof params.name!=='string'||!params.name.trim()||params.name.trim().length>120||/[\x00-\x1f\x7f]/.test(params.name))throw new Error('Введите название длиной от 1 до 120 символов без переносов строк');
        const renamed={...j,plan:{...j.plan,name:params.name.trim()}};await this.save(renamed);this.jobs.set(j.id,renamed);return this.publicJob(renamed);
      });
      case 'job':return this.publicJob(this.job(params.id));
      case 'artifact':{const j=this.scopedJob(params);if(!j.output)throw new Error('Сначала выполните финальный рендер');const expected=path.join(j.dir,'motion.mov');if(j.output.file!==expected)throw new Error('Недопустимый путь результата');await fs.access(expected);return {file:expected,imports:j.imports};}
      case 'recordImport':{const j=this.job(params.id);if(!params.projectId||!params.mediaId)throw new Error('Импорт не подтверждён Resolve');j.imports[params.projectId]=params.mediaId;await this.save(j);return this.publicJob(j);}
      case 'cancel':this.active?.abort();return {};
      default:throw new Error('Операция не разрешена');
    }
  }
  close(){this.active?.abort();this.auth.cancel();this.preview.server.close();for(const id of this.contexts.keys())this.discardContext(id).catch(()=>{});}
}
if(require.main===module){
  const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
  (async()=>{require('./runtime.cjs').assertCurrentRuntime();const c=await new Controller(ROOT,(event,data)=>send({event,data})).init();const input=readline.createInterface({input:process.stdin});input.on('line',async line=>{if(line.length>100000)return;let m;try{m=JSON.parse(line);const result=await c.handle(m.method,m.params);send({id:m.id,result});}catch(e){send({id:m?.id,error:e.message});}});input.on('close',()=>{c.close();setTimeout(()=>process.exit(0),300).unref();});send({event:'ready',data:{}});})().catch(()=>{send({event:'fatal',data:{message:'Не удалось запустить локальный контроллер'}});process.exitCode=1;});
}
module.exports={Controller};
