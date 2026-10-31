'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {spawnSync}=require('node:child_process');
const {RpcClient,codexArguments}=require('../lib/codex.cjs');
const {cleanEnvironment}=require('../lib/process.cjs');
const {FFMPEG,FFPROBE,renderEnvironment}=require('../lib/render.cjs');
(async()=>{
  require('../lib/runtime.cjs').assertCurrentRuntime();
  const root=path.resolve(__dirname,'..');
  for(const dir of ['lib','plugin','scripts'])for(const name of await fs.readdir(path.join(root,dir))){if(!/\.(cjs|js)$/.test(name))continue;const result=spawnSync(process.execPath,['--check',path.join(root,dir,name)],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(result.stderr);}
  for(const file of [FFMPEG,FFPROBE,renderEnvironment().HYPERFRAMES_BROWSER_PATH])await fs.access(file);
  const profile=path.join(root,'.data/protocol-check');await fs.mkdir(profile,{recursive:true});
  const exe=path.join(root,'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const client=new RpcClient(exe,codexArguments(),{cwd:profile,env:cleanEnvironment({CODEX_HOME:profile,ACCESS_TOKEN:'protocol-check-no-real-token'})});
  try{
    await client.request('initialize',{clientInfo:{name:'resolve_assistant',title:'Resolve Assistant',version:'0.1.0'},capabilities:{experimentalApi:true}});client.send({method:'initialized',params:{}});
    const response=await client.request('config/read',{includeLayers:false});
    const features=response.config.features||{};
    for(const key of ['shell_tool','unified_exec','multi_agent','hooks','plugins'])if(features[key]!==false)throw new Error('Codex feature was not disabled: '+key);
    console.log('Syntax OK; FFmpeg/FFprobe/browser OK; pinned Codex app-server initializes; shell, exec, multi-agent, hooks and plugins disabled. No inference requested.');
  }finally{client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
