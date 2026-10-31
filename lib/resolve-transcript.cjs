'use strict';
const {timecodeToFrame}=require('./video-context.cjs');

const DEFAULT_TIMEOUT_MS=120000;
const unavailable=message=>({transcript:[],speechIncluded:false,speechStatus:'unavailable',speechSource:null,speechError:message});
function evidence(transcript,source,errors=[]){
  let characters=0;
  transcript=transcript.filter(row=>{
    if(characters+row.text.length>12000)return false;
    characters+=row.text.length;return true;
  }).slice(0,300);
  return {transcript,speechIncluded:transcript.length>0,speechStatus:transcript.length?'ready':errors.length?'unavailable':'no-speech',speechSource:source,speechError:errors.length?[...new Set(errors)].join('; ').slice(0,1500):null};
}
function text(value){return typeof value==='string'?value.replace(/\(\s*\.\.\.\s*\)/g,'').replace(/\s+/g,' ').trim():'';}
function numeric(value){return (typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value))?Number(value):null;}
function supportedData(value){return value&&Array.isArray(value.segments);}

// Word times are intersected with [In, Out + 1), then clipped to that window.
// A segment without word times can only be used when wholly inside the window:
// otherwise including its full text would disclose speech outside the selection.
function selectTranscript(data,range,{fps=range.fps,dropFrame=range.dropFrame,map=frame=>frame,clipStart=-Infinity,clipEnd=Infinity}={},seen=new Set()){
  const transcript=[],errors=[];let characters=0;
  if(!supportedData(data))return {transcript,errors:['Resolve не вернул данные расшифровки']};
  const left=Math.max(range.startFrame,clipStart),right=Math.min(range.endFrame+1,clipEnd);
  if(right<=left)return {transcript,errors};
  for(const segment of data.segments){
    if(!segment||typeof segment!=='object')continue;
    const timedWords=Array.isArray(segment.words)&&segment.words.length>0;
    const selected=[];
    for(const word of timedWords?segment.words:[segment]){
      const value=text(word?.text);if(!value)continue;
      const sourceStart=timecodeToFrame(word.start,fps,dropFrame),sourceEnd=timecodeToFrame(word.end,fps,dropFrame);
      if(sourceStart===null||sourceEnd===null||sourceEnd<=sourceStart){errors.push('Некорректные пометки времени речи в Resolve');continue;}
      const start=map(sourceStart),end=map(sourceEnd);
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){errors.push('Неподдерживаемое отображение времени речи');continue;}
      if(end<=left||start>=right)continue;
      if(!timedWords&&(start<left||end>right)){errors.push('Для речи на границе In/Out нет пометок отдельных слов');continue;}
      const clippedStart=(Math.max(start,left)-range.startFrame)/range.fps,clippedEnd=(Math.min(end,right)-range.startFrame)/range.fps;
      const key=JSON.stringify([Math.round(clippedStart*1000000),Math.round(clippedEnd*1000000),value]);
      if(seen.has(key))continue;seen.add(key);
      selected.push({start:clippedStart,end:clippedEnd,text:value});
    }
    if(!selected.length)continue;
    selected.sort((a,b)=>a.start-b.start||a.end-b.end);
    const value=selected.map(word=>word.text).join(' ').slice(0,500);
    if(characters+value.length>12000||transcript.length>=300)break;
    characters+=value.length;transcript.push({start:selected[0].start,end:Math.max(...selected.map(word=>word.end)),text:value});
  }
  return {transcript,errors:[...new Set(errors)]};
}

async function acquireResolveSpeech(timeline,range,{signal,onStage=()=>{},ensure=async()=>{},timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  const budget=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(timeoutMs,300000):DEFAULT_TIMEOUT_MS;
  const deadline=Date.now()+budget;
  const cancelled=()=>Object.assign(new Error('Подготовка видеоконтекста отменена. Поздний результат распознавания Resolve не будет отправлен.'),{code:'SPEECH_CANCELLED'});
  const timedOut=()=>Object.assign(new Error('Превышено время ожидания распознавания DaVinci. Отправляются только кадры; Resolve может продолжать обработку.'),{code:'SPEECH_TIMEOUT'});
  async function bounded(work){
    if(signal?.aborted)throw cancelled();
    const remaining=deadline-Date.now();if(remaining<=0)throw timedOut();
    let timer,abort;
    try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(timedOut()),remaining);
      if(signal){abort=()=>reject(cancelled());signal.addEventListener('abort',abort,{once:true});}
    })]);}finally{clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);}
  }
  async function guard(){if(signal?.aborted)throw cancelled();await bounded(ensure);if(signal?.aborted)throw cancelled();}
  async function call(target,method,...args){
    await guard();
    if(typeof target?.[method]!=='function')return {available:false,value:undefined,error:`Метод ${method} недоступен в JavaScript SDK Resolve`};
    let result;
    try{result={available:true,value:await bounded(()=>target[method](...args))};}
    catch(error){if(['SPEECH_CANCELLED','SPEECH_TIMEOUT'].includes(error.code))throw error;result={available:true,value:undefined,error:`${method}: ${String(error.message||error).slice(0,300)}`};}
    // Context checks are outside the SDK-error catch: stale/cancelled context
    // rejects capture, rather than silently sending frames from another range.
    await guard();return result;
  }
  async function read(media,nested){return call(media,'GetTranscription',...(nested?[true]:[]));}
  function parsed(result,mapping,seen){return supportedData(result.value)?selectTranscript(result.value,range,mapping,seen):null;}
  async function sourcePlan(){
    const entries=[],errors=[];const countResult=await call(timeline,'GetTrackCount','audio');const count=numeric(countResult.value);
    if(count===null||!Number.isInteger(count)||count<0||count>256)return {entries,errors:[countResult.error||'Не удалось проверить аудиодорожки таймлайна'],known:false};
    let inspected=0;
    for(let track=1;track<=count;track++){
      const enabled=await call(timeline,'GetIsTrackEnabled','audio',track);
      if(enabled.value===false)continue;
      if(enabled.value!==true){errors.push(enabled.error||'Неизвестно, включена ли аудиодорожка');continue;}
      const items=await call(timeline,'GetItemListInTrack','audio',track);
      if(!Array.isArray(items.value)){errors.push(items.error||'Не удалось получить аудиоклипы');continue;}
      for(const item of items.value){
        if(++inspected>10000){errors.push('Слишком много аудиоклипов для безопасной подготовки речи');return {entries,errors,known:true};}
        const start=numeric((await call(item,'GetStart')).value),end=numeric((await call(item,'GetEnd')).value);
        if(start===null||end===null||end<=start){errors.push('Не удалось определить границы аудиоклипа');continue;}
        if(end<=range.startFrame||start>=range.endFrame+1)continue;
        const clipEnabled=await call(item,'GetClipEnabled');
        if(clipEnabled.value===false)continue;
        if(clipEnabled.value!==true){errors.push(clipEnabled.error||'Неизвестно, включён ли аудиоклип');continue;}
        const mediaResult=await call(item,'GetMediaPoolItem'),media=mediaResult.value;
        if(!media){errors.push(mediaResult.error||'Исходный аудиоклип недоступен');continue;}
        const properties=(await call(media,'GetClipProperty')).value;
        const type=properties?.Type;
        if(typeof type!=='string'||!/^(audio|video(?:\s*\+\s*audio)?)$/i.test(type.trim())){errors.push('Сложный клип (compound/multicam/timeline) не поддержан для пересчёта речи');continue;}
        const speed=(await call(item,'GetSpeed')).value;
        if(numeric(speed?.Percentage)!==100){errors.push('Ретайминг/reverse или неизвестная скорость клипа не поддержаны для пересчёта речи');continue;}
        const fpsMatch=typeof properties.FPS==='string'?properties.FPS.trim().match(/^(\d+(?:\.\d+)?)(?:\s+DF)?$/i):null;
        const fps=numeric(fpsMatch?fpsMatch[1]:properties.FPS),startTC=properties['Start TC'];
        const dropFrame=typeof startTC==='string'&&startTC.includes(';');
        const sourceZero=fps&&fps>=1&&fps<=120?timecodeToFrame(startTC,fps,dropFrame):null;
        const sourceStartFrame=numeric((await call(item,'GetSourceStartFrame')).value),sourceEndFrame=numeric((await call(item,'GetSourceEndFrame')).value);
        const startTime=numeric((await call(item,'GetSourceStartTime')).value),endTime=numeric((await call(item,'GetSourceEndTime')).value);
        const trimStart=sourceStartFrame??(startTime===null?null:startTime*fps),trimEnd=sourceEndFrame??(endTime===null?null:endTime*fps);
        if(sourceZero===null||trimStart===null||trimEnd===null||trimStart<0||trimEnd<=trimStart){errors.push('Недоступны FPS, исходный таймкод или подрезка аудиоклипа');continue;}
        const duration=(end-start)/range.fps,tolerance=1/fps+1e-6;
        // Resolve versions differ on the inclusive/exclusive source Out. Both
        // must describe a normal-speed span, to within one source frame.
        if(Math.abs((trimEnd-trimStart)/fps-duration)>tolerance||startTime!==null&&Math.abs(startTime-trimStart/fps)>tolerance||endTime!==null&&Math.abs(endTime-trimEnd/fps)>tolerance){errors.push('Ретайминг или неоднозначные координаты подрезки: пересчёт речи недоступен');continue;}
        const id=(await call(media,'GetUniqueId')).value;
        entries.push({media,identity:typeof id==='string'&&id?id:media,mapping:{fps,dropFrame,clipStart:start,clipEnd:end,map:frame=>start+(frame-sourceZero-trimStart)/fps*range.fps}});
      }
    }
    return {entries,errors,known:true};
  }
  async function native(media,nested){
    if(typeof media?.TranscribeAudio!=='function')return {error:'Метод TranscribeAudio недоступен в JavaScript SDK Resolve'};
    onStage('DaVinci распознаёт речь… Обрабатывается клип целиком; в запрос попадёт только In/Out.');
    const started=await call(media,'TranscribeAudio',false,...(nested?[true]:[]));
    if(started.value!==true)return {error:started.error||'Resolve не подтвердил распознавание речи'};
    if(typeof media?.GetTranscription!=='function')return {error:'Метод GetTranscription недоступен в JavaScript SDK Resolve'};
    // Some JS SDK versions resolve TranscribeAudio when queued, rather than when
    // results are readable. Poll only during this explicit capture, within the
    // same shared deadline, and never clear/replace the user's transcription.
    for(;;){
      const preferred=await read(media,nested);
      if(supportedData(preferred.value))return {data:preferred.value,source:nested?'timeline-nested':'source-clips'};
      if(nested){const ordinary=await read(media,false);if(supportedData(ordinary.value))return {data:ordinary.value,source:'timeline'};}
      if(preferred.error)return {error:preferred.error};
      await bounded(()=>new Promise(resolve=>setTimeout(resolve,250)));await guard();
    }
  }
  try{
    const errors=[],mediaResult=await call(timeline,'GetMediaPoolItem'),media=mediaResult.value;
    let existingTimeline=false,usableTimeline=null;
    if(media){
      for(const nested of [false,true]){
        const result=await read(media,nested),selected=parsed(result);
        if(result.error)errors.push(result.error);
        if(supportedData(result.value)&&result.value.segments.length){
          existingTimeline=true;
          if(selected.transcript.length&&!selected.errors.length)return evidence(selected.transcript,nested?'timeline-nested':'timeline');
          if(!selected.errors.length)usableTimeline=evidence([],nested?'timeline-nested':'timeline');
          else errors.push(...selected.errors);
        }
      }
      if(usableTimeline)return usableTimeline;
    }
    const plan=await sourcePlan(),seen=new Set(),cache=new Map();let sourceTranscript=[],missing=false;
    for(const entry of plan.entries){
      let result=cache.get(entry.identity);if(!result){result=await read(entry.media,false);cache.set(entry.identity,result);}
      entry.existing=supportedData(result.value)&&result.value.segments.length>0;
      if(entry.existing){const selected=parsed(result,entry.mapping,seen);sourceTranscript.push(...selected.transcript);plan.errors.push(...selected.errors);}
      else{missing=true;entry.readError=result.error;}
    }
    if(plan.known&&!plan.entries.length&&!plan.errors.length)return evidence([],'source-clips');
    if(plan.entries.length&&!missing&&!plan.errors.length)return evidence(sourceTranscript.sort((a,b)=>a.start-b.start),'source-clips');
    if(media&&!existingTimeline){
      const recognized=await native(media,true);
      if(recognized.data){const selected=selectTranscript(recognized.data,range);if(!selected.errors.length)return evidence(selected.transcript,recognized.source);errors.push(...selected.errors);}
      else errors.push(recognized.error);
    }
    const recognizedSources=new Map();
    for(const entry of plan.entries){
      if(entry.existing)continue;
      let recognized=recognizedSources.get(entry.identity);
      if(!recognized){recognized=await native(entry.media,false);recognizedSources.set(entry.identity,recognized);}
      if(recognized.data){const selected=selectTranscript(recognized.data,range,entry.mapping,seen);sourceTranscript.push(...selected.transcript);plan.errors.push(...selected.errors);}
      else plan.errors.push(recognized.error||entry.readError);
    }
    const sourceErrors=plan.errors.filter(Boolean);
    if(sourceTranscript.length)return evidence(sourceTranscript.sort((a,b)=>a.start-b.start).slice(0,300),'source-clips',sourceErrors);
    if(plan.entries.length&&!sourceErrors.length)return evidence([],'source-clips');
    return unavailable([...new Set([...errors,...sourceErrors].filter(Boolean))].join('; ').slice(0,1500)||'Расшифровка речи недоступна в JavaScript SDK Resolve');
  }catch(error){
    if(error.code==='SPEECH_TIMEOUT')return unavailable(error.message);
    throw error;
  }
}
module.exports={acquireResolveSpeech};
