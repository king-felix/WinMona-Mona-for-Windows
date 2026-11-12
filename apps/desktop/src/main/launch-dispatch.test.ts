import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, ProjectStore } from '@mona/project-state';
import type { CatalogProject, UiStateView } from '../shared/catalog.js';
import type { LaunchReceipt } from '../shared/launch.js';
import { CatalogService, type EnginePort } from './catalog-service.js';
import { LaunchDispatcher, type LaunchIntent } from './launch-dispatch.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p09-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function folder(label: string): Promise<string> {
  const root = await tempDir(label);
  const target = path.join(root, `${label} folder`);
  await mkdir(target, { recursive: true });
  return target;
}

type Harness = {
  service: CatalogService;
  dispatcher: LaunchDispatcher;
  receipts: LaunchReceipt[];
  projectViews: string[];
  pickCalls: string[];
  engine: FakeEngine;
  store: ProjectStore;
  setPicker: (value: string | null) => void;
};

type FakeEngine = {
  port: EnginePort;
  startCalls: number;
  workspace: string | null;
  state: 'not_started' | 'connected';
};

function fakeEngine(): FakeEngine {
  const engine: FakeEngine = {
    startCalls: 0,
    workspace: null,
    state: 'not_started',
    port: {
      summary: () => ({
        state: engine.state,
        detail: engine.state === 'connected' ? 'Owned runtime started.' : 'No runtime is running.',
        workspace: engine.workspace,
        pid: engine.state === 'connected' ? 6123 : null,
        endpoint: engine.state === 'connected' ? 'http://127.0.0.1:7801' : null,
        compatibility: engine.state === 'connected' ? 'qualified' : null,
        descriptors: [],
      }),
      startProjectRuntime: async ({ workspace }) => {
        engine.startCalls += 1;
        engine.state = 'connected';
        engine.workspace = workspace;
        return { ok: true as const, endpoint: 'http://127.0.0.1:7801' };
      },
      stopOwned: async () => {
        engine.state = 'not_started';
        engine.workspace = null;
        return { ok: true };
      },
    },
  };
  return engine;
}

async function harness(options: { profilePosture?: string } = {}): Promise<Harness> {
  const root = await tempDir('state');
  const store = new ProjectStore({ file: path.join(root, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  const ui = new UiStateStore({ file: path.join(root, 'ui-state.json') });
  const engine = fakeEngine();
  const projectViews: string[] = [];
  const pickCalls: string[] = [];
  let picker: string | null = null;

  const service = new CatalogService({
    store,
    ui,
    engine: engine.port,
    pickFolder: async (purpose) => {
      pickCalls.push(purpose);
      return picker;
    },
    reveal: async () => ({ ok: true, detail: 'ok' }),
  });

  const receipts: LaunchReceipt[] = [];
  const dispatcher = new LaunchDispatcher({
    service,
    ui: {
      setView: (projectId, view): UiStateView => {
        projectViews.push(`${projectId}:${view}`);
        return ui.setView(projectId, view);
      },
    },
    engine: engine.port,
    profile: () => ({
      label: 'Full Access',
      profile: 'DS',
      permissionPosture: options.profilePosture ?? 'full_access',
    }),
    pickFolder: async () => {
      pickCalls.push('launch');
      return picker;
    },
    emit: (receipt) => receipts.push(receipt),
    platform: process.platform,
  });

  return {
    service,
    dispatcher,
    receipts,
    projectViews,
    pickCalls,
    engine,
    store,
    setPicker: (value) => {
      picker = value;
    },
  };
}

function intent(paths: string[], profile: string | null = 'ds-full-access'): LaunchIntent {
  return { source: 'second-instance', paths, profile, problem: null };
}

describe('launch dispatch', () => {
  it('opens a folder, records the studio view, starts the runtime and sends no task', async () => {
    const h = await harness();
    const target = await folder('alpha');
    const receipts = await h.dispatcher.enqueue(intent([target]));
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0] as LaunchReceipt;
    expect(receipt.status).toBe('ready');
    expect(receipt.project?.canonicalPath).toBe(target.toLowerCase());
    expect(receipt.engine?.state).toBe('connected');
    expect(receipt.profile).toEqual({ label: 'Full Access', profile: 'DS', posture: 'full_access' });
    expect(receipt.focusComposer).toBe(true);
    expect(receipt.detail).toContain('No task was sent');
    expect(h.engine.startCalls).toBe(1);
    expect(h.projectViews).toEqual([`${receipt.project?.id}:studio`]);
    // A launch is not work: no thread, turn or submission exists.
    expect(receipt.project ? await h.store.countThreads(receipt.project.id) : -1).toBe(0);
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(1);
  });

  it('reuses an existing project and coalesces two identical fast launches', async () => {
    const h = await harness();
    const target = await folder('reused');
    const [first, second] = await Promise.all([
      h.dispatcher.enqueue(intent([target])),
      h.dispatcher.enqueue(intent([target])),
    ]);
    expect(first).toBe(second);
    expect(h.receipts).toHaveLength(1);
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(1);
    expect(h.engine.startCalls).toBe(1);
  });

  it('re-launching after the first launch settles does not duplicate the project', async () => {
    const h = await harness();
    const target = await folder('again');
    await h.dispatcher.enqueue(intent([target]));
    await h.dispatcher.enqueue(intent([target]));
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(1);
    expect(h.receipts).toHaveLength(2);
    expect(h.receipts.every((receipt) => receipt.status === 'ready')).toBe(true);
    // The runtime already serves this workspace, so the second launch does not
    // start a second one.
    expect(h.engine.startCalls).toBe(1);
  });

  it('processes two different fast launches in order and reports the busy runtime honestly', async () => {
    const h = await harness();
    const alpha = await folder('alpha');
    const beta = await folder('beta');
    const [first, second] = await Promise.all([
      h.dispatcher.enqueue(intent([alpha])),
      h.dispatcher.enqueue(intent([beta])),
    ]);
    const firstReceipts = first as LaunchReceipt[];
    const secondReceipts = second as LaunchReceipt[];
    expect(firstReceipts[0]?.seq).toBe(1);
    expect(secondReceipts[0]?.seq).toBe(2);
    expect(firstReceipts[0]?.status).toBe('ready');
    // One runtime is owned. The second project opens, but Mona refuses to start
    // a second workspace runtime and says so.
    expect(secondReceipts[0]?.status).toBe('opened');
    expect(secondReceipts[0]?.detail).toContain('runtime is serving');
    expect(secondReceipts[0]?.focusComposer).toBe(true);
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(2);
    expect(h.engine.startCalls).toBe(1);
  });

  it('asks for a project folder when the shell selected a drive root', async () => {
    const h = await harness();
    const target = await folder('chosen');
    h.setPicker(target);
    const receipts = await h.dispatcher.enqueue(intent(['C:\\']));
    const receipt = receipts[0] as LaunchReceipt;
    expect(h.pickCalls).toContain('launch');
    expect(receipt.status).toBe('ready');
    expect(receipt.openedPath).toBe(target.toLowerCase());
    expect(receipt.detail).not.toContain('whole drive');
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(1);
  });

  it('opens nothing when broad-root selection is cancelled', async () => {
    const h = await harness();
    h.setPicker(null);
    const receipts = await h.dispatcher.enqueue(intent(['C:\\']));
    expect(receipts[0]?.status).toBe('needs-selection');
    expect(receipts[0]?.detail).toContain('No project folder was opened');
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(0);
    expect(h.engine.startCalls).toBe(0);
  });

  it('rejects a missing folder without registering anything', async () => {
    const h = await harness();
    const root = await tempDir('missing-root');
    const receipts = await h.dispatcher.enqueue(intent([path.join(root, 'not-there')]));
    expect(receipts[0]?.status).toBe('rejected');
    expect(receipts[0]?.detail).toContain('was not found');
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(0);
  });

  it('refuses to create a second project when a moved folder needs a deliberate rebind', async () => {
    const h = await harness();
    const original = await folder('moved');
    const first = await h.dispatcher.enqueue(intent([original]));
    const project = (first[0] as LaunchReceipt).project as CatalogProject;
    const moved = `${original}-new-home`;
    await rename(original, moved);

    const receipts = await h.dispatcher.enqueue(intent([moved]));
    expect(receipts[0]?.status).toBe('relocation-required');
    expect(receipts[0]?.project?.id).toBe(project.id);
    const listed = await h.service.list();
    expect(listed.ok && listed.data.length).toBe(1);
  });

  it('surfaces a pre-parse problem as a receipt and changes nothing', async () => {
    const h = await harness();
    const receipts = await h.dispatcher.enqueue({
      source: 'startup',
      paths: [],
      profile: null,
      problem: {
        code: 'missing_path',
        detail: 'No folder was selected for Mona to open (--path <folder> is required).',
      },
    });
    expect(receipts[0]?.status).toBe('rejected');
    expect(receipts[0]?.detail).toContain('No folder was selected');
    expect(h.engine.startCalls).toBe(0);
  });

  it('does not rewrite a saved profile that is not full access', async () => {
    const h = await harness({ profilePosture: 'workspace_write' });
    const target = await folder('posture');
    const receipts = await h.dispatcher.enqueue(intent([target]));
    expect(receipts[0]?.profile?.posture).toBe('workspace_write');
    expect(receipts[0]?.warnings.join(' ')).toContain('does not change a saved posture');
    // The project is still opened honestly rather than pretending compliance.
    expect(receipts[0]?.status).toBe('ready');
  });

  it('records an engine failure as an opened project, not a ready one', async () => {
    const h = await harness();
    const target = await folder('broken-engine');
    h.engine.port.startProjectRuntime = async () => ({
      ok: false as const,
      error: { code: 'engine_unavailable' as const, message: 'Codewhale failed to start.', retryable: true },
    });
    const receipts = await h.dispatcher.enqueue(intent([target]));
    expect(receipts[0]?.status).toBe('opened');
    expect(receipts[0]?.detail).toContain('runtime did not start');
    expect(receipts[0]?.focusComposer).toBe(true);
  });
});
