'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('developer launcher runs the private Node and drops inherited application secrets',()=>{
  const root=path.resolve(__dirname,'..');
  const result=spawnSync(process.execPath,[path.join(root,'scripts/run.cjs'),'-e',"console.log(JSON.stringify({exe:process.execPath,version:process.version,secret:process.env.RUNTIME_TEST_SECRET}))"],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,RUNTIME_TEST_SECRET:'synthetic-private-marker'}});
  assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout);
  assert.equal(actual.exe.toLowerCase(),path.join(root,'.runtime/win32-x64/node/node.exe').toLowerCase());
  assert.equal(actual.version,'v'+require('../runtime-manifest.json').artifacts.find(a=>a.name==='node').version);
  assert.equal(actual.secret,undefined);
});

test('developer launcher preserves child failure status',()=>{
  const result=spawnSync(process.execPath,[path.join(__dirname,'../scripts/run.cjs'),'-e','process.exit(23)'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,23,result.stderr);
});

test('HyperFrames revalidates runtime integrity after the controller module has loaded',()=>{
  const Module=require('node:module'),file=require.resolve('../lib/render.cjs'),oldLoad=Module._load,oldCache=require.cache[file];let changed=false;
  delete require.cache[file];
  try{
    Module._load=function(name,parent,isMain){
      if(name==='./runtime.cjs'&&parent?.filename===file)return {runtimeExecutable:()=>{if(changed)throw new Error('runtime checksum changed');return process.execPath;}};
      return oldLoad.call(this,name,parent,isMain);
    };
    const {renderEnvironment}=require(file);
    renderEnvironment();changed=true;
    assert.throws(()=>renderEnvironment(),/runtime checksum changed/);
  }finally{Module._load=oldLoad;delete require.cache[file];if(oldCache)require.cache[file]=oldCache;}
});
