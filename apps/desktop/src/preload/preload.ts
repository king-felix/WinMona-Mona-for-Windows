import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL } from '../shared/channels.js';
import { ATTENTION_CHANNELS, type AttentionFocus } from '../shared/attention.js';
import { APPEARANCE_CHANNELS, type AppearanceView } from '../shared/appearance.js';
import { AGENT_CHANNELS } from '../shared/agents.js';
import { BRIEFING_CHANNELS } from '../shared/briefing.js';
import { CATALOG_CHANNELS } from '../shared/catalog.js';
import { CHANGES_CHANNELS } from '../shared/changes.js';
import { COST_CHANNELS, type BudgetInputView } from '../shared/cost.js';
import { CAPABILITY_CHANNELS } from '../shared/capabilities.js';
import { EXTENSION_CHANNELS } from '../shared/extensions.js';
import { LAUNCH_CHANNELS, type LaunchReceipt } from '../shared/launch.js';
import { MEMORY_CHANNELS } from '../shared/memory.js';
import { PROVIDER_CHANNELS } from '../shared/provider.js';
import { STUDIO_CHANNELS, type StudioEvent } from '../shared/studio.js';
import { TASK_CHANNELS, type TaskCreateView } from '../shared/tasks.js';
import { TERMINAL_CHANNELS, type TerminalEvent } from '../shared/terminal.js';

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
  memorySearch: (input: unknown) => ipcRenderer.invoke(MEMORY_CHANNELS.search, input),
  memoryReindex: (projectId: string) => ipcRenderer.invoke(MEMORY_CHANNELS.reindex, { projectId }),
  promptSave: (input: unknown) => ipcRenderer.invoke(MEMORY_CHANNELS.promptSave, input),
  promptRemove: (input: { projectId: string; promptId: string }) =>
    ipcRenderer.invoke(MEMORY_CHANNELS.promptRemove, input),
  promptPreview: (input: { projectId: string; promptId: string; values: Record<string, string> }) =>
    ipcRenderer.invoke(MEMORY_CHANNELS.promptPreview, input),
  promptImport: (projectId: string) => ipcRenderer.invoke(MEMORY_CHANNELS.promptImport, { projectId }),
  promptExport: (projectId: string) => ipcRenderer.invoke(MEMORY_CHANNELS.promptExport, { projectId }),
  portableExport: (input: unknown) => ipcRenderer.invoke(MEMORY_CHANNELS.portableExport, input),
  portableImport: (input: { kind: 'handoff' | 'resume' | 'settings'; replaceExisting?: boolean }) =>
    ipcRenderer.invoke(MEMORY_CHANNELS.portableImport, input),
  diagnosticsPreview: (input: unknown = {}) => ipcRenderer.invoke(MEMORY_CHANNELS.diagnosticsPreview, input),
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
  costLens: (input: { projectId: string; sessionId?: string | null }) => ipcRenderer.invoke(COST_CHANNELS.lens, input),
  costSetBudget: (input: BudgetInputView) => ipcRenderer.invoke(COST_CHANNELS.setBudget, input),
  costExport: (input: { projectId: string }) => ipcRenderer.invoke(COST_CHANNELS.exportCsv, input),
  taskBoard: (input: { projectId: string }) => ipcRenderer.invoke(TASK_CHANNELS.board, input),
  taskCreate: (input: TaskCreateView) => ipcRenderer.invoke(TASK_CHANNELS.create, input),
  appearanceGet: () => ipcRenderer.invoke(APPEARANCE_CHANNELS.get, {}),
  appearanceZoom: (input: { direction: 'in' | 'out' | 'reset' }) => ipcRenderer.invoke(APPEARANCE_CHANNELS.zoom, input),
  /** The main process pushes a new window scale after a Ctrl +/-/0 shortcut. */
  onAppearance: (handler: (view: AppearanceView) => void) => {
    const listener = (_event: unknown, payload: AppearanceView): void => handler(payload);
    ipcRenderer.on(APPEARANCE_CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(APPEARANCE_CHANNELS.event, listener);
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
  studioExport: (input: { projectId: string; sessionId: string; mode?: 'agent' | 'plan' }) =>
    ipcRenderer.invoke(STUDIO_CHANNELS.export, input),
  changesView: (input: { projectId: string }) => ipcRenderer.invoke(CHANGES_CHANNELS.view, input),
  changesDiff: (input: { projectId: string; path: string }) => ipcRenderer.invoke(CHANGES_CHANNELS.diff, input),
  changesCapture: (input: { projectId: string; label?: string }) => ipcRenderer.invoke(CHANGES_CHANNELS.capture, input),
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
  capabilitiesGet: () => ipcRenderer.invoke(CAPABILITY_CHANNELS.get, {}),
  capabilitiesReadLog: (input: { name: string; offset?: number; limit?: number }) =>
    ipcRenderer.invoke(CAPABILITY_CHANNELS.readLog, input),
  capabilitiesCheckTerminal: () => ipcRenderer.invoke(CAPABILITY_CHANNELS.checkTerminal, {}),
  terminalCreate: (input: { projectId: string; cols: number; rows: number }) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.create, input),
  terminalInput: (input: { projectId: string; sessionId: string; data: string }) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.input, input),
  terminalResize: (input: { projectId: string; sessionId: string; cols: number; rows: number }) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.resize, input),
  terminalKill: (input: { projectId: string; sessionId: string }) => ipcRenderer.invoke(TERMINAL_CHANNELS.kill, input),
  terminalRefresh: (input: { projectId: string; sessionId: string }) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.refresh, input),
  terminalCopy: (input: { data: string }) => ipcRenderer.invoke(TERMINAL_CHANNELS.copy, input),
  /** Terminal output and lifecycle. The only channel a terminal can reach. */
  onTerminalEvent: (handler: (event: TerminalEvent) => void) => {
    const listener = (_event: unknown, payload: TerminalEvent): void => handler(payload);
    ipcRenderer.on(TERMINAL_CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(TERMINAL_CHANNELS.event, listener);
    };
  },
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
