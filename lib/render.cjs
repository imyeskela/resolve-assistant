'use strict';
const {runtimeExecutable}=require('./runtime.cjs');
const {fpsArgument}=require('./frame-rate.cjs');
const path=require('node:path');
const fs=require('node:fs/promises');
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {run,cleanEnvironment}=require('./process.cjs');
const {buildComposition}=require('./motion.cjs');
const {atomicWrite}=require('./storage.cjs');
const {browserExecutable}=require('./browser.cjs');
const {ISOLATION_HASH,inlineScriptHashes,isolatedDocument}=require('./browser-isolation.cjs');
const {createPreviewCache}=require('./preview-cache.cjs');
const {normalizeScenePlan,renderTrustedScene}=require('./trusted-scene.cjs');
const ROOT=path.resolve(__dirname,'..');
const CLI=path.join(ROOT,'node_modules/hyperframes/bin/hyperframes.mjs');
const FFMPEG=runtimeExecutable('ffmpeg');
const FFPROBE=runtimeExecutable('ffprobe');
function renderEnvironment(){
  const browser=browserExecutable();
  // Disable HyperFrames' detached warm-check daemon for isolated job checks.
  // On Windows it retains the job cwd and prevents temporary jobs being removed.
  return cleanEnvironment({CI:'1',HYPERFRAMES_FFMPEG_PATH:runtimeExecutable('ffmpeg'),HYPERFRAMES_FFPROBE_PATH:runtimeExecutable('ffprobe'),HYPERFRAMES_BROWSER_PATH:browser});
}
async function prepareComposition(jobDir,plan){
  if(plan.engine==='remotion')return require('./remotion.cjs').prepareRemotionComposition(jobDir,plan);
  if(plan.engine&&plan.engine!=='hyperframes')throw new Error('Неизвестный движок композиции');
  await fs.mkdir(path.join(jobDir,'assets'),{recursive:true});
  await fs.copyFile(path.join(ROOT,'node_modules/gsap/dist/gsap.min.js'),path.join(jobDir,'assets/gsap.min.js'));
  await atomicWrite(path.join(jobDir,'index.html'),buildComposition(plan));
}
async function renderMotion(jobDir,plan,{signal,onStage=()=>{}}={}){
  plan=normalizeScenePlan(plan);
  if(plan.engine==='remotion')return require('./remotion.cjs').renderRemotion(jobDir,plan,{signal,onStage});
  return renderTrustedScene(jobDir,plan,{signal,prepare:prepareComposition,render:(directory,validated)=>renderPreparedMotion(directory,validated,{signal,onStage})});
}
async function renderPreparedMotion(jobDir,plan,{signal,onStage}){
  const env=renderEnvironment();
  await fs.access(FFMPEG);await fs.access(FFPROBE);
  onStage('Проверка композиции');
  await run(runtimeExecutable('node'),[CLI,'lint',jobDir,'--json'],{cwd:jobDir,env,signal,timeout:60000});
  onStage('Проверка расположения элементов');
  await run(runtimeExecutable('node'),[CLI,'check',jobDir,'--json','--at',String(Math.min(plan.duration/2,1.5)),'--no-contrast'],{cwd:jobDir,env,signal,timeout:120000});
  onStage('Рендер прозрачного MOV');
  const temp=path.join(jobDir,'render.partial.mov');
  await run(runtimeExecutable('node'),[CLI,'render',jobDir,'--format','mov','--fps',fpsArgument(plan.fps),'--prores-profile','4444','--workers','2','--output',temp],{cwd:jobDir,env,signal,timeout:600000,maxBytes:4*1024*1024});
  onStage('Проверка готового файла');
  const info=JSON.parse(await run(runtimeExecutable('ffprobe'),['-v','error','-show_streams','-show_format','-of','json',temp],{env,signal,timeout:30000}));
  const stream=info.streams.find(s=>s.codec_type==='video');
  const [num,den]=String(stream?.avg_frame_rate||'0/1').split('/').map(Number);
  if(!stream||stream.codec_name!=='prores'||!String(stream.pix_fmt).includes('a')||stream.width!==plan.width||stream.height!==plan.height||Math.abs(num/den-plan.fps)>0.001||Math.abs(Number(info.format.duration)-plan.duration)>1/plan.fps+0.01)throw new Error('Готовый MOV не соответствует размерам, длительности, FPS или альфа-формату');
  const output=path.join(jobDir,'motion.mov');await fs.rename(temp,output);
  return {file:output,bytes:(await fs.stat(output)).size,width:stream.width,height:stream.height,fps:plan.fps,duration:Number(info.format.duration),codec:stream.codec_name,pixelFormat:stream.pix_fmt,
    ...(plan.durationMode==='videoContext'?{durationMode:plan.durationMode,requestedDuration:plan.requestedDuration,frameCount:plan.frameCount}:{})};
}
async function startPreviewServer(getJob){
  const token=randomBytes(24).toString('hex');
  const cache=await createPreviewCache({build:prepareComposition});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
    const url=new URL(req.url,'http://127.0.0.1');
    const match=url.pathname.match(new RegExp('^/'+token+'/([0-9a-f-]{36})/(index\\.html|assets/gsap\\.min\\.js|assets/remotion\\.js)$'));
    if(!match){res.writeHead(404);res.end();return;}
    try{
      const job=await getJob(match[1]);if(!job){res.writeHead(404);res.end();return;}
      const content=await cache.read(job,match[2]);
      const hashes=ISOLATION_HASH+' '+(match[2]==='index.html'?inlineScriptHashes(content.toString('utf8')):'');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src "+hashes+" http://127.0.0.1:"+server.address().port+"; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
      res.setHeader('Content-Type',match[2]==='index.html'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');
      res.end(match[2]==='index.html'?isolatedDocument(content.toString('utf8')):content);
    }catch{res.writeHead(404);res.end();}
  });
  const closed=new Promise((resolve,reject)=>server.once('close',()=>cache.close().then(resolve,reject)));
  closed.catch(()=>{});
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){await cache.close();throw error;}
  return {server,closed,url:id=>`http://127.0.0.1:${server.address().port}/${token}/${id}/index.html?preview=1`};
}
module.exports={prepareComposition,renderMotion,startPreviewServer,renderEnvironment,FFMPEG,FFPROBE};
