import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge } from './core/public';

const api: Bridge = { call: (method, input) => ipcRenderer.invoke('mgit', method, input) };
contextBridge.exposeInMainWorld('mgit', api);
