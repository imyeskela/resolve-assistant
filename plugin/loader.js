'use strict';
const fs=require('fs');
const path=require('path');
const runtime=JSON.parse(fs.readFileSync(path.join(__dirname,'runtime.json'),'utf8'));
require(path.join(runtime.projectRoot,'plugin/host.cjs')).start(runtime,__dirname);
