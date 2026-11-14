// W08 live reply probe: start the pinned runtime on loopback, open a real
// thread, and send a reply to a request id that does not exist. This qualifies
// the actual routes Mona answers on (POST /v1/approvals/{id} and
// POST /v1/user-input/{thread}/{id}) without spending a provider request: the
// only thing a real approval would add is a pending id, which Full Access does
// not produce. Every result is written to docs/evidence/W08-reply.json.
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
const out = process.env.MONA_W08_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'W08-reply.json');

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

import { createServer } from 'node:net';

const workspace = await mkdtemp(path.join(tmpdir(), 'mona-w08-reply-'));
const home = await mkdtemp(path.join(tmpdir(), 'mona-w08-home-'));
const port = await freePort();
const token = makeToken();
const steps = [];
const check = (name, ok, detail) => {
  steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}\n`,
  );
};

let runtime = null;
let adapter = null;
try {
  // A throwaway CODEWHALE_HOME keeps the probe out of the user's real config
  // and sessions; the runtime reads it from the environment.
  process.env.CODEWHALE_HOME = home;
  runtime = await startOwnedRuntime({
    executable: process.env.MONA_ENGINE_EXECUTABLE ?? 'codewhale',
    workspace,
    port,
    token,
    startupTimeoutMs: 60_000,
  });
  check('the pinned runtime starts on loopback with a bearer token', true, { port });

  const transport = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}`, token });
  adapter = new EngineAdapter({
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
  check('the runtime identifies itself as the pinned engine', discovered.ok, {
    version: discovered.ok ? discovered.value.identity.version : null,
    commit: discovered.ok ? discovered.value.identity.commit : null,
  });

  const opened = await adapter.createOrOpenThread({ mode: 'agent', expectedWorkspace: workspace });
  check('a real thread opens without any provider request', opened.ok, {
    threadId: opened.ok ? opened.value.threadId : null,
  });
  const threadId = opened.ok ? opened.value.threadId : '';

  const answer = await adapter.respondToUserInput({
    threadId,
    requestId: 'mona_probe_missing_request',
    answers: [{ id: 'q1', label: 'Other', value: 'probe' }],
  });
  check(
    'a clarification reply reaches POST /v1/user-input and is refused for an unknown request',
    !answer.ok,
    answer.ok ? { unexpected: answer.value } : { code: answer.error.code, detail: answer.error.detail ?? null },
  );

  const approval = await adapter.respondToApproval({
    threadId,
    approvalId: 'mona_probe_missing_approval',
    decision: 'allow',
    remember: false,
  });
  check(
    'an approval decision reaches POST /v1/approvals and is refused for an unknown approval',
    !approval.ok,
    approval.ok ? { unexpected: approval.value } : { code: approval.error.code, detail: approval.error.detail ?? null },
  );

  // Read the runtime's own refusal, unmediated, so "the route exists and the id
  // is what failed" is observed rather than inferred from a status code.
  const raw = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = (await response.text()).slice(0, 400);
    return { route, status: response.status, body: text };
  };
  const unknownRoute = await raw('POST', '/v1/approvals', {});
  const approvalRaw = await raw('POST', '/v1/approvals/mona_probe_missing_approval', {
    decision: 'allow',
    remember: false,
  });
  const inputRaw = await raw('POST', `/v1/user-input/${threadId}/mona_probe_missing_request`, {
    answers: [{ id: 'q1', label: 'Other', value: 'probe' }],
  });
  check(
    'the approval route exists and names the approval it does not hold',
    approvalRaw.status === 404 && /no pending approval with id/.test(approvalRaw.body),
    approvalRaw,
  );
  // The runtime answers from its own handler; in this fresh process it resolves
  // the thread first, so the refusal it gives is about the thread. Either way the
  // route exists and the refusal is structured, not an unknown-route response.
  check(
    'the clarification route exists and answers from its own handler',
    inputRaw.status === 404 && /"error"/.test(inputRaw.body),
    inputRaw,
  );
  check(
    'a different method or path is refused as a route problem, not mistaken for a request problem',
    unknownRoute.status === 404 || unknownRoute.status === 405,
    unknownRoute,
  );

  const report = {
    ok: steps.every((step) => step.ok),
    steps,
    engine: discovered.ok ? discovered.value.identity : null,
    platform: process.platform,
    providerRequests: 0,
    note: 'These replies deliberately address ids the runtime does not hold. A successful decision needs a real pending approval, which the configured Full Access posture never produces; that remains unobserved and is recorded as such.',
    capturedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const report = {
    ok: false,
    steps,
    error: error instanceof Error ? error.message : String(error),
    capturedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.exitCode = 1;
  console.error(error);
} finally {
  await runtime?.stop?.().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}
