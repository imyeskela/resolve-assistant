'use strict';
const TYPES = new Set(['text', 'rect', 'circle']);
const ENTERS = new Set(['rise', 'slide', 'zoom', 'fade', 'draw']);
const FONTS = new Set(['Segoe UI', 'Georgia', 'Arial', 'Verdana']);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function number(value, fallback, min, max, name) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`Invalid ${name}: expected ${min}…${max}`);
  return v;
}
function color(value, fallback, name='color') {
  const v=value ?? fallback;
  if (typeof v!=='string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`Invalid ${name}: use #RRGGBB`);
  return v;
}
function normalizeVideoSettings(settings={}) {
  const width=number(settings.width,1920,360,4096,'width');
  const height=number(settings.height,1080,360,4096,'height');
  const fps=number(settings.fps,30,1,120,'fps');
  const contextDuration=settings.durationMode==='videoContext';
  const requestedDuration=contextDuration?settings.requestedDuration:(settings.duration===undefined?5:settings.duration);
  // Persisted plans contain effective seconds rather than the original request.
  // Permit a boundary rounded outward only when its trusted frame count proves
  // it is exactly a canonical result within the original 2…15-second limits.
  const canonicalDuration=Number.isInteger(settings.frameCount)&&
    settings.frameCount>=Math.round(2*fps)&&settings.frameCount<=Math.round(15*fps)&&
    requestedDuration===settings.frameCount/fps;
  if(typeof requestedDuration!=='number'||!Number.isFinite(requestedDuration)||
    (contextDuration?requestedDuration<=0:((requestedDuration<2||requestedDuration>15)&&!canonicalDuration)))throw new Error(contextDuration?'Invalid context duration: expected positive finite seconds':'Invalid duration: expected 2…15');
  if (!Number.isInteger(width)||!Number.isInteger(height)) throw new Error('Invalid frame dimensions');
  const frameCount=Math.max(1,Math.round(requestedDuration*fps));
  if(!Number.isSafeInteger(frameCount))throw new Error('Invalid duration: output frame count is not a safe integer');
  // Installed HyperFrames rejects render plans longer than 24 hours. Report its
  // real limit before generation instead of letting preparation fail later.
  if(contextDuration&&settings.engine!=='remotion'&&frameCount>Math.ceil(86400*fps))throw new Error('Длительность HyperFrames превышает предел движка: 24 часа');
  return {width,height,fps,duration:frameCount/fps,frameCount,...(contextDuration?{durationMode:'videoContext',requestedDuration}:{})};
}
function normalizeMotion(raw, settings) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Invalid composition');
  const video=normalizeVideoSettings({...settings,engine:'hyperframes'});
  const {width,height,fps,duration}=video;
  const requestedDuration=video.requestedDuration??settings?.duration??5;
  const contextDuration=video.durationMode==='videoContext';
  const minimumLayerDuration=contextDuration?Math.min(0.5,duration):0.5;
  const latestStart=duration-minimumLayerDuration;
  const fontScale=Math.max(1,Math.min(width/1920,height/1080));
  if (!Array.isArray(raw.elements)||!raw.elements.length||raw.elements.length>32) throw new Error('Invalid elements: expected 1…32 layers');
  const background=raw.background==='transparent'||raw.background===undefined?'transparent':color(raw.background,null,'background color');
  const elements=raw.elements.map((e,i)=>{
    if (!e || !TYPES.has(e.type)) throw new Error(`Invalid elements[${i}].type`);
    const start=number(e.start,Math.min(i*0.1,0.8,latestStart),0,latestStart,'start');
    // Model endpoints use the requested seconds; the final frame determines
    // the effective endpoint, including fractional frame rates such as 29.97.
    const modelEnd=contextDuration&&e.end===requestedDuration?duration:e.end;
    const suppliedEnd=number(modelEnd,contextDuration?duration:requestedDuration,start+minimumLayerDuration,contextDuration?Math.max(requestedDuration,duration):requestedDuration,'end');
    const end=suppliedEnd===requestedDuration?duration:Math.min(suppliedEnd,duration);
    if(end<start+minimumLayerDuration)throw new Error('Invalid end: layer is shorter than the minimum output interval');
    const enter=e.enter ?? 'rise';
    if (!ENTERS.has(enter)) throw new Error('Invalid enter');
    const font=e.font ?? 'Segoe UI';
    if (!FONTS.has(font)) throw new Error('Invalid font');
    const text=e.text ?? '';
    if (typeof text!=='string'||text.length>600) throw new Error('Invalid text');
    const align=e.align ?? 'left';
    if (!['left','center','right'].includes(align)) throw new Error('Invalid align');
    return {type:e.type,text,x:number(e.x,120,0,width,'x'),y:number(e.y,120,0,height,'y'),
      width:number(e.width,width-240,1,width,'width'),height:number(e.height,160,1,height,'height'),
      fontSize:number(e.fontSize,84,14,320*fontScale,'fontSize'),font,align,
      weight:number(e.weight,700,300,900,'weight'),color:color(e.color,'#F5F1E9'),
      opacity:number(e.opacity,1,0,1,'opacity'),radius:number(e.radius,0,0,500,'radius'),
      rotation:number(e.rotation,0,-180,180,'rotation'),start,end,enter};
  });
  return {version:1,name:typeof raw.name==='string'?raw.name.slice(0,120):'Motion',...video,background,elements};
}
function extractPlan(text) {
  const body=String(text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
  try {return JSON.parse(body);} catch {throw new Error('AI response must contain a single JSON object. Попробуйте уточнить команду.');}
}
function buildComposition(p) {
  const layers=p.elements.map((e,i)=>{
    const style=`position:absolute;left:${e.x}px;top:${e.y}px;width:${e.width}px;height:${e.height}px;z-index:${i+1};box-sizing:border-box;${e.type==='text'?`font-family:'${e.font}';font-size:${e.fontSize}px;font-weight:${e.weight};line-height:1.12;text-align:${e.align};color:${e.color};white-space:pre-wrap;overflow-wrap:break-word;`:`background:${e.color};border-radius:${e.type==='circle'?'50%':`${e.radius}px`};`}`;
    return `<div id="layer-${i}" data-start="${e.start}" data-duration="${e.end-e.start}" data-track-index="${i}" data-layout-allow-overflow style="${style}">${e.type==='text'?escapeHtml(e.text):''}</div>`;
  }).join('\n');
  const animation=p.elements.map((e,i)=>{
    const from={autoAlpha:0,rotation:e.rotation};
    if(e.enter==='rise') from.y=65;
    if(e.enter==='slide') from.x=-100;
    if(e.enter==='zoom') from.scale=0.72;
    if(e.enter==='draw') from.scaleX=0;
    const entrance=Math.min(0.65,(e.end-e.start)*0.35);
    const exit=Math.min(0.3,(e.end-e.start)*0.35);
    return `tl.fromTo('#layer-${i}',${JSON.stringify(from)},${JSON.stringify({autoAlpha:e.opacity,x:0,y:0,scale:1,scaleX:1,rotation:e.rotation,duration:entrance,ease:'power3.out',transformOrigin:'left center',immediateRender:true})},${e.start});tl.to('#layer-${i}',{autoAlpha:0,y:-18,duration:${exit},ease:'power2.in'},${e.end-exit});`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(p.name)}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#root{position:relative;overflow:hidden;width:${p.width}px;height:${p.height}px;background:${p.background}}</style></head><body><div id="root" data-composition-id="root" data-start="0" data-duration="${p.duration}" data-width="${p.width}" data-height="${p.height}">${layers}</div><script src="assets/gsap.min.js"></script><script>
const tl=gsap.timeline({paused:true});
${animation}
tl.to({}, {duration:${Math.min(0.001,p.duration)}}, ${Math.max(0,p.duration-0.001)});
window.__timelines=window.__timelines||{};window.__timelines.root=tl;
if(new URLSearchParams(location.search).has('preview')){
const fit=()=>{const s=Math.min(innerWidth/${p.width},innerHeight/${p.height});const r=document.getElementById('root');r.style.transformOrigin='top left';r.style.transform='translate('+((innerWidth-${p.width}*s)/2)+'px,'+((innerHeight-${p.height}*s)/2)+'px) scale('+s+')';};fit();addEventListener('resize',fit);
tl.eventCallback('onComplete',()=>tl.play(0));tl.play(0);
addEventListener('message',e=>{if(e.source!==parent)return;if(e.data==='pause')tl.pause();if(e.data==='play')tl.play();if(e.data==='restart')tl.play(0);});
}
</script></body></html>`;
}
function demoMotion(settings) {
  const video=normalizeVideoSettings({...settings,engine:'hyperframes'});
  const scale=Math.min(video.width/1920,video.height/1080);
  const offsetY=(video.height-1080*scale)/2;
  const elements=[
    {type:'rect',x:160,y:330,width:13,height:300,color:'#F39B59',enter:'draw',start:0.05,end:settings.duration},
    {type:'text',text:'РОСТ ПОКАЗАТЕЛЕЙ',x:215,y:330,width:1400,height:70,fontSize:44,color:'#F39B59',start:0.15,end:settings.duration},
    {type:'text',text:'+35%',x:205,y:405,width:1500,height:220,fontSize:190,color:'#F5F1E9',enter:'rise',start:0.3,end:settings.duration}
  ].map(e=>({...e,end:video.duration,start:Math.min(e.start,Math.max(0,video.duration-0.5)),x:e.x*scale,y:e.y*scale+offsetY,width:e.width*scale,height:e.height*scale,...(e.fontSize?{fontSize:e.fontSize*scale}:{})}));
  return normalizeMotion({name:'Рост +35%',background:'transparent',elements},video);
}
module.exports={normalizeVideoSettings,normalizeMotion,buildComposition,extractPlan,demoMotion,escapeHtml};
