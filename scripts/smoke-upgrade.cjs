'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {demoMotion}=require('../lib/motion.cjs');
const {demoRemotion}=require('../lib/remotion.cjs');
const {prepareComposition,renderMotion,FFMPEG,renderEnvironment}=require('../lib/render.cjs');
const {run}=require('../lib/process.cjs');
(async()=>{
  const [engine='remotion',width='640',height='360',fps='24',duration='2']=process.argv.slice(2);
  if(!['hyperframes','remotion'].includes(engine))throw new Error('Unknown engine');
  const settings={engine,width:Number(width),height:Number(height),fps:Number(fps),duration:Number(duration)};
  const plan=engine==='remotion'?demoRemotion(settings):demoMotion(settings);
  const dir=path.resolve('workspace/verification',`${engine}-${plan.width}x${plan.height}-${plan.fps}`);await fs.mkdir(dir,{recursive:true});
  await prepareComposition(dir,plan);const output=await renderMotion(dir,plan,{onStage:console.log});
  const rgba=await run(FFMPEG,['-v','error','-ss',String(plan.duration/2),'-i',output.file,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{env:renderEnvironment(),binary:true,maxBytes:plan.width*plan.height*4+4096});
  if(rgba.length!==plan.width*plan.height*4)throw new Error('Unexpected decoded frame size');
  let transparentPixels=0,visiblePixels=0,partialPixels=0;
  for(let i=3;i<rgba.length;i+=4){if(rgba[i]===0)transparentPixels++;else if(rgba[i]>=250)visiblePixels++;else partialPixels++;}
  if(!transparentPixels||!visiblePixels)throw new Error('Alpha check failed: need visible and transparent pixels');
  await run(FFMPEG,['-v','error','-ss',String(plan.duration/2),'-i',output.file,'-frames:v','1','-y',path.join(dir,'frame.png')],{env:renderEnvironment()});
  const report={engine,...output,frameCount:plan.frameCount,transparentPixels,visiblePixels,partialPixels,verifiedAt:new Date().toISOString()};
  await fs.writeFile(path.join(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
