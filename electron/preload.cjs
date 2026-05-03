const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  openFiles: (options) => ipcRenderer.invoke('dialog:openFiles', options),
  openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  selectDir: (options) => ipcRenderer.invoke('dialog:selectDir', options),
  redact: (payload) => ipcRenderer.invoke('job:redact', payload),
  restore: (payload) => ipcRenderer.invoke('job:restore', payload)
})
