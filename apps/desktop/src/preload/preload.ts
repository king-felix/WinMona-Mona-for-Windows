import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL } from '../shared/channels.js';

/**
 * The entire renderer-facing surface in P02. One frozen object, one channel,
 * no arbitrary IPC, no filesystem, no shell, no credentials.
 */
contextBridge.exposeInMainWorld(
  'mona',
  Object.freeze({
    getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL, {}),
  }),
);
