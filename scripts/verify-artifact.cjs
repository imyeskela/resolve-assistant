'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {run}=require('../lib/process.cjs');
const {FFMPEG,renderEnvironment}=require('../lib/render.cjs');
const {WorkspaceStore}=require('../lib/workspaces.cjs');
(async()=>{
  const id=process.argv[2];
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id||''))throw new Error('Expected artifact UUID');
  const workspaces=await new WorkspaceStore(path.resolve(__dirname,'..')).init();
  let dir;
  for(const root of workspaces.allDirectories()){const candidate=path.join(root,id);try{await fs.access(path.join(candidate,'job.json'));dir=candidate;break;}catch{}}
  if(!dir)throw new Error('Artifact not found in registered project folders');
  const job=JSON.parse(await fs.readFile(path.join(dir,'job.json'),'utf8'));
  if(!job.output)throw new Error('MOV has not been rendered');
  const file=path.join(dir,'motion.mov');
  const time=String(job.plan.duration/2);
  const env=renderEnvironment();
  const rgba=await run(FFMPEG,['-v','error','-ss',time,'-i',file,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{env,binary:true});
  if(rgba.length!==job.plan.width*job.plan.height*4)throw new Error('Unexpected decoded frame size');
  let transparentPixels=0,visiblePixels=0,partialPixels=0;
  for(let i=3;i<rgba.length;i+=4){if(rgba[i]===0)transparentPixels++;else if(rgba[i]>=250)visiblePixels++;else partialPixels++;}
  if(!transparentPixels||!visiblePixels)throw new Error('Expected both transparent and visible pixels');
  await run(FFMPEG,['-v','error','-ss',time,'-i',file,'-frames:v','1','-y',path.join(dir,'verified-frame.png')],{env});
  const report={...job.output,transparentPixels,visiblePixels,partialPixels,sampleSecond:Number(time),verifiedAt:new Date().toISOString()};
  await fs.writeFile(path.join(dir,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
