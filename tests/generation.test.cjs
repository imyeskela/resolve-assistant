const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildGenerationRequest}=require('../lib/codex.cjs');
const models=[{id:'chosen',name:'Chosen',reasoningEfforts:['low','high','ultra'],defaultReasoningEffort:'high'}];
test('React generation keeps selected model effort and full previous TSX for revision',()=>{
  const source="export default()=> <svg><path d='M0 0L20 20'/></svg>";
  const result=buildGenerationRequest({models,model:'chosen',effort:'ultra',prompt:'Добавь кривую',settings:{engine:'remotion',width:640,height:360,fps:29.97,duration:2},previous:{engine:'remotion',source}});
  assert.equal(result.model,'chosen');assert.equal(result.effort,'ultra');assert.ok(result.outputSchema.properties.source);assert.equal(JSON.parse(result.input[0].text).previousComposition.source,source);
});
test('generation rejects unsupported effort/model before contacting paid service',()=>{
  assert.throws(()=>buildGenerationRequest({models,model:'chosen',effort:'xhigh',settings:{}}),/усили|рассуж|доступ/);
  assert.throws(()=>buildGenerationRequest({models,model:'missing',settings:{}}),/модель/);
});
test('legacy HyperFrames generation retains declarative schema and model default effort',()=>{
  const result=buildGenerationRequest({models,settings:{engine:'hyperframes'},prompt:'text'});
  assert.ok(result.outputSchema.properties.elements);assert.equal(result.outputSchema.properties.source,undefined);assert.equal(result.effort,'high');
});

test('video generation attaches ordered images and timestamped evidence without exposing paths in the text',()=>{
  const context={range:{timelineName:'Монтаж',inTimecode:'01:00:12:00',outTimecode:'01:00:19:24',duration:8},frames:[{path:'C:/private/context/image-0.jpg',seconds:0,timecode:'01:00:12:00'},{path:'C:/private/context/image-1.jpg',seconds:7.96,timecode:'01:00:19:24'}],transcript:[],speechIncluded:false};
  const result=buildGenerationRequest({models,prompt:'Выдели цифры',settings:{engine:'remotion'},videoContext:context});
  assert.deepEqual(result.input.filter(i=>i.type==='localImage').map(i=>i.path),context.frames.map(f=>f.path));
  const text=JSON.parse(result.input[0].text);assert.equal(text.videoContext.duration,8);assert.equal(text.videoContext.frames[1].seconds,7.96);assert.equal(text.videoContext.speechIncluded,false);
  assert.doesNotMatch(result.input[0].text,/private|image-0\.jpg/);
  const without=buildGenerationRequest({models,prompt:'Без видео',settings:{},videoContext:null});assert.equal(without.input.length,1);assert.equal(JSON.parse(without.input[0].text).videoContext,undefined);
});
test('models explicitly limited to text reject video context before a model request',()=>{
  assert.throws(()=>buildGenerationRequest({models:[{...models[0],inputModalities:['text']}],settings:{},videoContext:{range:{},frames:[{path:'frame.jpg',seconds:0}],transcript:[]}}),/изображ|кадр/i);
});
