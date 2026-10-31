'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {cleanEnvironment}=require('../lib/process.cjs');
const {runtimeExecutable}=require('../lib/runtime.cjs');
const {ResolveBridge}=require('./bridge.cjs');
const {PARTITION,createPreviewPolicy,installPreviewSessionPolicy,installPreviewNavigationPolicy}=require('./preview-policy.cjs');
const {GENERATION_LIMITS}=require('../lib/generation-runtime.cjs');
module.exports.start=function(runtime,pluginRoot){
  const {app,BrowserWindow,ipcMain,shell,dialog,session}=require('electron');
  const root=runtime.projectRoot;let win,child,bridge,activeGeneration=null;let next=0;const pending=new Map();const importing=new Set();
  const previewPolicy=createPreviewPolicy(root);
  function request(method,params={}){return new Promise((resolve,reject)=>{if(!child||child.exitCode!==null)return reject(new Error('Локальный контроллер не запущен'));const id=++next;const modelRequest=['generate','chat.send'].includes(method);const timer=setTimeout(()=>{pending.delete(id);if(modelRequest)request('cancel').catch(()=>{});reject(new Error('Превышено время выполнения задачи'));},method==='render'?750000:modelRequest?GENERATION_LIMITS.hostMs:60000);pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  function startController(){
    child=spawn(runtimeExecutable('node'),[path.join(root,'lib/controller.cjs')],{cwd:root,env:cleanEnvironment(),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    readline.createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.event){win?.webContents.send('assistant:event',{event:m.event,data:m.data});return;}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else{previewPolicy.registerControllerResult(p.method,m.result);p.resolve(m.result);}}});
    const failed=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Локальный контроллер завершился'));}pending.clear();win?.webContents.send('assistant:event',{event:'fatal',data:{message:'Контроллер остановлен. Закройте и снова откройте плагин.'}});};child.once('error',failed);child.once('exit',failed);
  }
  async function projectContext(){const c=await bridge.context();const storage=await request('workspace.project',{project:c.project});if((storage.workspace.projectId||null)!==(c.project?.id||null))throw new Error('Проект изменился. Обновите сведения о проекте.');return {...c,...storage};}
  const allowed=new Set(['status','context','chooseFolder','signIn','cancelSignIn','signOut','models','demo','generate','chat.send','conversation.create','conversation.get','conversation.update','version.create','version.get','version.update','render','rename','import','cancel','openFolder','usage']);
  ipcMain.handle('assistant:call',async(event,method,params={})=>{
    try{
      if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame||!allowed.has(method)||JSON.stringify(params).length>30000)throw new Error('Операция не разрешена');
      if(method==='cancel'){activeGeneration?.abort.abort();return {ok:true,result:await request('cancel')};}
      if(activeGeneration&&!['context','status'].includes(method))throw new Error('Дождитесь текущей генерации или отмените её');
      if(method==='context'){try{return {ok:true,result:await projectContext()};}catch(e){return {ok:true,result:{connected:false,project:null,error:e.message}};}}
      if(method==='chooseFolder'){
        const before=await projectContext();if(!before.project)throw new Error('Сначала откройте проект Resolve');
        const picked=await dialog.showOpenDialog(win,{title:'Папка проекта — здесь будет создана папка jobs',defaultPath:before.workspace.directory,properties:['openDirectory','createDirectory']});
        if(picked.canceled||!picked.filePaths.length)return {ok:true,result:before};
        const after=await projectContext();if(after.project?.id!==before.project.id)throw new Error('Проект изменился. Повторите выбор папки.');
        await request('workspace.select',{projectId:before.project.id,directory:picked.filePaths[0]});
        return {ok:true,result:await projectContext()};
      }
      if(method==='signIn'){const {url}=await request('auth.begin');const u=new URL(url);if(u.origin!=='https://auth.openai.com'||u.pathname!=='/api/accounts/authorize')throw new Error('Недопустимый адрес входа');await shell.openExternal(url);return {ok:true,result:{waiting:true}};}
      if(method==='cancelSignIn')return {ok:true,result:await request('auth.cancel')};
      if(method==='signOut')return {ok:true,result:await request('auth.signOut')};
      if(method==='models')return {ok:true,result:await request('auth.models')};
      if(method==='usage'){await shell.openExternal('https://chatgpt.com/#settings/Usage');return {ok:true,result:{}};}
      if(method==='openFolder'){const {directory}=await request('workspace.folder',{id:params.id});const failure=await shell.openPath(directory);if(failure)throw new Error('Папка пока недоступна. Сначала создайте композицию или выберите папку проекта.');return {ok:true,result:{}};}
      if(method==='import'){
        if(typeof params.projectId!=='string'||!params.projectId)throw new Error('Откройте проект Resolve и обновите сведения');
        if(importing.has(params.id))throw new Error('Этот результат уже импортируется');importing.add(params.id);
        try{const a=await request('artifact',{id:params.id,compositionId:params.compositionId,versionId:params.versionId});const result=await bridge.importArtifact(a.file,params.projectId,a.imports[params.projectId]);const job=await request('recordImport',{id:params.id,...result});return {ok:true,result:{...result,job}};}finally{importing.delete(params.id);}
      }
      if(method==='generate'||method==='chat.send'){
        const operation={abort:new AbortController(),contextId:null};activeGeneration=operation;
        try{
          const c=await projectContext();if(!c.project)throw new Error('Сначала откройте проект Resolve');
          const forwarded={prompt:params.prompt,settings:params.settings,previousId:params.previousId,model:params.model,effort:params.effort,projectId:c.project.id};
          if(method==='chat.send'){forwarded.conversationId=params.conversationId;forwarded.versionId=params.versionId;}
          if(params.videoContextKey!==undefined){
            const range=c.project.videoContext;
            if(!range||typeof params.videoContextKey!=='string'||params.videoContextKey!==range.key)throw new Error('In/Out или таймлайн изменились. Обновите контекст и повторите генерацию.');
            const capture=await request('videoContext.prepare',{range});operation.contextId=capture.id;
            const evidence=await bridge.captureVideoContext(range,capture.exports,{signal:operation.abort.signal,onStage:stage=>win?.webContents.send('assistant:event',{event:'stage',data:{stage}})});
            const after=await projectContext();
            if(after.project?.videoContext?.key!==range.key)throw new Error('In/Out или таймлайн изменились во время подготовки контекста. Повторите генерацию.');
            forwarded.contextId=capture.id;forwarded.contextTranscript=evidence.transcript||[];forwarded.contextSpeechStatus=evidence.speechStatus||'unavailable';forwarded.contextSpeechSource=evidence.speechSource||null;forwarded.contextSpeechError=evidence.speechError||null;win?.webContents.send('assistant:event',{event:'speech',data:{rangeKey:range.key,...evidence}});
          }
          if(operation.abort.signal.aborted)throw new Error('Генерация отменена');
          return {ok:true,result:await request(method,forwarded)};
        }finally{
          try{if(operation.contextId)await request('videoContext.discard',{id:operation.contextId});}finally{activeGeneration=null;}
        }
      }
      if(method.startsWith('conversation.')||method.startsWith('version.')){const c=await projectContext();if(!c.project)throw new Error('Сначала откройте проект Resolve');return {ok:true,result:await request(method,{...params,projectId:c.project.id})};}
      if(method==='demo'){const c=await projectContext();if(!c.project)throw new Error('Сначала откройте проект Resolve');return {ok:true,result:await request(method,{...params,projectId:c.project.id})};}
      return {ok:true,result:await request(method,params)};
    }catch(e){return {ok:false,error:e.message};}
  });
  app.whenReady().then(()=>{
    bridge=new ResolveBridge(require(path.join(pluginRoot,'WorkflowIntegration.node')),'com.local.resolveassistant');
    const previewSession=session.fromPartition(PARTITION);
    installPreviewSessionPolicy(previewSession,previewPolicy);
    win=new BrowserWindow({width:1380,height:900,minWidth:920,minHeight:640,title:'Resolve Assistant',backgroundColor:'#15171B',autoHideMenuBar:true,webPreferences:{session:previewSession,preload:path.join(root,'plugin/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    installPreviewNavigationPolicy(win.webContents,previewPolicy);
    startController();win.loadFile(path.join(root,'plugin/index.html'));
    win.on('closed',()=>{win=null;app.quit();});
    if(runtime.diagnostics){const file=path.join(root,'.data/host-diagnostics.json');const report=()=>fs.writeFileSync(file,JSON.stringify({startedAt:new Date().toISOString(),electron:process.versions.electron,node:process.versions.node},null,2));report();}
  });
  app.on('before-quit',()=>{activeGeneration?.abort.abort();bridge?.close();if(child){child.stdin.end();setTimeout(()=>child?.kill(),2000).unref();}});
  app.on('window-all-closed',()=>app.quit());
};
