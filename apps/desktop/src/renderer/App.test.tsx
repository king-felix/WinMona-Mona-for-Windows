// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CatalogProject,
  EngineView,
  IpcResult,
  ProjectSpend,
  ProjectView,
  UiStateView,
} from '../shared/catalog.js';
import type { AppInfo } from '../shared/ipc.js';
import { App } from './App.js';

const info: AppInfo = {
  schemaVersion: 1,
  name: 'Mona',
  version: '0.1.0',
  electron: '45.3.0',
  chrome: '140.0.0',
  node: '24.0.0',
  platform: 'win32',
  arch: 'x64',
  engine: {
    status: 'not_started',
    detail: 'No runtime is running.',
    descriptors: [],
    workspace: null,
    pid: null,
    endpoint: null,
    compatibility: null,
  },
  localState: { available: true, schemaVersion: 1, detail: 'Local state open at schema v1.' },
  route: {
    provider: 'deepseek',
    model: 'deepseek-flash',
    endpoint: 'https://api.deepseek.com',
    source: 'pinned build route; not contacted to display this',
  },
  permission: { label: 'Full Access', profile: 'DS', detail: 'Saved profile.' },
  credentials: { state: 'unknown', detail: 'Codewhale manages credentials.' },
  harnessEnabled: false,
};

function project(id: string, label: string, overrides: Partial<CatalogProject> = {}): CatalogProject {
  return {
    id,
    label,
    canonicalPath: `x:\\work\\${label}`.toLowerCase(),
    repoKind: 'git',
    sharedRepoKey: null,
    branch: `feature/${label}`,
    pinned: false,
    archived: false,
    revision: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    folderExists: true,
    markerId: id,
    color: null,
    monogram: null,
    worktreeSiblingIds: [],
    binding: null,
    ...overrides,
  };
}

function emptyUi(): UiStateView {
  return { currentProjectId: null, projects: {}, warning: null };
}

function engine(overrides: Partial<EngineView> = {}): EngineView {
  return {
    state: 'not_started',
    detail: 'No runtime is running.',
    workspace: null,
    pid: null,
    endpoint: null,
    compatibility: null,
    ...overrides,
  };
}

type Store = {
  projects: CatalogProject[];
  ui: UiStateView;
  engine: EngineView;
  spends: Record<string, ProjectSpend>;
};

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function bridgeFor(store: Store): Window['mona'] {
  const ensure = (id: string) => {
    if (!store.ui.projects[id]) {
      store.ui = {
        ...store.ui,
        projects: {
          ...store.ui.projects,
          [id]: {
            view: 'studio',
            currentSessionId: `ses_${id}`,
            sessions: [],
            lastOpenedAt: '2026-11-12T00:00:00.000Z',
          },
        },
      };
    }
  };
  const current = (id: string | null) => {
    if (id) ensure(id);
    store.ui = { ...store.ui, currentProjectId: id };
    return store.ui;
  };
  return {
    getAppInfo: async () => ok(info),
    listProjects: async (input: { query?: string } = {}) =>
      ok(
        store.projects.filter((entry) => {
          const needle = (input.query ?? '').toLowerCase();
          return !needle || entry.label.toLowerCase().includes(needle) || entry.canonicalPath.includes(needle);
        }),
      ),
    openProject: async () => ok({ status: 'existing' as const, project: store.projects[0] as CatalogProject }),
    pickFolder: async () => ok({ path: null }),
    createProject: async () => ok(store.projects[0] as CatalogProject),
    updateProject: async () => ok(store.projects[0] as CatalogProject),
    removeProject: async () => ok({ removed: true, folderStillExists: true }),
    relocateProject: async () => ok(store.projects[0] as CatalogProject),
    revealProject: async () => ok({ revealed: true, detail: 'Opened the folder in File Explorer.' }),
    selectProject: async (projectId: string | null) =>
      ok({
        project: store.projects.find((entry) => entry.id === projectId) ?? null,
        engine: store.engine,
        ui: current(projectId),
      }),
    engineState: async () => ok(store.engine),
    startEngine: async (projectId: string) => {
      const selected = store.projects.find((entry) => entry.id === projectId) as CatalogProject;
      store.engine = engine({
        state: 'connected',
        detail: 'Owned runtime started.',
        workspace: selected.canonicalPath,
        pid: 1234,
        endpoint: 'http://127.0.0.1:7801',
        compatibility: 'qualified',
      });
      return ok({ engine: store.engine, project: selected });
    },
    stopEngine: async () => {
      store.engine = engine({ state: 'stopped', detail: 'Stopped.' });
      return ok({ engine: store.engine });
    },
    projectSpend: async (projectId: string) =>
      ok(store.spends[projectId] ?? { turnCount: 0, knownCostMicros: 0, unknownCostRecords: 0 }),
    getUiState: async () => ok(store.ui),
    setProjectView: async ({ projectId, view }: { projectId: string; view: ProjectView }) => {
      const entry = store.ui.projects[projectId] ?? {
        view: 'studio' as const,
        currentSessionId: `ses_${projectId}`,
        sessions: [],
        lastOpenedAt: null,
      };
      store.ui = { ...store.ui, projects: { ...store.ui.projects, [projectId]: { ...entry, view } } };
      return ok(store.ui);
    },
    saveDraft: async ({ projectId, sessionId, text }: { projectId: string; sessionId: string; text: string }) => {
      const entry = store.ui.projects[projectId] ?? {
        view: 'studio' as const,
        currentSessionId: sessionId,
        sessions: [],
        lastOpenedAt: null,
      };
      const sessions = [...entry.sessions];
      const index = sessions.findIndex((session) => session.sessionId === sessionId);
      if (index >= 0) sessions[index] = { ...sessions[index], text } as (typeof sessions)[number];
      else sessions.unshift({ sessionId, updatedAt: '2026-11-12T00:00:00.000Z', text });
      store.ui = {
        ...store.ui,
        projects: {
          ...store.ui.projects,
          [projectId]: { ...entry, sessions, currentSessionId: sessionId },
        },
      };
      return ok(store.ui);
    },
    newSession: async (projectId: string) => {
      const entry = store.ui.projects[projectId];
      if (entry) {
        store.ui = {
          ...store.ui,
          projects: {
            ...store.ui.projects,
            [projectId]: {
              ...entry,
              currentSessionId: `ses_new_${projectId}`,
              sessions: [
                { sessionId: `ses_new_${projectId}`, updatedAt: '2026-11-12T00:00:01.000Z', text: '' },
                ...entry.sessions,
              ],
            },
          },
        };
      }
      return ok(store.ui);
    },
  } as unknown as Window['mona'];
}

async function render(): Promise<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> {
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return { root, container };
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find((node) =>
    (node.textContent ?? '').trim().startsWith(name),
  );
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

function exactButton(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (node) => (node.textContent ?? '').trim() === name,
  );
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('Mona shell', () => {
  it('shows a real empty catalog state without demanding an API key', async () => {
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    expect(document.body.textContent).toContain('Choose a folder to begin');
    expect(document.body.textContent).toContain('needs no API key');
    expect(document.querySelector('[data-testid="app-version"]')?.textContent).toContain('v0.1.0');
    expect(document.querySelector('[data-testid="engine-state"]')?.textContent).toBe('Engine not connected');
    await act(async () => root.unmount());
  });

  it('renders the catalog and opens a project without a model request', async () => {
    const alpha = project('prj_alpha', 'alpha');
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: { [alpha.id]: { turnCount: 2, knownCostMicros: 3_500, unknownCostRecords: 1 } },
    });
    const { root } = await render();
    expect(document.body.textContent).toContain('alpha');
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.querySelector('[data-testid="studio-title"]')?.textContent).toBe('alpha');
    expect(document.querySelector('[data-testid="context-branch"]')?.textContent).toBe('feature/alpha');
    expect(document.querySelector('[data-testid="context-model"]')?.textContent).toBe('deepseek-flash');
    expect(document.querySelector('[data-testid="context-permission"]')?.textContent).toContain('Full Access');
    expect(document.querySelector('[data-testid="context-spend"]')?.textContent).toContain('$0.0035');
    expect(document.querySelector('[data-testid="context-spend"]')?.textContent).toContain('unknown');
    expect(document.querySelector('[data-testid="connection-detail"]')?.textContent).toContain('No runtime');
    const submit = button('Submit');
    expect(submit.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it('keeps drafts isolated per project while switching', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const beta = project('prj_beta', 'beta');
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [alpha, beta],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'alpha draft');
    expect(draft.value).toBe('alpha draft');

    await act(async () => {
      const recentBeta = Array.from(document.querySelectorAll('.rail-recent')).find(
        (node) => node.textContent === 'beta',
      );
      recentBeta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const switched = document.querySelector<HTMLTextAreaElement>('#draft');
    expect(switched?.value).toBe('');
    await typeInto(switched as HTMLTextAreaElement, 'beta draft');

    await act(async () => {
      const recentAlpha = Array.from(document.querySelectorAll('.rail-recent')).find(
        (node) => node.textContent === 'alpha',
      );
      recentAlpha?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.querySelector<HTMLTextAreaElement>('#draft')?.value).toBe('alpha draft');
    await act(async () => root.unmount());
  });

  it('opens the command palette with Ctrl+K and closes with Escape', async () => {
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('[role="dialog"][aria-label="Command palette"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('.mona-palette input');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.querySelector('[role="dialog"][aria-label="Command palette"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('ignores the fixture harness unless the development flag is enabled', async () => {
    window.history.replaceState({}, '', '/?harness=1');
    const store: Store = { projects: [], ui: emptyUi(), engine: engine(), spends: {} };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const first = await render();
    expect(document.querySelector('[data-testid="harness"]')).toBeNull();
    await act(async () => first.root.unmount());

    document.body.innerHTML = '<div id="root"></div>';
    info.harnessEnabled = true;
    const second = await render();
    expect(document.querySelector('[data-testid="harness"]')).not.toBeNull();
    info.harnessEnabled = false;
    await act(async () => second.root.unmount());
  });

  it('reports a bridge failure instead of pretending the engine is ready', async () => {
    (window as unknown as { mona: Window['mona'] }).mona = {
      ...bridgeFor({ projects: [], ui: emptyUi(), engine: engine(), spends: {} }),
      getAppInfo: async () => ({
        ok: false,
        error: { code: 'untrusted_sender', message: 'IPC sender is not trusted.', retryable: false },
      }),
    } as unknown as Window['mona'];
    const { root } = await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('IPC sender is not trusted.');
    await act(async () => root.unmount());
  });
});
