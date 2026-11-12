// P18 capability-explorer probe. Uses an isolated CODEWHALE_HOME and a real
// runtime. It reads identity, live flags, bounded logs and the terminal route,
// then builds the same capability view the desktop app uses. No turn, no
// provider request, no terminal process.
// Usage: node tools/spike/p18-capabilities.mjs [--out <path>]

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EngineAdapter } from '../../packages/adapter/dist/adapter.js';
import { HttpTransport } from '../../packages/adapter/dist/http.js';
import { MemorySubmissionJournal } from '../../packages/adapter/dist/journal.js';
import { CapabilityService } from '../../apps/desktop/dist/main/capability-service.js';
import { RuntimeClient, makeToken, startOwnedRuntime } from './runtime/client.mjs';

const ENGINE = process.env.MONA_ENGINE ?? 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe';
const root = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Temp',
  'mona-p18-capabilities',
  String(Date.now()),
);
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const secret = `p18-secret-${Date.now()}`;
await mkdir(join(home, 'logs'), { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(
  join(home, 'config.toml'),
  'provider = "deepseek"\nmodel = "deepseek-flash"\n\n[providers.deepseek]\nbase_url = "https://api.deepseek.com"\n',
  'utf8',
);
await writeFile(join(home, 'logs', 'runtime.log'), `line one\nsecret=${secret}\nline three\n`, 'utf8');
await writeFile(join(home, 'logs', 'big.log'), 'X'.repeat(200_000), 'utf8');

const token = makeToken();
process.env.CODEWHALE_HOME = home;
const runtime = await startOwnedRuntime({ executable: ENGINE, workspace, port: 7924, token });
const transport = new HttpTransport({ baseUrl: runtime.baseUrl, token });
const adapter = new EngineAdapter({
  transport,
  journal: new MemorySubmissionJournal(),
  context: { baseUrl: runtime.baseUrl, pid: null, workspace, startedAt: new Date().toISOString() },
});
const api = new RuntimeClient({ baseUrl: runtime.baseUrl, token });

const service = new CapabilityService({
  engine: {
    summary: () => ({
      state: 'connected',
      detail: 'p18 probe',
      workspace,
      pid: runtime.child.pid ?? null,
      endpoint: runtime.baseUrl,
      compatibility: 'qualified',
      descriptors: [],
    }),
    adapter: () => adapter,
  },
  ledgerPath: join(process.cwd(), 'docs', 'codewhale-capabilities.json'),
});

const report = {
  schema_version: 1,
  captured_utc: new Date().toISOString(),
  engine: { command: ENGINE, root, home, workspace },
  checks: [],
};
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}
function usageKey(usage) {
  const totals = usage?.totals ?? {};
  return {
    turns: totals.turns ?? null,
    input_tokens: totals.input_tokens ?? null,
    output_tokens: totals.output_tokens ?? null,
    cost_usd: totals.cost_usd ?? null,
  };
}

try {
  const usageBefore = await api.usage();
  report.usage_before = usageKey(usageBefore);

  const view = await service.view();
  if (!view.ok) throw new Error(`capability view failed: ${view.error.message}`);
  report.view = view.data;
  check(
    'the explorer reports the pinned engine and zero drift',
    view.data.identity.version === '0.10.2' && view.data.identity.drift === 'none',
    {
      version: view.data.identity.version,
      commit: view.data.identity.commit,
      drift: view.data.identity.drift,
    },
  );
  check(
    'every ledger row is present in the explorer',
    view.data.rows.length >= 50 && view.data.coverage.total === view.data.rows.length,
    {
      rows: view.data.rows.length,
      coverageTotal: view.data.coverage.total,
    },
  );
  check(
    'coverage accounts for every row without hiding awkward ones',
    view.data.coverage.verifiedEntryPoints +
      view.data.coverage.discoveredOnly +
      view.data.coverage.unavailable +
      view.data.coverage.blocked +
      view.data.coverage.unknown ===
      view.data.coverage.total,
    {
      coverage: view.data.coverage,
    },
  );
  const terminalRow = view.data.rows.find((row) => row.id === 'CAP-0053');
  check(
    'the terminal row is unavailable-on-platform, not a hidden or fake feature',
    terminalRow?.status === 'unavailable-on-platform' && terminalRow.integration === 'Unavailable',
    {
      status: terminalRow?.status,
      integration: terminalRow?.integration,
      gap: terminalRow?.gap,
    },
  );
  check(
    'the live terminal flags are false',
    view.data.liveFlags.filter((flag) => flag.name.startsWith('terminal_')).every((flag) => flag.value === false),
    {
      flags: view.data.liveFlags.filter((flag) => flag.name.startsWith('terminal_')),
    },
  );
  check(
    'the terminal availability reason names the engine limitation',
    view.data.terminal.status === 'unavailable' && /terminal_stream|Unix-only/i.test(view.data.terminal.reason),
    {
      status: view.data.terminal.status,
      reason: view.data.terminal.reason,
    },
  );
  check(
    'the palette exposes every capability row',
    view.data.palette.length === view.data.rows.length &&
      view.data.palette.some((item) => item.id === 'capability:CAP-0053'),
    {
      palette: view.data.palette.length,
    },
  );

  const terminal = await service.checkTerminal();
  if (!terminal.ok) throw new Error(`terminal check failed: ${terminal.error.message}`);
  report.terminal_check = terminal.data;
  check(
    'the explicit terminal route check returns the engine 501 answer',
    terminal.data.statusCode === 501 && /Unix-only/i.test(terminal.data.message),
    terminal.data,
  );

  const catalog = await adapter.diagnostics().listLogs();
  if (!catalog.ok) throw new Error('log catalog failed');
  report.log_sources = catalog.value.sources;
  const names = catalog.value.sources.flatMap((source) => source.files.map((file) => file.name));
  check('engine logs are listed read-only', names.includes('runtime.log') && names.includes('big.log'), { names });

  const small = await service.readLog({ name: 'runtime.log' });
  if (!small.ok) throw new Error(`log read failed: ${small.error.message}`);
  report.log_small = small.data;
  check(
    'log content is bounded and credential-shaped values are redacted',
    !small.data.content.includes(secret) && small.data.redacted && small.data.bytes < 64 * 1024,
    {
      bytes: small.data.bytes,
      redacted: small.data.redacted,
      content: small.data.content,
    },
  );

  const large = await service.readLog({ name: 'big.log', offset: 0, limit: 64 * 1024 });
  if (!large.ok) throw new Error(`large log read failed: ${large.error.message}`);
  report.log_large = { bytes: large.data.bytes, truncated: large.data.truncated, size: large.data.size };
  check(
    'a large log is bounded to 64 KiB and marked truncated',
    large.data.bytes <= 64 * 1024 && large.data.truncated,
    report.log_large,
  );

  const traversal = await service.readLog({ name: '..\\config.toml' });
  report.path_traversal = traversal.ok ? { ok: true } : { ok: false, error: traversal.error };
  check(
    'path-like log names are refused',
    !traversal.ok && traversal.error.code === 'invalid_request',
    report.path_traversal,
  );

  const usageAfter = await api.usage();
  report.usage_after = usageKey(usageAfter);
  check('the probe caused zero inference', JSON.stringify(report.usage_before) === JSON.stringify(report.usage_after), {
    before: report.usage_before,
    after: report.usage_after,
  });
} catch (error) {
  report.error = error.stack ?? String(error);
  console.log(`FAILED ${report.error}`);
  process.exitCode = 1;
} finally {
  await runtime.stop().catch(() => {});
  delete process.env.CODEWHALE_HOME;
  report.finished_utc = new Date().toISOString();
  report.ok = report.checks.every((entry) => entry.ok) && !report.error;
  const outIndex = process.argv.indexOf('--out');
  if (outIndex !== -1) {
    const out = process.argv[outIndex + 1];
    await mkdir(dirname(out), { recursive: true }).catch(() => {});
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`wrote ${out}`);
  }
}
