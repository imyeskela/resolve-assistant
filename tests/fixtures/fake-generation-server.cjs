const readline=require('node:readline');const scenario=process.argv[2];const send=m=>process.stdout.write(JSON.stringify(m)+'\n');const event=(method,params)=>send({method,params});let interval;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.method==='initialize')return send({id:m.id,result:{}});
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'thread'}}});
  if(m.method==='turn/interrupt'){clearInterval(interval);return;}
  if(m.method!=='turn/start')return;
  send({id:m.id,result:{turn:{id:'turn'}}});event('turn/started',{turn:{id:'turn'}});
  const activity=()=>event('item/completed',{item:{type:'reasoning',id:'reasoning'}});
  activity();
  if(scenario==='exit')return setTimeout(()=>process.exit(2),20);
  if(scenario==='idle'||scenario==='abort')return;
  if(scenario==='partial'||scenario==='commentary'){
    const text='{"name":"partial","source":"export default function Scene(){return null}"}';
    if(scenario==='partial')event('item/agentMessage/delta',{delta:text});else event('item/completed',{item:{type:'agentMessage',phase:'commentary',text}});
    event('turn/completed',{turn:{status:'completed'}});return;
  }
  interval=setInterval(activity,25);
  if(scenario==='active')setTimeout(()=>{clearInterval(interval);event('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:'{"name":"complete","source":"export default function Scene(){return null}"}'}});event('turn/completed',{turn:{status:'completed'}});},250);
});
