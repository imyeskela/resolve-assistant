'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {atomicWrite}=require('../lib/storage.cjs');

async function fixture(t){
  const parent=path.resolve(__dirname,'../.tmp/security-audit/atomic-write');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'test-'));
  t.after(async()=>{assert.equal(path.dirname(directory),parent);await fs.rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'state.json');await fs.writeFile(file,'original');return {directory,file};
}
for(const code of ['EPERM','EACCES','EBUSY'])test(`Windows atomic write survives a one-shot ${code} rename failure`,{skip:process.platform!=='win32'},async t=>{
  const {directory,file}=await fixture(t),rename=fs.rename;let attempts=0;
  t.mock.method(fs,'rename',async(source,destination)=>{
    assert.equal(await fs.readFile(file,'utf8'),'original');
    if(attempts++===0)throw Object.assign(new Error('Synthetic sharing failure'),{code});
    return rename(source,destination);
  });
  await atomicWrite(file,'replacement');
  assert.equal(await fs.readFile(file,'utf8'),'replacement');assert.deepEqual(await fs.readdir(directory),['state.json']);
});
test('permanent Windows rename failure is bounded and preserves the destination and original error',{skip:process.platform!=='win32',timeout:3000},async t=>{
  const {directory,file}=await fixture(t),failure=Object.assign(new Error('Synthetic persistent denial'),{code:'EPERM'});let attempts=0;
  t.mock.method(fs,'rename',async()=>{attempts++;assert.equal(await fs.readFile(file,'utf8'),'original');throw failure;});
  await assert.rejects(atomicWrite(file,'replacement'),e=>e===failure);
  assert.ok(attempts>1&&attempts<=10,'Only a bounded number of retries is allowed');
  assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual(await fs.readdir(directory),['state.json']);
});
test('a non-transient rename error is propagated immediately and cleans the temporary file',async t=>{
  const {directory,file}=await fixture(t),failure=Object.assign(new Error('Synthetic IO failure'),{code:'EIO'});let attempts=0;
  t.mock.method(fs,'rename',async()=>{attempts++;throw failure;});
  await assert.rejects(atomicWrite(file,'replacement'),e=>e===failure);assert.equal(attempts,1);
  assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual(await fs.readdir(directory),['state.json']);
});
test('a write failure is not retried as a rename failure and leaves the destination intact',async t=>{
  const {directory,file}=await fixture(t),writeFile=fs.writeFile,failure=Object.assign(new Error('Synthetic write denial'),{code:'EACCES'});let renames=0;
  t.mock.method(fs,'writeFile',async(...args)=>{await writeFile(...args);throw failure;});
  t.mock.method(fs,'rename',async()=>{renames++;throw new Error('Rename must not be reached');});
  await assert.rejects(atomicWrite(file,'replacement'),e=>e===failure);assert.equal(renames,0);
  assert.equal(await fs.readFile(file,'utf8'),'original');assert.deepEqual(await fs.readdir(directory),['state.json']);
});
