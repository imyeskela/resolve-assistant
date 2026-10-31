'use strict';
const {runtimeExecutable}=require('./runtime.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const esbuild=require('esbuild');
const {normalizeVideoSettings}=require('./motion.cjs');
const {run,cleanEnvironment}=require('./process.cjs');
const {atomicWrite}=require('./storage.cjs');
const {assertBrowserSource}=require('./remotion-source-policy.cjs');
const {normalizeScenePlan,renderTrustedScene}=require('./trusted-scene.cjs');
const ROOT=path.resolve(__dirname,'..');
const ALLOWED=new Set(['react','react/jsx-runtime','remotion']);
function normalizeReactComposition(raw,settings){
  if(!raw||typeof raw!=='object'||typeof raw.source!=='string'||!raw.source.trim()||raw.source.length>120000)throw new Error('Композиция Remotion должна содержать TSX-код (до 120 000 символов)');
  const video=normalizeVideoSettings({...settings,engine:'remotion'});
  return {version:1,engine:'remotion',name:typeof raw.name==='string'?raw.name.slice(0,120):'React Motion',...video,source:raw.source};
}
function demoRemotion(settings){return normalizeReactComposition({name:'React Motion',source:`import React from 'react';
import {AbsoluteFill,useCurrentFrame,useVideoConfig,interpolate,spring} from 'remotion';
export default function Scene(){
 const frame=useCurrentFrame(); const {fps,width,height,durationInFrames}=useVideoConfig();
 const enter=spring({frame,fps,config:{damping:14}});
 const fade=interpolate(frame,[durationInFrames-12,durationInFrames-1],[1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 const values=[0.36,0.62,0.48,0.84,1];
 return <AbsoluteFill style={{fontFamily:'Segoe UI',color:'#F5F1E9',opacity:fade,justifyContent:'center',padding:width*0.08}}>
  <div style={{fontSize:width*0.064,fontWeight:800,transform:'translateY('+((1-enter)*35)+'px)',opacity:enter}}>Движение. Без границ.</div>
  <svg width={width*0.8} height={height*0.38} viewBox="0 0 600 180">
   <defs><linearGradient id="bar" x2="0" y2="1"><stop stopColor="#F39B59"/><stop offset="1" stopColor="#F6D3A4"/></linearGradient></defs>
   {values.map((v,i)=>{const p=spring({frame:frame-i*4,fps,config:{damping:18}});return <g key={i}><rect x={i*115+10} y={170-v*140*p} width="76" height={v*140*p} rx="10" fill="url(#bar)"/><text x={i*115+48} y={153-v*140*p} textAnchor="middle" fill="#F5F1E9" fontSize="18">{Math.round(v*100*p)}%</text></g>})}
  </svg>
  <div style={{fontSize:width*0.025,opacity:enter}}>React · SVG · пружины · данные</div>
 </AbsoluteFill>;
}`},settings);}
function checkSource(source){
  // Parsing/printing is data-only: never execute or import model-authored code in Node.
  let printed;
  try{printed=esbuild.transformSync(source,{loader:'tsx',format:'esm',jsx:'automatic',tsconfigRaw:{compilerOptions:{verbatimModuleSyntax:true}}}).code;}
  catch(error){throw new Error('Ошибка TSX: '+String(error.errors?.[0]?.text||error.message).slice(0,300));}
  return assertBrowserSource(printed);
}
function wrapper(plan){return `import React,{createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Player} from '@remotion/player';
import Scene from 'generated-scene';
const player=createRef();
const exporting=new URLSearchParams(location.search).has('render');
class Boundary extends React.Component {constructor(p){super(p);this.state={error:null};}static getDerivedStateFromError(e){return {error:String(e.message||e)}}componentDidCatch(e){window.__motionError=String(e.message||e)}render(){return this.state.error?React.createElement('pre',null,'Ошибка композиции: '+this.state.error):this.props.children;}}
flushSync(()=>createRoot(document.getElementById('root')).render(<Boundary><Player ref={player} component={Scene} durationInFrames={${plan.frameCount}} compositionWidth={${plan.width}} compositionHeight={${plan.height}} fps={${plan.fps}} autoPlay={!exporting} loop={!exporting} controls={false} clickToPlay={false} doubleClickToFullscreen={false} spaceKeyToPlayOrPause={false} numberOfSharedAudioTags={0} style={{width:'100%',height:'100%',backgroundColor:'transparent'}} errorFallback={({error})=>{window.__motionError=String(error.message||error);return <pre>Ошибка композиции: {String(error.message||error)}</pre>}} /></Boundary>));
window.__motionSeek=async(frame)=>{if(!player.current)throw new Error('Player не готов');flushSync(()=>player.current.seekTo(frame));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(window.__motionError)throw new Error(window.__motionError);return player.current.getCurrentFrame();};
addEventListener('message',event=>{if(exporting||event.source!==parent||!player.current)return;if(event.data==='pause')player.current.pause();if(event.data==='play')player.current.play();if(event.data==='restart'){player.current.seekTo(0);player.current.play();}});
window.__motionReady=true;`;}
async function prepareRemotionComposition(jobDir,plan){
  const source=checkSource(plan.source);
  const result=await esbuild.build({stdin:{contents:wrapper(plan),loader:'tsx',resolveDir:ROOT,sourcefile:'trusted-player.tsx'},bundle:true,write:false,format:'iife',platform:'browser',target:'chrome110',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true,logLevel:'silent',plugins:[{name:'composition-import-boundary',setup(build){
    build.onResolve({filter:/^generated-scene$/},()=>({path:'scene.tsx',namespace:'generated'}));
    build.onLoad({filter:/.*/,namespace:'generated'},()=>({contents:source,loader:'jsx',resolveDir:ROOT}));
    build.onResolve({filter:/.*/,namespace:'generated'},args=>{if(!ALLOWED.has(args.path))return {errors:[{text:'Импорт запрещён: '+args.path+'. Разрешены react и remotion.'}]};return build.resolve(args.path,{resolveDir:ROOT,kind:args.kind});});
  }}]}).catch(error=>{throw new Error('Не удалось собрать React-композицию: '+String(error.errors?.[0]?.text||error.message).slice(0,400));});
  await fs.mkdir(path.join(jobDir,'assets'),{recursive:true});
  await atomicWrite(path.join(jobDir,'assets/remotion.js'),result.outputFiles[0].text);
  await atomicWrite(path.join(jobDir,'source.tsx'),plan.source);
  await atomicWrite(path.join(jobDir,'remotion-render.json'),JSON.stringify(normalizeVideoSettings({...plan,engine:'remotion'})));
  await atomicWrite(path.join(jobDir,'index.html'),'<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}pre{white-space:pre-wrap;color:#ffb199;padding:20px}</style></head><body><div id="root"></div><script src="assets/remotion.js"></script></body></html>');
}
async function renderRemotion(jobDir,plan,{signal,onStage=()=>{}}={}){
  plan=normalizeScenePlan(plan);
  if(plan.engine!=='remotion')throw new Error('Неизвестный движок композиции');
  return renderTrustedScene(jobDir,plan,{signal,prepare:prepareRemotionComposition,render:(directory,validated)=>renderPreparedRemotion(directory,validated,{signal,onStage})});
}
async function renderPreparedRemotion(jobDir,plan,{signal,onStage}){
  if(signal?.aborted)throw new Error('Задание отменено');
  onStage('Рендер React-композиции в прозрачный MOV');
  await run(runtimeExecutable('node'),[path.join(__dirname,'remotion-worker.cjs'),jobDir],{cwd:ROOT,env:cleanEnvironment(),signal,timeout:600000,maxBytes:1024*1024,onLine:line=>{if(line.startsWith('PROGRESS '))onStage('Рендер React: '+line.slice(9).trim());}});
  onStage('Проверка альфа-канала и параметров MOV');
  const temp=path.join(jobDir,'render.partial.mov');
  const info=JSON.parse(await run(runtimeExecutable('ffprobe'),['-v','error','-show_streams','-show_format','-of','json',temp],{signal,timeout:30000}));
  const stream=info.streams.find(s=>s.codec_type==='video');const [n,d]=String(stream?.avg_frame_rate||'0/1').split('/').map(Number);
  if(!stream||stream.codec_name!=='prores'||!String(stream.pix_fmt).startsWith('yuva')||stream.width!==plan.width||stream.height!==plan.height||Math.abs(n/d-plan.fps)>0.001||Math.abs(Number(info.format.duration)-plan.duration)>1/plan.fps+0.01)throw new Error('MOV не соответствует параметрам композиции или не содержит альфа-канал');
  const file=path.join(jobDir,'motion.mov');await fs.rename(temp,file);
  return {file,bytes:(await fs.stat(file)).size,width:stream.width,height:stream.height,fps:plan.fps,duration:Number(info.format.duration),codec:stream.codec_name,pixelFormat:stream.pix_fmt,
    ...(plan.durationMode==='videoContext'?{durationMode:plan.durationMode,requestedDuration:plan.requestedDuration,frameCount:plan.frameCount}:{})};
}
module.exports={normalizeReactComposition,demoRemotion,prepareRemotionComposition,renderRemotion};
