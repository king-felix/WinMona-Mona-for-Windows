// P18: record the capability-explorer and terminal/log surfaces exercised
// against the pinned runtime. The terminal row stays unavailable because the
// engine says so; this script never upgrades it to a claim.
// Usage: node tools/spike/qualify-p18.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const LEDGER = join(ROOT, 'docs', 'codewhale-capabilities.json');
const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
const captured = new Date().toISOString();
const version = '0.10.2+ff466b2ed0bf';
const tests = [
  'packages/adapter/src/diagnostics.test.ts',
  'apps/desktop/src/main/capability-service.test.ts',
  'apps/desktop/src/main/capability-ipc.test.ts',
  'apps/desktop/src/renderer/App.test.tsx',
  'tools/spike/p18-capabilities.mjs',
];

function row(entry) {
  return {
    platform: 'windows-x64',
    cost_implications: 'none',
    required_arguments: 'see route contract',
    permission_implications: 'Uses the authenticated loopback runtime token; logs are redacted and bounded by Mona.',
    tests,
    evidence: {
      help_capture: null,
      captured_utc: captured,
      contract_report: 'docs/evidence/P18-capabilities.json',
    },
    ...entry,
    upstream: { version, ...entry.upstream },
  };
}

const additions = [
  row({
    id: 'CAP-0053',
    upstream: {
      name: 'terminal (runtime)',
      surface: 'runtime-api',
      source: 'GET /v1/terminal/{name}/output; POST /v1/terminal/{name}/input|resize|kill',
    },
    class: 'read/write',
    chosen_integration: 'Unavailable',
    ui_location: 'Capabilities → Integrated terminal',
    status: 'unavailable-on-platform',
    gap: 'The runtime reports terminal_stream, terminal_input, terminal_resize and terminal_kill as false. A direct route check returned HTTP 501: "terminal sessions are Unix-only in this build; native Windows PTY support is not implemented yet". Mona shows the exact limitation and does not fake a PTY. A native Windows PTY path is a release blocker for MONA-023/terminal.',
  }),
  row({
    id: 'CAP-0054',
    upstream: {
      name: 'logs (runtime)',
      surface: 'runtime-api',
      source: 'GET /v1/logs; GET /v1/logs/{name}?offset&limit',
    },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Capabilities → Engine logs',
    status: 'read-qualified',
    gap: 'Read-only. Mona lists log sources, reads at most 64 KiB per request, paginates with offset, rejects path-like names and redacts credential-shaped values. No log is writable from the renderer.',
  }),
  row({
    id: 'CAP-0055',
    upstream: { name: 'process (runtime)', surface: 'runtime-api', source: 'GET /v1/process' },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Capabilities → identity',
    status: 'read-qualified',
    gap: 'Reports pid, version, commit, start time, uptime and executable for the owned runtime. Read-only.',
  }),
  row({
    id: 'CAP-0056',
    upstream: { name: 'runtime info (runtime)', surface: 'runtime-api', source: 'GET /v1/runtime/info' },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Capabilities → identity and live flags',
    status: 'read-qualified',
    gap: 'Reports runtime API version, engine version/commit, bind host/port, auth requirement and the capability-flag map. Mona compares the live version/commit with the ledger and reports drift; it does not inherit ledger claims across a version change.',
  }),
];

for (const addition of additions) {
  const index = ledger.rows.findIndex((entry) => entry.id === addition.id);
  if (index === -1) ledger.rows.push(addition);
  else ledger.rows[index] = addition;
}

const counts = ledger.rows.reduce(
  (summary, entry) => {
    summary.rows += 1;
    if (entry.status === 'qualified') summary.qualified += 1;
    else if (entry.status === 'read-qualified') summary.read_qualified += 1;
    else if (entry.status === 'discovered') summary.discovered += 1;
    else if (entry.status === 'unavailable-by-choice') summary.unavailable_by_choice += 1;
    else if (entry.status === 'unavailable-on-platform') summary.unavailable_on_platform += 1;
    else summary.unknown += 1;
    return summary;
  },
  {
    rows: 0,
    qualified: 0,
    read_qualified: 0,
    discovered: 0,
    unavailable_by_choice: 0,
    unavailable_on_platform: 0,
    unknown: 0,
  },
);
ledger.coverage_notes = {
  ...ledger.coverage_notes,
  ...counts,
  note: 'qualified = exercised against the live 0.10.2 binary; read-qualified = read path exercised without mutation; discovered = help captured only; unavailable-by-choice = intentionally not surfaced in 1.0; unavailable-on-platform = the pinned build does not implement it on Windows.',
};
ledger.captured_utc = captured;
ledger.inventory_scope =
  'Top-level CLI commands with captured help, the runtime route table extracted from the installed binary, effective configuration, transports, extension surfaces (P17), and the capability-explorer inputs (P18: runtime info, process, logs, terminal). The explorer reports every row with its own status; unsupported rows stay visible.';

await writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(
  `updated ${LEDGER}: ${counts.rows} rows (${counts.qualified} qualified, ${counts.read_qualified} read-qualified, ${counts.unavailable_on_platform} unavailable-on-platform)`,
);
