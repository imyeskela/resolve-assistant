'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(value).digest('hex');
const manifest={platform:'win32',arch:'x64',artifacts:[{name:'node',url:'https://example.com/node.zip',sha256:digest('archive'),files:[{entry:'node/node.exe',path:'node/node.exe',sha256:digest('verified'),executable:'node'},{entry:'node/LICENSE',path:'node/LICENSE',sha256:digest('license')}]}]};
async function fixture(t){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'private-runtime-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return {runtimeRoot:root,manifest,platform:'win32',arch:'x64'};}
async function populate(root){await fsp.mkdir(path.join(root,'node'),{recursive:true});await fsp.writeFile(path.join(root,'node/node.exe'),'verified');await fsp.writeFile(path.join(root,'node/LICENSE'),'license');}
test('runtime fails closed when missing or modified, and verifies again after a previous success',async t=>{
  const {runtimeExecutable}=require('../lib/runtime.cjs');const options=await fixture(t);
  assert.throws(()=>runtimeExecutable('node',options),/runtime:setup/);
  await populate(path.join(options.runtimeRoot,'win32-x64'));
  assert.equal(runtimeExecutable('node',options),path.join(options.runtimeRoot,'win32-x64/node/node.exe'));
  await fsp.writeFile(path.join(options.runtimeRoot,'win32-x64/node/node.exe'),'tampered');
  assert.throws(()=>runtimeExecutable('node',options),/checksum/i);
});
test('runtime rejects redirected directories and unsupported platforms',async t=>{
  const {runtimeExecutable}=require('../lib/runtime.cjs');const options=await fixture(t);const outside=path.join(options.runtimeRoot,'outside');await populate(outside);
  await fsp.symlink(outside,path.join(options.runtimeRoot,'win32-x64'),'junction');
  assert.throws(()=>runtimeExecutable('node',options),/link|redirect/i);
  assert.throws(()=>runtimeExecutable('node',{...options,platform:'linux'}),/Windows x64/);
});
test('bad download checksum is rejected before extraction and preserves the installed runtime',async t=>{
  const {installRuntime}=require('../scripts/setup-runtime.cjs');const options=await fixture(t);const target=path.join(options.runtimeRoot,'win32-x64');await populate(target);await fsp.writeFile(path.join(target,'node/node.exe'),'previous');let extracted=false;
  await assert.rejects(installRuntime({...options,download:async(_url,dest)=>fsp.writeFile(dest,'corrupt'),extract:async()=>{extracted=true;}}),/checksum/i);
  assert.equal(extracted,false);assert.equal(fs.readFileSync(path.join(target,'node/node.exe'),'utf8'),'previous');
});
test('invalid extracted binary or missing license preserves prior installation',async t=>{
  const {installRuntime}=require('../scripts/setup-runtime.cjs');const options=await fixture(t);const target=path.join(options.runtimeRoot,'win32-x64');await populate(target);await fsp.writeFile(path.join(target,'node/node.exe'),'previous');
  await assert.rejects(installRuntime({...options,download:async(_url,dest)=>fsp.writeFile(dest,'archive'),extract:async(_zip,stage)=>{await populate(stage);await fsp.unlink(path.join(stage,'node/LICENSE'));}}),/LICENSE|runtime:setup/);
  assert.equal(fs.readFileSync(path.join(target,'node/node.exe'),'utf8'),'previous');
});
test('valid staged installation publishes all verified files and is idempotent',async t=>{
  const {installRuntime}=require('../scripts/setup-runtime.cjs');const options=await fixture(t);let downloads=0;
  const setup={...options,download:async(_url,dest)=>{downloads++;await fsp.writeFile(dest,'archive');},extract:async(_zip,stage)=>populate(stage)};
  await installRuntime(setup);await installRuntime(setup);
  assert.equal(downloads,1);assert.equal(fs.readFileSync(path.join(options.runtimeRoot,'win32-x64/node/LICENSE'),'utf8'),'license');
  assert.deepEqual(fs.readdirSync(options.runtimeRoot),['win32-x64']);
});
test('manifest paths cannot escape extraction or installed root on Windows',()=>{
  const {safeRelativePath}=require('../lib/runtime.cjs');
  for(const value of ['../outside.exe','C:/outside.exe','/outside.exe','node/../outside.exe','node\\outside.exe','node/file.exe:ads','node/CON','node/file.','node//file'])assert.throws(()=>safeRelativePath(value),/path/i,value);
  assert.equal(safeRelativePath('node/node.exe'),'node/node.exe');
});
test('publish failure rolls back the previous installation',async t=>{
  const {installRuntime}=require('../scripts/setup-runtime.cjs');const options=await fixture(t);const target=path.join(options.runtimeRoot,'win32-x64');await populate(target);await fsp.writeFile(path.join(target,'node/node.exe'),'previous');
  const rename=fsp.rename.bind(fsp);t.mock.method(fsp,'rename',async(from,to)=>{if(path.basename(from)==='installed')throw new Error('synthetic publish failure');return rename(from,to);});
  await assert.rejects(installRuntime({...options,download:async(_url,dest)=>fsp.writeFile(dest,'archive'),extract:async(_zip,stage)=>populate(stage)}),/synthetic publish failure/);
  assert.equal(fs.readFileSync(path.join(target,'node/node.exe'),'utf8'),'previous');
  assert.deepEqual(fs.readdirSync(options.runtimeRoot),['win32-x64']);
});
test('runtime downloader rejects insecure or unapproved origins before making a request',async()=>{
  const {download}=require('../scripts/setup-runtime.cjs');
  for(const url of ['http://nodejs.org/dist/a.zip','https://evil.example/a.zip','https://user:password@nodejs.org/a.zip','https://nodejs.org:444/a.zip'])await assert.rejects(download(url,'never-written'),/approved HTTPS/);
});
test('cleanup failure releases setup lock while retaining published and previous runtimes',async t=>{
  const {installRuntime}=require('../scripts/setup-runtime.cjs');const options=await fixture(t);const target=path.join(options.runtimeRoot,'win32-x64');await populate(target);await fsp.writeFile(path.join(target,'node/node.exe'),'previous');
  const remove=fsp.rm.bind(fsp);const mocked=t.mock.method(fsp,'rm',async(file,...args)=>{
    if(path.basename(file).startsWith('.setup-')&&path.basename(file)!=='.setup-lock')throw new Error('synthetic cleanup failure');
    return remove(file,...args);
  });
  try {
    await assert.rejects(installRuntime({...options,download:async(_url,dest)=>fsp.writeFile(dest,'archive'),extract:async(_zip,stage)=>populate(stage)}),/synthetic cleanup failure/);
    assert.equal(fs.existsSync(path.join(options.runtimeRoot,'.setup-lock')),false);
    assert.equal(fs.readFileSync(path.join(target,'node/node.exe'),'utf8'),'verified');
    const work=fs.readdirSync(options.runtimeRoot).find(name=>name.startsWith('.setup-'));
    assert.ok(work);assert.equal(fs.readFileSync(path.join(options.runtimeRoot,work,'previous/node/node.exe'),'utf8'),'previous');
  }finally{mocked.mock.restore();}
});
test('failed rollback retains the previous runtime for recovery even when a target appears',async t=>{
  const {installRuntime}=require('../scripts/setup-runtime.cjs');const options=await fixture(t);const target=path.join(options.runtimeRoot,'win32-x64');await populate(target);await fsp.writeFile(path.join(target,'node/node.exe'),'previous');
  const rename=fsp.rename.bind(fsp);t.mock.method(fsp,'rename',async(from,to)=>{
    if(path.basename(from)==='installed'){await fsp.mkdir(target);throw new Error('synthetic publish failure');}
    if(path.basename(from)==='previous')throw new Error('synthetic rollback failure');
    return rename(from,to);
  });
  await assert.rejects(installRuntime({...options,download:async(_url,dest)=>fsp.writeFile(dest,'archive'),extract:async(_zip,stage)=>populate(stage)}),/synthetic rollback failure/);
  const work=fs.readdirSync(options.runtimeRoot).find(name=>name.startsWith('.setup-'));
  assert.ok(work,'Retain recovery directory');assert.equal(fs.readFileSync(path.join(options.runtimeRoot,work,'previous/node/node.exe'),'utf8'),'previous');
});
test('real ZIP extraction selects only pinned entries and rejects duplicates and unsafe paths',{skip:process.platform!=='win32'},async t=>{
  const {extract}=require('../scripts/setup-runtime.cjs');const {promisify}=require('node:util');const exec=promisify(require('node:child_process').execFile);const options=await fixture(t);
  const script=path.join(options.runtimeRoot,'create-fixture.ps1');
  await fsp.writeFile(script,`param([string]$Archive,[switch]$Duplicate)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip=[IO.Compression.ZipFile]::Open($Archive,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach($name in @('node/node.exe','node/LICENSE','../escape.exe')) {
    $entry=$zip.CreateEntry($name);$writer=New-Object IO.StreamWriter($entry.Open())
    try {$writer.Write('fixture')} finally {$writer.Dispose()}
  }
  if($Duplicate){$entry=$zip.CreateEntry('node/node.exe');$stream=$entry.Open();$stream.Dispose()}
} finally {$zip.Dispose()}
`);
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  for(const duplicate of [false,true]){
    const dir=path.join(options.runtimeRoot,duplicate?'duplicate':'valid');await fsp.mkdir(dir);const archive=path.join(dir,'fixture.zip');const stage=path.join(dir,'stage');await fsp.mkdir(stage);
    await exec(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Archive',archive,...(duplicate?['-Duplicate']:[])],{windowsHide:true});
    if(duplicate)await assert.rejects(extract(archive,stage,manifest.artifacts[0]),/duplicate/);
    else {await extract(archive,stage,manifest.artifacts[0]);assert.equal(fs.readFileSync(path.join(stage,'node/node.exe'),'utf8'),'fixture');assert.equal(fs.existsSync(path.join(dir,'escape.exe')),false);}
  }
  await assert.rejects(extract('unused','unused',{name:'node',files:[{entry:'node/node.exe',path:'../escape.exe'}]}),/path/i);
});
