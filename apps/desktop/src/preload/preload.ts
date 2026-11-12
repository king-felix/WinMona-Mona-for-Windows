import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL } from '../shared/channels.js';
import { ATTENTION_CHANNELS, type AttentionFocus } from '../shared/attention.js';
import { AGENT_CHANNELS } from '../shared/agents.js';
import { BRIEFING_CHANNELS } from '../shared/briefing.js';
import { CATALOG_CHANNELS } from '../shared/catalog.js';
import { EXTENSION_CHANNELS } from '../shared/extensions.js';
import { LAUNCH_CHANNELS, type LaunchReceipt } from '../shared/launch.js';
import { PROVIDER_CHANNELS } from '../shared/provider.js';
import { STUDIO_CHANNELS, type StudioEvent } from '../shared/studio.js';

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
  setProjectLayout: (input: { projectId: string; layout: string }) =>
    ipcRenderer.invoke(CATALOG_CHANNELS.uiSetLayout, input),
  saveFavorite: (input: { projectId: string; label: string; text: string }) =>
    ipcRenderer.invoke(CATALOG_CHANNELS.uiSaveFavorite, input),
  removeFavorite: (input: { projectId: string; favoriteId: string }) =>
    ipcRenderer.invoke(CATALOG_CHANNELS.uiRemoveFavorite, input),
  briefingGet: (input: { projectId: string; markSeen?: boolean }) => ipcRenderer.invoke(BRIEFING_CHANNELS.get, input),
  attentionGet: () => ipcRenderer.invoke(ATTENTION_CHANNELS.get, {}),
  attentionSet: (patch: object) => ipcRenderer.invoke(ATTENTION_CHANNELS.set, patch),
  attentionQuitStop: () => ipcRenderer.invoke(ATTENTION_CHANNELS.quitStop, {}),
  onAttentionFocus: (handler: (focus: AttentionFocus) => void) => {
    const listener = (_event: unknown, payload: AttentionFocus): void => handler(payload);
    ipcRenderer.on(ATTENTION_CHANNELS.focus, listener);
    return () => {
      ipcRenderer.removeListener(ATTENTION_CHANNELS.focus, listener);
    };
  },
  studioGet: (input: { projectId: string; sessionId: string; mode?: 'agent' | 'plan' }) =>
    ipcRenderer.invoke(STUDIO_CHANNELS.get, input),
  studioSubmit: (input: {
    projectId: string;
    sessionId: string;
    text: string;
    mode: 'agent' | 'plan';
    references: string[];
  }) => ipcRenderer.invoke(STUDIO_CHANNELS.submit, input),
  studioInterrupt: (input: { projectId: string }) => ipcRenderer.invoke(STUDIO_CHANNELS.interrupt, input),
  studioPause: (input: { projectId: string }) => ipcRenderer.invoke(STUDIO_CHANNELS.pause, input),
  studioResume: (input: { projectId: string }) => ipcRenderer.invoke(STUDIO_CHANNELS.resume, input),
  studioPickReferences: (input: { projectId: string }) => ipcRenderer.invoke(STUDIO_CHANNELS.references, input),
  /** Main-process pushes for the live studio; the only channel the renderer listens on. */
  onStudioEvent: (handler: (event: StudioEvent) => void) => {
    const listener = (_event: unknown, payload: StudioEvent): void => handler(payload);
    ipcRenderer.on(STUDIO_CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(STUDIO_CHANNELS.event, listener);
    };
  },
  observatoryGet: (input: { projectId: string; threadId: string | null }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.get, input),
  createFleetRun: (input: { projectId: string; name: string; instructions: string; role: string }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.createFleetRun, input),
  startFleetRun: (input: { projectId: string; runId: string }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.startFleetRun, input),
  stopFleetRun: (input: { projectId: string; runId: string }) => ipcRenderer.invoke(AGENT_CHANNELS.stopFleetRun, input),
  interruptWorker: (input: { projectId: string; workerId: string }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.interruptWorker, input),
  cancelAgentRun: (input: { projectId: string; runId: string }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.cancelAgentRun, input),
  cancelTask: (input: { projectId: string; taskId: string }) => ipcRenderer.invoke(AGENT_CHANNELS.cancelTask, input),
  createGoal: (input: { projectId: string; threadId: string; objective: string }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.createGoal, input),
  completeGoal: (input: { projectId: string; threadId: string }) =>
    ipcRenderer.invoke(AGENT_CHANNELS.completeGoal, input),
  providerGet: (input: { projectId: string; sessionId: string; providerId?: string }) =>
    ipcRenderer.invoke(PROVIDER_CHANNELS.get, input),
  providerApplyRoute: (input: {
    projectId: string;
    sessionId: string;
    provider: string;
    model: string;
    expectedRevision: string;
  }) => ipcRenderer.invoke(PROVIDER_CHANNELS.applyRoute, input),
  providerApplyPermission: (input: {
    projectId: string;
    sessionId: string;
    posture: 'ask' | 'auto-review' | 'full-access';
    expectedRevision: string;
  }) => ipcRenderer.invoke(PROVIDER_CHANNELS.applyPermission, input),
  providerApplyMode: (input: {
    projectId: string;
    sessionId: string;
    mode: 'agent' | 'plan';
    expectedRevision: string;
  }) => ipcRenderer.invoke(PROVIDER_CHANNELS.applyMode, input),
  extensionsGet: (input: { projectId: string }) => ipcRenderer.invoke(EXTENSION_CHANNELS.get, input),
  extensionsSetMcp: (input: { projectId: string; name: string; enabled: boolean; expectedRevision: string }) =>
    ipcRenderer.invoke(EXTENSION_CHANNELS.setMcp, input),
  extensionsCheckMcp: (input: { projectId: string; name: string; expectedRevision: string }) =>
    ipcRenderer.invoke(EXTENSION_CHANNELS.checkMcp, input),
  /** The latest Explorer launch, and pushes for new ones. Returns no path to execute. */
  getLaunchState: () => ipcRenderer.invoke(LAUNCH_CHANNELS.state, {}),
  onLaunchEvent: (handler: (receipt: LaunchReceipt) => void) => {
    const listener = (_event: unknown, payload: LaunchReceipt): void => handler(payload);
    ipcRenderer.on(LAUNCH_CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(LAUNCH_CHANNELS.event, listener);
    };
  },
});

contextBridge.exposeInMainWorld('mona', bridge);
