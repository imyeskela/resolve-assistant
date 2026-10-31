const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalizeVideoSettings, normalizeMotion, buildComposition, extractPlan, demoMotion} = require('../lib/motion.cjs');

const valid = () => ({name:'Рост', background:'transparent', elements:[
  {type:'text', text:'Рост +35%', x:120,y:360,width:1600,height:220,fontSize:132,
   color:'#F5F1E9',enter:'rise',start:0.2,end:4.6}
]});
const settings = {width:1920,height:1080,fps:30,duration:5};

test('rejects executable or external CSS values from model output', () => {
  const p=valid(); p.elements[0].color='url(https://example.com/secret)';
  assert.throws(()=>normalizeMotion(p,settings), /color/i);
});
test('rejects infinite, out-of-range and oversized composition parameters', () => {
  const p=valid(); p.elements[0].x=Infinity;
  assert.throws(()=>normalizeMotion(p,settings), /x/i);
  assert.throws(()=>normalizeMotion(valid(),{...settings,duration:999}), /duration/i);
  assert.throws(()=>normalizeMotion({...valid(),elements:Array(65).fill(valid().elements[0])},settings), /elements/i);
});
test('model cannot override export dimensions, fps or duration', () => {
  const p=normalizeMotion({...valid(),width:1,height:1,fps:60,duration:300},settings);
  assert.equal(p.width,1920); assert.equal(p.fps,30); assert.equal(p.duration,5);
});
test('escapes model text while preserving Cyrillic and transparent background', () => {
  const p=valid(); p.elements[0].text='Рост </script><script>alert(1)</script> & <img src=x>';
  const html=buildComposition(normalizeMotion(p,settings));
  assert.ok(html.includes('Рост &lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('https://'));
  assert.match(html,/data-composition-id="root"/);
  assert.match(html,/background:transparent/);
});
test('accepts plain JSON and a single JSON code fence, rejects surrounding prose', () => {
  assert.equal(extractPlan(JSON.stringify(valid())).name,'Рост');
  assert.equal(extractPlan('```json\n'+JSON.stringify(valid())+'\n```').name,'Рост');
  assert.throws(()=>extractPlan('Here is your plan: '+JSON.stringify(valid())), /JSON/);
});
test('demo fits all three offered canvas formats',()=>{
  for(const [width,height] of [[1920,1080],[1080,1920],[1080,1080]]){
    const p=demoMotion({width,height,fps:30,duration:5});
    for(const e of p.elements){assert.ok(e.x+e.width<=width);assert.ok(e.y+e.height<=height);}
  }
});
test('supports manual frame rates and 3K, UHD, DCI and inherited portrait canvases',()=>{
  for(const [width,height] of [[3072,1728],[3840,2160],[4096,2160],[2160,3840],[2160,2160]]){
    for(const fps of [24,25,30,60,120]){
      const p=normalizeMotion({...valid(),width:8192,fps:999},{width,height,fps,duration:5});
      assert.equal(p.width,width);assert.equal(p.height,height);assert.equal(p.fps,fps);
      assert.equal(p.frameCount,5*fps);
    }
  }
});
test('fractional frame rates use a whole frame count with an effective duration',()=>{
  for(const [fps,frameCount] of [[29.97,150],[23.976,120],[59.94,300]]){
    const p=normalizeMotion({elements:[{type:'text',text:'End',end:5}]},{...settings,fps});
    assert.equal(p.frameCount,frameCount);
    assert.equal(p.duration,frameCount/fps);
    assert.equal(p.elements[0].end,p.duration);
    assert.ok(Math.abs(p.duration-5)<=1/fps);
  }
  const p=normalizeMotion({elements:[{type:'text',end:5.01}]},{...settings,duration:5.01});
  assert.equal(p.duration,5);assert.equal(p.elements[0].end,5);
});
test('canonical fractional settings round-trip at duration limits without accepting arbitrary overlong clips',()=>{
  for(const [fps,duration,frameCount] of [[29.97,15,450],[23.976,2,48],[24.1,2,48]]){
    const first=normalizeVideoSettings({...settings,fps,duration});
    assert.equal(first.frameCount,frameCount);
    assert.deepEqual(normalizeVideoSettings(first),first);
    const plan=normalizeMotion({elements:[{type:'text'}]},first);
    assert.equal(plan.duration,first.duration);
    assert.equal(plan.elements[0].end,first.duration);
  }
  for(const extra of [
    {fps:29.97,duration:450/29.97},
    {fps:29.97,duration:450/29.97,frameCount:'450'},
    {fps:29.97,duration:450/29.97,frameCount:451},
    {fps:29.97,duration:451/29.97,frameCount:451},
    {fps:24.1,duration:47/24.1,frameCount:47},
    {fps:29.97,duration:15.02,frameCount:450}
  ])assert.throws(()=>normalizeVideoSettings({...settings,...extra}),/duration/);
});
test('rejects invalid trusted video settings instead of coercing values',()=>{
  for(const [key,values] of Object.entries({width:[359,4097,3840.5,'3840',Infinity],height:[0,8192,'2160'],fps:[0,121,'30',NaN,Infinity],duration:[1.99,15.01,'5',Infinity]})){
    for(const value of values)assert.throws(()=>normalizeMotion(valid(),{...settings,[key]:value}),/Invalid/);
  }
});
test('4K demo retains fitted typography and all layers inside every supported aspect',()=>{
  for(const [width,height] of [[3072,1728],[3840,2160],[4096,2160],[2160,3840],[2160,2160]]){
    const p=demoMotion({width,height,fps:29.97,duration:5});
    for(const e of p.elements){assert.ok(e.x+e.width<=width);assert.ok(e.y+e.height<=height);}
    if(width===3840&&height===2160)assert.equal(p.elements[2].fontSize,380);
  }
  assert.throws(()=>normalizeMotion({elements:[{type:'text',fontSize:321}]},settings),/fontSize/);
});
