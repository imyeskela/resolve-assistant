const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {createPreviewPolicy}=require('../plugin/preview-policy.cjs');
test('chat responses register only the controller-validated nested job preview',()=>{
  const id='00000000-0000-4000-8000-000000000001',url='http://127.0.0.1:47821/'+'a'.repeat(48)+'/'+id+'/index.html?preview=1';
  const policy=createPreviewPolicy(path.resolve(__dirname,'..')),details={url,method:'GET',resourceType:'subFrame'};
  policy.registerControllerResult('conversation.update',{job:{id,previewUrl:url}});assert.equal(policy.allowsRequest(details),false);
  policy.registerControllerResult('chat.send',{conversation:{previewUrl:'http://evil.test/'},job:{id,previewUrl:url}});assert.equal(policy.allowsRequest(details),true);
  assert.equal(policy.allowsRequest({url:'http://evil.test/',method:'GET',resourceType:'subFrame'}),false);
});
