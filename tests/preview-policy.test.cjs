const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {pathToFileURL}=require('node:url');
const make=()=>require('../plugin/preview-policy.cjs').createPreviewPolicy(path.resolve(__dirname,'..'));
const id='00000000-0000-4000-8000-000000000001';const id2='00000000-0000-4000-8000-000000000002';
const prefix='http://127.0.0.1:47821/'+ 'a'.repeat(48)+'/';const previewUrl=prefix+id+'/index.html?preview=1';
test('preview policy authorizes only controller job responses and exact app/preview assets',()=>{
  const p=make();const req=(url,resourceType='subFrame',method='GET')=>p.allowsRequest({url,resourceType,method});
  assert.equal(req(previewUrl),false);p.registerControllerResult('generate',{id,previewUrl});assert.equal(req(previewUrl),true);
  assert.equal(req(prefix+id+'/assets/remotion.js','script'),true);assert.equal(req(prefix+id+'/assets/gsap.min.js','script'),true);
  const app=pathToFileURL(path.resolve(__dirname,'../plugin/index.html')).href;assert.equal(req(app,'mainFrame'),true);assert.equal(req(app,'subFrame'),false);
  for(const bad of [previewUrl+'&leak=secret',prefix+id+'/source.tsx','http://127.0.0.1:47822/probe','http://localhost:47821/probe','https://example.com/',pathToFileURL(path.resolve(__dirname,'../lib/auth.cjs')).href])assert.equal(req(bad),false,bad);
  assert.equal(req(previewUrl,'subFrame','POST'),false);assert.equal(req(previewUrl,'mainFrame'),false);
  assert.equal(p.allowsRequest({url:'http://127.0.0.1:9999/probe',method:'GET'}),false);
  p.registerControllerResult('status',{jobs:[{id:id2,previewUrl:prefix+id2+'/index.html?preview=1'}]});assert.equal(req(prefix+id2+'/index.html?preview=1'),true);assert.equal(req(previewUrl),true);
  assert.equal(p.allowsNavigation({url:previewUrl,isMainFrame:false}),true);assert.equal(p.allowsNavigation({url:'http://127.0.0.1:47822/probe',isMainFrame:false}),false);assert.equal(p.allowsNavigation({url:previewUrl,isMainFrame:true}),false);
});
test('renderer params, nested generated objects, forged URLs and redirect responses cannot expand policy',()=>{
  const p=make();p.registerControllerResult('generate',{id,previewUrl});
  for(const method of ['auth.begin','unknown'])p.registerControllerResult(method,{id:id2,previewUrl:prefix+id2+'/index.html?preview=1'});
  p.registerControllerResult('generate',{plan:{id:id2,previewUrl:prefix+id2+'/index.html?preview=1'}});
  p.registerControllerResult('status',{jobs:[{id:id2,previewUrl:'http://127.0.0.1:47822/'+ 'b'.repeat(48)+'/'+id2+'/index.html?preview=1'}]});
  p.registerControllerResult('generate',{id:id2,previewUrl:prefix+id+'/index.html?preview=1&anything=1'});
  assert.equal(p.allowsRequest({url:prefix+id2+'/index.html?preview=1',method:'GET',resourceType:'subFrame'}),false);
  assert.equal(p.allowsResponse({statusCode:302}),false);assert.equal(p.allowsResponse({statusCode:200}),true);
});
