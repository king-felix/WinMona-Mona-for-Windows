import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadId, parseEngineEvent, toEventEnvelope, type ParsedEngineEvent } from '@mona/contracts';
import type { EngineAdapter } from '@mona/adapter';
import { applyMigrations } from '@mona/project-state';
import { CostLedger, ProjectStore } from '@mona/project-state';
import type { EngineSummary } from './engine-host.js';
import { StudioService, composePrompt, type StudioAttentionEvent } from './studio-service.js';
import type { StudioEvent, StudioView } from '../shared/studio.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p08-studio-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function openStore(label: string): Promise<ProjectStore> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  return store;
}

async function makeProject(store: ProjectStore, label = 'fixture'): Promise<{ id: string; path: string }> {
  const root = await tempDir(`${label}-root`);
  const folder = path.join(root, label);
  await mkdir(folder, { recursive: true });
  const outcome = await store.registerProject(folder, { label });
  if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
  return { id: outcome.project.id, path: outcome.project.canonicalPath };
}

type FakeToolInput = Record<string, unknown>;

class FakeAdapter {
  readonly threadCalls: Array<{ mode: string; workspace: string }> = [];
  readonly submissions: Array<{ threadId: string; prompt: string }> = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  private readonly queue: Array<
    | { kind: 'event'; seq: number; event: ParsedEngineEvent }
    | {
        kind: 'diagnostic';
        failure: { code: string; message: string; retryable: boolean; detail?: string };
      }
    | { kind: 'reconnected'; sinceSeq: number; attempt: number }
  > = [];
  private threadCounter = 0;
  private turnCounter = 0;
  readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async createOrOpenThread(input: { mode: string; expectedWorkspace?: string }) {
    this.threadCounter += 1;
    this.threadCalls.push({ mode: input.mode, workspace: input.expectedWorkspace ?? '' });
    const threadId = ThreadId.parse(`thr_${this.threadCounter.toString(16).padStart(32, '0')}`);
    return {
      ok: true as const,
      value: {
        threadId,
        latestSeq: 0,
        profile: {
          threadId,
          workspace: this.workspace,
          provider: 'deepseek',
          model: 'deepseek-flash',
          mode: input.mode,
          permissionPosture: 'full_access',
          allowShell: true,
          trustMode: true,
          autoApprove: true,
          observedAt: '2026-11-12T00:00:00.000Z',
        },
      },
    };
  }

  async submitTurn(input: { threadId: string; prompt: string }) {
    this.turnCounter += 1;
    this.submissions.push({ threadId: input.threadId, prompt: input.prompt });
    return {
      ok: true as const,
      value: {
        submissionId: `sub_${this.turnCounter}`,
        operationKey: `op_${this.turnCounter}`,
        threadId: input.threadId,
        turnId: `turn_${this.turnCounter.toString(16).padStart(32, '0')}`,
        state: 'accepted',
        replayed: false,
        reconciliation: { required: false },
      },
    };
  }

  async readUsage() {
    return {
      ok: true as const,
      value: {
        buckets: { inputMissTokens: 120, cacheHitTokens: 20, outputTokens: 40, reasoningTokens: 5 },
        cost: { status: 'known' as const, usd: 0.0012, source: 'engine_priced' as const, rateRevision: 'rev-1' },
        complete: true,
        capturedAt: '2026-11-12T00:00:00.000Z',
        turnId: null,
      },
    };
  }

  async interrupt(input: { threadId: string; turnId: string }) {
    this.interrupts.push(input);
    return {
      ok: true as const,
      value: { threadId: input.threadId, turnId: input.turnId, acknowledgedStatus: 'interrupted' },
    };
  }

  async *subscribe(request: { signal?: AbortSignal }) {
    const signal = request.signal;
    while (!signal?.aborted) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 4);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        continue;
      }
      yield this.queue.shift();
    }
  }

  pushEvent(event: ParsedEngineEvent): void {
    this.queue.push({ kind: 'event', seq: event.envelope.seq, event });
  }

  pushDiagnostic(code: string, message: string): void {
    this.queue.push({ kind: 'diagnostic', failure: { code, message, retryable: true } });
  }

  pushReconnected(sinceSeq: number): void {
    this.queue.push({ kind: 'reconnected', sinceSeq, attempt: 1 });
  }

  tool(_name: string, _input: FakeToolInput): void {
    // Placeholder kept for readability of test intent.
  }
}

function engineEvent(
  name: string,
  seq: number,
  threadId: string,
  turnId: string | null,
  payload: unknown,
  itemId: string | null = null,
): ParsedEngineEvent {
  const envelope = toEventEnvelope({
    schema_version: 1,
    seq,
    event: name,
    thread_id: threadId,
    turn_id: turnId ? padTurnId(turnId) : null,
    item_id: itemId,
    payload,
  });
  const parsed = parseEngineEvent(envelope);
  if (!parsed.ok) throw new Error(`unparseable fake event ${name}: ${parsed.error}`);
  return parsed.event;
}

/** Short turn ids in this test are padded to the contract's opaque shape. */
function padTurnId(value: string): string {
  const hex = value.replace(/^turn_/, '');
  if (/^[0-9a-f]{32}$/.test(hex)) return value;
  return `turn_${hex.padStart(32, '0')}`;
}

type Harness = {
  service: StudioService;
  store: ProjectStore;
  adapter: FakeAdapter;
  project: { id: string; path: string };
  events: StudioEvent[];
  threadId: () => string;
  view: () => Promise<StudioView>;
  waitFor: (predicate: (view: StudioView) => boolean, timeoutMs?: number) => Promise<StudioView>;
  submit: (text: string, options?: { mode?: 'agent' | 'plan'; references?: string[] }) => Promise<void>;
};

async function harness(
  label: string,
  options: {
    maxItemChars?: number;
    attention?: (event: StudioAttentionEvent) => void;
    saveFile?: (input: { title: string; defaultName: string; extensions: string[] }) => Promise<string | null>;
    appVersion?: () => string;
  } = {},
): Promise<Harness> {
  const store = await openStore(label);
  const project = await makeProject(store, label);
  const adapter = new FakeAdapter(project.path);
  const events: StudioEvent[] = [];
  const connected = true;
  const engine = {
    summary: (): EngineSummary => ({
      state: connected ? 'connected' : 'not_started',
      detail: connected ? 'fake runtime connected' : 'not connected',
      workspace: connected ? project.path : null,
      pid: 1,
      endpoint: 'http://127.0.0.1:7801',
      compatibility: 'qualified',
      descriptors: [],
    }),
    adapter: () => (connected ? (adapter as unknown as EngineAdapter) : null),
  };
  const service = new StudioService({
    store,
    engine,
    emit: (event) => events.push(event),
    maxItemChars: options.maxItemChars ?? 64 * 1024,
    flushIntervalMs: 0,
    ...(options.attention ? { attention: options.attention } : {}),
    ...(options.saveFile ? { saveFile: options.saveFile } : {}),
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
  });

  const threadId = (): string => {
    const stateEvent = [...events].reverse().find((event) => event.type === 'state');
    if (!stateEvent || stateEvent.type !== 'state' || !stateEvent.thread) throw new Error('no thread yet');
    return stateEvent.thread.threadId;
  };

  const view = async (): Promise<StudioView> => {
    const result = await service.view(project.id, 'ses_fixture');
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  };

  const waitFor = async (predicate: (view: StudioView) => boolean, timeoutMs = 3_000): Promise<StudioView> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await view();
      if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('condition was never observed');
  };

  const submit = async (
    text: string,
    submitOptions: { mode?: 'agent' | 'plan'; references?: string[] } = {},
  ): Promise<void> => {
    const result = await service.submit({
      projectId: project.id,
      sessionId: 'ses_fixture',
      text,
      mode: submitOptions.mode ?? 'agent',
      references: submitOptions.references ?? [],
    });
    if (!result.ok) throw new Error(`submit failed: ${result.error.message}`);
  };

  cleanup.push(async () => service.close());
  void connected;
  return { service, store, adapter, project, events, threadId, view, waitFor, submit };
}

describe('live studio service', () => {
  it('streams a real turn into user, assistant and outcome items exactly once', async () => {
    const h = await harness('stream');
    await h.submit('Say MONA_OK and touch hello.txt');
    const thread = h.threadId();

    h.adapter.pushEvent(engineEvent('thread.started', 1, thread, null, { thread: { id: thread } }));
    h.adapter.pushEvent(
      engineEvent('turn.started', 2, thread, 'turn_1', {
        turn: { id: 'turn_1', input_summary: 'Say MONA_OK and touch hello.txt' },
      }),
    );
    h.adapter.pushEvent(
      engineEvent(
        'item.started',
        3,
        thread,
        'turn_1',
        {
          item: {
            id: 'item_user',
            kind: 'user_message',
            status: 'completed',
            detail: 'Say MONA_OK and touch hello.txt',
          },
        },
        'item_user',
      ),
    );
    h.adapter.pushEvent(
      engineEvent(
        'item.started',
        4,
        thread,
        'turn_1',
        { item: { id: 'item_agent', kind: 'agent_message', status: 'in_progress' } },
        'item_agent',
      ),
    );
    h.adapter.pushEvent(engineEvent('item.delta', 5, thread, 'turn_1', { delta: 'MONA_' }, 'item_agent'));
    h.adapter.pushEvent(engineEvent('item.delta', 6, thread, 'turn_1', { delta: 'OK' }, 'item_agent'));
    h.adapter.pushEvent(
      engineEvent(
        'item.completed',
        7,
        thread,
        'turn_1',
        { item: { id: 'item_agent', kind: 'agent_message', status: 'completed', detail: 'MONA_OK' } },
        'item_agent',
      ),
    );
    h.adapter.pushEvent(
      engineEvent('turn.usage', 8, thread, 'turn_1', {
        usage: { input_tokens: 120, output_tokens: 40, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100 },
      }),
    );
    h.adapter.pushEvent(
      engineEvent('turn.completed', 9, thread, 'turn_1', {
        turn: {
          id: 'turn_1',
          thread_id: thread,
          status: 'completed',
          duration_ms: 2100,
          workspace_snapshots: [{ kind: 'post_turn', changed_paths: ['hello.txt'] }],
        },
      }),
    );

    const finished = await h.waitFor((current) => current.run.state === 'idle');
    const kinds = finished.items.map((item) => item.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('outcome');
    expect(finished.items.filter((item) => item.kind === 'user')).toHaveLength(1);
    const assistant = finished.items.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.body).toBe('MONA_OK');
    const outcome = finished.items.find((item) => item.kind === 'outcome');
    expect(outcome?.body).toContain('Status: completed');
    expect(outcome?.body).toContain('Changed paths: hello.txt');
    expect(outcome?.body).toContain('Cost: $0.0012');
    expect(finished.thread?.permissionPosture).toBe('full_access');
    expect(h.adapter.submissions).toHaveLength(1);
    const usage = await h.store.projectUsage(h.project.id);
    expect(usage.turnCount).toBe(1);
    expect(usage.knownCostMicros).toBe(1200);
  });

  it('raises one local attention event per settled turn and per blocked problem', async () => {
    const raised: StudioAttentionEvent[] = [];
    const h = await harness('attention', { attention: (event) => raised.push(event) });
    await h.submit('Say MONA_OK');
    const thread = h.threadId();
    h.adapter.pushEvent(engineEvent('thread.started', 1, thread, null, { thread: { id: thread } }));
    h.adapter.pushEvent(
      engineEvent('turn.started', 2, thread, 'turn_00000000000000000000000000000001', {
        turn: { id: 'turn_00000000000000000000000000000001', input_summary: 'Say MONA_OK' },
      }),
    );
    h.adapter.pushEvent(
      engineEvent('turn.completed', 3, thread, 'turn_00000000000000000000000000000001', {
        turn: { id: 'turn_00000000000000000000000000000001', thread_id: thread, status: 'completed' },
      }),
    );
    await h.waitFor((current) => current.run.state === 'idle');
    expect(raised).toEqual([
      expect.objectContaining({
        kind: 'run_completed',
        projectId: h.project.id,
        turnId: 'turn_00000000000000000000000000000001',
        outcome: 'completed',
      }),
    ]);

    h.service.blockOnProblem(h.project.id, {
      problemId: 'prb_attention',
      taskId: 'tsk_attention',
      detail: 'three attempts made no progress',
    });
    expect(raised[1]).toMatchObject({ kind: 'blocker', projectId: h.project.id, taskId: 'tsk_attention' });
  });

  it('renders tool calls as cards with the real tool input', async () => {
    const h = await harness('tool');
    await h.submit('Run the test');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent(
        'item.started',
        2,
        thread,
        'turn_1',
        {
          item: {
            id: 'item_tool',
            kind: 'tool_call',
            status: 'in_progress',
            summary: 'bash started',
            metadata: {
              tool_name: 'bash',
              tool_input: JSON.stringify({ command: 'node check.mjs', description: 'Run the check' }),
            },
          },
        },
        'item_tool',
      ),
    );
    const state = await h.waitFor((current) => current.items.some((item) => item.kind === 'tool'));
    const tool = state.items.find((item) => item.kind === 'tool');
    expect(tool?.title).toBe('Tool · bash');
    expect(tool?.body).toContain('node check.mjs');
    expect(tool?.status).toBe('in_progress');
  });

  it('suppresses a replayed engine sequence instead of duplicating the row', async () => {
    const h = await harness('replay');
    await h.submit('Hello');
    const thread = h.threadId();
    const event = engineEvent(
      'item.completed',
      2,
      thread,
      'turn_1',
      { item: { id: 'item_user', kind: 'user_message', status: 'completed', detail: 'Hello' } },
      'item_user',
    );
    h.adapter.pushEvent(event);
    h.adapter.pushEvent(event);
    const state = await h.waitFor((current) => current.items.length > 0);
    expect(state.items.filter((item) => item.kind === 'user')).toHaveLength(1);
  });

  it('surfaces an approval wait and offers a real interrupt receipt', async () => {
    const h = await harness('approval');
    await h.submit('Delete the build folder');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('approval.required', 2, thread, 'turn_1', {
        approvalId: 'appr_1',
        toolName: 'bash',
        description: 'rm -rf dist needs approval',
      }),
    );
    const waiting = await h.waitFor((current) => current.run.state === 'awaiting_approval');
    expect(waiting.pending?.kind).toBe('approval');
    expect(waiting.pending?.description).toContain('rm -rf dist');
    expect(waiting.capabilities.approvalResponse.status).toBe('unsupported');
    expect(waiting.items.some((item) => item.kind === 'approval')).toBe(true);

    const interrupted = await h.service.interrupt(h.project.id);
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.data.run.state).toBe('interrupting');
    expect(h.adapter.interrupts).toHaveLength(1);

    h.adapter.pushEvent(
      engineEvent('turn.completed', 3, thread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: thread, status: 'interrupted' },
      }),
    );
    const settled = await h.waitFor((current) => current.run.state === 'idle');
    expect(settled.pending).toBeNull();
    expect(settled.items.some((item) => item.title === 'Turn interrupted')).toBe(true);
  });

  it('truncates oversized output and labels it', async () => {
    const h = await harness('oversize', { maxItemChars: 200 });
    await h.submit('Print everything');
    const thread = h.threadId();
    const long = 'A'.repeat(5_000);
    h.adapter.pushEvent(
      engineEvent(
        'item.completed',
        2,
        thread,
        'turn_1',
        { item: { id: 'item_long', kind: 'tool_result', status: 'completed', summary: long } },
        'item_long',
      ),
    );
    const state = await h.waitFor((current) => current.items.some((item) => item.truncated));
    const item = state.items.find((entry) => entry.truncated);
    expect(item?.body.length).toBeLessThan(350);
    expect(item?.body).toContain('output truncated at 200 characters');
  });

  it('composes explicit file references into the prompt exactly as sent', async () => {
    const h = await harness('references');
    await h.submit('Run the failing test', { references: ['src/app.test.ts', 'README.md'] });
    const expected = composePrompt('Run the failing test', ['src/app.test.ts', 'README.md']);
    expect(h.adapter.submissions[0]?.prompt).toBe(expected);
    expect(expected).toContain('- src/app.test.ts');
    const state = await h.view();
    expect(state.capabilities.attachments.status).toBe('unsupported');
    expect(state.capabilities.planMode.status).toBe('supported');
  });

  it('rejects an absolute or traversing file reference instead of sending it', async () => {
    const h = await harness('bad-reference');
    const result = await h.service.submit({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      text: 'Look at this',
      mode: 'agent',
      references: ['C:\\Windows\\win.ini'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_request');
    expect(h.adapter.submissions).toHaveLength(0);
  });

  it('turns a dropped stream into reconnecting, then running after a replay', async () => {
    const h = await harness('reconnect');
    await h.submit('Keep going');
    const thread = h.threadId();
    h.adapter.pushEvent(engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    h.adapter.pushDiagnostic('transport_failed', 'event stream dropped');
    const dropped = await h.waitFor((current) => current.run.state === 'reconnecting');
    expect(dropped.run.detail).toContain('may still be running');
    expect(dropped.diagnostics.some((line) => line.includes('transport_failed'))).toBe(true);

    h.adapter.pushEvent(engineEvent('item.delta', 3, thread, 'turn_1', { delta: 'still here' }, 'item_a'));
    h.adapter.pushReconnected(2);
    const back = await h.waitFor((current) => current.run.state === 'running');
    expect(back.items.some((item) => item.body.includes('still here'))).toBe(true);
  });

  it('starts Plan work in its own engine thread and keeps Work history', async () => {
    const h = await harness('modes');
    await h.submit('Plan the change', { mode: 'plan' });
    const planThread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('item.completed', 2, planThread, 'turn_1', {
        item: { id: 'item_plan', kind: 'agent_message', status: 'completed', detail: 'A plan' },
      }),
    );
    h.adapter.pushEvent(
      engineEvent('turn.completed', 3, planThread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: planThread, status: 'completed' },
      }),
    );
    await h.waitFor((current) => current.run.state === 'idle');

    await h.submit('Do the change', { mode: 'agent' });
    expect(h.adapter.threadCalls.map((call) => call.mode)).toEqual(['plan', 'agent']);
    const agentThread = h.threadId();
    expect(agentThread).not.toBe(planThread);

    const planView = await h.service.view(h.project.id, 'ses_fixture', 'plan');
    expect(planView.ok).toBe(true);
    if (planView.ok) {
      expect(planView.data.thread?.mode).toBe('plan');
      expect(planView.data.items.some((item) => item.body === 'A plan')).toBe(true);
    }
  });

  it('pauses after the current task and refuses new work until resumed', async () => {
    const h = await harness('pause');
    await h.submit('First task');
    const thread = h.threadId();
    const paused = h.service.pause(h.project.id);
    expect(paused.ok).toBe(true);
    if (paused.ok) expect(paused.data.control.pauseRequested).toBe(true);

    h.adapter.pushEvent(
      engineEvent('turn.completed', 2, thread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: thread, status: 'completed' },
      }),
    );
    const idle = await h.waitFor((current) => current.run.state === 'idle');
    expect(idle.control.pauseRequested).toBe(true);

    const refused = await h.service.submit({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      text: 'Second task',
      mode: 'agent',
      references: [],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('paused');

    h.service.resume(h.project.id);
    await h.submit('Second task');
    expect(h.adapter.submissions).toHaveLength(2);
  });

  it('refuses to send anything when the engine is not connected', async () => {
    const store = await openStore('offline');
    const project = await makeProject(store, 'offline');
    const events: StudioEvent[] = [];
    const service = new StudioService({
      store,
      engine: {
        summary: () => ({
          state: 'not_started',
          detail: 'No runtime',
          workspace: null,
          pid: null,
          endpoint: null,
          compatibility: null,
          descriptors: [],
        }),
        adapter: () => null,
      },
      emit: (event) => events.push(event),
    });
    cleanup.push(async () => service.close());
    const result = await service.submit({
      projectId: project.id,
      sessionId: 'ses_offline',
      text: 'Do work',
      mode: 'agent',
      references: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('engine_unavailable');
    expect(events).toHaveLength(0);
  });

  it('marks a live turn uncertain when the engine stops', async () => {
    const h = await harness('stop');
    await h.submit('Long job');
    await h.waitFor((current) => current.run.state === 'running');
    h.service.engineStopped('user stopped the runtime');
    const stopped = await h.view();
    expect(stopped.run.state).toBe('failed');
    expect(stopped.run.detail).toContain('outcome is uncertain');
  });

  it('keeps the observed permission rather than a hard-coded badge', async () => {
    const h = await harness('permission');
    await h.submit('Check permission');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('thread.started', 2, thread, null, {
        thread: {
          id: thread,
          workspace: h.project.path,
          model: 'deepseek-flash',
          model_provider: 'deepseek',
          mode: 'agent',
          permission_posture: 'read_only',
          allow_shell: false,
          trust_mode: false,
          auto_approve: false,
        },
      }),
    );
    const state = await h.waitFor((current) => current.thread !== null);
    // The thread record observed at creation is authoritative; a later event
    // never silently rewrites display state.
    expect(state.thread?.permissionPosture).toBe('full_access');
    expect(state.thread?.allowShell).toBe(true);
  });
});

describe('cost and dispatch boundary', () => {
  it('gates the next dispatch by budget and makes no provider request for UI actions', async () => {
    const store = await openStore('cost-boundary');
    const project = await makeProject(store, 'cost-boundary');
    const adapter = new FakeAdapter(project.path);
    const events: StudioEvent[] = [];
    const ledger = new CostLedger(store, { now: () => new Date('2026-11-12T12:00:00.000Z') });
    await ledger.setBudget({
      projectId: project.id,
      scope: 'project',
      limitMicros: 1_000,
      warnMicros: 500,
      stopMicros: 1_000,
    });
    await ledger.ingest({
      projectId: project.id,
      turnId: 'turn_prior',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1 },
      cost: { kind: 'provider_reported', micros: 1_000, source: 'fixture' },
      source: 'fixture',
    });
    const service = new StudioService({
      store,
      engine: {
        summary: () => ({
          state: 'connected',
          detail: 'fake runtime connected',
          workspace: project.path,
          pid: 1,
          endpoint: 'http://127.0.0.1:7801',
          compatibility: 'qualified',
          descriptors: [],
        }),
        adapter: () => adapter as unknown as EngineAdapter,
      },
      emit: (event) => events.push(event),
      costs: ledger,
      flushIntervalMs: 0,
    });
    cleanup.push(async () => service.close());

    // Reading the studio and pausing/resuming are local operations.
    expect((await service.view(project.id, 'ses_budget')).ok).toBe(true);
    expect(service.pause(project.id).ok).toBe(true);
    expect(service.resume(project.id).ok).toBe(true);
    expect((await service.view(project.id, 'ses_budget')).ok).toBe(true);
    expect(adapter.threadCalls).toHaveLength(0);
    expect(adapter.submissions).toHaveLength(0);

    const blocked = await service.submit({
      projectId: project.id,
      sessionId: 'ses_budget',
      text: 'run the task',
      mode: 'agent',
      references: [],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain('budget');
    expect(adapter.threadCalls).toHaveLength(0);
    expect(adapter.submissions).toHaveLength(0);
  });

  it('reports a native-owned pause as partial instead of claiming it stopped', async () => {
    const store = await openStore('native-pause');
    const project = await makeProject(store, 'native-pause');
    const adapter = new FakeAdapter(project.path);
    const service = new StudioService({
      store,
      engine: {
        summary: () => ({
          state: 'connected',
          detail: 'fake runtime connected',
          workspace: project.path,
          pid: 1,
          endpoint: 'http://127.0.0.1:7801',
          compatibility: 'qualified',
          descriptors: [],
        }),
        adapter: () => adapter as unknown as EngineAdapter,
      },
      emit: () => undefined,
      nativeDispatcherActive: () => true,
      flushIntervalMs: 0,
    });
    cleanup.push(async () => service.close());
    await service.view(project.id, 'ses_native');
    const paused = service.pause(project.id);
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.data.control.pauseRequested).toBe(true);
      expect(paused.data.run.detail).toContain('native workflow');
    }
    expect(adapter.submissions).toHaveLength(0);
  });
});

describe('conversation export', () => {
  async function runOneTurn(h: Harness, prompt: string, reply: string): Promise<void> {
    await h.submit(prompt);
    const thread = h.threadId();
    h.adapter.pushEvent(engineEvent('thread.started', 1, thread, null, { thread: { id: thread } }));
    h.adapter.pushEvent(
      engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1', input_summary: prompt } }),
    );
    h.adapter.pushEvent(
      engineEvent(
        'item.started',
        3,
        thread,
        'turn_1',
        { item: { id: 'item_user', kind: 'user_message', status: 'completed', detail: prompt } },
        'item_user',
      ),
    );
    h.adapter.pushEvent(
      engineEvent(
        'item.completed',
        4,
        thread,
        'turn_1',
        { item: { id: 'item_agent', kind: 'agent_message', status: 'completed', detail: reply } },
        'item_agent',
      ),
    );
    h.adapter.pushEvent(
      engineEvent('turn.completed', 5, thread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: thread, status: 'completed' },
      }),
    );
    await h.waitFor((current) => current.run.state === 'idle');
  }

  it('writes the recorded timeline verbatim and reports the file it wrote', async () => {
    const directory = await tempDir('export');
    const target = path.join(directory, 'conversation.md');
    const h = await harness('export', { saveFile: async () => target, appVersion: () => '0.1.0' });
    await runOneTurn(h, 'Say MONA_OK', 'MONA_OK');

    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_fixture' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.saved).toBe(true);
    expect(result.data.path).toBe(target);
    expect(result.data.items).toBeGreaterThanOrEqual(3);
    expect(result.data.bytes).toBeGreaterThan(0);
    expect(result.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data.note).toContain('No model was called');

    const text = readFileSync(target, 'utf8');
    expect(text).toContain('# Mona conversation');
    expect(text).toContain('Say MONA_OK');
    expect(text).toContain('MONA_OK');
    expect(text).toContain('Mona 0.1.0');
    expect(text).toContain('deepseek-flash');
    expect(text).toContain('full_access');
    // Nothing was sent by exporting.
    expect(h.adapter.submissions).toHaveLength(1);
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    const directory = await tempDir('export-cancel');
    const target = path.join(directory, 'never.md');
    const h = await harness('export-cancel', { saveFile: async () => null });
    await runOneTurn(h, 'Say MONA_OK', 'MONA_OK');

    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_fixture' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.saved).toBe(false);
      expect(result.data.path).toBeNull();
      expect(result.data.bytes).toBe(0);
      expect(result.data.note).toContain('Nothing was written');
    }
    expect(existsSync(target)).toBe(false);
  });

  it('refuses to export a session with no recorded events instead of writing an empty file', async () => {
    const directory = await tempDir('export-empty');
    const h = await harness('export-empty', { saveFile: async () => path.join(directory, 'empty.md') });
    await h.service.view(h.project.id, 'ses_empty');
    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_empty' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('nothing to export');
    expect(existsSync(path.join(directory, 'empty.md'))).toBe(false);
  });
});
