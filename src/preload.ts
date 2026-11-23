import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, UpdateView } from './core/public';

const api: Bridge = {
  call: (method, input) => ipcRenderer.invoke('mgit', method, input),
  onUpdate(listener) {
    const receive = (_event: Electron.IpcRendererEvent, status: UpdateView) => listener(status);
    ipcRenderer.on('mgit:update', receive);
    return () => { ipcRenderer.removeListener('mgit:update', receive); };
  }
};
contextBridge.exposeInMainWorld('mgit', api);
