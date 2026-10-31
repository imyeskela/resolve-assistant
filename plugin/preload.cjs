const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('assistant',{
  call:async(method,params={})=>{const response=await ipcRenderer.invoke('assistant:call',method,params);if(!response.ok)throw new Error(response.error);return response.result;},
  onEvent:listener=>{const wrapped=(_event,message)=>listener(message);ipcRenderer.on('assistant:event',wrapped);return ()=>ipcRenderer.removeListener('assistant:event',wrapped);}
});
