'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {demoMotion}=require('../lib/motion.cjs');
const {prepareComposition,renderMotion,FFMPEG,renderEnvironment}=require('../lib/render.cjs');
const {run}=require('../lib/process.cjs');
(async()=>{
  const dir=path.resolve('workspace/smoke');await fs.mkdir(dir,{recursive:true});
  const p=demoMotion({width:1920,height:1080,fps:30,duration:2});
  await prepareComposition(dir,p);
  const output=await renderMotion(dir,p,{onStage:console.log});
  const rgba=await run(FFMPEG,['-v','error','-ss','1','-i',output.file,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{env:renderEnvironment(),binary:true});
  let transparent=0,visible=0;for(let i=3;i<rgba.length;i+=4){if(rgba[i]===0)transparent++;if(rgba[i]>220)visible++;}
  if(!transparent||!visible)throw new Error('Альфа-проверка провалена: кадр должен содержать прозрачные и видимые пиксели');
  await run(FFMPEG,['-v','error','-ss','1','-i',output.file,'-frames:v','1','-y',path.join(dir,'frame.png')],{env:renderEnvironment()});
  const report={...output,transparentPixels:transparent,visiblePixels:visible,checkedAt:new Date().toISOString()};
  await fs.writeFile(path.join(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
