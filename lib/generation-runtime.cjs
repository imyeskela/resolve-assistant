'use strict';
const GENERATION_LIMITS=Object.freeze({idleMs:180000,totalMs:900000,hostMs:1080000});
function createGenerationWatchdog({idleMs=GENERATION_LIMITS.idleMs,totalMs=GENERATION_LIMITS.totalMs,onTimeout}){
  let idleTimer,totalTimer,stopped=false;
  const stop=()=>{stopped=true;clearTimeout(idleTimer);clearTimeout(totalTimer);};
  const expire=kind=>{if(stopped)return;stop();const error=new Error(kind==='idle'?'От модели давно нет новых данных. Генерация остановлена; повторите запрос.':'Достигнут общий лимит времени генерации. Запрос остановлен; упростите сцену или уменьшите уровень рассуждения.');error.code=kind==='idle'?'GENERATION_IDLE_TIMEOUT':'GENERATION_TOTAL_TIMEOUT';onTimeout(error);};
  const activity=()=>{if(stopped)return;clearTimeout(idleTimer);idleTimer=setTimeout(()=>expire('idle'),idleMs);};
  totalTimer=setTimeout(()=>expire('total'),totalMs);activity();return {activity,stop};
}
function providerStatus(error){
  function find(value,depth=0){if(!value||typeof value!=='object'||depth>4)return null;if(Number.isInteger(value.httpStatusCode))return value.httpStatusCode;for(const child of Object.values(value)){const found=find(child,depth+1);if(found)return found;}return null;}
  return find(error?.codexErrorInfo)||find(error);
}
function providerFailure(error){
  const status=providerStatus(error);const kind=typeof error?.codexErrorInfo==='string'?error.codexErrorInfo:'';
  if(status===401||kind.toLowerCase()==='unauthorized')return {permanent:true,message:'Сессия ChatGPT недействительна. Выполните вход заново.',code:'GENERATION_AUTH'};
  if(status===403)return {permanent:true,message:'Выбранная модель недоступна для этой сессии ChatGPT.',code:'GENERATION_ACCESS'};
  if(status===429||/usagelimitexceeded/i.test(kind))return {permanent:true,message:'Достигнут лимит ChatGPT. Проверьте использование подписки и повторите позже.',code:'GENERATION_LIMIT'};
  if(status>=400&&status<500&&![408,409].includes(status))return {permanent:true,message:'Сервис отклонил параметры AI-запроса'+(status?' (HTTP '+status+')':'')+'. Повторите с другой доступной настройкой модели.',code:'GENERATION_REQUEST'};
  return {permanent:false,message:'Ошибка соединения с AI'+(status?' (HTTP '+status+')':'')+'. Повторите запрос.',code:'GENERATION_PROVIDER'};
}
const EVENTS=new Set(['turn/started','turn/completed','item/started','item/completed','item/agentMessage/delta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','item/reasoning/textDelta','error','process/closed','process/stderr']);
function createGenerationDiagnostics({model,effort,engine}){
  const started=Date.now();const counts={};const events=[];let outcome='running';
  return {
    record(method,p={}){if(!EVENTS.has(method))return;counts[method]=(counts[method]||0)+1;const event={event:method,elapsedMs:Date.now()-started};if(['reasoning','agentMessage','userMessage'].includes(p.item?.type))event.itemType=p.item.type;if(typeof p.delta==='string')event.characters=p.delta.length;if(method==='error'){event.willRetry=p.willRetry===true;event.httpStatus=providerStatus(p.error);}if(method==='turn/completed'&&['completed','failed','interrupted'].includes(p.turn?.status))event.status=p.turn.status;if(method==='process/stderr')event.bytes=p.bytes;events.push(event);if(events.length>80)events.shift();},
    finish(value){outcome=value;},
    snapshot(){return {version:1,startedAt:new Date(started).toISOString(),model,effort,engine,outcome,elapsedMs:Date.now()-started,counts:{...counts},events:[...events]};}
  };
}
module.exports={GENERATION_LIMITS,createGenerationWatchdog,createGenerationDiagnostics,providerFailure};
