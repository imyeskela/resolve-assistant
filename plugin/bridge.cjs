'use strict';
const {normalizeRange,timecodeToFrame}=require('../lib/video-context.cjs');
const {acquireResolveSpeech}=require('../lib/resolve-transcript.cjs');
const VIDEO_KEYS=['timelineResolutionWidth','timelineResolutionHeight','timelineFrameRate'];
async function optionalCall(target,method,...args){
  try{return typeof target?.[method]==='function'?await target[method](...args):undefined;}catch{return undefined;}
}
async function readSettings(target,keys=VIDEO_KEYS){
  let snapshot=await optionalCall(target,'GetSettings');
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))snapshot=await optionalCall(target,'GetSetting');
  const result=snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)?{...snapshot}:{};
  for(const key of keys){
    if(result[key]===undefined)result[key]=await optionalCall(target,'GetSetting',key);
  }
  return result;
}
function sdkNumber(value,min,max,integer=false){
  if(typeof value==='string'){
    const match=value.trim().match(/^(\d+(?:\.\d+)?)(?:\s+DF)?$/i);
    if(!match)return null;
    value=Number(match[1]);
  }
  return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!integer||Number.isInteger(value))?value:null;
}
async function readVideo(project,projectSettings){
  const timeline=await optionalCall(project,'GetCurrentTimeline');
  const timelineSettings=timeline?await readSettings(timeline):{};
  const limits=[[360,4096,true],[360,4096,true],[1,120,false]];
  let fromTimeline=false;
  const values=VIDEO_KEYS.map((key,i)=>{
    const timelineValue=sdkNumber(timelineSettings[key],...limits[i]);
    if(timelineValue!==null){fromTimeline=true;return timelineValue;}
    return sdkNumber(projectSettings[key],...limits[i]);
  });
  if(values.some(value=>value===null))return null;
  const [width,height,fps]=values;
  const video={width,height,fps,source:fromTimeline?'timeline':'project'};
  if(timeline){
    const id=await optionalCall(timeline,'GetUniqueId');
    const name=await optionalCall(timeline,'GetName');
    if(typeof id==='string'&&id)video.timelineId=id;
    if(typeof name==='string'&&name)video.timelineName=name;
  }
  return video;
}
async function readVideoContext(project){
  try{
    const timeline=await project.GetCurrentTimeline();if(!timeline)return null;
    const marks=await optionalCall(timeline,'GetMarkInOut');if(!marks?.video)return null;
    const settings=await readSettings(timeline,['timelineFrameRate','timelineDropFrameTimecode']);
    const fps=sdkNumber(settings.timelineFrameRate,1,120);if(!fps)return null;
    const startTc=await optionalCall(timeline,'GetStartTimecode');
    return normalizeRange({projectId:await project.GetUniqueId(),timelineId:await timeline.GetUniqueId(),timelineName:await timeline.GetName(),fps,timelineStart:await timeline.GetStartFrame(),timelineEnd:await timeline.GetEndFrame(),markIn:marks.video.in,markOut:marks.video.out,dropFrame:settings.timelineDropFrameTimecode==='1'||settings.timelineDropFrameTimecode===1||settings.timelineDropFrameTimecode===true||startTc?.includes(';')});
  }catch{return null;}
}
class ResolveBridge {
  constructor(workflow,pluginId){this.workflow=workflow;this.pluginId=pluginId;this.resolve=null;}
  async connect(){if(!this.resolve){if(!await this.workflow.InitializePromise(this.pluginId))throw new Error('Resolve SDK не инициализирован. Откройте плагин из Resolve Studio.');this.workflow.SetAPITimeout(15);this.resolve=await this.workflow.GetResolvePromise();}return this.resolve;}
  async context(){
    const resolve=await this.connect();const pm=await resolve.GetProjectManager();const project=await pm.GetCurrentProject();
    let mediaDirectory=null,video=null,videoContext=null;
    if(project){
      const settings=await readSettings(project,[...VIDEO_KEYS,'projectMediaLocation','cloudProjectMediaLocation']);
      mediaDirectory=settings.projectMediaLocation||settings.cloudProjectMediaLocation||null;
      if(!mediaDirectory)mediaDirectory=await optionalCall(project,'GetSetting','projectMediaLocation')||null;
      if(typeof mediaDirectory!=='string')mediaDirectory=null;
      video=await readVideo(project,settings);
      videoContext=await readVideoContext(project);
    }
    return {connected:true,version:await resolve.GetVersionString(),product:await resolve.GetProductName(),project:project?{id:await project.GetUniqueId(),name:await project.GetName(),mediaDirectory,video,videoContext}:null};
  }
  async captureVideoContext(range,exports,{signal,onStage=()=>{},speechTimeoutMs}={}){
    const resolve=await this.connect();const pm=await resolve.GetProjectManager();const project=await pm.GetCurrentProject();
    const ensure=async()=>{if(signal?.aborted)throw new Error('Подготовка видеоконтекста отменена');const current=await pm.GetCurrentProject();if(!current||await current.GetUniqueId()!==range.projectId||(await readVideoContext(current))?.key!==range.key)throw new Error('Проект, таймлайн или In/Out изменились. Обновите контекст и повторите генерацию.');};
    await ensure();const timeline=await project.GetCurrentTimeline();const before=await timeline.GetCurrentTimecode();let last=null,keepUserPosition=false;
    const ensurePosition=async()=>{if(await timeline.GetCurrentTimecode()!==(last||before)){keepUserPosition=true;throw new Error('Позиция курсора изменилась во время получения кадров. Повторите генерацию.');}};
    try{
      for(const [i,sample]of exports.entries()){
        await ensure();onStage(`Получение кадров из Resolve · ${i+1}/${exports.length}`);
        if(signal?.aborted)throw new Error('Подготовка видеоконтекста отменена');
        await ensurePosition();
        if(!await timeline.SetCurrentTimecode(sample.timecode))throw new Error('Resolve не переместил курсор для получения кадра');
        last=await timeline.GetCurrentTimecode();
        if(timecodeToFrame(last,range.fps,range.dropFrame)!==timecodeToFrame(sample.timecode,range.fps,range.dropFrame)){keepUserPosition=true;throw new Error('Resolve не подтвердил позицию кадра');}
        if(!await project.ExportCurrentFrameAsStill(sample.file))throw new Error('Resolve не сохранил кадр видеоконтекста');
        await ensurePosition();
      }
      await ensure();await ensurePosition();
    }finally{
      try{const current=await pm.GetCurrentProject();if(!keepUserPosition&&last&&current&&await current.GetUniqueId()===range.projectId&&await (await current.GetCurrentTimeline()).GetUniqueId()===range.timelineId&&await timeline.GetCurrentTimecode()===last)await timeline.SetCurrentTimecode(before);}catch{}
    }
    // Frame sampling alone owns the playhead. Restore it before recognition so
    // the user can seek during a long SDK operation without a later overwrite.
    await ensure();
    const speech=await acquireResolveSpeech(timeline,range,{signal,onStage,ensure,timeoutMs:speechTimeoutMs});
    await ensure();return speech;
  }
  async importArtifact(file,targetProjectId,previousMediaId){
    const resolve=await this.connect();const pm=await resolve.GetProjectManager();const project=await pm.GetCurrentProject();
    if(!project||await project.GetUniqueId()!==targetProjectId)throw new Error('Проект изменился. Обновите сведения о проекте и повторите импорт.');
    const pool=await project.GetMediaPool();const root=await pool.GetRootFolder();
    async function findMedia(folder,id){for(const clip of await folder.GetClipList()||[])if(await clip.GetMediaId()===id)return clip;for(const child of await folder.GetSubFolderList()||[]){const clip=await findMedia(child,id);if(clip)return clip;}return null;}
    if(previousMediaId){const existing=await findMedia(root,previousMediaId);if(existing)return {projectId:targetProjectId,mediaId:previousMediaId,alreadyImported:true};}
    async function bin(parent,name){for(const f of await parent.GetSubFolderList()||[])if(await f.GetName()===name)return f;const f=await pool.AddSubFolder(parent,name);if(!f)throw new Error('Не удалось создать папку Media Pool');return f;}
    const target=await bin(await bin(root,'AI Assistant'),'Motion');
    const current=await pm.GetCurrentProject();if(!current||await current.GetUniqueId()!==targetProjectId)throw new Error('Проект изменился во время подготовки импорта');
    const old=await pool.GetCurrentFolder();if(!await pool.SetCurrentFolder(target))throw new Error('Не удалось выбрать папку импорта');
    // The installed JS SDK treats dictionary imports as image sequences. Its
    // official Workflow Integration sample uses this API for complete files.
    let clips;try{const storage=await resolve.GetMediaStorage();clips=await storage.AddItemListToMediaPool([file]);}finally{if(old)await pool.SetCurrentFolder(old).catch(()=>{});}
    if(!clips?.length)throw new Error('Resolve не подтвердил импорт. Готовый MOV сохранён.');
    return {projectId:targetProjectId,mediaId:await clips[0].GetMediaId(),alreadyImported:false};
  }
  close(){try{this.workflow.CleanUp();}catch{}}
}
module.exports={ResolveBridge};
