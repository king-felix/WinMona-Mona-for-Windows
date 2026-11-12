// P01 G2: qualify the capability ledger against the installed 0.10.2 binary.
// Help captures live in docs/evidence/engine/commands/. Only routes exercised by
// the P01 contract/G0/G1 runs are marked qualified; everything else stays
// discovered (help captured) or unqualified. No row claims runtime support from
// documentation alone.
//
// Usage: node tools/spike/qualify-capabilities.mjs

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const LEDGER = join(ROOT, 'docs', 'codewhale-capabilities.json');
const HELP_DIR = join(ROOT, 'docs', 'evidence', 'engine', 'commands');
const CAPTURED = new Date().toISOString();

const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
const helpFiles = new Map(
  (await readdir(HELP_DIR)).filter((f) => f.endsWith('.txt')).map((f) => [f.replace(/\.txt$/, ''), f]),
);

// Mona contract surfaces (spec 7.1): Native view | Advanced action |
// Integrated terminal | Unavailable | Blocked integration gap.
const PLAN = {
  run: [
    'Integrated terminal',
    'bottom drawer / terminal',
    'discovered',
    'Interactive TUI; Mona uses the runtime API for normal work.',
  ],
  doctor: [
    'Advanced action',
    'settings → diagnostics',
    'read-qualified',
    '`--probe-api` executed at P01 with no token spend; structural JSON remains unqualified.',
  ],
  'session-diagnostics': ['Advanced action', 'right inspector → diagnostics', 'discovered', ''],
  scorecard: ['Advanced action', 'right inspector → changes/tests', 'discovered', ''],
  models: [
    'Native view',
    'top context bar / settings → models',
    'read-qualified',
    'Catalog read via runtime `/v1/providers/{id}/models`; CLI output not exercised.',
  ],
  speech: ['Advanced action', 'bottom drawer', 'discovered', 'Model-backed; never automatic.'],
  sessions: [
    'Native view',
    'left rail → recent sessions',
    'read-qualified',
    'Listed through `/v1/sessions` and `/v1/threads/summary`.',
  ],
  receipts: [
    'Native view',
    'right inspector → receipts',
    'read-qualified',
    'Read for the direct exec arm; JSON shape recorded.',
  ],
  resume: [
    'Native view',
    'left rail → resume',
    'discovered',
    'Engine session resume verified through `exec --resume` equivalents at G0.',
  ],
  rc: ['Unavailable', 'none', 'unavailable-by-choice', 'Upstream remote-control UI overlaps Mona; not exposed in 1.0.'],
  fork: [
    'Advanced action',
    'right inspector → thread',
    'discovered',
    'Runtime route `/v1/threads/{id}/fork` discovered, not yet contract-tested.',
  ],
  init: ['Advanced action', 'settings → project instructions', 'discovered', ''],
  install: ['Advanced action', 'settings → integrations', 'discovered', ''],
  setup: ['Advanced action', 'settings', 'discovered', ''],
  'remote-setup': [
    'Advanced action',
    'settings → remote',
    'discovered',
    'Later-scope transport; not part of Windows 1.0 support claims.',
  ],
  exec: [
    'Advanced action',
    'bottom drawer / one-shot jobs',
    'qualified',
    'Used as the direct benchmark arm with `--auto --output-format stream-json`; not the persistent control channel.',
  ],
  fleet: [
    'Native view',
    'right inspector → agents',
    'discovered',
    'Fleet routes discovered (`/v1/fleet/*`); native execution deferred to P15.',
  ],
  workflow: ['Native view', 'right inspector → workflows', 'discovered', ''],
  lane: ['Advanced action', 'bottom drawer', 'discovered', ''],
  review: ['Native view', 'right inspector → review', 'discovered', ''],
  apply: ['Advanced action', 'right inspector → changes', 'discovered', 'Destructive surface; preview required.'],
  eval: ['Advanced action', 'bottom drawer', 'discovered', 'Model-backed; explicit only.'],
  mcp: [
    'Native view',
    'settings → tools',
    'discovered',
    'Runtime MCP management routes discovered (`/v1/apps/mcp/*`).',
  ],
  features: ['Native view', 'settings → advanced', 'discovered', ''],
  integrations: ['Native view', 'settings → integrations', 'discovered', ''],
  serve: [
    'Advanced action',
    'settings → advanced',
    'discovered',
    'Compatibility alias of `app-server --http`; Mona uses app-server explicitly.',
  ],
  web: [
    'Unavailable',
    'none',
    'unavailable-by-choice',
    'Upstream browser client; Mona does not embed a duplicate chat surface.',
  ],
  login: ['Advanced action', 'settings → account', 'discovered', 'Credential mutation; never silent.'],
  logout: [
    'Advanced action',
    'settings → account',
    'discovered',
    'Destructive to saved auth; explicit confirmation required.',
  ],
  auth: [
    'Advanced action',
    'settings → account',
    'discovered',
    'Credential store; Mona must not read or rewrite keys.',
  ],
  account: ['Native view', 'settings → account', 'discovered', ''],
  dispatch: ['Advanced action', 'bottom drawer', 'discovered', ''],
  'mcp-server': ['Unavailable', 'none', 'unavailable-by-choice', 'Mona is not an MCP server in 1.0.'],
  config: [
    'Native view',
    'settings',
    'read-qualified',
    'Effective config read via `/v1/config`; mutation not exposed.',
  ],
  model: [
    'Native view',
    'top context bar',
    'read-qualified',
    'Resolved model/deepseek-flash verified through `/v1/config`.',
  ],
  thread: [
    'Advanced action',
    'right inspector → thread',
    'discovered',
    'Runtime thread routes are the primary Mona surface.',
  ],
  sandbox: [
    'Native view',
    'top context bar → permissions',
    'discovered',
    'Host reports no sandbox; posture display must say so.',
  ],
  'app-server': [
    'Native view',
    'internal runtime transport',
    'qualified',
    'Primary integration: `--http` with bearer token, contract-tested at P01 and used for G0/G1.',
  ],
  completion: ['Advanced action', 'settings → advanced', 'discovered', 'Shell completion generation; no inference.'],
  metrics: [
    'Native view',
    'right inspector → usage',
    'read-qualified',
    'Read for tool-call evidence; no cost field observed.',
  ],
  update: ['Advanced action', 'settings → about', 'discovered', 'Never automatic during active work.'],
  providers: [
    'Native view',
    'settings → providers',
    'read-qualified',
    'Read via `/v1/providers`; route preserved unchanged.',
  ],
  help: [
    'Advanced action',
    'command palette',
    'discovered',
    '`help --help` exits 2 (no help for help); captured for completeness.',
  ],
};

for (const row of ledger.rows) {
  const name = row.upstream.name;
  const plan = PLAN[name];
  if (!plan) continue;
  const [integration, ui, status, gap] = plan;
  row.chosen_integration = row.chosen_integration ?? integration;
  row.ui_location = row.ui_location ?? ui;
  row.status = status;
  row.gap = gap || null;
  row.tests = row.tests ?? [];
  row.evidence = {
    help_capture: helpFiles.has(name) ? `docs/evidence/engine/commands/${helpFiles.get(name)}` : null,
    captured_utc: CAPTURED,
    contract_report: [
      'app-server',
      'exec',
      'doctor',
      'sessions',
      'receipts',
      'metrics',
      'providers',
      'config',
      'model',
      'models',
    ].includes(name)
      ? 'docs/evidence/P01-contract.json'
      : null,
  };
  row.required_arguments = extractUsage(row.evidence.help_capture);
  if (row.permission_implications.startsWith('not yet qualified')) {
    row.permission_implications = permissionFor(row.class);
  }
}

ledger.captured_utc = CAPTURED;
ledger.engine.version = '0.10.2';
ledger.engine.commit = 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e';
ledger.inventory_scope =
  'Top-level CLI commands with captured help (docs/evidence/engine/commands), the runtime API route table extracted from the installed binary and contract-tested where marked, effective configuration, transports, and permission posture. Subcommand deep-dive, MCP/skill/plugin detail and full capability explorer remain P17/P18.';
ledger.transports = [
  {
    name: 'app-server --http',
    description: 'Full HTTP/SSE Runtime API under /v1/*; canonical runtime surface',
    default_bind: '127.0.0.1:7878',
    auth: 'bearer token from --auth-token, CODEWHALE_RUNTIME_TOKEN, or DEEPSEEK_RUNTIME_TOKEN; /v1/runtime/info and /health are unauthenticated',
    qualified: true,
    evidence: 'docs/evidence/P01-contract.json',
    notes:
      'Contract-tested: auth boundary, thread create idempotency (201 + same id on replay, 409 on changed data), event replay, interrupt, history, usage, unknown-route 404.',
  },
  {
    name: 'app-server --stdio',
    description: 'Smaller JSON-RPC compatibility transport; tool-free turns require allowed_tools: []',
    default_bind: 'stdio',
    auth: 'process boundary',
    qualified: false,
    notes: 'Not selected: help states it lacks tools/approvals/full journal.',
  },
  {
    name: 'app-server --socket',
    description: 'Desktop daemon JSON-RPC on a user-private local endpoint; requires daemon/attach',
    default_bind: 'named pipe under ~/.codewhale/run',
    auth: 'client authentication + daemon/attach',
    qualified: false,
    notes: 'Not selected: narrower compatibility controls and extra attach handshake.',
  },
  {
    name: 'exec',
    description: 'Headless one-shot CLI; --auto offers tools with Full Access by default',
    default_bind: 'n/a',
    auth: 'existing provider credentials',
    qualified: true,
    evidence: 'docs/evidence/P01-bench.json',
    notes:
      'Qualified as a one-shot benchmark/diagnostic path only. It emits per-request usage and wire tool-schema evidence.',
  },
];
ledger.runtime_api = {
  runtime_api_version: '1.0',
  service: 'codewhale-runtime-api',
  routes_discovered: 250,
  discovery_method:
    'ASCII route strings extracted from the installed binary, then contract-tested on the live server; no route invented from prose.',
  tested_routes: [
    'GET /health',
    'GET /v1/runtime/info',
    'GET /v1/config',
    'GET /v1/providers',
    'GET /v1/providers/{id}/models',
    'GET /v1/sessions',
    'GET /v1/usage',
    'GET /v1/tasks',
    'GET /v1/approvals',
    'GET /v1/skills',
    'GET /v1/goals',
    'GET /v1/settings/schema',
    'POST /v1/threads',
    'GET /v1/threads',
    'GET /v1/threads/summary',
    'GET /v1/threads/{id}',
    'GET /v1/threads/{id}/history',
    'GET /v1/threads/{id}/usage',
    'GET /v1/threads/{id}/events',
    'POST /v1/threads/{id}/turns',
    'POST /v1/threads/{id}/turns/{turn_id}/interrupt',
    'GET /v1/threads/{id}/turns/{turn_id}/receipt',
    'POST /v1/approvals/{approval_id}',
    'POST /v1/tasks/{id}/cancel',
  ],
  tested_capabilities: [
    'thread_create_idempotency',
    'turn_operation_idempotency',
    'turn_operation_lookup',
    'event_replay',
    'event_stream_resume',
    'turn_interrupt',
    'turn_steer',
    'fleet_event_stream',
  ],
  observed_limitations: [
    'terminal_stream/terminal_input/terminal_resize/terminal_kill report false in this build; terminal routes exist but are not capability-advertised.',
    '/v1/runtime/info is unauthenticated discovery metadata (loopback-only); stateful routes require the bearer token.',
    'A second Windows runtime can create and run turns in a workspace another runtime drives; safe simultaneous mutation is not proven, so Mona serializes execution by default until P04/P07 own a lease.',
    'CLI exec and runtime turns report different endpoint fingerprints (6a440b42... vs 812b1f7c...) for the same deepseek route; parity is proven by wire model/dialect/tool-schema, not by fingerprint. Investigate at P03/P16.',
  ],
};
ledger.coverage_notes = {
  ...ledger.coverage_notes,
  rows: ledger.rows.length,
  qualified: ledger.rows.filter((row) => row.status === 'qualified').length,
  read_qualified: ledger.rows.filter((row) => row.status === 'read-qualified').length,
  discovered: ledger.rows.filter((row) => row.status === 'discovered').length,
  unavailable_by_choice: ledger.rows.filter((row) => row.status === 'unavailable-by-choice').length,
  note: 'qualified = exercised against the live 0.10.2 binary; read-qualified = read path exercised without mutation; discovered = help captured only; unavailable-by-choice = intentionally not surfaced in 1.0.',
};

await writeFile(LEDGER, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
console.log(
  `updated ${LEDGER}: ${ledger.coverage_notes.qualified} qualified, ${ledger.coverage_notes.read_qualified} read-qualified, ${ledger.coverage_notes.discovered} discovered, ${ledger.coverage_notes.unavailable_by_choice} unavailable-by-choice`,
);

function extractUsage(path) {
  if (!path) return 'not captured';
  return 'see help capture';
}

function permissionFor(kind) {
  switch (kind) {
    case 'read':
      return 'read-only';
    case 'write':
      return 'mutates local files/config; requires explicit user action';
    case 'destructive':
      return 'destructive; requires explicit confirmation';
    case 'mixed':
      return 'depends on subcommand; not yet classified per subcommand';
    default:
      return 'unknown; do not expose without qualification';
  }
}
