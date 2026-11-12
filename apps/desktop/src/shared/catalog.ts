import type { ErrorResult } from '@mona/contracts';
import type { EngineStatus } from './engine-status.js';

/**
 * Channel names for the project catalog and the small amount of independent UI
 * state Mona owns. Every one of these is invoked from the trusted main frame
 * only; the preload exposes named methods rather than a generic invoke.
 */
export const CATALOG_CHANNELS = {
  list: 'mona:catalog-list',
  open: 'mona:catalog-open',
  pickFolder: 'mona:catalog-pick-folder',
  create: 'mona:catalog-create',
  update: 'mona:catalog-update',
  remove: 'mona:catalog-remove',
  relocate: 'mona:catalog-relocate',
  reveal: 'mona:catalog-reveal',
  select: 'mona:catalog-select',
  engineState: 'mona:engine-state',
  engineStart: 'mona:engine-start',
  engineStop: 'mona:engine-stop',
  spend: 'mona:project-spend',
  uiGet: 'mona:ui-get',
  uiSetView: 'mona:ui-set-view',
  uiSaveDraft: 'mona:ui-save-draft',
  uiNewSession: 'mona:ui-new-session',
} as const;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorResult };

export type ProjectView = 'home' | 'studio' | 'work' | 'cost' | 'settings';

export type RepoKind = 'none' | 'git' | 'worktree';

export type RuntimeBindingView = {
  workspace: string;
  endpoint: string | null;
  pid: number | null;
  owned: boolean;
  state: string;
  engineVersion: string | null;
  engineCommit: string | null;
  lastSeenAt: string;
};

export type CatalogProject = {
  id: string;
  label: string;
  canonicalPath: string;
  repoKind: RepoKind;
  sharedRepoKey: string | null;
  branch: string | null;
  pinned: boolean;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  folderExists: boolean;
  markerId: string | null;
  color: string | null;
  monogram: string | null;
  worktreeSiblingIds: string[];
  binding: RuntimeBindingView | null;
};

/** Observed engine identity, never a hard-coded badge. */
export type EngineView = {
  state: EngineStatus;
  detail: string;
  workspace: string | null;
  pid: number | null;
  endpoint: string | null;
  compatibility: 'qualified' | 'compatible_unqualified' | 'unsupported' | null;
};

export type OpenProjectResult =
  | { status: 'created' | 'existing' | 'alias' | 'rebound'; project: CatalogProject }
  | { status: 'relocation_required'; project: CatalogProject; observedPath: string; reason: string };

export type ProjectSpend = {
  turnCount: number;
  knownCostMicros: number;
  unknownCostRecords: number;
};

export type DraftSession = {
  sessionId: string;
  updatedAt: string;
  text: string;
};

export type ProjectUiState = {
  view: ProjectView;
  currentSessionId: string;
  sessions: DraftSession[];
  lastOpenedAt: string | null;
};

export type UiStateView = {
  currentProjectId: string | null;
  projects: Record<string, ProjectUiState>;
  warning: string | null;
};

export type CatalogBridge = {
  listProjects(input?: { includeArchived?: boolean; query?: string }): Promise<IpcResult<CatalogProject[]>>;
  openProject(path: string): Promise<IpcResult<OpenProjectResult>>;
  pickFolder(purpose: 'open' | 'create-parent'): Promise<IpcResult<{ path: string | null }>>;
  createProject(input: { parent: string; name: string }): Promise<IpcResult<CatalogProject>>;
  updateProject(input: {
    projectId: string;
    expectedRevision: number;
    patch: { label?: string; pinned?: boolean; archived?: boolean };
  }): Promise<IpcResult<CatalogProject>>;
  removeProject(projectId: string): Promise<IpcResult<{ removed: boolean; folderStillExists: boolean }>>;
  relocateProject(input: {
    projectId: string;
    expectedRevision: number;
    path: string;
  }): Promise<IpcResult<CatalogProject>>;
  revealProject(projectId: string): Promise<IpcResult<{ revealed: boolean; detail: string }>>;
  selectProject(
    projectId: string | null,
  ): Promise<IpcResult<{ project: CatalogProject | null; engine: EngineView; ui: UiStateView }>>;
  engineState(): Promise<IpcResult<EngineView>>;
  startEngine(projectId: string): Promise<IpcResult<{ engine: EngineView; project: CatalogProject }>>;
  stopEngine(): Promise<IpcResult<{ engine: EngineView }>>;
  projectSpend(projectId: string): Promise<IpcResult<ProjectSpend>>;
  getUiState(): Promise<IpcResult<UiStateView>>;
  setProjectView(input: { projectId: string; view: ProjectView }): Promise<IpcResult<UiStateView>>;
  saveDraft(input: { projectId: string; sessionId: string; text: string }): Promise<IpcResult<UiStateView>>;
  newSession(projectId: string): Promise<IpcResult<UiStateView>>;
};
