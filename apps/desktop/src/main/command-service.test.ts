import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, ProjectStore } from '@mona/project-state';
import { CommandService } from './command-service.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-w05-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

type Harness = {
  service: CommandService;
  store: ProjectStore;
  ui: UiStateStore;
  projectId: string;
  sessionId: string;
  setBusy: (busy: { turnId: string | null; state: string } | null) => void;
  setEngineCalls: () => number;
};

async function harness(label: string): Promise<Harness> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  const folder = path.join(dir, 'project');
  await mkdir(folder, { recursive: true });
  const registered = await store.registerProject(folder, { label: 'cmd-project' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const ui = new UiStateStore({ file: path.join(dir, 'ui-state.json') });
  let busy: { turnId: string | null; state: string } | null = null;
  let engineCalls = 0;
  const service = new CommandService({
    store,
    ensureSession: (projectId, sessionId) => {
      engineCalls += 1;
      return ui.ensureSession(projectId, sessionId);
    },
    sessionBusy: () => busy,
  });
  ui.saveDraft(registered.project.id, 'ses_old', 'a draft that should survive');
  return {
    service,
    store,
    ui,
    projectId: registered.project.id,
    sessionId: 'ses_old',
    setBusy: (value) => {
      busy = value;
    },
    setEngineCalls: () => engineCalls,
  };
}

async function dispatch(h: Harness, text: string, operationKey = 'cmd_test_key_0001') {
  const result = await h.service.dispatch({ projectId: h.projectId, sessionId: h.sessionId, text, operationKey });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

describe('command dispatch', () => {
  it('starts a real new conversation, locally, and reports the identities', async () => {
    const h = await harness('new');
    const receipt = await dispatch(h, '/new');

    expect(receipt.status).toBe('done');
    expect(receipt.operation).toBe('new-conversation');
    expect(receipt.command).toBe('new');
    expect(receipt.providerRequest).toBe(false);
    expect(receipt.threadCreated).toBe(false);
    expect(receipt.oldSessionId).toBe('ses_old');
    expect(receipt.newSessionId).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(receipt.newSessionId).not.toBe('ses_old');
    expect(receipt.replayed).toBe(false);
    // No engine thread was opened by the rotation.
    expect(await h.store.studioThreadForSession(h.projectId, receipt.newSessionId!)).toBeNull();
    // The new session is current in the saved UI state, and it is empty.
    expect(receipt.ui?.projects[h.projectId]?.sessions.some((s) => s.sessionId === receipt.newSessionId)).toBe(true);
    // The old session's draft is untouched.
    const old = h.ui.view().projects[h.projectId]?.sessions.find((s) => s.sessionId === 'ses_old');
    expect(old?.text).toBe('a draft that should survive');
  });

  it('replays the same conversation for a retried operation key', async () => {
    const h = await harness('retry');
    const first = await dispatch(h, '/new', 'cmd_retry_0001');
    const second = await dispatch(h, '/new', 'cmd_retry_0001');

    expect(second.newSessionId).toBe(first.newSessionId);
    expect(second.replayed).toBe(true);
    expect(second.oldSessionId).toBe('ses_old');
    const rotations = await h.store.listSessionRotations(h.projectId);
    expect(rotations).toHaveLength(1);
  });

  it('refuses while a turn is running and creates nothing', async () => {
    const h = await harness('busy');
    h.setBusy({ turnId: 'turn_123', state: 'running' });
    const receipt = await dispatch(h, '/new');
    expect(receipt.status).toBe('refused');
    expect(receipt.code).toBe('busy');
    expect(receipt.detail).toContain('Interrupt it or wait');
    expect(receipt.detail).toContain('turn_123');
    expect(receipt.newSessionId).toBeNull();
    expect(await h.store.listSessionRotations(h.projectId)).toHaveLength(0);
  });

  it('refuses arguments instead of interpreting them', async () => {
    const h = await harness('arguments');
    for (const text of [
      '/new --force',
      '/new ; Remove-Item -Recurse C:\\',
      '/new $(whoami)',
      '/new && calc.exe',
      '/new focus',
    ]) {
      const receipt = await dispatch(h, text);
      expect(receipt.status, text).toBe('refused');
      expect(receipt.code, text).toBe('unexpected_argument');
    }
    expect(await h.store.listSessionRotations(h.projectId)).toHaveLength(0);
  });

  it('refuses a terminal-only command with its own explanation', async () => {
    const h = await harness('tui');
    const receipt = await dispatch(h, '/model deepseek-flash');
    expect(receipt.status).toBe('refused');
    expect(receipt.code).toBe('not_routed');
    expect(receipt.detail).toContain('/model');
    expect(receipt.detail).toContain('terminal');
    expect(receipt.operation).toBeNull();
  });

  it('refuses unknown, ambiguous and non-command text', async () => {
    const h = await harness('unknown');
    const unknown = await dispatch(h, '/not-a-real-command');
    expect(unknown.code).toBe('unknown_command');

    const ambiguous = await dispatch(h, '/mod');
    expect(ambiguous.code).toBe('unknown_command');
    expect(ambiguous.detail).toContain('/model');

    const prose = await dispatch(h, 'Please review the diff');
    expect(prose.code).toBe('unknown_command');
    expect(prose.detail).toContain('ordinary text');
  });

  it('opens the catalog through the typed route, including by alias', async () => {
    const h = await harness('help');
    const direct = await dispatch(h, '/help');
    expect(direct.status).toBe('done');
    expect(direct.operation).toBe('show-catalog');
    expect(direct.detail).toContain('commands captured');

    const alias = await dispatch(h, '/bangzhu');
    expect(alias.status).toBe('done');
    expect(alias.via).toBe('alias');
    expect(alias.command).toBe('help');
    expect(await h.store.listSessionRotations(h.projectId)).toHaveLength(0);
  });

  it('rejects a missing or malformed operation key before doing anything', async () => {
    const h = await harness('key');
    for (const key of ['', 'short', 'bad key with spaces', 'x'.repeat(200)]) {
      const result = await h.service.dispatch({
        projectId: h.projectId,
        sessionId: h.sessionId,
        text: '/new',
        operationKey: key,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe('refused');
        expect(result.data.code).toBe('invalid_request');
      }
    }
    expect(await h.store.listSessionRotations(h.projectId)).toHaveLength(0);
  });

  it('reports an unknown project instead of inventing one', async () => {
    const h = await harness('project');
    const result = await h.service.dispatch({
      projectId: 'prj_missing',
      sessionId: h.sessionId,
      text: '/new',
      operationKey: 'cmd_missing_project',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('refused');
      expect(result.data.code).toBe('not_found');
    }
  });

  it('keeps the previous conversation readable after the rotation', async () => {
    const h = await harness('history');
    const threadId = `thr_${'e'.repeat(32)}`;
    await h.store.putStudioThread({
      id: threadId,
      projectId: h.projectId,
      engineThreadId: threadId,
      workspace: path.join(h.store.file, '..'),
      sessionId: 'ses_old',
      mode: 'agent',
      profileJson: JSON.stringify({
        threadId,
        workspace: path.join(h.store.file, '..'),
        provider: 'deepseek',
        model: 'deepseek-flash',
        mode: 'agent',
        permissionPosture: 'full_access',
        allowShell: true,
        trustMode: true,
        autoApprove: true,
        observedAt: '2026-11-14T00:00:00.000Z',
      }),
    });
    await h.store.putTimelineItem({
      id: 'tl_old_1',
      projectId: h.projectId,
      threadId,
      turnId: null,
      seq: 1,
      kind: 'user',
      title: 'You',
      body: 'the first conversation',
      status: 'completed',
      truncated: false,
    });

    const receipt = await dispatch(h, '/new');
    expect(receipt.status).toBe('done');

    const oldThread = await h.store.studioThreadForSession(h.projectId, 'ses_old', 'agent');
    expect(oldThread?.id).toBe(threadId);
    const page = await h.store.timelinePage(threadId, { limit: 10 });
    expect(page.items.map((item) => item.body)).toEqual(['the first conversation']);
    expect(await h.store.studioThreadForSession(h.projectId, receipt.newSessionId!, 'agent')).toBeNull();
  });

  it('touches no engine and spends nothing on any path', async () => {
    const h = await harness('economics');
    const receipts = [
      await dispatch(h, '/new', 'cmd_econ_0001'),
      await dispatch(h, '/help', 'cmd_econ_0002'),
      await dispatch(h, '/model'),
      await dispatch(h, '/nope'),
    ];
    for (const receipt of receipts) expect(receipt.providerRequest).toBe(false);
    // The only collaborator invoked is the local UI-state writer for /new.
    expect(h.setEngineCalls()).toBe(1);
  });
});

describe('dispatch boundaries', () => {
  it('scopes an operation key to its project, so a switch cannot redirect it', async () => {
    const h = await harness('projects');
    const first = await dispatch(h, '/new', 'cmd_shared_key_01');

    // A second project with the same key is its own rotation.
    const otherFolder = path.join(await tempDir('projects-other'), 'other');
    await mkdir(otherFolder, { recursive: true });
    const other = await h.store.registerProject(otherFolder, { label: 'other-project' });
    if (other.status === 'relocation_required') throw new Error('unexpected relocation');
    const result = await h.service.dispatch({
      projectId: other.project.id,
      sessionId: 'ses_other',
      text: '/new',
      operationKey: 'cmd_shared_key_01',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('done');
    expect(result.data.newSessionId).not.toBe(first.newSessionId);
    expect(await h.store.listSessionRotations(other.project.id)).toHaveLength(1);
    expect(await h.store.listSessionRotations(h.projectId)).toHaveLength(1);
  });

  it('never changes the saved provider route or permission profile', async () => {
    const h = await harness('profile');
    await h.store.saveSettingVersion('profile', 1, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com',
      permission: 'full_access',
    });
    const before = await h.store.latestSettingVersion('profile');
    await dispatch(h, '/new', 'cmd_profile_0001');
    await dispatch(h, '/model deepseek-v4-pro', 'cmd_profile_0002');
    const after = await h.store.latestSettingVersion('profile');
    expect(after).toEqual(before);
    expect(before?.version).toBe(1);
  });

  it('does not need a connected runtime, and says the thread comes later', async () => {
    const h = await harness('disconnected');
    const receipt = await dispatch(h, '/new', 'cmd_disconnected_01');
    expect(receipt.status).toBe('done');
    expect(receipt.threadCreated).toBe(false);
    expect(receipt.detail).toContain('no engine thread exists until the new conversation sends work');
  });
});

describe('restart behaviour', () => {
  it('reuses the recorded conversation when the process is re-created', async () => {
    const h = await harness('restart');
    const first = await dispatch(h, '/new', 'cmd_restart_0001');

    // A fresh service over the same durable store models a restart: no in-memory
    // dispatch state survives, only the recorded rotation.
    const restarted = new CommandService({
      store: h.store,
      ensureSession: (projectId, sessionId) => h.ui.ensureSession(projectId, sessionId),
      sessionBusy: () => null,
    });
    const again = await restarted.dispatch({
      projectId: h.projectId,
      sessionId: 'ses_old',
      text: '/new',
      operationKey: 'cmd_restart_0001',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.newSessionId).toBe(first.newSessionId);
    expect(again.data.replayed).toBe(true);
    expect(await h.store.listSessionRotations(h.projectId)).toHaveLength(1);
  });
});
