'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeModelCatalog}=require('../lib/auth.cjs');

test('model picker retains server-advertised efforts and model default',()=>{
  const models=normalizeModelCatalog({models:[{slug:'model-a',display_name:'Model A',visibility:'list',supported_reasoning_levels:[{effort:'low',description:'Fast'},{effort:'high',description:'Deep'}],default_reasoning_level:'high'}]});
  assert.deepEqual(models,[{id:'model-a',name:'Model A',reasoningEfforts:['low','high'],defaultReasoningEffort:'high'}]);
});
test('model capabilities support app-server names and never invent effort options',()=>{
  const models=normalizeModelCatalog({data:[{id:'model-a',displayName:'A',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'xhigh'}],defaultReasoningEffort:'medium'},{id:'unknown'},{id:'hidden',hidden:true},{id:'disabled',visibility:'hide'}]});
  assert.deepEqual(models,[{id:'model-a',name:'A',reasoningEfforts:['medium','xhigh'],defaultReasoningEffort:'medium'},{id:'unknown',name:'unknown',reasoningEfforts:[],defaultReasoningEffort:null}]);
});
test('malformed model catalog entries cannot become selectable capabilities',()=>{
  assert.deepEqual(normalizeModelCatalog({models:'invalid'}),[]);
  assert.deepEqual(normalizeModelCatalog({models:[null,{id:42},{id:'a',supported_reasoning_efforts:['high','high',null,{},'not a level'],default_reasoning_effort:'unsupported'},{id:'a'}]}),[{id:'a',name:'a',reasoningEfforts:['high'],defaultReasoningEffort:'high'}]);
});
