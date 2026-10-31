'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const PARTITION='persist:resolve-assistant-preview-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB_RESPONSES=new Set(['demo','generate','render','rename','job','recordImport']);
const LIST_RESPONSES=new Set(['status','workspace.project','workspace.select']);
function createPreviewPolicy(projectRoot){
  const files=new Map([['index.html','mainFrame'],['renderer.js','script'],['styles.css','stylesheet']].map(([name,type])=>[pathToFileURL(path.join(projectRoot,'plugin',name)).href,type]));
  const documents=new Set(),scripts=new Set();let serverPrefix=null;
  function registerJob(job){
    if(!job||typeof job.id!=='string'||!UUID.test(job.id)||typeof job.previewUrl!=='string')return;
    let url;try{url=new URL(job.previewUrl);}catch{return;}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.hash||url.search!=='?preview=1')return;
    const match=url.pathname.match(/^\/([0-9a-f]{48})\/([0-9a-f-]{36})\/index\.html$/);
    if(!match||match[2]!==job.id||url.href!==job.previewUrl)return;
    const prefix=url.origin+'/'+match[1]+'/';if(serverPrefix&&serverPrefix!==prefix)return;serverPrefix=prefix;
    documents.add(url.href);
    for(const asset of ['remotion.js','gsap.min.js'])scripts.add(prefix+job.id+'/assets/'+asset);
  }
  return {
    // Call only on parsed, correlated controller responses, never IPC parameters/events/source.
    registerControllerResult(method,result){
      if(JOB_RESPONSES.has(method))registerJob(result);
      if(method==='chat.send')registerJob(result?.job);
      if(LIST_RESPONSES.has(method)&&Array.isArray(result?.jobs))for(const job of result.jobs)registerJob(job);
    },
    allowsRequest({url,method,resourceType}){
      if(method!=='GET')return false;
      if(files.has(url)&&files.get(url)===resourceType)return true;
      return resourceType==='subFrame'?documents.has(url):resourceType==='script'&&scripts.has(url);
    },
    allowsNavigation({url,isMainFrame}){return isMainFrame===false&&documents.has(url);},
    allowsResponse({statusCode}){return !(statusCode>=300&&statusCode<400);}
  };
}
function installPreviewSessionPolicy(session,policy){
  session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!policy.allowsRequest(details)}));
  session.webRequest.onHeadersReceived((details,callback)=>callback({cancel:!policy.allowsResponse(details)}));
}
function installPreviewNavigationPolicy(webContents,policy){
  webContents.setWindowOpenHandler(()=>({action:'deny'}));
  webContents.on('will-navigate',event=>event.preventDefault());
  webContents.on('will-frame-navigate',event=>{if(!policy.allowsNavigation(event))event.preventDefault();});
  webContents.on('will-redirect',event=>event.preventDefault());
}
module.exports={PARTITION,createPreviewPolicy,installPreviewSessionPolicy,installPreviewNavigationPolicy};
