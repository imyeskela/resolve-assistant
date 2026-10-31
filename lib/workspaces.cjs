'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {atomicWrite,readJson}=require('./storage.cjs');
const {checkedJobsRoot}=require('./storage-boundaries.cjs');
class WorkspaceStore {
  constructor(root){this.root=root;this.file=path.join(root,'.data/workspaces.json');this.defaultDirectory=path.join(root,'workspace');this.project=null;}
  async init(){this.data=await readJson(this.file,{projects:{},roots:[]});this.data.projects??={};this.data.roots??=[];return this;}
  setProject(project){
    if(project!==null&&(!project||typeof project.id!=='string'||!project.id||project.id.length>300))throw new Error('Некорректный ID проекта');
    this.project=project?{id:project.id,name:String(project.name||'Project'),mediaDirectory:typeof project.mediaDirectory==='string'?project.mediaDirectory:null}:null;
  }
  info(){
    const p=this.project;const chosen=p?this.data.projects[p.id]?.directory:null;
    const media=p?.mediaDirectory&&path.isAbsolute(p.mediaDirectory)?path.resolve(p.mediaDirectory):null;
    const directory=chosen||media||this.defaultDirectory;
    return {projectId:p?.id||null,projectName:p?.name||null,directory,jobsDir:path.join(directory,'jobs'),source:chosen?'selected':media?'project':'application',needsSelection:!!p&&!chosen&&!media};
  }
  async save(){await atomicWrite(this.file,JSON.stringify(this.data,null,2));}
  async recordRoot(projectId,jobsDir){if(!this.data.roots.some(r=>r.projectId===projectId&&r.jobsDir===jobsDir)){this.data.roots.push({projectId,jobsDir});await this.save();}}
  async prepareTarget(){
    const target=this.info();
    if(target.needsSelection)throw new Error('Выберите папку проекта для сохранения jobs');
    if(target.source==='application')await fs.mkdir(target.directory,{recursive:true});
    let directory;try{if(!(await fs.stat(target.directory)).isDirectory())throw new Error();directory=await fs.realpath(target.directory);}catch{throw new Error('Папка проекта недоступна. Подключите диск или выберите другую папку.');}
    let jobsDir;try{jobsDir=await checkedJobsRoot(target.jobsDir,{create:true});}catch(error){if(error.code==='ERR_STORAGE_BOUNDARY')throw error;throw new Error('Не удалось создать jobs в папке проекта. Проверьте права или выберите другую папку.');}
    const snapshot={...target,directory,jobsDir};
    await this.recordRoot(snapshot.projectId,snapshot.jobsDir);
    return Object.freeze(snapshot);
  }
  async selectDirectory(projectId,directory){
    if(!this.project||this.project.id!==projectId)throw new Error('Проект изменился. Повторите выбор папки.');
    if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Нужен абсолютный путь папки проекта');
    let canonical;try{if(!(await fs.stat(directory)).isDirectory())throw new Error();canonical=await fs.realpath(directory);}catch{throw new Error('Выбранная папка недоступна');}
    await checkedJobsRoot(path.join(canonical,'jobs'),{create:true});
    if(!this.project||this.project.id!==projectId)throw new Error('Проект изменился. Повторите выбор папки.');
    this.data.projects[projectId]={directory:canonical,name:this.project.name};
    if(!this.data.roots.some(r=>r.projectId===projectId&&r.jobsDir===path.join(canonical,'jobs')))this.data.roots.push({projectId,jobsDir:path.join(canonical,'jobs')});
    await this.save();return this.info();
  }
  directoriesForProject(){
    return [...new Set([path.join(this.defaultDirectory,'jobs'),...this.data.roots.filter(r=>r.projectId===(this.project?.id||null)).map(r=>r.jobsDir),this.info().jobsDir])];
  }
  allDirectories(){return [...new Set([path.join(this.defaultDirectory,'jobs'),...this.data.roots.map(r=>r.jobsDir)])];}
}
module.exports={WorkspaceStore};
