'use strict';
const {runtimeExecutable}=require('./runtime.cjs');
const path=require('node:path');
const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const {run}=require('./process.cjs');

function nominalRate(fps){return Math.round(fps);}
function dropCount(fps,drop){return drop&&[30,60,120].includes(nominalRate(fps))?Math.round(nominalRate(fps)/15):0;}
function frameToTimecode(frame,fps,drop=false){
  const rate=nominalRate(fps),skip=dropCount(fps,drop);let value=Math.round(frame);
  if(skip){const perTen=rate*600-skip*9;const blocks=Math.floor(value/perTen),rest=value%perTen;value+=skip*9*blocks+(rest>=skip?skip*Math.floor((rest-skip)/(rate*60-skip)):0);}
  const f=value%rate,s=Math.floor(value/rate)%60,m=Math.floor(value/(rate*60))%60,h=Math.floor(value/(rate*3600));
  const two=v=>String(v).padStart(2,'0');return `${two(h)}:${two(m)}:${two(s)}${skip?';':':'}${two(f)}`;
}
function timecodeToFrame(tc,fps,drop=false){
  const match=typeof tc==='string'&&tc.match(/^(\d{2,}):(\d{2}):(\d{2})[:;](\d{2,3})$/);if(!match)return null;
  const [h,m,s,f]=match.slice(1).map(Number),rate=nominalRate(fps),skip=dropCount(fps,drop);
  if(m>59||s>59||f>=rate||(skip&&m%10!==0&&s===0&&f<skip))return null;
  const minutes=h*60+m;return ((h*3600+m*60+s)*rate+f)-skip*(minutes-Math.floor(minutes/10));
}
function normalizeRange(value){
  if(!value||!['projectId','timelineId'].every(k=>typeof value[k]==='string'&&value[k]&&value[k].length<=300))return null;
  const {fps,timelineStart,timelineEnd,markIn,markOut}=value;
  if(typeof fps!=='number'||!Number.isFinite(fps)||fps<1||fps>120||![timelineStart,timelineEnd,markIn,markOut].every(Number.isSafeInteger)||timelineStart<0||markIn<0||markOut<markIn||timelineEnd<timelineStart+markOut)return null;
  const dropFrame=!!value.dropFrame;if(dropFrame&&!dropCount(fps,true))return null;
  const startFrame=timelineStart+markIn,endFrame=timelineStart+markOut;
  const range={projectId:value.projectId,timelineId:value.timelineId,timelineName:String(value.timelineName||'Таймлайн').slice(0,200),fps,dropFrame,timelineStart,startFrame,endFrame,duration:(markOut-markIn+1)/fps,inTimecode:frameToTimecode(startFrame,fps,dropFrame),outTimecode:frameToTimecode(endFrame,fps,dropFrame)};
  range.key=createHash('sha256').update(JSON.stringify([range.projectId,range.timelineId,startFrame,endFrame,fps,dropFrame])).digest('hex');return range;
}
function sampleFrames(range){
  const count=Math.min(12,range.endFrame-range.startFrame+1,Math.max(1,Math.ceil(range.duration)));
  return Array.from({length:count},(_,i)=>{const frame=range.startFrame+(count===1?0:Math.round((range.endFrame-range.startFrame)*i/(count-1)));return {frame,seconds:(frame-range.startFrame)/range.fps,timecode:frameToTimecode(frame,range.fps,range.dropFrame)};});
}
async function prepareContextImages(snapshot,{signal,onStage=()=>{}}={}){
  const frames=[];
  if(!snapshot.exports?.length||snapshot.exports.length>12)throw new Error('Не удалось получить кадры видеоконтекста');
  for(const [i,sample]of snapshot.exports.entries()){
    if(signal?.aborted)throw new Error('Подготовка видеоконтекста отменена');
    if(path.dirname(sample.file)!==snapshot.directory)throw new Error('Недопустимый путь кадра контекста');
    await fs.access(sample.file);const file=path.join(snapshot.directory,`image-${i}.jpg`);
    onStage(`Подготовка видеоконтекста · ${i+1}/${snapshot.exports.length}`);
    await run(runtimeExecutable('ffmpeg'),['-hide_banner','-loglevel','error','-i',sample.file,'-vf',"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease",'-frames:v','1','-q:v','4','-y',file],{signal,timeout:30000});
    const stat=await fs.stat(file);if(!stat.size||stat.size>2*1024*1024)throw new Error('Кадр видеоконтекста слишком большой');
    frames.push({path:file,seconds:sample.seconds,timecode:sample.timecode});
  }
  return {range:snapshot.range,frames,transcript:snapshot.transcript||[],speechIncluded:!!snapshot.transcript?.length,
    speechStatus:snapshot.speechStatus,speechSource:snapshot.speechSource,speechError:snapshot.speechError};
}
module.exports={normalizeRange,frameToTimecode,timecodeToFrame,sampleFrames,prepareContextImages};
