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
import type { AppearanceView } from '../shared/appearance.js';
import type { CostLensView } from '../shared/cost.js';
import type { TaskBoardView } from '../shared/tasks.js';
import type { BriefingView } from '../shared/briefing.js';
import type { ExtensionsView, CapabilityExplorerView } from '@mona/contracts';
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

function emptyCost(projectId: string): CostLensView {
  const totals = {
    records: 0,
    providerReportedMicros: 0,
    estimatedMicros: 0,
    knownMicros: 0,
    unknownRecords: 0,
    unknownReasons: [],
    tokens: { cacheHit: null, cacheMiss: null, input: null, output: null, reasoning: null },
    latestRecordedAt: null,
  };
  return {
    projectId,
    totals,
    byTurn: [],
    byTask: [],
    bySession: [],
    rates: [],
    budgets: [],
    evaluation: { action: 'allow', decisions: [], disclosure: 'Local dispatch limit only.' },
    disclosure: [],
    empty: true,
  };
}

function emptyBoard(projectId: string): TaskBoardView {
  return {
    projectId,
    generatedAt: '2026-11-12T00:00:00.000Z',
    tasks: [],
    eligible: [],
    next: null,
    counts: {
      pending: 0,
      running: 0,
      verifying: 0,
      completed: 0,
      blocked: 0,
      interrupted: 0,
      skipped: 0,
    },
  };
}

function defaultAppearance(): AppearanceView {
  return {
    zoomFactor: 1,
    zoomPercent: 100,
    canZoomIn: true,
    canZoomOut: true,
    detail: 'Scale 100%',
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
  appearance?: AppearanceView;
  cost?: CostLensView;
  tasks?: TaskBoardView;
  briefing?: BriefingView;
  focusHandlers?: Array<(focus: AttentionFocus) => void>;
  layouts?: Array<{ projectId: string; layout: string }>;
  extensions?: ExtensionsView;
  extensionActions?: string[];
  capabilities?: CapabilityExplorerView;
  capabilityActions?: string[];
};

function emptyStudio(): StudioView {
  return {
    projectId: null,
    sessionId: null,
    thread: null,
    items: [],
    history: { total: 0, oldestSeq: null, newestSeq: null, hasOlder: false, hasNewer: false },
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

/** The thread the shell currently shows; a push must carry its identity. */
function threadIdFor(store: Store): string {
  return store.studio?.thread?.threadId ?? 'thr_00000000000000000000000000000001';
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

function emptyExtensionsView(): ExtensionsView {
  return {
    connected: true,
    capturedAt: '2026-11-12T00:00:00.000Z',
    workspace: 'x:\\work\\alpha',
    engineState: 'connected',
    mcp: { status: 'ok', note: null, revision: 'mcp-v1-aaaa', servers: [] },
    skills: { status: 'ok', note: null, directories: [], warnings: [], skills: [] },
    plugins: {
      status: 'ok',
      note: null,
      workspace: 'x:\\work\\alpha',
      plugins: [],
      registryDiagnostics: [],
      validationClean: true,
    },
    hooks: { status: 'ok', note: null, workspace: 'x:\\work\\alpha', enabled: false, hooks: [], problems: [] },
    instructions: {
      status: 'ok',
      note: null,
      workspace: 'x:\\work\\alpha',
      sources: [],
      foreignImports: [],
      generatedFallback: true,
      aggregateBudgetBytes: 49_152,
      warnings: [],
    },
    counts: { mcpServers: 0, mcpEnabled: 0, skills: 0, plugins: 0, hooks: 0, instructionsLoaded: 0 },
    scopes: [],
    caveats: [],
  };
}

function emptyCapabilityView(): CapabilityExplorerView {
  return {
    connected: true,
    capturedAt: '2026-11-12T00:00:00.000Z',
    ledgerPath: 'docs/codewhale-capabilities.json',
    identity: {
      connected: true,
      version: '0.10.2',
      commit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
      apiVersion: '1.0',
      bindHost: '127.0.0.1',
      port: 7878,
      authRequired: true,
      pid: 1234,
      startedAt: '2026-11-12T00:00:00.000Z',
      uptimeSeconds: 10,
      executable: 'codewhale.exe',
      ledgerVersion: '0.10.2',
      ledgerCommit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
      compatibility: 'qualified',
      drift: 'none',
      driftDetail: 'matches',
      capturedAt: '2026-11-12T00:00:00.000Z',
    },
    coverage: {
      total: 0,
      qualified: 0,
      readQualified: 0,
      discovered: 0,
      unavailable: 0,
      blocked: 0,
      unknown: 0,
      nativeView: 0,
      advancedAction: 0,
      integratedTerminal: 0,
      unavailableSurface: 0,
      blockedGap: 0,
      verifiedEntryPoints: 0,
      discoveredOnly: 0,
      completenessPercent: 0,
      note: 'catalog coverage, not parity',
    },
    rows: [],
    liveFlags: [],
    terminal: {
      supported: false,
      status: 'unavailable',
      flags: { stream: false, input: false, resize: false, kill: false },
      route: '/v1/terminal/{name}',
      reason: 'terminal sessions are Unix-only in this build',
      checkedAt: '2026-11-12T00:00:00.000Z',
    },
    logs: { status: 'ok', note: null, sources: [] },
    palette: [],
    caveats: [],
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
    observatoryGet: async ({ projectId }: { projectId: string; threadId: string | null }) =>
      ok({
        projectId,
        threadId: null,
        connected: true,
        capturedAt: '2026-11-12T00:00:00.000Z',
        ownership: { owner: 'none', runId: null, detail: 'No execution owner is active.', since: null },
        spend: {
          threadCost: { status: 'unknown', reason: 'No thread selected.' },
          childrenKnownMicros: null,
          aggregate: { status: 'unknown', reason: 'No thread selected.' },
          doubleCountAvoided: false,
          note: 'No native record.',
        },
        nodes: [],
        goals: [],
        tasks: [],
        fleetRuns: [],
        agentRuns: [],
        artifacts: [],
        caveats: [],
        diagnostics: [],
      }),
    createFleetRun: async () => ok({ runId: 'fleet_1', detail: 'queued' }),
    startFleetRun: async ({ runId }: { runId: string }) =>
      ok({
        receipt: {
          action: 'start',
          execution: 'scheduled',
          runId,
          target: 'this_computer',
          leased: 0,
          queued: 1,
          workerIds: [],
        },
        observation: { leased: 0, runningTasks: 0, detail: 'no lease' },
      }),
    stopFleetRun: async () => ok({ acknowledged: true }),
    interruptWorker: async () => ok({ acknowledged: true }),
    cancelAgentRun: async () => ok({ acknowledged: true }),
    cancelTask: async () => ok({ acknowledged: true }),
    createGoal: async () => ok({ goalId: 'goal_1', detail: 'started' }),
    completeGoal: async () => ok({ acknowledged: true }),
    providerGet: async ({ projectId }: { projectId: string; sessionId: string; providerId?: string }) =>
      ok({
        connected: true,
        capturedAt: '2026-11-12T00:00:00.000Z',
        providers: [],
        selectedProviderId: 'deepseek',
        models: [],
        requested: { provider: 'deepseek', model: 'deepseek-flash', source: 'engine_config' },
        effective: {
          threadId: null,
          provider: 'deepseek',
          model: 'deepseek-flash',
          mode: 'agent',
          permissionPosture: 'full_access',
          observedAt: '2026-11-12T00:00:00.000Z',
        },
        savedDefault: null,
        reasoning: { supported: false, levels: [], source: null, note: 'No reasoning control.' },
        permissions: [
          { value: 'ask', label: 'Ask', description: 'Ask first.' },
          { value: 'auto-review', label: 'Auto-Review', description: 'Review.' },
          { value: 'full-access', label: 'Full Access', description: 'No prompts.' },
        ],
        maxWorkers: 1,
        configRevision: 'sha256:test',
        diagnostics: {
          status: 'healthy',
          checkedAt: '2026-11-12T00:00:00.000Z',
          probed: false,
          credentialState: 'configured',
          endpoint: 'https://api.deepseek.com/beta',
          findings: [],
          redactedText: 'route: deepseek',
        },
        caveats: [],
        projectId,
      }),
    providerApplyRoute: async () => ok({ verified: true }),
    providerApplyPermission: async () => ok({ verified: true }),
    providerApplyMode: async () => ok({ verified: true }),
    extensionsGet: async () => ok(store.extensions ?? emptyExtensionsView()),
    extensionsSetMcp: async (input: { name: string; enabled: boolean; expectedRevision: string }) => {
      (store.extensionActions ??= []).push(`set:${input.name}:${input.enabled}:${input.expectedRevision}`);
      return ok({
        action: input.enabled ? ('mcp.enable' as const) : ('mcp.disable' as const),
        target: input.name,
        origin: 'global' as const,
        enabled: input.enabled,
        connected: false,
        verified: true,
        previousRevision: input.expectedRevision,
        revision: 'mcp-v1-bbbb',
        detail: 'The engine confirms the change.',
        appliedAt: '2026-11-12T00:00:00.000Z',
      });
    },
    extensionsCheckMcp: async (input: { name: string; expectedRevision: string }) => {
      (store.extensionActions ??= []).push(`check:${input.name}:${input.expectedRevision}`);
      return ok({
        server: input.name,
        connected: true,
        authRequired: false,
        error: null,
        tools: [{ server: input.name, name: 'echo_text', prefixedName: 'mcp_fixture_echo_text' }],
        checkedAt: '2026-11-12T00:00:00.000Z',
        revision: 'mcp-v1-aaaa',
      });
    },
    capabilitiesGet: async () => ok(store.capabilities ?? emptyCapabilityView()),
    capabilitiesReadLog: async (input: { name: string; offset?: number; limit?: number }) => {
      (store.capabilityActions ??= []).push(`log:${input.name}:${input.offset ?? 0}`);
      return ok({
        name: input.name,
        size: 24,
        modifiedAt: '2026-11-12T00:00:00.000Z',
        offset: input.offset ?? 0,
        requestedLimit: input.limit ?? 64 * 1024,
        bytes: 20,
        content: 'line one\ntoken=[redacted]\n',
        truncated: false,
        redacted: true,
        readAt: '2026-11-12T00:00:00.000Z',
      });
    },
    capabilitiesCheckTerminal: async () => {
      (store.capabilityActions ??= []).push('terminal-check');
      return ok({
        supported: false,
        status: 'unavailable' as const,
        statusCode: 501,
        message: 'terminal sessions are Unix-only in this build',
        checkedAt: '2026-11-12T00:00:00.000Z',
      });
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
            favorites: [
              {
                id: `pfv_${label}`,
                label,
                text,
                createdAt: '2026-11-12T00:00:00.000Z',
                description: '',
                template: text,
                variables: [],
                acceptance: [],
                version: 1,
                updatedAt: '2026-11-12T00:00:00.000Z',
                history: [],
              },
              ...entry.favorites,
            ],
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
    appearanceGet: async () => ok(store.appearance ?? defaultAppearance()),
    appearanceZoom: async ({ direction }: { direction: 'in' | 'out' | 'reset' }) => {
      const ladder = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
      const current = store.appearance?.zoomFactor ?? 1;
      const index = ladder.indexOf(current) < 0 ? ladder.indexOf(1) : ladder.indexOf(current);
      const stepped = ladder[Math.max(0, Math.min(ladder.length - 1, index + (direction === 'in' ? 1 : -1)))] ?? 1;
      const next = direction === 'reset' ? 1 : stepped;
      store.appearance = {
        zoomFactor: next,
        zoomPercent: Math.round(next * 100),
        canZoomIn: next < 2,
        canZoomOut: next > 0.5,
        detail: `Scale ${Math.round(next * 100)}%`,
      };
      return ok(store.appearance);
    },
    onAppearance: () => () => undefined,
    costLens: async ({ projectId }: { projectId: string }) => ok(store.cost ?? emptyCost(projectId)),
    costSetBudget: async (input: { projectId: string; scope: string; limitMicros: number }) => {
      const base = store.cost ?? emptyCost(input.projectId);
      const budgets = base.budgets.filter((budget) => budget.scope !== input.scope);
      store.cost = {
        ...base,
        budgets: [
          ...budgets,
          {
            id: `bdg_${input.scope}`,
            scope: input.scope as CostLensView['budgets'][number]['scope'],
            sessionId: null,
            limitMicros: input.limitMicros,
            warnMicros: Math.floor(input.limitMicros * 0.8),
            stopMicros: input.limitMicros,
            updatedAt: '2026-11-12T00:00:00.000Z',
          },
        ],
      };
      return ok(store.cost);
    },
    costExport: async () =>
      ok({
        saved: true,
        path: 'C:\\tmp\\mona-cost.csv',
        bytes: 64,
        rows: 2,
        note: 'Wrote the recorded usage rows to C:\\tmp\\mona-cost.csv.',
      }),
    taskBoard: async ({ projectId }: { projectId: string }) => ok(store.tasks ?? emptyBoard(projectId)),
    taskCreate: async (input: { projectId: string; title: string; steps?: string[]; criteria?: string[] }) => {
      const base = store.tasks ?? emptyBoard(input.projectId);
      const ordinals = base.tasks.map((task) => task.ordinal);
      store.tasks = {
        ...base,
        counts: { ...base.counts, pending: base.counts.pending + 1 },
        tasks: [
          ...base.tasks,
          {
            id: `tsk_${base.tasks.length + 1}`,
            title: input.title,
            status: 'pending',
            description: '',
            owner: 'mona_queue',
            ordinal: ordinals.length > 0 ? Math.max(...ordinals) + 1 : 1,
            currentStep: null,
            blockedReason: null,
            skippedReason: null,
            steps: (input.steps ?? []).map((title, index) => ({
              id: `stp_${index}`,
              position: index + 1,
              title,
              status: 'pending' as const,
              detail: null,
            })),
            criteria: (input.criteria ?? []).map((description, index) => ({
              id: `crt_${index}`,
              description,
              kind: 'check' as const,
              required: true,
              satisfied: false,
              note: null,
            })),
            evidence: [],
            dependencies: [],
            dependents: [],
            requirementRefs: [],
            eligible: true,
            eligibilityReason: 'no blocking dependency',
            blockedByProblemIds: [],
            updatedAt: '2026-11-12T00:00:00.000Z',
          },
        ],
      };
      return ok(store.tasks);
    },
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
  mounted.push(() => root.unmount());
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

/** Mounted trees, so a test that fails mid-way cannot keep timers that write into
 * the next test's bridge. */
const mounted: Array<() => void> = [];

afterEach(async () => {
  while (mounted.length > 0) {
    try {
      const unmount = mounted.pop();
      await act(async () => unmount?.());
    } catch {
      /* the tree was already unmounted by the test itself */
    }
  }
  document.documentElement.removeAttribute('data-theme');
});

describe('Mona shell', () => {
  it('steps the window scale from the status bar and disables exhausted directions honestly', async () => {
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    expect(document.querySelector('[data-testid="zoom-value"]')?.textContent).toBe('100%');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Larger scale"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('[data-testid="zoom-value"]')?.textContent).toBe('110%');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label^="Window scale"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('[data-testid="zoom-value"]')?.textContent).toBe('100%');
    await act(async () => root.unmount());
  });

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

  it('opens the Agents observatory and the provider workbench without starting work', async () => {
    const alpha = project('prj_alpha', 'alpha');
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      (document.querySelector('[data-testid="nav-agents"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="ownership-detail"]')?.textContent).toContain('No execution owner');
    expect(document.querySelector('[data-testid="aggregate-spend"]')?.textContent).toContain('unknown');
    await act(async () => {
      (document.querySelector('[data-testid="nav-settings"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="provider-select"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="requested-route"]')?.textContent).toContain('deepseek');
    expect(document.querySelector('[data-testid="reasoning-note"]')?.textContent).toContain('reasoning control');
    await act(async () => root.unmount());
  });

  it('shows extension provenance and sends MCP actions with the observed revision', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const extensions = emptyExtensionsView();
    extensions.mcp.servers = [
      {
        name: 'fixture',
        origin: 'global',
        writable: true,
        authRequired: false,
        enabled: true,
        required: false,
        command: 'node',
        argumentCount: 1,
        url: null,
        transport: 'stdio',
        connected: false,
        credentialConfigured: false,
        enabledTools: [],
        disabledTools: [],
        envKeys: ['FIXTURE_TOKEN'],
        scopes: [],
        detailAvailable: true,
        detailNote: null,
      },
    ];
    extensions.counts = { ...extensions.counts, mcpServers: 1, mcpEnabled: 1 };
    extensions.instructions.sources = [
      {
        kind: 'project',
        status: 'loaded',
        scopeDir: 'x:\\work\\alpha',
        path: 'x:\\work\\alpha\\AGENTS.md',
        relativePath: 'AGENTS.md',
        exists: true,
        bytes: 42,
        warning: null,
      },
    ];
    extensions.counts = { ...extensions.counts, instructionsLoaded: 1 };
    const store: Store = { projects: [alpha], ui: emptyUi(), engine: engine(), spends: {}, extensions };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      (document.querySelector('[data-testid="nav-extensions"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="mcp-server-fixture"]')?.textContent).toContain('Global');
    expect(document.querySelector('[data-testid="instruction-project-loaded"]')?.textContent).toContain('AGENTS.md');
    await act(async () => {
      exactButton('Check health').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="mcp-health-fixture"]')?.textContent).toContain('echo_text');
    await act(async () => {
      exactButton('Disable').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(store.extensionActions).toEqual(['check:fixture:mcp-v1-aaaa', 'set:fixture:false:mcp-v1-aaaa']);
    await act(async () => root.unmount());
  });

  it('shows capability coverage, terminal limits, bounded logs and palette entries', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const view = emptyCapabilityView();
    view.rows = [
      {
        id: 'CAP-0001',
        upstream: { name: 'run', surface: 'cli', source: 'codewhale --help', version: '0.10.2+ff466b2ed0bf' },
        platform: 'windows-x64',
        kind: 'read/write',
        permissionImplications: 'shell access',
        costImplications: 'model',
        requiredArguments: 'see help',
        integration: 'Advanced action',
        uiLocation: 'Studio composer',
        tests: ['packages/adapter/src/cli.test.ts'],
        status: 'qualified',
        gap: null,
        evidence: { helpCapture: 'docs/evidence/engine/commands/run.txt', capturedAt: null, contractReport: null },
      },
    ];
    view.coverage = {
      ...view.coverage,
      total: 1,
      qualified: 1,
      advancedAction: 1,
      verifiedEntryPoints: 1,
      completenessPercent: 100,
    };
    view.logs = {
      status: 'ok',
      note: null,
      sources: [
        {
          dir: 'x:\\home\\logs',
          files: [{ name: 'runtime.log', size: 24, modifiedAt: '2026-11-12T00:00:00.000Z' }],
        },
      ],
    };
    view.palette = [
      {
        id: 'capability:CAP-0001',
        label: 'run — qualified',
        hint: 'cli · Studio composer',
        status: 'qualified',
        integration: 'Advanced action',
      },
    ];
    const store: Store = {
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
      capabilities: view,
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      (document.querySelector('[data-testid="nav-capabilities"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="capability-coverage"]')?.textContent).toContain('1/1');
    expect(document.querySelector('[data-testid="capability-CAP-0001"]')?.textContent).toContain('run');
    expect(document.querySelector('[data-testid="terminal-reason"]')?.textContent).toContain('Unix-only');
    await act(async () => {
      exactButton('Check terminal route').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="terminal-check"]')?.textContent).toContain('501');
    await act(async () => {
      exactButton('Read').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="log-content"]')?.textContent).toContain('[redacted]');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.body.textContent).toContain('run — qualified');
    expect(store.capabilityActions).toEqual(['terminal-check', 'log:runtime.log:0']);
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

  it('clears only the accepted prompt and keeps text typed while it was in flight', async () => {
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
      studio: emptyStudio(),
    };
    const mona = bridgeFor(store);
    const realSubmit = mona.studioSubmit;
    let release: (() => void) | null = null;
    (mona as unknown as Record<string, unknown>).studioSubmit = async (input: Parameters<typeof realSubmit>[0]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return realSubmit(input);
    };
    (window as unknown as { mona: Window['mona'] }).mona = mona;
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'First prompt');
    await act(async () => {
      exactButton('Submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The runtime has not answered yet; the renderer already shows the prompt it
    // is waiting on and has not recorded an accepted submission.
    expect(document.body.textContent).toContain('Sending…');
    expect(store.submitted ?? []).toHaveLength(0);

    // This text is newer than the revision that was accepted and must survive
    // the acknowledgement.
    await typeInto(draft, 'Second thoughts');
    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(store.submitted).toEqual([{ text: 'First prompt', mode: 'agent', references: [] }]);
    expect(document.querySelector<HTMLTextAreaElement>('#draft')?.value).toBe('Second thoughts');
    await act(async () => root.unmount());
  });

  it('keeps the draft when the runtime rejects the submission', async () => {
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
      studio: emptyStudio(),
    };
    const mona = bridgeFor(store);
    (mona as unknown as Record<string, unknown>).studioSubmit = async () => ({
      ok: false,
      error: {
        code: 'engine_unavailable',
        message: 'The engine is not connected. Connect it for this project before submitting work.',
        retryable: false,
      },
    });
    (window as unknown as { mona: Window['mona'] }).mona = mona;
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'do not lose this');
    await act(async () => {
      exactButton('Submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector<HTMLTextAreaElement>('#draft')?.value).toBe('do not lose this');
    expect(document.body.textContent).not.toContain('Sending…');
    expect(document.body.textContent).toContain('The engine is not connected');
    await act(async () => root.unmount());
  });

  it('drops a late project selection instead of overwriting the newer one', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const beta = project('prj_beta', 'beta');
    const store: Store = { projects: [alpha, beta], ui: emptyUi(), engine: engine(), spends: {} };
    const mona = bridgeFor(store);
    const realSelect = mona.selectProject;
    let releaseAlpha: (() => void) | null = null;
    (mona as unknown as Record<string, unknown>).selectProject = async (projectId: string | null) => {
      if (projectId === alpha.id) {
        await new Promise<void>((resolve) => {
          releaseAlpha = resolve;
        });
      }
      return realSelect(projectId);
    };
    (window as unknown as { mona: Window['mona'] }).mona = mona;
    const { root } = await render();

    const recent = (label: string): HTMLElement | undefined =>
      Array.from(document.querySelectorAll('.rail-recent')).find((node) => node.textContent?.trim().endsWith(label)) as
        HTMLElement | undefined;

    await act(async () => {
      recent('alpha')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    // alpha's selection is still in flight; choose beta, which answers at once.
    await act(async () => {
      recent('beta')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="context-project"]')?.textContent).toContain('beta');

    await act(async () => {
      releaseAlpha?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[data-testid="context-project"]')?.textContent).toContain('beta');
    await act(async () => root.unmount());
  });

  it('submits once on Ctrl+Enter and never during an IME composition or a key repeat', async () => {
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
      studio: emptyStudio(),
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'Ctrl enter prompt');

    const press = async (init: KeyboardEventInit): Promise<void> => {
      await act(async () => {
        draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, ...init }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };

    await press({ repeat: true });
    expect(store.submitted ?? []).toHaveLength(0);
    await press({ isComposing: true });
    expect(store.submitted ?? []).toHaveLength(0);
    await press({});
    expect(store.submitted).toEqual([{ text: 'Ctrl enter prompt', mode: 'agent', references: [] }]);
    await act(async () => root.unmount());
  });

  it('saves the pending draft before New session switches away from it', async () => {
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
      studio: emptyStudio(),
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor(store);
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'keep this draft');
    // The 350 ms debounce has not fired yet; New session must flush it first.
    await act(async () => {
      exactButton('New session').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const sessions = store.ui.projects[alpha.id]?.sessions ?? [];
    const original = sessions.find((session) => session.sessionId === `ses_${alpha.id}`);
    expect(original?.text).toBe('keep this draft');
    expect(store.ui.projects[alpha.id]?.currentSessionId).toBe(`ses_new_${alpha.id}`);
    expect(document.querySelector<HTMLTextAreaElement>('#draft')?.value).toBe('');
    await act(async () => root.unmount());
  });

  it('restores the saved section after a restart instead of falling back to Studio', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const ui = emptyUi();
    ui.currentProjectId = alpha.id;
    ui.projects[alpha.id] = {
      view: 'memory',
      layout: 'standard',
      currentSessionId: `ses_${alpha.id}`,
      sessions: [],
      favorites: [],
      lastOpenedAt: '2026-11-12T00:00:00.000Z',
      lastSeenAt: null,
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [alpha],
      ui,
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    // The registry is the single source of truth: a section survives a relaunch.
    expect(document.querySelector('#memory-search-title')).not.toBeNull();
    expect(document.querySelector('[data-testid="context-project"]')?.textContent).toContain('alpha');
    await act(async () => root.unmount());
  });

  it('keeps two draft saves in order so a late older save cannot win', async () => {
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
      studio: emptyStudio(),
    };
    const mona = bridgeFor(store);
    const realSave = mona.saveDraft;
    const calls: string[] = [];
    let releaseFirst: (() => void) | null = null;
    (mona as unknown as Record<string, unknown>).saveDraft = async (input: Parameters<typeof realSave>[0]) => {
      calls.push(input.text);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return realSave(input);
    };
    (window as unknown as { mona: Window['mona'] }).mona = mona;
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const draft = document.querySelector<HTMLTextAreaElement>('#draft');
    if (!draft) throw new Error('draft missing');
    await typeInto(draft, 'A');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 420));
    });
    await typeInto(draft, 'AB');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 420));
    });
    // The first save is still in flight, so the newer one has not been sent yet.
    expect(calls).toEqual(['A']);
    await act(async () => {
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(calls).toEqual(['A', 'AB']);
    const sessions = store.ui.projects[alpha.id]?.sessions ?? [];
    expect(sessions.find((session) => session.sessionId === `ses_${alpha.id}`)?.text).toBe('AB');
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
          threadId: store.studio?.thread?.threadId ?? 'thr_00000000000000000000000000000001',
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
          threadId: store.studio?.thread?.threadId ?? null,
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
        handler({ type: 'item', projectId: alpha.id, threadId: threadIdFor(store), item });
        handler({ type: 'item', projectId: alpha.id, threadId: threadIdFor(store), item });
        handler({
          type: 'delta',
          projectId: alpha.id,
          threadId: threadIdFor(store),
          itemId: 'tl_dup',
          text: '_OK',
          seq: 5,
        });
        handler({
          type: 'delta',
          projectId: alpha.id,
          threadId: threadIdFor(store),
          itemId: 'tl_dup',
          text: '_OK',
          seq: 5,
        });
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
          threadId: threadIdFor(store),
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
    // The Inspector is a reference panel: closed by default so the timeline owns
    // the width, and reachable through one labelled control.
    expect(document.querySelector('aside[aria-label="Inspector"]')).toBeNull();
    expect(document.querySelector('.workspace')?.className).toContain('inspector-collapsed');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Show Inspector"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('aside[aria-label="Inspector"]')).not.toBeNull();
    expect(document.querySelector('.workspace')?.className).not.toContain('inspector-collapsed');
    expect(localStorage.getItem('mona.inspector')).toBe('open');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Hide Inspector"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('aside[aria-label="Inspector"]')).toBeNull();
    expect(localStorage.getItem('mona.inspector')).toBe('collapsed');
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

  it('shows recorded cost and sets a budget from the Cost lens', async () => {
    const alpha = project('prj_alpha', 'alpha');
    const cost: CostLensView = {
      ...emptyCost(alpha.id),
      empty: false,
      totals: {
        records: 3,
        providerReportedMicros: 3_000,
        estimatedMicros: 500,
        knownMicros: 3_500,
        unknownRecords: 1,
        unknownReasons: [{ reason: 'provider did not report usage', count: 1 }],
        tokens: { cacheHit: 100, cacheMiss: 900, input: null, output: 250, reasoning: null },
        latestRecordedAt: '2026-11-12T00:00:00.000Z',
      },
      byTask: [
        {
          key: 'tsk_1',
          label: 'tsk_1',
          detail: null,
          totals: {
            records: 2,
            providerReportedMicros: 3_000,
            estimatedMicros: 0,
            knownMicros: 3_000,
            unknownRecords: 0,
            unknownReasons: [],
            tokens: { cacheHit: null, cacheMiss: null, input: null, output: null, reasoning: null },
            latestRecordedAt: '2026-11-12T00:00:00.000Z',
          },
        },
      ],
    };
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
      cost,
    });
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      button('Cost').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    // The known total and the unknown count are both visible, and the unknown is
    // never folded into the money.
    expect(document.querySelector('[data-testid="cost-known"]')?.textContent).toContain('$0.0035');
    expect(document.querySelector('[data-testid="cost-known"]')?.textContent).toContain('1 unknown');
    expect(document.querySelector('[data-testid="cost-unknown"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="cost-empty"]')).toBeNull();
    // The provider/estimated split is stated where the number came from.
    expect(document.body.textContent).toContain('provider $0.0030');
    expect(document.body.textContent).toContain('estimated $0.0005');
    // No stale "arrives with P12" placeholder survives.
    expect(document.body.textContent).not.toContain('arrive with P12');

    const limit = document.querySelector<HTMLInputElement>('input[aria-label="Budget limit in US dollars"]');
    if (!limit) throw new Error('budget limit field missing');
    await typeIntoInput(limit, '2.50');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(document.querySelector('[data-testid="cost-budgets"]')?.textContent).toContain('$2.5000');
    expect(document.querySelector('[data-testid="cost-receipt"]')?.textContent).toContain('project total budget');

    await act(async () => {
      exactButton('Export CSV').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(document.querySelector('[data-testid="cost-receipt"]')?.textContent).toContain('mona-cost.csv');
    await act(async () => root.unmount());
  });

  it('shows the real work board and records a new task without starting it', async () => {
    const alpha = project('prj_alpha', 'alpha');
    (window as unknown as { mona: Window['mona'] }).mona = bridgeFor({
      projects: [alpha],
      ui: emptyUi(),
      engine: engine(),
      spends: {},
    });
    const { root } = await render();
    await act(async () => {
      exactButton('Open').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      button('Work').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(document.body.textContent).toContain('No tasks recorded');
    expect(document.body.textContent).not.toContain('arrive with P10');

    const title = document.querySelector<HTMLInputElement>('input[aria-label="Task title"]');
    const steps = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task steps, one per line"]');
    const criteria = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Acceptance criteria, one per line"]',
    );
    if (!title || !steps || !criteria) throw new Error('task form fields missing');
    await typeIntoInput(title, 'Check the export');
    await typeInto(steps, 'open the dialog');
    await typeInto(criteria, 'the file exists');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.task-form button[type="submit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const card = document.querySelector('[data-testid="task-card"]');
    expect(card?.textContent).toContain('Check the export');
    expect(card?.textContent).toContain('Pending');
    expect(card?.textContent).toContain('open the dialog');
    expect(card?.textContent).toContain('the file exists');
    expect(document.querySelector('[data-testid="task-eligibility"]')?.textContent).toContain('Eligible');
    expect(document.querySelector('[data-testid="work-count"]')?.textContent).toContain('1 task');
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
