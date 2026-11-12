import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, ProjectStore } from '@mona/project-state';
import type { CatalogProject, OpenProjectResult, UiStateView } from '../shared/catalog.js';
import { CatalogService, type EnginePort } from './catalog-service.js';
import { UiStateStore } from './ui-state.js';

const cleanup: Array<() => Promise<void>> = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p07-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function openStore(label: string): Promise<{ store: ProjectStore; dir: string }> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  return { store, dir };
}

async function folder(label: string): Promise<string> {
  const root = await tempDir(`${label}-root`);
  const target = path.join(root, label);
  await mkdir(target, { recursive: true });
  return target;
}

type FakeEngine = { port: EnginePort; startCalls: number; stopCalls: number };

type FakeSummary = {
  state: 'not_started' | 'connected' | 'stopped' | 'failed';
  detail: string;
  workspace: string | null;
  pid: number | null;
  endpoint: string | null;
  compatibility: 'qualified' | 'compatible_unqualified' | 'unsupported' | null;
  descriptors: string[];
};

function fakeEngine(): FakeEngine {
  let summary: FakeSummary = {
    state: 'not_started',
    detail: 'No runtime is running.',
    workspace: null,
    pid: null,
    endpoint: null,
    compatibility: null,
    descriptors: [],
  };
  const engine: FakeEngine = {
    startCalls: 0,
    stopCalls: 0,
    port: {
      summary: () => summary,
      startProjectRuntime: async ({ workspace }) => {
        engine.startCalls += 1;
        if (workspace.toLowerCase().includes('broken')) {
          return {
            ok: false as const,
            error: { code: 'engine_unavailable' as const, message: 'Codewhale failed to start.', retryable: true },
          };
        }
        summary = {
          state: 'connected',
          detail: `Owned runtime on ${workspace}`,
          workspace,
          pid: 6123,
          endpoint: 'http://127.0.0.1:7801',
          compatibility: 'qualified',
          descriptors: [],
        };
        return { ok: true as const, endpoint: 'http://127.0.0.1:7801' };
      },
      stopOwned: async () => {
        engine.stopCalls += 1;
        summary = {
          state: 'stopped',
          detail: 'Runtime stopped.',
          workspace: null,
          pid: null,
          endpoint: null,
          compatibility: null,
          descriptors: [],
        };
        return { ok: true };
      },
    },
  };
  return engine;
}

function serviceFor(store: ProjectStore, dir: string, engine: FakeEngine): CatalogService {
  return new CatalogService({
    store,
    ui: new UiStateStore({ file: path.join(dir, 'ui-state.json') }),
    engine: engine.port,
    pickFolder: async () => null,
    reveal: async () => ({ ok: true, detail: 'Opened the folder in File Explorer.' }),
  });
}

function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.data;
}

function expectProject(result: { ok: true; data: CatalogProject } | { ok: false; error: unknown }): CatalogProject {
  return expectOk(result);
}

function openedProject(result: { ok: true; data: OpenProjectResult } | { ok: false; error: unknown }): CatalogProject {
  const data = expectOk(result);
  if (data.status === 'relocation_required') throw new Error('unexpected relocation');
  return data.project;
}

function uiState(service: CatalogService): UiStateView {
  return expectOk(service.uiState());
}

describe('catalog service', () => {
  it('opens a folder, lists it, and does not start the engine or create a thread', async () => {
    const { store, dir } = await openStore('open');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const target = await folder('open-proj');

    const first = openedProject(await service.open(target));
    const listed = expectOk(await service.list());

    expect(listed).toHaveLength(1);
    expect(listed[0]?.canonicalPath.toLowerCase()).toBe(target.toLowerCase());
    expect(listed[0]?.folderExists).toBe(true);
    expect(engine.startCalls).toBe(0);
    expect(await store.countThreads(first.id)).toBe(0);
  });

  it('renames, pins, archives, restores, searches and removes without deleting files', async () => {
    const { store, dir } = await openStore('lifecycle');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const target = await folder('lifecycle-proj');
    await writeFile(path.join(target, 'keep.txt'), 'keep\n', 'utf8');
    const first = openedProject(await service.open(target));

    const renamed = expectProject(await service.update(first.id, first.revision, { label: 'Renamed', pinned: true }));
    expect(renamed.label).toBe('Renamed');
    const archived = expectProject(await service.update(first.id, renamed.revision, { archived: true }));
    expect(expectOk(await service.list())).toHaveLength(0);
    expect(expectOk(await service.list({ includeArchived: true })).map((entry) => entry.label)).toContain('Renamed');
    expectProject(await service.update(first.id, archived.revision, { archived: false }));

    const removed = expectOk(await service.remove(first.id));
    expect(removed).toEqual({ removed: true, folderStillExists: true });
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('deduplicates aliases and requires a deliberate rebind after a move', async () => {
    const { store, dir } = await openStore('move');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const target = await folder('move-proj');
    const first = openedProject(await service.open(target));

    const alias = expectOk(await service.open(path.join(target, '..', path.basename(target))));
    expect(alias.status).toBe('existing');
    if (alias.status !== 'relocation_required') expect(alias.project.id).toBe(first.id);

    const moved = `${target}-moved`;
    await rename(target, moved);
    const observed = expectOk(await service.open(moved));
    expect(observed.status).toBe('relocation_required');
    if (observed.status !== 'relocation_required') return;
    const rebound = expectProject(await service.relocate(first.id, first.revision, moved));
    expect(rebound.canonicalPath.toLowerCase()).toContain('moved');
  });

  it('creates a new folder and rejects unsafe names', async () => {
    const { store, dir } = await openStore('create');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const parent = await tempDir('create-parent');
    const created = expectProject(await service.create(parent, 'brand new'));
    expect(created.label).toBe('brand new');
    expect(existsSync(path.join(parent, 'brand new'))).toBe(true);

    for (const name of ['..', '.', 'a/b', 'a\\b', '']) {
      expect((await service.create(parent, name)).ok).toBe(false);
    }
    const duplicate = await service.create(parent, 'brand new');
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.message).toContain('already exists');
  });

  it('keeps drafts, views, costs and runtime bindings separate when switching projects', async () => {
    const { store, dir } = await openStore('isolation');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const alpha = await folder('alpha');
    const beta = await folder('beta');
    const a = openedProject(await service.open(alpha));
    const b = openedProject(await service.open(beta));

    const sessionA = uiState(service).projects[a.id]?.currentSessionId;
    const sessionB = uiState(service).projects[b.id]?.currentSessionId;
    if (!sessionA || !sessionB) throw new Error('missing sessions');
    service.saveDraft(a.id, sessionA, 'draft for alpha');
    service.saveDraft(b.id, sessionB, 'draft for beta');
    service.setView(a.id, 'studio');
    service.setView(b.id, 'cost');

    await store.write((tx) => {
      tx.recordUsage({ projectId: a.id, costKnown: true, costMicros: 1_000, source: 'engine' });
      tx.recordUsage({ projectId: b.id, costKnown: false, source: 'engine' });
    });

    const started = expectOk(await service.startEngine(a.id));
    expect(started.engine.state).toBe('connected');
    expect(started.engine.workspace?.toLowerCase()).toBe(alpha.toLowerCase());
    const blocked = await service.startEngine(b.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain('already serving');

    expect(expectOk(await service.spend(a.id))).toMatchObject({ knownCostMicros: 1_000, unknownCostRecords: 0 });
    expect(expectOk(await service.spend(b.id))).toMatchObject({ knownCostMicros: 0, unknownCostRecords: 1 });

    const state = uiState(service);
    expect(state.projects[a.id]?.sessions[0]?.text).toBe('draft for alpha');
    expect(state.projects[b.id]?.sessions[0]?.text).toBe('draft for beta');
    expect(state.projects[a.id]?.view).toBe('studio');
    expect(state.projects[b.id]?.view).toBe('cost');

    expect(expectOk(await service.stopEngine()).engine.state).toBe('stopped');
    expect((await store.getRuntimeBinding(a.id))?.state).toBe('stopped');
    expect(engine.stopCalls).toBe(1);
  });

  it('reports engine start failure and leaves the project usable offline', async () => {
    const { store, dir } = await openStore('offline');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const target = await folder('broken');
    const a = openedProject(await service.open(target));

    const failed = await service.startEngine(a.id);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('engine_unavailable');
    expect((await store.getRuntimeBinding(a.id))?.state).toBe('failed');

    const selected = expectOk(await service.select(a.id));
    expect(selected.project?.label).toBe('broken');
    expect(selected.engine.state).not.toBe('connected');
    expect(selected.ui.currentProjectId).toBe(a.id);
    expect(expectOk(await service.list({ query: 'broken' })).map((entry) => entry.label)).toEqual(['broken']);
  });

  it('survives a restart: catalog and UI state reload from disk', async () => {
    const { store, dir } = await openStore('restart');
    const engine = fakeEngine();
    const service = serviceFor(store, dir, engine);
    const target = await folder('restart-proj');
    const a = openedProject(await service.open(target));
    const session = uiState(service).projects[a.id]?.currentSessionId;
    if (!session) throw new Error('missing session');
    service.saveDraft(a.id, session, 'unsent words');
    service.setView(a.id, 'settings');
    store.close();
    stores.pop();

    const reopened = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
    stores.push(reopened);
    const restarted = serviceFor(reopened, dir, fakeEngine());
    const listed = expectOk(await restarted.list());
    expect(listed[0]?.id).toBe(a.id);
    const restored = uiState(restarted);
    expect(restored.currentProjectId).toBe(a.id);
    expect(restored.projects[a.id]?.view).toBe('settings');
    expect(restored.projects[a.id]?.sessions[0]?.text).toBe('unsent words');
  });

  it('reveals only a registered, existing project folder', async () => {
    const { store, dir } = await openStore('reveal');
    const engine = fakeEngine();
    const revealed: string[] = [];
    const service = new CatalogService({
      store,
      ui: new UiStateStore({ file: path.join(dir, 'ui-state.json') }),
      engine: engine.port,
      pickFolder: async () => null,
      reveal: async (target) => {
        revealed.push(target);
        return { ok: true, detail: 'Opened the folder in File Explorer.' };
      },
    });
    const target = await folder('reveal-proj');
    const a = openedProject(await service.open(target));
    expect(expectOk(await service.reveal(a.id))).toEqual({
      revealed: true,
      detail: 'Opened the folder in File Explorer.',
    });
    expect(revealed).toHaveLength(1);

    await rm(target, { recursive: true, force: true });
    expect((await service.reveal(a.id)).ok).toBe(false);
  });
});
