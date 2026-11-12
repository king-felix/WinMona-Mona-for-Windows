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
import type { AttentionFocus, AttentionView } from '../shared/attention.js';
import type { BriefingView } from '../shared/briefing.js';
import type { LaunchReceipt } from '../shared/launch.js';
import type { StudioEvent, StudioView } from '../shared/studio.js';
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
  return {
    currentProjectId: null,
    projects: {},
    preferences: {
      notificationsEnabled: true,
      quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'local' },
      density: 'comfortable',
      firstCloseNotified: false,
    },
    warning: null,
  };
}

function defaultAttention(): AttentionView {
  return {
    settings: {
      notificationsEnabled: true,
      quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'local' },
      density: 'comfortable',
      firstCloseNotified: false,
    },
    tray: { tone: 'idle', tooltip: 'Mona is idle', detail: 'No runtime is running.' },
    quietNow: false,
    quietDetail: 'Quiet hours are off. Notifications can be delivered at any time.',
    lastEvent: null,
  };
}

function emptyBriefing(projectId: string): BriefingView {
  const generatedAt = '2026-11-12T00:00:00.000Z';
  return {
    resume: {
      projectId,
      projectLabel: 'project',
      generatedAt,
      currentPrompt: null,
      blockers: [],
      lastTest: null,
      changes: { count: null, added: 0, modified: 0, deleted: 0, basis: 'none', truncated: false, detail: 'unknown' },
      spend: { knownMicros: 0, unknownRecords: 0, records: 0, confidence: 'none', label: 'No usage recorded' },
      nextStep: { taskId: null, text: 'No eligible task.' },
      progress: {
        tasksTotal: 0,
        completed: 0,
        blocked: 0,
        verifying: 0,
        verifiedEvidence: 0,
        note: 'Counts, not percentages.',
      },
      evidence: [],
      disclosure: ['Generated locally; no model was called.'],
    },
    since: {
      projectId,
      since: null,
      until: generatedAt,
      empty: true,
      groups: [],
      counts: {
        events: 0,
        tasksCompleted: 0,
        tasksBlocked: 0,
        testsPassed: 0,
        testsFailed: 0,
        changedFiles: null,
        knownMicros: 0,
        unknownRecords: 0,
        timelineItems: 0,
      },
      note: 'Grouped from recorded rows only.',
    },
  };
}

function richBriefing(projectId: string): BriefingView {
  const base = emptyBriefing(projectId);
  return {
    resume: {
      ...base.resume,
      projectLabel: 'alpha',
      currentPrompt: {
        id: 'tsk_alpha',
        title: 'Ship the briefing panel',
        status: 'running',
        owner: 'mona_queue',
        step: 'render the brief',
        requirementIds: ['MONA-029'],
        dependencies: [],
        evidencePaths: ['docs/evidence/P14-polish.md'],
      },
      blockers: [
        {
          kind: 'problem',
          id: 'prb_alpha',
          title: 'import fails',
          detail: '3 consecutive no-progress attempts of 3.',
          helpNeeded: 'confirm the fixture contents',
          evidencePaths: ['docs/evidence/P11-attempts.md'],
        },
      ],
      lastTest: {
        outcome: 'failed',
        command: 'npm test',
        finishedAt: '2026-11-12T00:00:00.000Z',
        recordedAt: '2026-11-12T00:00:00.000Z',
        commit: 'abc123',
        outputPath: 'docs/evidence/P14-tests.txt',
        outputSha256: 'f'.repeat(64),
      },
      changes: {
        count: 2,
        added: 1,
        modified: 1,
        deleted: 0,
        basis: 'git_status',
        truncated: false,
        detail: '2 path(s) differ from HEAD according to Git status.',
      },
      spend: {
        knownMicros: 2_500,
        unknownRecords: 1,
        records: 2,
        confidence: 'partial',
        label: '$0.0025 + 1 unknown record(s)',
      },
      nextStep: { taskId: 'tsk_alpha', text: 'Resume tsk_alpha at: render the brief (running).' },
      progress: {
        tasksTotal: 3,
        completed: 1,
        blocked: 1,
        verifying: 0,
        verifiedEvidence: 2,
        note: 'Counts of recorded task states. Mona does not infer a completion percentage.',
      },
      evidence: [{ label: 'tsk_alpha', path: 'docs/evidence/P14-polish.md', at: null }],
    },
    since: {
      ...base.since,
      since: '2026-11-11T00:00:00.000Z',
      empty: false,
      groups: [
        {
          id: 'completed',
          label: 'Finished',
          items: [
            {
              at: '2026-11-12T00:00:00.000Z',
              summary: 'tsk_prev completed: earlier work',
              tone: 'success',
              taskId: 'tsk_prev',
              evidencePath: 'docs/evidence/P10-continuity.md',
              kind: 'task_completed',
            },
          ],
        },
      ],
      counts: {
        events: 1,
        tasksCompleted: 1,
        tasksBlocked: 0,
        testsPassed: 0,
        testsFailed: 0,
        changedFiles: 2,
        knownMicros: 2_500,
        unknownRecords: 1,
        timelineItems: 0,
      },
    },
  };
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
  studio?: StudioView;
  studioHandlers?: Array<(event: StudioEvent) => void>;
  submitted?: Array<{ text: string; mode: string; references: string[] }>;
  launchHandlers?: Array<(receipt: LaunchReceipt) => void>;
  launch?: LaunchReceipt | null;
  attention?: AttentionView;
  briefing?: BriefingView;
  focusHandlers?: Array<(focus: AttentionFocus) => void>;
  layouts?: Array<{ projectId: string; layout: string }>;
};

function emptyStudio(): StudioView {
  return {
    projectId: null,
    sessionId: null,
    thread: null,
    items: [],
    run: { state: 'idle', detail: 'Ready. Nothing has been sent.', turnId: null, submission: null, startedAt: null },
    control: { pauseRequested: false, queueState: 'idle', lastOutcome: null, interrupt: null, blockedProblem: null },
    pending: null,
    diagnostics: [],
    capabilities: {
      planMode: { status: 'supported', reason: null },
      approvalResponse: { status: 'unsupported', reason: 'Mona does not send approval decisions in this build.' },
      attachments: { status: 'unsupported', reason: 'The turn contract sends text and file references only.' },
    },
    warning: null,
  };
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function launchFor(target: CatalogProject, seq: number): LaunchReceipt {
  return {
    seq,
    at: '2026-11-12T00:00:00.000Z',
    source: 'second-instance',
    requestedPath: target.canonicalPath,
    openedPath: target.canonicalPath,
    status: 'ready',
    detail: `${target.label} is open from Explorer and the runtime is ready. No task was sent.`,
    warnings: [],
    project: target,
    engine: engine({
      state: 'connected',
      detail: 'Owned runtime started.',
      workspace: target.canonicalPath,
      pid: 99,
      endpoint: 'http://127.0.0.1:7801',
      compatibility: 'qualified',
    }),
    profile: { label: 'Full Access', profile: 'DS', posture: 'full_access' },
    focusComposer: true,
  };
}

function bridgeFor(store: Store): Window['mona'] {
  const studio = (): StudioView => (store.studio ??= emptyStudio());
  const handlers = (store.studioHandlers ??= []);
  const submitted = (store.submitted ??= []);
  const ensure = (id: string) => {
    if (!store.ui.projects[id]) {
      store.ui = {
        ...store.ui,
        projects: {
          ...store.ui.projects,
          [id]: {
            view: 'studio',
            layout: 'standard',
            currentSessionId: `ses_${id}`,
            sessions: [],
            favorites: [],
            lastOpenedAt: '2026-11-12T00:00:00.000Z',
            lastSeenAt: null,
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
        layout: 'standard' as const,
        currentSessionId: `ses_${projectId}`,
        sessions: [],
        favorites: [],
        lastOpenedAt: null,
        lastSeenAt: null,
      };
      store.ui = { ...store.ui, projects: { ...store.ui.projects, [projectId]: { ...entry, view } } };
      return ok(store.ui);
    },
    saveDraft: async ({ projectId, sessionId, text }: { projectId: string; sessionId: string; text: string }) => {
      const entry = store.ui.projects[projectId] ?? {
        view: 'studio' as const,
        layout: 'standard' as const,
        currentSessionId: sessionId,
        sessions: [],
        favorites: [],
        lastOpenedAt: null,
        lastSeenAt: null,
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
    studioGet: async (input: { projectId: string; sessionId: string }) =>
      ok({ ...studio(), projectId: input.projectId, sessionId: input.sessionId }),
    studioSubmit: async (input: { text: string; mode: string; references: string[] }) => {
      submitted.push({ text: input.text, mode: input.mode, references: input.references });
      store.studio = {
        ...studio(),
        run: {
          state: 'running',
          detail: 'Turn accepted by the runtime.',
          turnId: 'turn_1',
          submission: { submissionId: 'sub_1', state: 'accepted', replayed: false },
          startedAt: '2026-11-12T00:00:00.000Z',
        },
      };
      return ok({
        submissionId: 'sub_1',
        threadId: 'thr_1',
        turnId: 'turn_1',
        state: 'accepted',
        replayed: false,
        reconciliation: { required: false },
        prompt: input.text,
        thread: studio().thread,
        run: studio().run,
      });
    },
    studioInterrupt: async () => {
      store.studio = {
        ...studio(),
        run: { ...studio().run, state: 'interrupting', detail: 'Interrupt acknowledged.' },
      };
      return ok({ run: studio().run, control: studio().control });
    },
    studioPause: async () => {
      store.studio = {
        ...studio(),
        control: { ...studio().control, pauseRequested: true, queueState: 'running' },
      };
      return ok({ run: studio().run, control: studio().control });
    },
    studioResume: async () => {
      store.studio = {
        ...studio(),
        control: { ...studio().control, pauseRequested: false, queueState: 'idle' },
      };
      return ok({ run: studio().run, control: studio().control });
    },
    studioPickReferences: async () => ok({ paths: ['src/app.test.ts'] }),
    onStudioEvent: (handler: (event: StudioEvent) => void) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    getLaunchState: async () => ok({ latest: store.launch ?? null, count: store.launch?.seq ?? 0 }),
    onLaunchEvent: (handler: (receipt: LaunchReceipt) => void) => {
      const list = (store.launchHandlers ??= []);
      list.push(handler);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    setProjectLayout: async ({ projectId, layout }: { projectId: string; layout: 'standard' | 'focus' }) => {
      (store.layouts ??= []).push({ projectId, layout });
      ensure(projectId);
      const entry = store.ui.projects[projectId] as NonNullable<(typeof store.ui.projects)[string]>;
      store.ui = { ...store.ui, projects: { ...store.ui.projects, [projectId]: { ...entry, layout } } };
      return ok(store.ui);
    },
    saveFavorite: async ({ projectId, label, text }: { projectId: string; label: string; text: string }) => {
      ensure(projectId);
      const entry = store.ui.projects[projectId] as NonNullable<(typeof store.ui.projects)[string]>;
      store.ui = {
        ...store.ui,
        projects: {
          ...store.ui.projects,
          [projectId]: {
            ...entry,
            favorites: [{ id: `pfv_${label}`, label, text, createdAt: '2026-11-12T00:00:00.000Z' }, ...entry.favorites],
          },
        },
      };
      return ok(store.ui);
    },
    removeFavorite: async ({ projectId, favoriteId }: { projectId: string; favoriteId: string }) => {
      ensure(projectId);
      const entry = store.ui.projects[projectId] as NonNullable<(typeof store.ui.projects)[string]>;
      store.ui = {
        ...store.ui,
        projects: {
          ...store.ui.projects,
          [projectId]: { ...entry, favorites: entry.favorites.filter((item) => item.id !== favoriteId) },
        },
      };
      return ok(store.ui);
    },
    briefingGet: async ({ projectId }: { projectId: string }) => ok(store.briefing ?? emptyBriefing(projectId)),
    attentionGet: async () => ok(store.attention ?? defaultAttention()),
    attentionSet: async (patch: Partial<AttentionView['settings']>) => {
      const base = store.attention ?? defaultAttention();
      store.attention = { ...base, settings: { ...base.settings, ...patch } };
      return ok(store.attention);
    },
    attentionQuitStop: async () => ok({ requested: true, detail: 'Quit requested.' }),
    onAttentionFocus: (handler: (focus: AttentionFocus) => void) => {
      const list = (store.focusHandlers ??= []);
      list.push(handler);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
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

async function typeIntoInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
      const recentBeta = Array.from(document.querySelectorAll('.rail-recent')).find((node) =>
        node.textContent?.trim().endsWith('beta'),
      );
      recentBeta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const switched = document.querySelector<HTMLTextAreaElement>('#draft');
    expect(switched?.value).toBe('');
    await typeInto(switched as HTMLTextAreaElement, 'beta draft');

    await act(async () => {
      const recentAlpha = Array.from(document.querySelectorAll('.rail-recent')).find((node) =>
        node.textContent?.trim().endsWith('alpha'),
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

  it('drives the live studio: observed permission, submit receipt, and pending approval', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const store: Store = {
      projects: [alpha],
      ui: emptyUi(),
      engine: engine({
        state: 'connected',
        detail: 'Owned runtime started.',
        workspace: alpha.canonicalPath,
        pid: 4321,
        endpoint: 'http://127.0.0.1:7801',
        compatibility: 'qualified',
      }),
      spends: {},
      studio: {
        ...emptyStudio(),
        thread: {
          threadId: 'thr_00000000000000000000000000000001',
          workspace: alpha.canonicalPath,
          provider: 'deepseek',
          model: 'deepseek-flash',
          mode: 'agent',
          permissionPosture: 'full_access',
          allowShell: true,
          trustMode: true,
          autoApprove: true,
          observedAt: '2026-11-12T00:00:00.000Z',
        },
      },
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(document.querySelector('[data-testid="studio-permission"]')?.textContent).toContain('Full Access');
    expect(document.querySelector('[data-testid="mode-plan"]')?.textContent).toBe('Plan');
    expect(document.querySelector('[data-testid="mode-agent"]')?.textContent).toBe('Work');
    const attach = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent ?? '').includes('Attach file'),
    );
    expect(attach?.disabled).toBe(true);

    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'Say MONA_OK');
    const submit = exactButton('Submit');
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(store.submitted).toEqual([{ text: 'Say MONA_OK', mode: 'agent', references: [] }]);
    expect(document.body.textContent).toContain('Sending…');

    await act(async () => {
      for (const handler of store.studioHandlers ?? []) {
        handler({
          type: 'item',
          projectId: alpha.id,
          item: {
            id: 'tl_1',
            seq: 1,
            turnId: 'turn_1',
            kind: 'user',
            title: 'You',
            body: 'Say MONA_OK',
            status: 'completed',
            truncated: false,
            at: '2026-11-12T00:00:00.000Z',
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.body.textContent).not.toContain('Sending…');
    expect(document.querySelectorAll('[data-testid="timeline-user"]')).toHaveLength(1);

    await act(async () => {
      for (const handler of store.studioHandlers ?? []) {
        handler({
          type: 'state',
          projectId: alpha.id,
          thread: store.studio?.thread ?? null,
          run: {
            state: 'awaiting_approval',
            detail: 'The runtime paused for an approval.',
            turnId: 'turn_1',
            submission: null,
            startedAt: null,
          },
          control: {
            pauseRequested: false,
            queueState: 'running',
            lastOutcome: null,
            interrupt: null,
            blockedProblem: null,
          },
          pending: {
            kind: 'approval',
            approvalId: 'appr_1',
            toolName: 'bash',
            description: 'rm -rf dist needs approval',
            at: '2026-11-12T00:00:00.000Z',
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.querySelector('[data-testid="studio-pending"]')?.textContent).toContain('rm -rf dist');
    expect(document.querySelector('[data-testid="studio-run-state"]')?.textContent).toBe('Awaiting approval');
    await act(async () => root.unmount());
  });

  it('keeps a duplicate streamed item from appearing twice', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const item = {
      id: 'tl_dup',
      seq: 4,
      turnId: 'turn_1',
      kind: 'assistant' as const,
      title: 'Assistant',
      body: 'MONA',
      status: 'streaming',
      truncated: false,
      at: '2026-11-12T00:00:00.000Z',
    };
    const store: Store = {
      projects: [alpha],
      ui: emptyUi(),
      engine: engine({ state: 'connected', workspace: alpha.canonicalPath }),
      spends: {},
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      for (const handler of store.studioHandlers ?? []) {
        handler({ type: 'item', projectId: alpha.id, item });
        handler({ type: 'item', projectId: alpha.id, item });
        handler({ type: 'delta', projectId: alpha.id, itemId: 'tl_dup', text: '_OK', seq: 5 });
        handler({ type: 'delta', projectId: alpha.id, itemId: 'tl_dup', text: '_OK', seq: 5 });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const rendered = document.querySelectorAll('[data-testid="timeline-assistant"]');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.textContent).toContain('MONA_OK');
    await act(async () => root.unmount());
  });

  it('shows the blocked-problem card and makes no completion claim', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const store: Store = {
      projects: [alpha],
      ui: emptyUi(),
      engine: engine({ state: 'connected', workspace: alpha.canonicalPath }),
      spends: {},
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      for (const handler of store.studioHandlers ?? []) {
        handler({
          type: 'state',
          projectId: alpha.id,
          thread: null,
          run: {
            state: 'idle',
            detail: 'Ready.',
            turnId: null,
            submission: null,
            startedAt: null,
          },
          control: {
            pauseRequested: true,
            queueState: 'blocked',
            lastOutcome: null,
            interrupt: null,
            blockedProblem: {
              problemId: 'prb_0123456789abcdef0123456789abcdef',
              taskId: 'tsk_1',
              detail: 'Victor: confirm the expected fixture contents for this check.',
            },
          },
          pending: null,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const card = document.querySelector('[data-testid="studio-blocked-problem"]');
    expect(card?.textContent).toContain('prb_0123456789abcdef0123456789abcdef');
    expect(card?.textContent).toContain('Victor: confirm the expected fixture contents');
    expect(card?.textContent).toContain('does not reset the count');
    await act(async () => root.unmount());
  });

  it('opens the studio and focuses the composer for an Explorer launch', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const beta = project('prj_beta', 'beta');
    const store: Store = {
      projects: [alpha, beta],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
      launch: launchFor(beta, 1),
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(document.querySelector('[data-testid="studio-title"]')?.textContent).toBe('beta');
    expect(document.activeElement?.id).toBe('draft');
    expect(document.body.textContent).toContain('Opened from Explorer');
    expect(document.body.textContent).toContain('No task was sent');
    await act(async () => root.unmount());
  });

  it('applies a pushed launch and ignores a stale receipt', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const beta = project('prj_beta', 'beta');
    const store: Store = { projects: [alpha, beta], ui: emptyUi(), engine: engine(), spends: {} };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      for (const handler of store.launchHandlers ?? []) handler(launchFor(beta, 2));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(document.querySelector('[data-testid="studio-title"]')?.textContent).toBe('beta');
    expect(document.activeElement?.id).toBe('draft');
    await act(async () => {
      for (const handler of store.launchHandlers ?? []) handler(launchFor(alpha, 1));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(document.querySelector('[data-testid="studio-title"]')?.textContent).toBe('beta');
    await act(async () => root.unmount());
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

  it('renders the Resume Brief from recorded rows and focuses evidence without submitting', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const store: Store = {
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
      briefing: richBriefing('prj_alpha'),
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      button('Home').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('[data-testid="brief-current"]')?.textContent).toContain('Ship the briefing panel');
    expect(document.querySelector('[data-testid="brief-spend"]')?.textContent).toContain('$0.0025');
    expect(document.querySelector('[data-testid="brief-changes"]')?.textContent).toContain('2 path(s)');
    expect(document.querySelector('[data-testid="brief-next"]')?.textContent).toContain('render the brief');
    expect(document.querySelector('[data-testid="digest-window"]')?.textContent).toContain('Since');
    const link = document.querySelector<HTMLButtonElement>(
      '[data-testid="evidence-link"][data-path="docs/evidence/P14-polish.md"]',
    );
    expect(link).not.toBeNull();
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(link?.getAttribute('aria-pressed')).toBe('true');
    expect(link?.className).toContain('focused');
    expect(store.submitted?.length ?? 0).toBe(0);
    await act(async () => root.unmount());
  });

  it('saves Focus Mode per project and keeps the emergency controls visible', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const store: Store = {
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
      studio: {
        ...emptyStudio(),
        run: {
          state: 'running',
          detail: 'A turn is running.',
          turnId: 'turn_live',
          submission: { submissionId: 'sub_live', state: 'accepted', replayed: false },
          startedAt: '2026-11-12T00:00:00.000Z',
        },
      },
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      button('Studio').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('aside[aria-label="Inspector"]')).not.toBeNull();
    await act(async () => {
      button('Focus').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('.app-shell')?.className).toContain('focus-mode');
    expect(document.querySelector('aside[aria-label="Inspector"]')).toBeNull();
    expect(document.querySelector('[data-testid="studio-run-state"]')?.textContent).toContain('Running');
    expect(button('Interrupt now')).toBeTruthy();
    expect(store.layouts).toContainEqual({ projectId: 'prj_alpha', layout: 'focus' });
    await act(async () => root.unmount());
  });

  it('focuses the right project and evidence from a notification without starting work', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const beta = project('prj_beta', 'beta');
    const store: Store = {
      projects: [alpha, beta],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
      briefing: richBriefing('prj_beta'),
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      for (const handler of store.focusHandlers ?? [])
        handler({ projectId: 'prj_beta', evidencePath: 'docs/evidence/P14-polish.md', kind: 'blocker' });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(document.querySelector('[data-testid="context-project"]')?.textContent).toBe('beta');
    expect(document.body.textContent).toContain('Blocker needs attention');
    expect(document.body.textContent).toContain('No task was started');
    expect(
      document.querySelector('[data-testid="evidence-link"][data-path="docs/evidence/P14-polish.md"]')?.className,
    ).toContain('focused');
    expect(store.submitted?.length ?? 0).toBe(0);
    await act(async () => root.unmount());
  });

  it('saves a prompt favorite, fills the composer with it, and keeps density', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const store: Store = { projects: [alpha], ui: emptyUi(), engine: engine(), spends: {} };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      button('Studio').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const composer = document.querySelector<HTMLTextAreaElement>('#draft') as HTMLTextAreaElement;
    await typeInto(composer, 'Review the failing test and report the exact command.');
    const label = document.querySelector<HTMLInputElement>('#favorite-label') as HTMLInputElement;
    await typeIntoInput(label, 'Review failing test');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="save-favorite"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.body.textContent).toContain('Review failing test');
    await act(async () => {
      button('Use').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector<HTMLTextAreaElement>('#draft')?.value).toBe(
      'Review the failing test and report the exact command.',
    );
    expect(store.submitted?.length ?? 0).toBe(0);
    await act(async () => {
      button('Settings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="density-compact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.documentElement.dataset.density).toBe('compact');
    await act(async () => root.unmount());
  });
});
