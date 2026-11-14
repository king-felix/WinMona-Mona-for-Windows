// W08 live round trip: open a thread whose posture actually asks for approval
// (shell allowed, auto-approve off), submit one harmless command, and answer the
// real approval.this Mona receives through the same adapter call the product
// uses. This is the only way to observe a genuine pending request: the saved
// Full Access profile never produces one.
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineAdapter } from '../../packages/adapter/dist/index.js';
import { HttpTransport } from '../../packages/adapter/dist/http.js';
import { MemorySubmissionJournal } from '../../packages/adapter/dist/journal.js';
import { makeToken, startOwnedRuntime } from './runtime/client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const out = process.env.MONA_W08_RT_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'W08-roundtrip.json');
const budgetMs = Number(process.env.MONA_W08_RT_TIMEOUT ?? 240_000);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const workspace = await mkdtemp(path.join(tmpdir(), 'mona-w08-rt-'));
const home = await mkdtemp(path.join(tmpdir(), 'mona-w08-rt-home-'));
const port = await freePort();
const token = makeToken();
const steps = [];
const check = (name, ok, detail) => {
  steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}\n`,
  );
};

let runtime = null;
let report = null;
try {
  // The engine needs the machine's own saved provider key to run a turn, so this
  // probe uses the real engine home and a throwaway *workspace*. Only the probe
  // project and that one turn are written; nothing in the user's configuration is
  // changed. Set MONA_W08_RT_ISOLATED=1 to run with a throwaway home instead.
  if (process.env.MONA_W08_RT_ISOLATED === '1') process.env.CODEWHALE_HOME = home;
  runtime = await startOwnedRuntime({
    executable: process.env.MONA_ENGINE_EXECUTABLE ?? 'codewhale',
    workspace,
    port,
    token,
    startupTimeoutMs: 60_000,
  });
  const transport = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}`, token });
  const adapter = new EngineAdapter({
    transport,
    journal: new MemorySubmissionJournal(),
    context: {
      baseUrl: `http://127.0.0.1:${port}`,
      pid: runtime.child?.pid ?? 0,
      workspace,
      startedAt: new Date().toISOString(),
    },
  });
  const discovered = await adapter.discover();
  check('the pinned runtime answers discovery', discovered.ok, discovered.ok ? discovered.value.identity : discovered);

  // A posture that asks: shell allowed, but a command needs a decision.
  const opened = await adapter.createOrOpenThread({
    mode: 'agent',
    allowShell: true,
    trustMode: false,
    autoApprove: false,
    expectedWorkspace: workspace,
  });
  check('a thread opens with a posture that asks before running a command', opened.ok, {
    threadId: opened.ok ? opened.value.threadId : null,
    posture: opened.ok ? opened.value.profile.permissionPosture : null,
    autoApprove: opened.ok ? opened.value.profile.autoApprove : null,
  });
  if (!opened.ok) throw new Error('thread could not be opened');
  const threadId = opened.value.threadId;

  const submitted = await adapter.submitTurn({
    threadId,
    prompt:
      'Run this exactly once with the shell tool: node -e "console.log(String.fromCharCode(77,79,78,65))". Then reply with the single word DONE.',
  });
  check('one bounded turn is submitted', submitted.ok, submitted.ok ? { turnId: submitted.value.turnId } : submitted);
  const turnId = submitted.ok ? submitted.value.turnId : null;

  const seen = [];
  const toolsUsed = [];
  let approval = null;
  let completed = null;
  const controller = new AbortController();
  const deadline = Date.now() + budgetMs;
  for await (const frame of adapter.subscribe({ threadId, signal: controller.signal })) {
    if (frame.kind === 'event') {
      const name = frame.event.envelope.event;
      seen.push(name);
      if (name === 'item.completed') {
        const item = frame.event.envelope.payload?.item ?? {};
        if (item.metadata?.tool_name) toolsUsed.push(String(item.metadata.tool_name));
      }
      if (name === 'approval.required' && approval === null) {
        approval = frame.event.envelope;
      }
      if (name === 'turn.completed') {
        completed = frame.event.envelope;
        break;
      }
    }
    if (Date.now() > deadline) break;
  }
  controller.abort();

  check('the runtime asked for an approval before running the command', approval !== null, {
    events: [...new Set(seen)].slice(0, 20),
    payload: approval?.payload ?? null,
  });

  const payload = approval?.payload ?? {};
  const approvalId = payload.approval_id ?? payload.approvalId ?? payload.id ?? null;
  if (approvalId) {
    const decision = await adapter.respondToApproval({ threadId, approvalId, decision: 'allow', remember: false });
    check('the decision is accepted by the runtime', decision.ok, decision.ok ? decision.value : decision.error);
  } else {
    check('the decision is accepted by the runtime', false, { reason: 'the approval event carried no id' });
  }

  // Let the turn finish after the decision.
  const followUp = approvalId
    ? (async () => {
        const waitUntil = Date.now() + 180_000;
        for await (const frame of adapter.subscribe({ threadId, signal: new AbortController().signal })) {
          if (frame.kind === 'event' && frame.event.envelope.event === 'turn.completed') return frame.event.envelope;
          if (Date.now() > waitUntil) return null;
        }
        return null;
      })()
    : Promise.resolve(null);
  const finished = completed ?? (await followUp);
  check('the turn reaches a terminal state after the decision', finished !== null, {
    payload: finished?.payload ?? null,
  });

  report = {
    ok: steps.every((step) => step.ok),
    steps,
    engine: discovered.ok ? discovered.value.identity : null,
    threadId,
    turnId,
    approvalId,
    eventsObserved: [...new Set(seen)],
    toolsUsed: [...new Set(toolsUsed)],
    providerRequests: approval === null ? 1 : 2,
    note: 'One bounded turn on the configured route, with the workspace posture that asks before a shell command. The decision was sent through EngineAdapter.respondToApproval, the same call the studio uses.',
    capturedAt: new Date().toISOString(),
  };
} catch (error) {
  report = {
    ok: false,
    steps,
    error: error instanceof Error ? error.message : String(error),
    capturedAt: new Date().toISOString(),
  };
  console.error(error);
} finally {
  await runtime?.stop?.().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (!report?.ok) process.exitCode = 1;
}
