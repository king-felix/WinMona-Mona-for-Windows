import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
  readonly submissions: Array<{ threadId: string; prompt: string; operationKey: string | null }> = [];
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

  async submitTurn(input: { threadId: string; prompt: string; operationKey?: string }) {
    this.turnCounter += 1;
    this.submissions.push({
      threadId: input.threadId,
      prompt: input.prompt,
      operationKey: input.operationKey ?? null,
    });
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

  readonly approvals: Array<{ threadId: string; approvalId: string; decision: string; remember: boolean }> = [];
  readonly userInputs: Array<{
    threadId: string;
    requestId: string;
    answers: Array<{ id: string; label: string; value: string }>;
  }> = [];
  /** Set to make the runtime refuse the next reply, as an expired request would. */
  refuseReply: { code: string; message: string } | null = null;

  async respondToApproval(input: {
    threadId: string;
    approvalId: string;
    decision: 'allow' | 'deny';
    remember: boolean;
  }) {
    this.approvals.push(input);
    if (this.refuseReply) {
      return {
        ok: false as const,
        error: { code: this.refuseReply.code, message: this.refuseReply.message, retryable: false },
      };
    }
    return {
      ok: true as const,
      value: {
        threadId: input.threadId,
        approvalId: input.approvalId,
        decision: input.decision,
        echoed: true,
        remember: input.remember,
      },
    };
  }

  async respondToUserInput(input: {
    threadId: string;
    requestId: string;
    answers: Array<{ id: string; label: string; value: string }>;
  }) {
    this.userInputs.push(input);
    if (this.refuseReply) {
      return {
        ok: false as const,
        error: { code: this.refuseReply.code, message: this.refuseReply.message, retryable: false },
      };
    }
    return {
      ok: true as const,
      value: {
        threadId: input.threadId,
        requestId: input.requestId,
        answers: input.answers.length,
        acknowledged: true,
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
  sessionId: string;
  engineSummary: () => EngineSummary;
};

async function harness(
  label: string,
  options: {
    maxItemChars?: number;
    flushIntervalMs?: number;
    attention?: (event: StudioAttentionEvent) => void;
    saveFile?: (input: { title: string; defaultName: string; extensions: string[] }) => Promise<string | null>;
    appVersion?: () => string;
    costs?: CostLedger;
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
    flushIntervalMs: options.flushIntervalMs ?? 0,
    ...(options.attention ? { attention: options.attention } : {}),
    ...(options.saveFile ? { saveFile: options.saveFile } : {}),
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    ...(options.costs ? { costs: options.costs } : {}),
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
  return {
    service,
    store,
    adapter,
    project,
    events,
    threadId,
    view,
    waitFor,
    submit,
    sessionId: 'ses_fixture',
    engineSummary: () => engine.summary(),
  };
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

  it('records an approval durably and answers it once, with an acknowledgement', async () => {
    const h = await harness('approval');
    await h.submit('Delete the build folder');
    const thread = h.threadId();
    // The pinned runtime's own spelling: approval_id / tool_name.
    h.adapter.pushEvent(
      engineEvent('approval.required', 2, thread, 'turn_1', {
        approval_id: 'appr_1',
        tool_name: 'bash',
        description: 'rm -rf dist needs approval',
        intent_summary: 'The agent wants to remove the build output.',
      }),
    );
    const waiting = await h.waitFor((current) => current.run.state === 'awaiting_approval');
    expect(waiting.pending?.kind).toBe('approval');
    expect(waiting.pending?.requestId).toBe('appr_1');
    expect(waiting.pending?.description).toContain('rm -rf dist');
    expect(waiting.capabilities.approvalResponse.status).toBe('supported');
    expect(waiting.items.some((item) => item.kind === 'approval')).toBe(true);

    const rows = await h.store.listHumanRequests(h.project.id, { status: 'pending' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('approval');
    expect(rows[0]?.permitted.decisions).toEqual(['allow', 'deny']);

    // Dismissing the card is not an answer: nothing has been sent yet.
    expect(h.adapter.approvals).toHaveLength(0);

    const answered = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'appr_1',
      decision: 'allow',
      remember: true,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.data.acknowledged).toBe(true);
    expect(h.adapter.approvals).toEqual([
      { threadId: thread, approvalId: 'appr_1', decision: 'allow', remember: true },
    ]);

    const after = await h.view();
    expect(after.pending).toBeNull();
    expect(after.run.state).toBe('running');
    const settled = await h.store.listHumanRequests(h.project.id, { status: 'answered' });
    expect(settled).toHaveLength(1);
    expect(settled[0]?.answer).toEqual({ decision: 'allow', remember: true, answers: [] });

    // A second click is refused and sends nothing: one request, one decision.
    const again = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'appr_1',
      decision: 'deny',
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('conflict');
    expect(h.adapter.approvals).toHaveLength(1);
  });

  it('refuses an approval answer the recorded request does not permit', async () => {
    const h = await harness('approval-invalid');
    await h.submit('Delete the build folder');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('approval.required', 2, thread, 'turn_1', { approval_id: 'appr_2', tool_name: 'bash' }),
    );
    await h.waitFor((current) => current.run.state === 'awaiting_approval');

    const missing = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'appr_2',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('invalid_request');

    const unknown = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'appr_2',
      decision: 'allow',
    });
    expect(unknown.ok).toBe(true);
    expect(h.adapter.approvals).toHaveLength(1);
  });

  it('treats a runtime refusal as an expired request instead of retrying', async () => {
    const h = await harness('approval-expired');
    await h.submit('Delete the build folder');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('approval.required', 2, thread, 'turn_1', { approval_id: 'appr_3', tool_name: 'bash' }),
    );
    await h.waitFor((current) => current.run.state === 'awaiting_approval');
    h.adapter.refuseReply = { code: 'not_found', message: 'runtime route or item was not found' };

    const refused = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'appr_3',
      decision: 'deny',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('not_found');
    // Exactly one attempt reached the runtime; the row is settled, not retried.
    expect(h.adapter.approvals).toHaveLength(1);
    const rows = await h.store.listHumanRequests(h.project.id);
    expect(rows[0]?.status).toBe('expired');
    const view = await h.view();
    expect(view.pending).toBeNull();
    expect(view.run.state).toMatch(/running|awaiting_approval/);
  });

  it('answers a clarification with the runtime questions, refusing an incomplete answer', async () => {
    const h = await harness('input');
    await h.submit('Ask me which folder');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('user_input.required', 2, thread, 'turn_1', {
        request_id: 'req_1',
        request: {
          questions: [
            {
              id: 'q1',
              header: 'Folder',
              question: 'Which folder should be removed?',
              options: [{ label: 'dist' }, { label: 'build' }],
            },
          ],
        },
      }),
    );
    const waiting = await h.waitFor((current) => current.run.state === 'awaiting_approval');
    expect(waiting.pending?.kind).toBe('input');
    if (waiting.pending?.kind !== 'input') return;
    expect(waiting.pending.questions).toHaveLength(1);
    expect(waiting.pending.questions[0]?.options.map((option) => option.label)).toEqual(['dist', 'build']);

    const empty = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'req_1',
      answers: [],
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe('invalid_request');
    expect(h.adapter.userInputs).toHaveLength(0);

    const forged = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'req_1',
      answers: [{ id: 'q1', label: 'everything', value: 'everything' }],
    });
    expect(forged.ok).toBe(false);
    expect(h.adapter.userInputs).toHaveLength(0);

    const answered = await h.service.respond({
      projectId: h.project.id,
      sessionId: h.sessionId,
      requestId: 'req_1',
      answers: [{ id: 'q1', label: 'dist', value: 'dist' }],
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.data.answers).toEqual([{ id: 'q1', label: 'dist', value: 'dist' }]);
    expect(h.adapter.userInputs).toHaveLength(1);
    expect(h.adapter.userInputs[0]?.requestId).toBe('req_1');
  });

  it('reads session usage from recorded rows and keeps unknown and missing values honest', async () => {
    const store = await openStore('usage');
    const project = await makeProject(store, 'usage');
    const ledger = new CostLedger(store);
    const adapter = new FakeAdapter(project.path);
    const events: StudioEvent[] = [];
    const engine = {
      summary: (): EngineSummary => ({
        state: 'connected',
        detail: 'fake runtime connected',
        workspace: project.path,
        pid: 1,
        endpoint: 'http://127.0.0.1:7801',
        compatibility: 'qualified',
        descriptors: [],
      }),
      adapter: () => adapter as unknown as EngineAdapter,
    };
    const service = new StudioService({
      store,
      engine,
      emit: (event) => events.push(event),
      flushIntervalMs: 0,
      costs: ledger,
    });
    const opened = await service.submit({
      projectId: project.id,
      sessionId: 'ses_usage',
      text: 'A turn that records usage',
      mode: 'agent',
      references: [],
    });
    expect(opened.ok).toBe(true);
    const threadId = opened.ok ? opened.data.threadId : '';

    // Nothing recorded yet: the HUD says so instead of showing a free turn.
    let view = await service.view(project.id, 'ses_usage');
    expect(view.ok && view.data.usage).toBeNull();

    const buckets = {
      cacheHitTokens: 256,
      cacheMissTokens: 744,
      inputTokens: 1_000,
      outputTokens: 300,
      reasoningTokens: 120,
    };
    const priced = await ledger.ingest({
      projectId: project.id,
      threadId,
      turnId: 'turn_usage',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets,
      cost: { kind: 'provider_reported', micros: 2_500, source: 'runtime' },
      source: 'studio-test',
    });
    expect(priced.recorded).toBe(true);
    const unpriced = await ledger.ingest({
      projectId: project.id,
      threadId,
      turnId: 'turn_usage_2',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets: { cacheHitTokens: null, cacheMissTokens: null, inputTokens: null, outputTokens: null },
      cost: { kind: 'unknown', reason: 'the runtime did not price this turn' },
      source: 'studio-test',
    });
    expect(unpriced.recorded).toBe(true);

    // A duplicate replay must not double-charge the session.
    const duplicate = await ledger.ingest({
      projectId: project.id,
      threadId,
      turnId: 'turn_usage',
      provider: 'deepseek',
      model: 'deepseek-flash',
      buckets,
      cost: { kind: 'provider_reported', micros: 2_500, source: 'runtime' },
      source: 'studio-test',
    });
    expect(duplicate.duplicate).toBe(true);

    view = await service.view(project.id, 'ses_usage');
    expect(view.ok).toBe(true);
    if (!view.ok || !view.data.usage) throw new Error('usage was not projected');
    expect(view.data.usage.records).toBe(2);
    expect(view.data.usage.knownMicros).toBe(2_500);
    expect(view.data.usage.unknownRecords).toBe(1);
    expect(view.data.usage.tokens.cacheHit).toBe(256);
    expect(view.data.usage.tokens.cacheMiss).toBe(744);
    expect(view.data.usage.tokens.input).toBe(1_000);
    expect(view.data.usage.tokens.output).toBe(300);
    expect(view.data.usage.tokens.reasoning).toBe(120);
    expect(view.data.usage.reasoningIncludedInOutput).toBe(true);
    expect(view.data.usage.scope).toBe('session');
    // Reading the studio sent nothing.
    expect(adapter.submissions).toHaveLength(1);
  });

  it("restores a pending request after a restart and never answers another project's request", async () => {
    const h = await harness('reconnect');
    await h.submit('Delete the build folder');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('approval.required', 2, thread, 'turn_1', { approval_id: 'appr_9', tool_name: 'bash' }),
    );
    await h.waitFor((current) => current.run.state === 'awaiting_approval');

    // A fresh service over the same store is what a restart looks like.
    const restarted = new StudioService({
      store: h.store,
      engine: { summary: h.engineSummary, adapter: () => h.adapter as unknown as EngineAdapter },
      emit: () => undefined,
      flushIntervalMs: 0,
    });
    const afterRestart = await restarted.view(h.project.id, h.sessionId, 'agent');
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) return;
    expect(afterRestart.data.pending?.requestId).toBe('appr_9');
    expect(afterRestart.data.run.state).toBe('awaiting_approval');

    const other = await makeProject(h.store, 'other-project');
    const crossed = await h.service.respond({
      projectId: other.id,
      sessionId: h.sessionId,
      requestId: 'appr_9',
      decision: 'allow',
    });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('not_found');
    expect(h.adapter.approvals).toHaveLength(0);
  });

  it('settles the card when the runtime reports the request decided elsewhere', async () => {
    const h = await harness('settled');
    await h.submit('Delete the build folder');
    const thread = h.threadId();
    h.adapter.pushEvent(
      engineEvent('approval.required', 2, thread, 'turn_1', { approval_id: 'appr_5', tool_name: 'bash' }),
    );
    await h.waitFor((current) => current.run.state === 'awaiting_approval');
    h.adapter.pushEvent(
      engineEvent('approval.decided', 3, thread, 'turn_1', { approval_id: 'appr_5', decision: 'deny' }),
    );
    const settled = await h.waitFor((current) => current.pending === null);
    expect(settled.pending).toBeNull();
    const rows = await h.store.listHumanRequests(h.project.id);
    expect(rows[0]?.status).toBe('answered');
    // No decision of Mona's own was sent for someone else's decision.
    expect(h.adapter.approvals).toHaveLength(0);
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
    // A reference must be a real file inside the project; create them first.
    await mkdir(path.join(h.project.path, 'src'), { recursive: true });
    writeFileSync(path.join(h.project.path, 'src', 'app.test.ts'), 'test\n', 'utf8');
    writeFileSync(path.join(h.project.path, 'README.md'), '# fixture\n', 'utf8');
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

  it('refuses a reference that is missing or escapes the project through a junction', async () => {
    const h = await harness('reference-policy');
    await mkdir(path.join(h.project.path, 'real'), { recursive: true });
    writeFileSync(path.join(h.project.path, 'real', 'note.txt'), 'inside\n', 'utf8');

    const missing = await h.service.submit({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      text: 'Read this',
      mode: 'agent',
      references: ['does/not/exist.txt'],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('not a file in this project');

    const outside = await tempDir('outside');
    writeFileSync(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
    let linked = true;
    try {
      // A junction needs no elevation on Windows; if the platform refuses, the
      // escape case cannot be constructed and is reported rather than assumed.
      symlinkSync(outside, path.join(h.project.path, 'linked'), 'junction');
    } catch {
      linked = false;
    }
    if (linked) {
      const escaped = await h.service.submit({
        projectId: h.project.id,
        sessionId: 'ses_fixture',
        text: 'Read this',
        mode: 'agent',
        references: ['linked/secret.txt'],
      });
      expect(escaped.ok).toBe(false);
      if (!escaped.ok) expect(escaped.error.message).toContain('resolves outside this project');
    }

    const traversal = await h.service.submit({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      text: 'Read this',
      mode: 'agent',
      references: ['../outside/secret.txt'],
    });
    expect(traversal.ok).toBe(false);

    // Nothing above reached the engine.
    expect(h.adapter.submissions).toHaveLength(0);

    // A real project-relative file is accepted and normalised.
    const accepted = await h.service.submit({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      text: 'Read this',
      mode: 'agent',
      references: ['real\\note.txt', 'real/note.txt'],
    });
    expect(accepted.ok).toBe(true);
    expect(h.adapter.submissions[0]?.prompt).toContain('- real/note.txt');
    // The duplicate spelling of one path is sent once.
    expect(h.adapter.submissions[0]?.prompt.match(/- real\/note\.txt/g)).toHaveLength(1);
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

  it('accepts exactly one dispatch when two submits overlap', async () => {
    const store = await openStore('dispatch-once');
    const project = await makeProject(store, 'dispatch-once');
    const adapter = new FakeAdapter(project.path);
    const ledger = new CostLedger(store, { now: () => new Date('2026-11-12T12:00:00.000Z') });
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
      // The budget check is an await between the run-state guard and the claim.
      // That gap is exactly where a second click used to slip through.
      costs: ledger,
      flushIntervalMs: 0,
    });
    cleanup.push(async () => service.close());
    await service.view(project.id, 'ses_once');

    const [first, second] = await Promise.all([
      service.submit({
        projectId: project.id,
        sessionId: 'ses_once',
        text: 'run it once',
        mode: 'agent',
        references: [],
      }),
      service.submit({
        projectId: project.id,
        sessionId: 'ses_once',
        text: 'run it once',
        mode: 'agent',
        references: [],
      }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const refused = first.ok ? second : first;
    if (refused.ok) throw new Error('expected one refusal');
    expect(refused.error.message).toContain('already');
    expect(adapter.submissions).toHaveLength(1);
    expect(adapter.threadCalls).toHaveLength(1);
    // The accepted turn carries a journal key, so an uncertain outcome reconciles
    // against this dispatch instead of being minted again on a retry.
    expect(adapter.submissions[0]?.operationKey).toMatch(/^turn-[0-9a-f]{32}$/);
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

  it('writes a Unicode destination with spaces and reports the bytes it wrote', async () => {
    const directory = await tempDir('export-unicode');
    const folder = path.join(directory, 'Mona gespräche — café');
    await mkdir(folder, { recursive: true });
    const target = path.join(folder, 'Konversation ünicode.md');
    const h = await harness('export-unicode', { saveFile: async () => target });
    await runOneTurn(h, 'Say MONA_OK', 'MONA_OK');

    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_fixture' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.saved).toBe(true);
      expect(result.data.path).toBe(target);
      expect(result.data.bytes).toBe(Buffer.byteLength(readFileSync(target, 'utf8'), 'utf8'));
      expect(result.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(readFileSync(target, 'utf8')).toContain('MONA_OK');
  });

  it('replaces an existing export atomically instead of appending or half-writing', async () => {
    const directory = await tempDir('export-existing');
    const target = path.join(directory, 'existing.md');
    writeFileSync(target, 'older export text', 'utf8');
    const h = await harness('export-existing', { saveFile: async () => target });
    await runOneTurn(h, 'Say MONA_OK', 'MONA_OK');

    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_fixture' });
    expect(result.ok).toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text).not.toContain('older export text');
    expect(text).toContain('Say MONA_OK');
    // No temporary sibling survived the rename.
    const leftovers = readdirSync(directory).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('reports a destination it cannot write instead of claiming an export', async () => {
    const directory = await tempDir('export-denied');
    // A path whose parent does not exist is the cheap, portable stand-in for a
    // read-only or unavailable destination; the assertion is that the writer
    // fails closed and leaves no partial file.
    const target = path.join(directory, 'missing-parent', 'conversation.md');
    const h = await harness('export-denied', { saveFile: async () => target });
    await runOneTurn(h, 'Say MONA_OK', 'MONA_OK');

    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_fixture' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('could not be written');
    expect(existsSync(target)).toBe(false);
  });
});

describe('stored history and stream identity', () => {
  const LONG_THREAD = `thr_${'c'.repeat(32)}`;

  async function seedHistory(h: Harness, count: number, label = 'entry'): Promise<void> {
    const profile = {
      threadId: LONG_THREAD,
      workspace: h.project.path,
      provider: 'deepseek',
      model: 'deepseek-flash',
      mode: 'agent',
      permissionPosture: 'full_access',
      allowShell: true,
      trustMode: true,
      autoApprove: true,
      observedAt: '2026-11-12T00:00:00.000Z',
    };
    await h.store.putStudioThread({
      id: LONG_THREAD,
      projectId: h.project.id,
      engineThreadId: LONG_THREAD,
      workspace: h.project.path,
      sessionId: 'ses_fixture',
      mode: 'agent',
      profileJson: JSON.stringify(profile),
    });
    await h.store.write((tx) => {
      const insert = tx.db.prepare(
        `INSERT INTO timeline_items(id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`,
      );
      for (let index = 0; index < count; index += 1) {
        const seq = index + 1;
        const at = new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString();
        insert.run(
          `tl_${LONG_THREAD}_${seq}`,
          h.project.id,
          LONG_THREAD,
          seq,
          'assistant',
          `Item ${seq}`,
          `${label}-${String(seq).padStart(4, '0')}`,
          'completed',
          at,
          at,
        );
      }
    });
  }

  it('opens at the newest stored rows and pages back with no provider call', async () => {
    const h = await harness('history-window');
    await seedHistory(h, 1_200);

    const first = await h.view();
    expect(first.items).toHaveLength(500);
    expect(first.items[0]?.seq).toBe(701);
    expect(first.items[first.items.length - 1]?.seq).toBe(1_200);
    expect(first.history).toMatchObject({
      total: 1_200,
      oldestSeq: 701,
      newestSeq: 1_200,
      hasOlder: true,
      hasNewer: false,
    });

    const older = await h.service.history({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      beforeSeq: 701,
      limit: 500,
    });
    expect(older.ok).toBe(true);
    if (older.ok) {
      expect(older.data.items[0]?.seq).toBe(201);
      expect(older.data.items[older.data.items.length - 1]?.seq).toBe(700);
      expect(older.data.window.hasOlder).toBe(true);
      expect(older.data.window.hasNewer).toBe(true);
    }

    const oldest = await h.service.history({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      beforeSeq: 201,
      limit: 500,
    });
    expect(oldest.ok).toBe(true);
    if (oldest.ok) {
      expect(oldest.data.items[0]?.seq).toBe(1);
      expect(oldest.data.window.hasOlder).toBe(false);
    }

    const around = await h.service.history({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      aroundSeq: 500,
      limit: 100,
    });
    expect(around.ok).toBe(true);
    if (around.ok) expect(around.data.items.some((item) => item.seq === 500)).toBe(true);

    // Paging is local-only.
    expect(h.adapter.submissions).toHaveLength(0);
    expect(h.adapter.threadCalls).toHaveLength(0);
  });

  it('finds old content by search and reports the honest total', async () => {
    const h = await harness('history-search');
    await seedHistory(h, 1_200);

    const found = await h.service.searchHistory({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      query: 'entry-0117',
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.data.total).toBe(1);
      expect(found.data.items[0]?.seq).toBe(117);
    }

    const none = await h.service.searchHistory({
      projectId: h.project.id,
      sessionId: 'ses_fixture',
      query: 'not recorded anywhere',
    });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.data.total).toBe(0);
    expect(h.adapter.submissions).toHaveLength(0);
  });

  it('exports every stored row rather than the loaded window', async () => {
    const directory = await tempDir('export-history');
    const target = path.join(directory, 'conversation.md');
    const h = await harness('export-history', { saveFile: async () => target });
    await seedHistory(h, 1_200);

    const result = await h.service.exportConversation({ projectId: h.project.id, sessionId: 'ses_fixture' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toBe(1_200);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('entry-0001');
    expect(text).toContain('entry-1200');
    expect(text).toContain('all 1200 stored item(s)');
    expect(existsSync(target)).toBe(true);
  });

  it('keeps one answer card when a heartbeat sits between id-less deltas', async () => {
    const h = await harness('heartbeat');
    await h.submit('Stream slowly');
    const thread = h.threadId();

    h.adapter.pushEvent(engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    h.adapter.pushEvent(engineEvent('item.delta', 3, thread, 'turn_1', { delta: 'ALPHA' }, null));
    h.adapter.pushEvent(engineEvent('turn.lifecycle', 4, thread, 'turn_1', { phase: 'heartbeat' }));
    h.adapter.pushEvent(engineEvent('item.delta', 5, thread, 'turn_1', { delta: ' BETA' }, null));
    h.adapter.pushEvent(
      engineEvent('turn.completed', 6, thread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: thread, status: 'completed' },
      }),
    );

    const settled = await h.waitFor((current) => current.run.state === 'idle');
    const assistant = settled.items.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.body).toBe('ALPHA BETA');
    expect(assistant[0]?.status).toBe('completed');
  });

  it('reconciles an id-less stream with its final message instead of duplicating the card', async () => {
    const h = await harness('reconcile');
    await h.submit('Answer once');
    const thread = h.threadId();

    h.adapter.pushEvent(engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    h.adapter.pushEvent(engineEvent('item.delta', 3, thread, 'turn_1', { delta: 'MONA_' }, null));
    h.adapter.pushEvent(engineEvent('item.delta', 4, thread, 'turn_1', { delta: 'OK' }, null));
    h.adapter.pushEvent(
      engineEvent(
        'item.completed',
        5,
        thread,
        'turn_1',
        { item: { id: 'item_agent', kind: 'agent_message', status: 'completed', detail: 'MONA_OK' } },
        'item_agent',
      ),
    );
    h.adapter.pushEvent(
      engineEvent('turn.completed', 6, thread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: thread, status: 'completed' },
      }),
    );

    const settled = await h.waitFor((current) => current.run.state === 'idle');
    const assistant = settled.items.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.body).toBe('MONA_OK');
    expect(assistant[0]?.status).toBe('completed');
    expect(settled.items.filter((item) => item.kind === 'outcome')).toHaveLength(1);
  });

  it('records a late delta as late instead of appending it to a finished answer', async () => {
    const h = await harness('late-delta');
    await h.submit('Answer once');
    const thread = h.threadId();

    h.adapter.pushEvent(engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    h.adapter.pushEvent(engineEvent('item.delta', 3, thread, 'turn_1', { delta: 'DONE' }, 'item_agent'));
    h.adapter.pushEvent(
      engineEvent(
        'item.completed',
        4,
        thread,
        'turn_1',
        { item: { id: 'item_agent', kind: 'agent_message', status: 'completed', detail: 'DONE' } },
        'item_agent',
      ),
    );
    h.adapter.pushEvent(engineEvent('item.delta', 5, thread, 'turn_1', { delta: ' LATE' }, 'item_agent'));

    const settled = await h.waitFor((current) => current.diagnostics.some((line) => line.includes('late delta')));
    const assistant = settled.items.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.body).toBe('DONE');
    expect(assistant[0]?.status).toBe('completed');
  });

  it('ignores a frame that claims another thread', async () => {
    const h = await harness('thread-mismatch');
    await h.submit('Answer once');
    const thread = h.threadId();
    const other = `thr_${'d'.repeat(32)}`;

    h.adapter.pushEvent(engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    h.adapter.pushEvent(engineEvent('item.delta', 3, other, 'turn_1', { delta: 'BETA' }, 'item_other'));

    const seen = await h.waitFor((current) => current.diagnostics.some((line) => line.includes('thread_mismatch')));
    expect(seen.items.some((item) => item.body.includes('BETA'))).toBe(false);
  });

  it('closes a mid-stream answer as interrupted when the stream resumes past missing frames', async () => {
    const h = await harness('gap');
    await h.submit('Stream then drop');
    const thread = h.threadId();

    h.adapter.pushEvent(engineEvent('turn.started', 2, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    h.adapter.pushEvent(engineEvent('item.delta', 3, thread, 'turn_1', { delta: 'HALF' }, null));
    h.adapter.pushReconnected(9);

    const recovered = await h.waitFor((current) =>
      current.items.some((item) => item.kind === 'status' && item.title === 'Event stream resumed past missing frames'),
    );
    const assistant = recovered.items.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.body).toBe('HALF');
    expect(assistant[0]?.status).toBe('interrupted');
    const notice = recovered.items.find((item) => item.title === 'Event stream resumed past missing frames');
    expect(notice?.body).toContain('5 frame(s) were not delivered');
  });

  it('keeps a 2 100-frame turn in one row and labels the size truncation', async () => {
    const h = await harness('long-turn', { flushIntervalMs: 60_000, maxItemChars: 5_000 });
    await h.submit('Stream a lot');
    const thread = h.threadId();

    h.adapter.pushEvent(engineEvent('turn.started', 1, thread, 'turn_1', { turn: { id: 'turn_1' } }));
    for (let frame = 0; frame < 2_100; frame += 1) {
      h.adapter.pushEvent(engineEvent('item.delta', frame + 2, thread, 'turn_1', { delta: '0123456789' }, null));
    }
    h.adapter.pushEvent(
      engineEvent('turn.completed', 2_102, thread, 'turn_1', {
        turn: { id: 'turn_1', thread_id: thread, status: 'completed' },
      }),
    );

    const streamed = await h.waitFor((current) => current.run.state === 'idle', 25_000);
    const assistant = streamed.items.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.truncated).toBe(true);
    expect(assistant[0]?.body).toContain('output truncated at 5,000 characters');
    // Every frame was still accounted for: truncation is labeled, not hidden.
    expect(streamed.diagnostics.some((line) => line.includes('sequence gap'))).toBe(false);
  }, 30_000);
});
