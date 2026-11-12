import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL } from '../shared/channels.js';
import { CATALOG_CHANNELS } from '../shared/catalog.js';

/**
 * The entire renderer-facing surface. Named methods only: no generic invoke, no
 * filesystem, no shell, no credentials, and no raw channel names. Every call is
 * validated again in the main process, including the sender frame.
 */
const bridge = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL, {}),
  listProjects: (input: unknown = {}) => ipcRenderer.invoke(CATALOG_CHANNELS.list, input),
  openProject: (path: string) => ipcRenderer.invoke(CATALOG_CHANNELS.open, { path }),
  pickFolder: (purpose: 'open' | 'create-parent') => ipcRenderer.invoke(CATALOG_CHANNELS.pickFolder, { purpose }),
  createProject: (input: { parent: string; name: string }) => ipcRenderer.invoke(CATALOG_CHANNELS.create, input),
  updateProject: (input: { projectId: string; expectedRevision: number; patch: object }) =>
    ipcRenderer.invoke(CATALOG_CHANNELS.update, input),
  removeProject: (projectId: string) => ipcRenderer.invoke(CATALOG_CHANNELS.remove, { projectId }),
  relocateProject: (input: { projectId: string; expectedRevision: number; path: string }) =>
    ipcRenderer.invoke(CATALOG_CHANNELS.relocate, input),
  revealProject: (projectId: string) => ipcRenderer.invoke(CATALOG_CHANNELS.reveal, { projectId }),
  selectProject: (projectId: string | null) => ipcRenderer.invoke(CATALOG_CHANNELS.select, { projectId }),
  engineState: () => ipcRenderer.invoke(CATALOG_CHANNELS.engineState, {}),
  startEngine: (projectId: string) => ipcRenderer.invoke(CATALOG_CHANNELS.engineStart, { projectId }),
  stopEngine: () => ipcRenderer.invoke(CATALOG_CHANNELS.engineStop, {}),
  projectSpend: (projectId: string) => ipcRenderer.invoke(CATALOG_CHANNELS.spend, { projectId }),
  getUiState: () => ipcRenderer.invoke(CATALOG_CHANNELS.uiGet, {}),
  setProjectView: (input: { projectId: string; view: string }) => ipcRenderer.invoke(CATALOG_CHANNELS.uiSetView, input),
  saveDraft: (input: { projectId: string; sessionId: string; text: string }) =>
    ipcRenderer.invoke(CATALOG_CHANNELS.uiSaveDraft, input),
  newSession: (projectId: string) => ipcRenderer.invoke(CATALOG_CHANNELS.uiNewSession, { projectId }),
});

contextBridge.exposeInMainWorld('mona', bridge);
