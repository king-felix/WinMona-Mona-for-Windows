import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { errorResult, type ErrorResult } from '@mona/contracts';
import { ProjectCatalog, StateError, type CatalogEntry, type ProjectStore } from '@mona/project-state';
import type {
  CatalogProject,
  EngineView,
  OpenProjectResult,
  ProjectSpend,
  ProjectView,
  UiStateView,
} from '../shared/catalog.js';
import type { EngineSummary } from './engine-host.js';
import type { UiStateStore } from './ui-state.js';

/** The engine facts the catalog needs; the real EngineHost satisfies this. */
export type EnginePort = {
  summary(): EngineSummary;
  startProjectRuntime(input: {
    workspace: string;
  }): Promise<{ ok: true; endpoint: string } | { ok: false; error: ErrorResult }>;
  stopOwned(reason: string): Promise<unknown>;
};

export type CatalogServiceDeps = {
  store: ProjectStore;
  ui: UiStateStore;
  engine: EnginePort;
  pickFolder: (purpose: 'open' | 'create-parent') => Promise<string | null>;
  reveal: (target: string) => Promise<{ ok: boolean; detail: string }>;
  folderExists?: (target: string) => boolean;
  readBranch?: (target: string) => string | null;
};

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ErrorResult };
type ServiceResult<T> = Success<T> | Failure;

const LABEL_MAX = 120;
const NAME_PATTERN = /^[^<>:"/\\|?*]+$/;

/** Control characters are rejected by code point rather than by a regex class. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Every catalog action a shell can take, with its validation and its honest
 * failure. Rendering lives elsewhere; this class is also the test surface for
 * "switching projects never mixes drafts, turns, costs or permissions".
 */
export class CatalogService {
  readonly catalog: ProjectCatalog;
  private readonly store: ProjectStore;
  private readonly ui: UiStateStore;
  private readonly engine: EnginePort;
  private readonly pickFolderDialog: CatalogServiceDeps['pickFolder'];
  private readonly revealFolder: CatalogServiceDeps['reveal'];
  private readonly folderExists: (target: string) => boolean;

  constructor(deps: CatalogServiceDeps) {
    this.store = deps.store;
    this.ui = deps.ui;
    this.engine = deps.engine;
    this.pickFolderDialog = deps.pickFolder;
    this.revealFolder = deps.reveal;
    this.folderExists = deps.folderExists ?? existsSync;
    this.catalog = new ProjectCatalog(deps.store, {
      ...(deps.folderExists ? { folderExists: deps.folderExists } : {}),
      ...(deps.readBranch ? { readBranch: deps.readBranch } : {}),
    });
  }

  async list(input: { includeArchived?: boolean; query?: string } = {}): Promise<ServiceResult<CatalogProject[]>> {
    return this.attempt(async () => {
      const entries = await this.catalog.list({
        includeArchived: input.includeArchived ?? false,
        query: input.query ?? '',
      });
      return entries.map(toCatalogProject);
    });
  }

  async open(target: string, options: { label?: string } = {}): Promise<ServiceResult<OpenProjectResult>> {
    return this.attempt(async () => {
      if (typeof target !== 'string' || !target.trim()) {
        throw new ServiceFailure(errorResult('invalid_request', 'Choose a folder to open.'));
      }
      const outcome = await this.store.registerProject(target, {
        ...(options.label ? { label: options.label } : {}),
      });
      if (outcome.status === 'relocation_required') {
        const entry = await this.catalog.describe(outcome.project);
        return {
          status: 'relocation_required',
          project: toCatalogProject(entry),
          observedPath: outcome.observedPath,
          reason: outcome.reason,
        };
      }
      this.ui.select(outcome.project.id);
      const entry = await this.catalog.get(outcome.project.id);
      if (!entry)
        throw new ServiceFailure(errorResult('internal', 'The project was registered but could not be read back.'));
      return { status: outcome.status, project: toCatalogProject(entry) };
    });
  }

  async pickFolder(purpose: 'open' | 'create-parent'): Promise<ServiceResult<{ path: string | null }>> {
    return this.attempt(async () => ({ path: await this.pickFolderDialog(purpose) }));
  }

  async create(parent: string, name: string): Promise<ServiceResult<CatalogProject>> {
    return this.attempt(async () => {
      const trimmed = name.trim();
      if (
        !trimmed ||
        trimmed === '.' ||
        trimmed === '..' ||
        trimmed.length > 80 ||
        !NAME_PATTERN.test(trimmed) ||
        hasControlCharacters(trimmed)
      ) {
        throw new ServiceFailure(
          errorResult('invalid_request', 'Use a folder name without path separators or reserved characters.'),
        );
      }
      if (!parent.trim()) throw new ServiceFailure(errorResult('invalid_request', 'Choose a parent folder.'));
      let parentInfo;
      try {
        parentInfo = statSync(parent);
      } catch {
        throw new ServiceFailure(errorResult('invalid_request', `The parent folder ${parent} does not exist.`));
      }
      if (!parentInfo.isDirectory()) {
        throw new ServiceFailure(errorResult('invalid_request', `${parent} is not a folder.`));
      }
      const target = path.join(parent, trimmed);
      try {
        mkdirSync(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          throw new ServiceFailure(
            errorResult('invalid_request', `${trimmed} already exists in that folder. Open it instead.`),
          );
        }
        throw error;
      }
      const outcome = await this.store.registerProject(target, { label: trimmed });
      if (outcome.status === 'relocation_required') {
        throw new ServiceFailure(errorResult('invalid_request', outcome.reason));
      }
      this.ui.select(outcome.project.id);
      const entry = await this.catalog.get(outcome.project.id);
      if (!entry)
        throw new ServiceFailure(errorResult('internal', 'The project was created but could not be read back.'));
      return toCatalogProject(entry);
    });
  }

  async update(
    projectId: string,
    expectedRevision: number,
    patch: { label?: string; pinned?: boolean; archived?: boolean },
  ): Promise<ServiceResult<CatalogProject>> {
    return this.attempt(async () => {
      const next: { label?: string; pinned?: boolean; archived?: boolean } = {};
      if (patch.label !== undefined) {
        const label = patch.label.trim();
        if (!label || label.length > LABEL_MAX) {
          throw new ServiceFailure(errorResult('invalid_request', 'A project label must be 1–120 characters.'));
        }
        next.label = label;
      }
      if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
      if (patch.archived !== undefined) next.archived = Boolean(patch.archived);
      const row = await this.store.updateProject(projectId, expectedRevision, next);
      const entry = await this.catalog.describe(row);
      return toCatalogProject(entry);
    });
  }

  async remove(projectId: string): Promise<ServiceResult<{ removed: boolean; folderStillExists: boolean }>> {
    return this.attempt(async () => {
      const project = await this.store.getProject(projectId);
      if (!project) throw new ServiceFailure(errorResult('not_found', 'That project is not in the catalog.'));
      const result = await this.store.removeProject(projectId);
      this.ui.forget(projectId);
      // Removing a catalog entry is not deleting a folder. Report the observed
      // truth rather than assuming either answer.
      return { removed: result.removed, folderStillExists: this.folderExists(project.canonicalPath) };
    });
  }

  async relocate(projectId: string, expectedRevision: number, target: string): Promise<ServiceResult<CatalogProject>> {
    return this.attempt(async () => {
      if (!target.trim()) throw new ServiceFailure(errorResult('invalid_request', 'Choose the folder’s new location.'));
      const row = await this.store.relocateProject(projectId, expectedRevision, target);
      this.ui.select(projectId);
      const entry = await this.catalog.describe(row);
      return toCatalogProject(entry);
    });
  }

  async reveal(projectId: string): Promise<ServiceResult<{ revealed: boolean; detail: string }>> {
    return this.attempt(async () => {
      const project = await this.store.getProject(projectId);
      if (!project) throw new ServiceFailure(errorResult('not_found', 'That project is not in the catalog.'));
      if (!this.folderExists(project.canonicalPath)) {
        throw new ServiceFailure(
          errorResult('not_found', 'The project folder is missing. Locate it before revealing it.'),
        );
      }
      const result = await this.revealFolder(project.canonicalPath);
      return { revealed: result.ok, detail: result.detail };
    });
  }

  async select(
    projectId: string | null,
  ): Promise<ServiceResult<{ project: CatalogProject | null; engine: EngineView; ui: UiStateView }>> {
    return this.attempt(async () => {
      if (projectId === null) {
        const ui = this.ui.select(null);
        return { project: null, engine: this.engineView(), ui };
      }
      const entry = await this.catalog.get(projectId);
      if (!entry) throw new ServiceFailure(errorResult('not_found', 'That project is not in the catalog.'));
      const ui = this.ui.select(projectId);
      return { project: toCatalogProject(entry), engine: this.engineView(), ui };
    });
  }

  engineState(): ServiceResult<EngineView> {
    return { ok: true, data: this.engineView() };
  }

  async startEngine(projectId: string): Promise<ServiceResult<{ engine: EngineView; project: CatalogProject }>> {
    return this.attempt(async () => {
      const entry = await this.catalog.get(projectId);
      if (!entry) throw new ServiceFailure(errorResult('not_found', 'That project is not in the catalog.'));
      if (!entry.folderExists) {
        throw new ServiceFailure(errorResult('invalid_request', 'The project folder is missing. Locate it first.'));
      }
      const current = this.engine.summary();
      if (current.state === 'connected' && current.workspace !== entry.canonicalPath) {
        throw new ServiceFailure(
          errorResult(
            'invalid_request',
            `A runtime is already serving ${current.workspace ?? 'another project'}. Stop it before starting this one.`,
          ),
        );
      }
      const started = await this.engine.startProjectRuntime({ workspace: entry.canonicalPath });
      if (!started.ok) {
        await this.store.putRuntimeBinding({
          projectId,
          workspace: entry.canonicalPath,
          owned: true,
          state: 'failed',
        });
        throw new ServiceFailure(started.error);
      }
      const summary = this.engine.summary();
      await this.store.putRuntimeBinding({
        projectId,
        workspace: entry.canonicalPath,
        endpoint: summary.endpoint,
        pid: summary.pid,
        owned: true,
        state: summary.state,
      });
      const refreshed = await this.catalog.get(projectId);
      if (!refreshed)
        throw new ServiceFailure(errorResult('internal', 'The project disappeared while starting the engine.'));
      return { engine: this.engineView(), project: toCatalogProject(refreshed) };
    });
  }

  async stopEngine(): Promise<ServiceResult<{ engine: EngineView }>> {
    return this.attempt(async () => {
      const summary = this.engine.summary();
      await this.engine.stopOwned('user_request');
      for (const binding of await this.store.listRuntimeBindings()) {
        if (binding.state === 'running' || (summary.workspace && binding.workspace === summary.workspace)) {
          await this.store.clearRuntimeBinding(binding.projectId);
        }
      }
      return { engine: this.engineView() };
    });
  }

  async spend(projectId: string): Promise<ServiceResult<ProjectSpend>> {
    return this.attempt(async () => {
      const usage = await this.store.projectUsage(projectId);
      return usage;
    });
  }

  uiState(): ServiceResult<UiStateView> {
    return { ok: true, data: this.ui.view() };
  }

  setView(projectId: string, view: ProjectView): ServiceResult<UiStateView> {
    return { ok: true, data: this.ui.setView(projectId, view) };
  }

  saveDraft(projectId: string, sessionId: string, text: string): ServiceResult<UiStateView> {
    return { ok: true, data: this.ui.saveDraft(projectId, sessionId, text) };
  }

  newSession(projectId: string): ServiceResult<UiStateView> {
    return { ok: true, data: this.ui.newSession(projectId) };
  }

  private engineView(): EngineView {
    const summary = this.engine.summary();
    return {
      state: summary.state,
      detail: summary.detail,
      workspace: summary.workspace,
      pid: summary.pid,
      endpoint: summary.endpoint,
      compatibility: summary.compatibility,
    };
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<ServiceResult<T>> {
    try {
      return { ok: true, data: await fn() };
    } catch (error) {
      return { ok: false, error: mapFailure(error) };
    }
  }
}

/** Failures that already carry a renderer-safe ErrorResult. */
class ServiceFailure extends Error {
  constructor(readonly result: ErrorResult) {
    super(result.message);
    this.name = 'ServiceFailure';
  }
}

function mapFailure(error: unknown): ErrorResult {
  if (error instanceof ServiceFailure) return error.result;
  if (error instanceof StateError) {
    switch (error.code) {
      case 'not_found':
        return errorResult('not_found', error.message);
      case 'invalid_request':
        return errorResult('invalid_request', error.message);
      case 'stale_revision':
        return errorResult('invalid_request', 'This project changed in another action. Reload and try again.', true);
      case 'alias_conflict':
      case 'relocation_required':
        return errorResult('invalid_request', error.message);
      case 'disk_full':
        return errorResult('internal', 'The local state disk is full; no partial catalog change was kept.', true);
      default:
        return errorResult('internal', error.message, true);
    }
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return errorResult('permission_denied', 'Windows denied access to that folder.');
  }
  if (code === 'ENOENT') {
    return errorResult('not_found', 'That folder or file no longer exists.');
  }
  return errorResult('internal', 'The catalog action failed unexpectedly.', true, String(error).slice(0, 500));
}

function toCatalogProject(entry: CatalogEntry): CatalogProject {
  return {
    id: entry.id,
    label: entry.label,
    canonicalPath: entry.canonicalPath,
    repoKind: entry.repoKind,
    sharedRepoKey: entry.sharedRepoKey,
    branch: entry.branch,
    pinned: entry.pinned,
    archived: entry.archived,
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    folderExists: entry.folderExists,
    markerId: entry.markerId,
    color: entry.color,
    monogram: entry.monogram,
    worktreeSiblingIds: entry.worktreeSiblingIds,
    binding: entry.binding
      ? {
          workspace: entry.binding.workspace,
          endpoint: entry.binding.endpoint,
          pid: entry.binding.pid,
          owned: entry.binding.owned,
          state: entry.binding.state,
          engineVersion: entry.binding.engineVersion,
          engineCommit: entry.binding.engineCommit,
          lastSeenAt: entry.binding.lastSeenAt,
        }
      : null,
  };
}
