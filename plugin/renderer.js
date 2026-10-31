'use strict';
const $=id=>document.getElementById(id);
const api=window.assistant;
let jobs=[],conversations=[],conversation=null,current=null,context=null,workspace=null,workspaceKey=null,contextSequence=0,chatSequence=0,auth={},busy=false,models=[];
let manualSize=false,manualFps=false,videoContextEnabled=true,videoContextProject=null;
let manualDurationSeconds=5,speechEvidence=null;
let saveTimer=null,draftWrites=Promise.resolve();
const drafts=new Map();
const PREFERENCES_KEY='resolve-assistant.preferences.v1';
let preferences={};
try{preferences=JSON.parse(localStorage.getItem(PREFERENCES_KEY)||'{}')||{};}catch{}
if(typeof preferences!=='object'||Array.isArray(preferences))preferences={};
const engineName=value=>value==='remotion'?'Remotion':'HyperFrames';
const jobEngine=j=>j.plan.engine==='remotion'?'remotion':'hyperframes';
const draftKey=(id,versionId=conversation?.selectedVersionId)=>`${context?.project?.id||''}:${id||'new'}:${versionId||''}`;
function savePreferences(){try{localStorage.setItem(PREFERENCES_KEY,JSON.stringify(preferences));}catch{}}
function error(e){$('error').textContent=e.message||String(e);$('error').hidden=false;}
function clearError(){$('error').hidden=true;}
function settings(){const [baseWidth,baseHeight]=$('size').value.split('x').map(Number);const [width,height]=$('vertical').checked&&baseWidth!==baseHeight?[baseHeight,baseWidth]:[baseWidth,baseHeight];return {width,height,fps:Number($('fps').value),duration:videoContextEnabled&&context?.project?.videoContext?context.project.videoContext.duration:manualDurationSeconds,engine:$('engine').value};}
function exactOption(id,value,label){const el=$(id);value=String(value);if(!Array.from(el.options).some(o=>o.value===value)){const option=new Option(label,value);option.dataset.custom='true';el.append(option);}el.value=value;}
function setResolution(width,height){const baseWidth=Math.max(width,height),baseHeight=Math.min(width,height);exactOption('size',`${baseWidth}x${baseHeight}`,`Другое · ${baseWidth} × ${baseHeight}`);$('vertical').checked=width<height;}
function setFields(s){if(!s)return;setResolution(s.width,s.height);exactOption('fps',s.fps,`${s.fps}`);$('engine').value=s.engine==='remotion'?'remotion':'hyperframes';updateDuration();}
function updateDuration(){
 const range=videoContextEnabled&&context?.project?.videoContext,locked=!!range,input=$('duration');input.disabled=busy||locked;input.value=locked?Number(range.duration).toFixed(1):manualDurationSeconds;
 const text=locked?`Длительность определяется видеоконтекстом: ${Number(range.duration).toFixed(1)} с. Чтобы изменить её, измените In/Out в DaVinci. Отключите видеоконтекст — поле длительности станет доступно.`:'Длительность можно изменить вручную. Включите видеоконтекст — длительность будет взята из In/Out и заблокирована.';
 $('duration-note').textContent=text;$('duration-help').setAttribute('aria-label',text);$('duration-help').classList.toggle('locked',locked);
}
function activeVersion(){return conversation?.versions?.find(v=>v.id===conversation.selectedVersionId);}
function showSpeech(){
 const range=context?.project?.videoContext,latest=conversation?.contextSnapshots?.at(-1);const evidence=speechEvidence?.rangeKey&&speechEvidence.rangeKey===range?.key?speechEvidence:latest?.range?.key&&latest.range.key===range?.key?latest:null;const saved=evidence||latest;
 const text=!videoContextEnabled?'Видеоконтекст отключён. Длительность доступна вручную.':evidence?.speechStatus==='ready'?`Речь из DaVinci · ${evidence.transcript?.length||0} фрагментов${evidence.speechError?' · Часть речи недоступна: '+evidence.speechError:''}`:evidence?.speechStatus==='no-speech'?'В выбранном диапазоне речь не найдена':evidence?.speechStatus==='unavailable'?`Речь недоступна: ${evidence.speechError||'SDK не вернул текст'}. Отправляются только кадры`:'Речь будет получена из DaVinci при отправке';
 $('speech-status').textContent=text;$('show-speech').hidden=!saved?.transcript?.length;$('show-speech').textContent=evidence?'Показать текст речи':'Показать сохранённый текст речи';$('show-speech').dataset.saved=String(!evidence);return saved;
}
function snapshotDraft(){const value={draft:$('prompt').value,settings:settings(),videoContextEnabled,manualSize,manualFps,manualDurationSeconds};drafts.set(draftKey(conversation?.id),value);return value;}
function queueDraftSave(){snapshotDraft();clearTimeout(saveTimer);if(conversation&&!busy)saveTimer=setTimeout(()=>flushDraft().catch(error),250);}
async function flushDraft(){
  clearTimeout(saveTimer);saveTimer=null;
  const value=snapshotDraft(),id=conversation?.id,key=workspaceKey;
  if(!id)return draftWrites.catch(()=>{});
  const params={id,versionId:conversation.selectedVersionId,manualDurationSeconds:value.manualDurationSeconds,draft:value.draft,settings:value.settings,videoContextEnabled:value.videoContextEnabled,manualSize:value.manualSize,manualFps:value.manualFps,selectedJobId:activeVersion()?.selectedRevisionId||null};
  draftWrites=draftWrites.catch(()=>{}).then(()=>api.call('conversation.update',params));
  try{await draftWrites;}catch(e){if(workspaceKey===key)throw e;}
}
function videoSettings(){const video=context?.project?.video;return video&&Number(video.width)>0&&Number(video.height)>0&&Number(video.fps)>0?video:null;}
function updateResolutionControls(){const [w,h]=$('size').value.split('x').map(Number),square=w===h;if(square)$('vertical').checked=false;$('vertical').disabled=busy||square;const {width,height}=settings();let a=width,b=height;while(b){const r=a%b;a=b;b=r;}$('aspect-ratio').textContent=`${width/a}:${height/a}`;}
function updateVideoContext(){
  const range=context?.project?.videoContext,card=$('video-context-card');card.hidden=!range;updateDuration();showSpeech();
  $('video-context-enabled').checked=videoContextEnabled;$('video-context-enabled').disabled=busy;card.classList.toggle('off',!videoContextEnabled);
  if(range){$('video-context-title').textContent=videoContextEnabled?`Видеоконтекст · ${range.timelineName}`:`Видеоконтекст отключён · ${range.timelineName}`;$('video-context-time').textContent=`${range.inTimecode} → ${range.outTimecode} · ${Number(range.duration.toFixed(3))} с`;card.title=videoContextEnabled?'Убрать видеоконтекст. Длительность снова можно будет изменить вручную.':'Включить видеоконтекст. Длительность будет взята из In/Out и заблокирована.';}
}
function updateVideoSource(){
  const video=videoSettings();$('inherit-video').disabled=busy||!video;
  const changed=current&&['width','height','fps','duration','engine'].some(key=>{const s=settings();return key==='engine'?s[key]!==jobEngine(current):Math.abs(s[key]-current.plan[key])>.001;});
  $('video-source').textContent=current?(changed?'Для следующего изменения':`Параметры v${versionNumber(current.id)}`):video?(manualSize&&manualFps?'Вручную':manualSize||manualFps?'Из Resolve · с изменениями':'Из Resolve'):'Вручную · настройки недоступны';
  $('video-source').title=video?`${video.source==='timeline'?'Таймлайн':'Проект'}${video.timelineName?' «'+video.timelineName+'»':''} · ${video.width} × ${video.height} · ${video.fps} fps`:'Resolve не передал видеонастройки';
}
function updatePreview(){
  updateResolutionControls();const {width,height,fps,duration}=current?.plan||settings();
  $('canvas').style.aspectRatio=`${width} / ${height}`;$('canvas').style.width=`min(100%, ${width/height*100}cqh)`;
  const alpha=current?.plan.engine==='remotion'?'MOV ProRes 4444':current?.plan.background==='transparent'?'Альфа':current?.plan.background?'Цветной фон':'MOV ProRes 4444';
  $('clip-info').textContent=`${width} × ${height} · ${fps} fps · ${Number(Number(duration).toFixed(3))} с${current?' · '+engineName(jobEngine(current))+' · '+alpha:''}`;
  $('engine-status').textContent=engineName($('engine').value)+(current&&jobEngine(current)!==$('engine').value?' · следующее изменение':'');updateVideoSource();
}
function inheritVideo(force=false){const video=videoSettings();if(video){if(force||!manualSize)setResolution(video.width,video.height);if(force||!manualFps)exactOption('fps',video.fps,`${video.fps}`);}if(force){manualSize=false;manualFps=false;}updatePreview();}
function controls(){
  const storageReady=!!context?.project&&!!workspace&&!workspace.needsSelection;
  $('generate').disabled=busy||!auth.connected||!storageReady;$('demo').disabled=busy||!storageReady;$('choose-folder').disabled=busy||!context?.project;
  $('render').disabled=busy||!current||!!current.output||!activeVersion()?.selectedRevisionId;$('import').disabled=busy||!current?.output||!context?.project||!activeVersion()?.selectedRevisionId;$('add-version').disabled=busy||!conversation;
  $('cancel').hidden=!busy;$('sign-in').disabled=busy||auth.waiting;
  for(const id of ['size','duration','fps','engine','prompt','new','refresh','rename','rename-name','rename-save','rename-cancel','sign-out','latest-version'])$(id).disabled=busy;
  $('model').disabled=busy||!auth.connected||!models.length;$('effort').disabled=busy||!auth.connected||!supportedEfforts().length;
  for(const el of document.querySelectorAll('#jobs button,#versions button,#messages button'))el.disabled=busy;
  for(const action of ['play','pause','restart'])$(action).disabled=!current;
  updateResolutionControls();updateVideoSource();updateVideoContext();document.querySelector('.task-status').classList.toggle('busy',busy);
}
async function task(fn){if(busy)return;busy=true;clearError();controls();try{return await fn();}catch(e){error(e);$('stage').textContent='Задача остановлена';}finally{busy=false;controls();}}
function versionNumber(id){return conversation?.versions?.find(v=>v.id===id||v.revisionIds?.includes(id))?.number||activeVersion()?.number||1;}
function drawJobs(){
 const el=$('jobs');el.replaceChildren();for(const c of conversations){const b=document.createElement('button');b.className='job'+(c.id===conversation?.id?' active':'');b.title=c.name;b.setAttribute('aria-pressed',String(c.id===conversation?.id));b.disabled=busy;const name=document.createElement('strong');name.textContent=c.name;const sub=document.createElement('small'),count=c.versions?.length||1;sub.textContent=`${count} ${count===1?'версия':count<5?'версии':'версий'}`;b.append(name,sub);b.onclick=()=>task(()=>openConversation(c.id));el.append(b);}
}
function drawVersions(){
 const versions=conversation?.versions||[],el=$('versions');el.replaceChildren();$('version-count').textContent=versions.length;$('version-selected').textContent=activeVersion()?`Выбрана V${activeVersion().number}`:'Пока нет версий';
 for(const v of versions){const j=jobs.find(j=>j.id===(v.selectedRevisionId||v.baseRevisionId));const b=document.createElement('button');b.className='version'+(v.id===conversation.selectedVersionId?' active':'');b.dataset.versionId=v.id;if(j)b.dataset.jobId=j.id;b.setAttribute('aria-pressed',String(v.id===conversation.selectedVersionId));b.disabled=busy;const title=document.createElement('strong');title.textContent=`V${v.number}`;const label=document.createElement('span');label.className='version-title';label.textContent=v.selectedRevisionId?j?.prompt||j?.name||'Результат':v.parentVersionId?`Основа V${versionNumber(v.parentVersionId)}`:'Черновик';const sub=document.createElement('small');sub.textContent=j?`${engineName(jobEngine(j))} · ${Number(j.plan.duration.toFixed(3))} с`:'Свой чат';b.append(title,label,sub);b.onclick=()=>task(()=>openVersion(v.id));el.append(b);}
 const v=activeVersion();$('chat-title').textContent=v?`Чат V${v.number}`:'Чат V1';$('revision').hidden=!v?.parentVersionId;$('revision').textContent=v?.parentVersionId?`Основа: V${versionNumber(v.parentVersionId)}`:'';$('latest-version').hidden=!v||v.id===versions.at(-1)?.id;
}
function drawMessages(scroll=true){
  const el=$('messages'),old=el.scrollTop;el.replaceChildren();const messages=conversation?.messages||[];$('legacy-binding').hidden=!conversation||!!conversation.projectId;$('message-count').textContent=`${messages.length} сообщений`;
  if(conversation?.legacyHistory?.length){const note=document.createElement('details');const summary=document.createElement('summary');summary.textContent='История до обновления';const text=document.createElement('p');text.textContent=conversation.legacyHistory.map(m=>`${m.role==='user'?'Вы':'Ассистент'}: ${m.text}`).join('\n\n');note.append(summary,text);el.append(note);}
  if(!messages.length){const box=document.createElement('div');box.className='chat-empty';const title=document.createElement('h2');title.textContent='Что создадим?';const text=document.createElement('p');text.textContent='Опишите идею или задайте вопрос. Здесь можно обсудить и доработать композицию.';box.append(title,text);el.append(box);}
  for(const m of messages){const box=document.createElement('article');box.className=`message ${m.role} ${m.status||''}`;const author=document.createElement('div');author.className='message-author';author.textContent=m.role==='user'?'Вы':m.legacy?'Сохранённая композиция':'Ассистент';const text=document.createElement('p');text.textContent=m.text;box.append(author,text);
    if(m.versionId){const j=jobs.find(j=>j.id===m.versionId);if(j){const button=document.createElement('button');button.className='message-version'+(j.id===current?.id?' active':'');button.textContent=`v${versionNumber(j.id)} · ${j.name}`;const state=document.createElement('span');state.textContent=j.id===current?.id?'Открыта':'Открыть';button.append(state);button.disabled=busy;button.onclick=()=>{const owner=conversation.versions.find(v=>v.revisionIds.includes(j.id));if(owner&&!busy)task(()=>openVersion(owner.id,j.id));};box.append(button);}}
    if(m.status==='pending'){const state=document.createElement('div');state.className='message-state';state.textContent='Ассистент готовит ответ…';box.append(state);}
    if(['failed','cancelled','interrupted'].includes(m.status)){const state=document.createElement('div');state.className='message-state';state.textContent=m.status==='cancelled'?'Отменено':m.status==='interrupted'?'Ответ был прерван':m.error||'Не удалось получить ответ';const retry=document.createElement('button');retry.className='text-button';retry.textContent='Повторить сообщение';retry.disabled=busy;retry.onclick=()=>{$('prompt').value=m.text;queueDraftSave();$('prompt').focus();};box.append(state,retry);}
    el.append(box);
  }
  if(scroll)requestAnimationFrame(()=>{el.scrollTop=el.scrollHeight;});else el.scrollTop=old;
}
function closeRename(){$('rename-form').hidden=true;$('rename').hidden=!conversation&&!current;}
function showVersion(j){
  current=j||null;closeRename();$('preview').hidden=!j;$('empty').hidden=!!j;
  if(j){if($('preview').getAttribute('src')!==j.previewUrl)$('preview').src=j.previewUrl;$('result-info').textContent=activeVersion()&&!activeVersion().selectedRevisionId?`Основа V${versionNumber(activeVersion().parentVersionId)} — V${activeVersion().number} ещё не изменена`:j.output?`MOV готов · ${(j.output.bytes/1024/1024).toFixed(1)} МБ`:'Версия готова к рендеру';}
  else{$('preview').removeAttribute('src');$('result-info').textContent='';}
  $('composition-name').textContent=conversation?.name||j?.name||'Новая композиция';updatePreview();drawVersions();drawJobs();controls();
}
function restoreConversation(doc){
 conversation=doc;speechEvidence=null;const local=drafts.get(draftKey(doc.id,doc.selectedVersionId)),draft=local||doc;
 $('prompt').value=draft.draft||'';videoContextEnabled=draft.videoContextEnabled!==false;manualSize=draft.manualSize??!!draft.settings;manualFps=draft.manualFps??!!draft.settings;manualDurationSeconds=draft.manualDurationSeconds??((draft.settings?.durationMode==='videoContext'?5:draft.settings?.duration)||5);
 const job=jobs.find(j=>j.id===doc.selectedJobId)||null;setFields(draft.settings||job?.plan);showVersion(job);drawMessages();showSpeech();
}
async function openVersion(versionId,revisionId){await flushDraft();const id=conversation.id,key=workspaceKey,sequence=++chatSequence;const doc=await api.call('version.update',{compositionId:id,versionId,selectedVersionId:versionId,...(revisionId?{selectedJobId:revisionId}:{})});if(sequence!==chatSequence||key!==workspaceKey)return;restoreConversation(doc);}
async function openConversation(id,{save=true}={}){
 if(save)await flushDraft();const sequence=++chatSequence,key=workspaceKey,doc=await api.call('conversation.get',{id});if(sequence!==chatSequence||key!==workspaceKey)return;restoreConversation(doc);preferences.selection??={};if(context?.project?.id){preferences.selection[context.project.id]=id;savePreferences();}
}
function upsert(j){jobs=[j,...jobs.filter(x=>x.id!==j.id)];if(conversation?.jobIds?.includes(j.id)){showVersion(j);drawMessages(false);}else{conversation=null;showVersion(j);}}
function resetComposition({clearPrompt=true}={}){
  ++chatSequence;conversation=null;current=null;if(clearPrompt){videoContextEnabled=true;$('prompt').value='';}
  manualSize=false;manualFps=false;manualDurationSeconds=5;speechEvidence=null;setResolution(1920,1080);$('fps').value='30';$('duration').value='5';$('engine').value=preferences.engine==='hyperframes'?'hyperframes':'remotion';inheritVideo();showVersion(null);drawMessages();
}
async function createConversation(){const d=await api.call('conversation.create',{settings:{...settings(),duration:manualDurationSeconds}});conversation=d;conversations=[d,...conversations.filter(c=>c.id!==d.id)];await flushDraft();showVersion(null);drawMessages();return d;}
async function applyContext(c){
  const key=JSON.stringify([c.project?.id,c.workspace?.jobsDir]),changed=key!==workspaceKey,first=workspaceKey===null;
  if(changed&&!first){snapshotDraft();++chatSequence;clearTimeout(saveTimer);}
  if(c.connected&&c.project?.id&&c.project.id!==videoContextProject){videoContextProject=c.project.id;videoContextEnabled=true;}
  context=c;workspace=c.workspace||null;workspaceKey=key;const p=c.project;
  $('resolve-status').textContent=p?p.name:(c.connected?'Resolve подключён · проект не открыт':'Resolve не подключён');$('resolve-status').className=c.connected?'connected':'';$('resolve-status').title=c.error||c.version||'';
  $('destination').textContent=p?`Проект «${p.name}» → AI Assistant / Motion`:'Откройте проект Resolve для импорта.';
  $('storage-path').textContent=!p?'Откройте проект Resolve.':workspace?.needsSelection?'Выберите папку проекта — в ней появится jobs.':workspace?.jobsDir||'Папка недоступна';$('storage-path').title=workspace?.jobsDir||'';$('choose-folder').textContent=workspace?.needsSelection?'Выбрать папку проекта…':'Изменить папку…';
  if(Array.isArray(c.jobs))jobs=c.jobs;if(Array.isArray(c.conversations))conversations=c.conversations;
  if(conversation&&!conversations.some(d=>d.id===conversation.id)){resetComposition({clearPrompt:true});}
  else if(conversation){const summary=conversations.find(d=>d.id===conversation.id);conversation.name=summary.name;if(current)current=jobs.find(j=>j.id===current.id)||null;$('composition-name').textContent=conversation.name;}
  if((first||changed)&&!conversation&&conversations.length&&p){const preferred=preferences.selection?.[p.id];await openConversation(conversations.some(d=>d.id===preferred)?preferred:conversations[0].id,{save:false});}
  if(!current)inheritVideo();drawJobs();drawVersions();
  if(c.storageWarnings?.length)error(new Error(c.storageWarnings.join('\n')));
  if(c.error)error(new Error('Подключение к Resolve: '+c.error));controls();
}
async function refreshContext(){const sequence=++contextSequence;const c=await api.call('context');if(sequence===contextSequence)await applyContext(c);}
function supportedEfforts(){const model=models.find(m=>m.id===$('model').value);return Array.isArray(model?.reasoningEfforts)?model.reasoningEfforts.filter(e=>typeof e==='string'&&e):[];}
function showEfforts(preferred){const model=models.find(m=>m.id===$('model').value),supported=supportedEfforts(),el=$('effort');el.replaceChildren();for(const effort of supported)el.append(new Option(effort,effort));if(!supported.length)el.append(new Option('Недоступен для модели',''));else el.value=supported.includes(preferred)?preferred:supported.includes(model.defaultReasoningEffort)?model.defaultReasoningEffort:supported[0];controls();}
async function refreshModels(){if(!auth.connected)return;try{const catalog=await api.call('models'),previous=$('model').value,effort=$('effort').value;models=Array.isArray(catalog)?catalog:[];const el=$('model');el.replaceChildren();for(const m of models)el.append(new Option(m.name,m.id));if(models.some(m=>m.id===previous))el.value=previous;else if(models.some(m=>m.id===preferences.model))el.value=preferences.model;if(!models.length)el.append(new Option('Нет доступных моделей',''));showEfforts(effort||preferences.effort);}catch(e){error(e);}}
function showAuth(a){auth=a;$('account-status').textContent=a.waiting?'Ожидание входа в браузере…':a.connected?a.email||'Подписка подключена':'Аккаунт не подключён';$('sign-in').hidden=a.connected;$('sign-out').hidden=!a.connected;$('cancel-auth').hidden=!a.waiting;$('ai-route').textContent=a.connected?'Подписка ChatGPT':'Подключите ChatGPT';controls();}
async function refresh(){const s=await api.call('status');jobs=s.jobs||[];conversations=s.conversations||[];showAuth(s.auth);drawJobs();await refreshContext();}
$('new').onclick=()=>task(async()=>{await flushDraft();resetComposition();await createConversation();clearError();$('prompt').focus();});
$('size').onchange=$('vertical').onchange=()=>{manualSize=true;updatePreview();queueDraftSave();};$('fps').onchange=()=>{manualFps=true;updatePreview();queueDraftSave();};$('duration').oninput=()=>{if(!videoContextEnabled||!context?.project?.videoContext)manualDurationSeconds=Number($('duration').value);updatePreview();queueDraftSave();};$('prompt').oninput=queueDraftSave;
$('inherit-video').onclick=()=>{if(!busy){inheritVideo(true);queueDraftSave();}};
$('engine').onchange=()=>{preferences.engine=$('engine').value;savePreferences();updatePreview();queueDraftSave();};
$('model').onchange=()=>{showEfforts($('effort').value);preferences.model=$('model').value;preferences.effort=$('effort').value||null;savePreferences();};$('effort').onchange=()=>{preferences.effort=$('effort').value||null;savePreferences();};
$('rename').onclick=()=>{if((!conversation&&!current)||busy)return;$('rename-name').value=conversation?.name||current.name;$('rename-form').hidden=false;$('rename').hidden=true;$('rename-name').focus();$('rename-name').select();};$('rename-cancel').onclick=closeRename;
$('rename-name').onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();closeRename();$('rename').focus();}};
$('rename-form').onsubmit=e=>{e.preventDefault();task(async()=>{await flushDraft();const name=$('rename-name').value.trim();if(!name)throw new Error('Введите название композиции');if(current){const renamed=await api.call('rename',{id:current.id,name});jobs=jobs.map(j=>j.id===renamed.id?renamed:j);current=renamed;}if(conversation){conversation=await api.call('conversation.update',{id:conversation.id,name});conversations=conversations.map(c=>c.id===conversation.id?{...c,name}:c);}$('composition-name').textContent=name;closeRename();drawJobs();drawMessages(false);$('stage').textContent='Название сохранено';});};
$('refresh').onclick=()=>refreshContext().catch(error);
$('demo').onclick=()=>task(async()=>{await flushDraft();$('stage').textContent='Подготовка тестовой композиции';const j=await api.call('demo',{settings:{...settings(),duration:manualDurationSeconds}});upsert(j);await refreshContext();await openConversation(j.conversationId||j.id,{save:false});$('stage').textContent='Тестовая композиция готова · AI не использовался';});
$('video-context-enabled').onchange=()=>{videoContextEnabled=$('video-context-enabled').checked;updateVideoContext();queueDraftSave();};
$('latest-version').onclick=()=>{const v=conversation?.versions.at(-1);if(v&&!busy)task(()=>openVersion(v.id));};
$('add-version').onclick=()=>task(async()=>{await flushDraft();const doc=await api.call('version.create',{compositionId:conversation.id,baseVersionId:conversation.selectedVersionId,requestId:crypto.randomUUID()});restoreConversation(doc);conversations=conversations.map(c=>c.id===doc.id?doc:c);$('stage').textContent=`Создана V${activeVersion().number}. Напишите, что изменить.`;});
$('show-speech').onclick=()=>{const evidence=showSpeech();$('speech-title').textContent=$('show-speech').dataset.saved==='true'?'Сохранённая речь прежнего In/Out':'Текст речи из DaVinci';$('speech-text').textContent=(evidence?.transcript||[]).map(s=>`${s.start.toFixed(2)}–${s.end.toFixed(2)} с  ${s.text}`).join('\n\n');$('speech-dialog').showModal();};$('close-speech').onclick=()=>$('speech-dialog').close();
$('generate').onclick=()=>task(async()=>{
  const prompt=$('prompt').value.trim();if(!prompt)throw new Error('Введите сообщение ассистенту');
  await flushDraft();if(!conversation)await createConversation();const id=conversation.id,versionId=conversation.selectedVersionId,key=workspaceKey,range=context?.project?.videoContext;
  const optimistic={id:'pending-local',role:'user',text:prompt,status:'pending'};conversation.messages.push(optimistic);drawMessages();$('stage').textContent='Подготовка сообщения';
  try{const result=await api.call('chat.send',{conversationId:id,versionId,prompt,settings:settings(),previousId:current?.id||null,model:$('model').value||null,effort:$('effort').value||null,...(videoContextEnabled&&range?{videoContextKey:range.key}:{})});
    if(key!==workspaceKey||conversation?.id!==id||conversation.selectedVersionId!==versionId)return;conversation=result.conversation;conversations=[conversation,...conversations.filter(c=>c.id!==id)];if(result.job)jobs=[result.job,...jobs.filter(j=>j.id!==result.job.id)];$('prompt').value='';drafts.delete(draftKey(id,versionId));showVersion(result.job||current);drawMessages();$('stage').textContent=result.job?'Изменения готовы. Проверьте предпросмотр.':'Ответ получен';
  }catch(e){if(key===workspaceKey){try{conversation=await api.call('conversation.get',{id});}catch{optimistic.status='failed';optimistic.error=e.message;}$('prompt').value=prompt;drawMessages();await flushDraft().catch(()=>{});}throw e;}
});
$('render').onclick=()=>task(async()=>{await flushDraft();upsert(await api.call('render',{id:current.id,compositionId:conversation.id,versionId:conversation.selectedVersionId}));$('stage').textContent='Прозрачный MOV готов. Можно добавить в Media Pool.';});
$('import').onclick=()=>task(async()=>{await flushDraft();const result=await api.call('import',{id:current.id,compositionId:conversation.id,versionId:conversation.selectedVersionId,projectId:context.project.id});upsert(result.job);$('stage').textContent=result.alreadyImported?'Этот результат уже есть в Media Pool.':'Добавлено в Media Pool → AI Assistant / Motion';});
$('sign-in').onclick=async()=>{if(busy||auth.waiting)return;try{clearError();await api.call('signIn');showAuth({...auth,waiting:true});}catch(e){error(e);}};$('cancel-auth').onclick=async()=>{try{await api.call('cancelSignIn');showAuth({...auth,waiting:false});}catch(e){error(e);}};
$('sign-out').onclick=()=>task(async()=>{const r=await api.call('signOut');models=[];showAuth({connected:false});$('model').replaceChildren(new Option('После подключения аккаунта',''));showEfforts();$('stage').textContent=r.message;});
$('usage').onclick=()=>api.call('usage').catch(error);$('folder').onclick=()=>api.call('openFolder',{id:current?.id}).catch(error);
$('choose-folder').onclick=()=>task(async()=>{await flushDraft();const sequence=++contextSequence;const c=await api.call('chooseFolder');if(sequence===contextSequence)await applyContext(c);$('stage').textContent=workspace?.needsSelection?'Выберите папку проекта для сохранения композиций.':'Папка проекта выбрана.';});
$('cancel').onclick=()=>api.call('cancel').catch(error);
for(const action of ['play','pause','restart'])$(action).onclick=()=>$('preview').contentWindow?.postMessage(action,'*');
for(const b of document.querySelectorAll('[data-bg]'))b.onclick=()=>{document.querySelectorAll('[data-bg]').forEach(x=>{x.classList.remove('selected');x.setAttribute('aria-pressed','false');});b.classList.add('selected');b.setAttribute('aria-pressed','true');$('canvas').className='canvas '+b.dataset.bg;};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!$('generate').disabled){e.preventDefault();$('generate').click();}};
api.onEvent(async({event,data})=>{if(event==='stage'){$('stage').textContent=data.stage;if(data.stage.includes('распознаёт речь'))$('speech-status').textContent='DaVinci распознаёт речь…';}if(event==='speech'){speechEvidence=data;showSpeech();}if(event==='authChanged'){showAuth(data);await refreshModels();$('stage').textContent='Подписка подключена. Можно отправить сообщение.';}if(event==='authError'){showAuth({...auth,waiting:false});error(new Error(data.message));}if(event==='fatal')error(new Error(data.message));});
$('engine').value=preferences.engine==='hyperframes'?'hyperframes':'remotion';updatePreview();refresh().then(refreshModels).catch(error);
setInterval(()=>{if(!busy)refreshContext().catch(()=>{});},6000);
