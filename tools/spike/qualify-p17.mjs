// P17: record the extension surfaces exercised against the pinned runtime.
// This updates the capability ledger; it does not infer support from prose.
// Usage: node tools/spike/qualify-p17.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const LEDGER = join(ROOT, 'docs', 'codewhale-capabilities.json');
const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
const captured = new Date().toISOString();
const version = '0.10.2+ff466b2ed0bf';

const TEST_PATHS = [
  'packages/adapter/src/extensions.test.ts',
  'apps/desktop/src/main/extensions-service.test.ts',
  'apps/desktop/src/main/extensions-ipc.test.ts',
  'apps/desktop/src/renderer/App.test.tsx',
  'tools/spike/p17-extensions.mjs',
];

function row(entry) {
  return {
    platform: 'windows-x64',
    cost_implications: 'none',
    required_arguments: 'see route contract',
    permission_implications:
      'Uses the authenticated loopback runtime token; no renderer access and no file parsing by Mona.',
    tests: TEST_PATHS,
    evidence: {
      help_capture: null,
      captured_utc: captured,
      contract_report: 'docs/evidence/P17-extensions.json',
    },
    ...entry,
    upstream: { version, ...entry.upstream },
  };
}

const additions = [
  row({
    id: 'CAP-0048',
    upstream: { name: 'skills (runtime)', surface: 'runtime-api', source: 'GET /v1/skills' },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Extensions → Skills',
    status: 'read-qualified',
    gap: 'List and provenance read (name, source, plugin, invocation, aliases, bundled tier). Skill bodies stay on disk. Install/trust/update remain engine-reviewed routes and were not exercised.',
  }),
  row({
    id: 'CAP-0049',
    upstream: { name: 'plugins (runtime)', surface: 'runtime-api', source: 'GET /v1/apps/plugins' },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Extensions → Plugins',
    status: 'read-qualified',
    gap: 'List and provenance read (scope, origin, trust, compatibility, inventory, content hash). Trust/install/enable are engine actions with their own consent step and were not exercised.',
  }),
  row({
    id: 'CAP-0050',
    upstream: { name: 'hooks (runtime)', surface: 'runtime-api', source: 'GET /v1/hooks' },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Extensions → Hooks',
    status: 'read-qualified',
    gap: 'Read-only inventory with redacted commands. Project hooks were observed rejected until the engine records workspace trust and hook approval; Mona never approves them.',
  }),
  row({
    id: 'CAP-0051',
    upstream: {
      name: 'workspace instructions (runtime)',
      surface: 'runtime-api',
      source: 'GET /v1/workspace/instructions',
    },
    class: 'read',
    chosen_integration: 'Native view',
    ui_location: 'Extensions → Rules and instructions',
    status: 'read-qualified',
    gap: 'Reports each source, kind, status, byte count and warnings. Imported instructions remain inert until the engine selects them.',
  }),
  row({
    id: 'CAP-0052',
    upstream: {
      name: 'mcp servers (runtime)',
      surface: 'runtime-api',
      source:
        'GET /v1/apps/mcp/servers; GET /v1/apps/mcp/servers/{name}; POST .../enable|disable|reconnect; GET /v1/apps/mcp/tools',
    },
    class: 'read/write',
    chosen_integration: 'Native view',
    ui_location: 'Extensions → MCP servers',
    status: 'qualified',
    gap: 'List, detail, explicit health check, enable and disable were exercised with If-Match revisions. Stale edits return conflict; unknown top-level and server-level keys survived an edit; env values are never returned, only key names. Project-scope servers stay hidden until engine trust. Add/remove/login remain CLI advanced actions.',
  }),
];

for (const addition of additions) {
  const index = ledger.rows.findIndex((entry) => entry.id === addition.id);
  if (index === -1) ledger.rows.push(addition);
  else ledger.rows[index] = addition;
}

const mcpCli = ledger.rows.find((entry) => entry.id === 'CAP-0023');
if (mcpCli) {
  mcpCli.chosen_integration = 'Advanced action';
  mcpCli.ui_location = 'Extensions → MCP advanced actions';
  mcpCli.status = 'discovered';
  mcpCli.gap =
    'Add, remove, connect, login, logout and validate remain engine CLI actions; Mona shows the exact invocation and does not assemble it from remote content. The runtime read/action routes are CAP-0052.';
  mcpCli.evidence = {
    help_capture: 'docs/evidence/engine/commands/mcp.txt',
    captured_utc: captured,
    contract_report: 'docs/evidence/P17-extensions.json',
  };
}

const install = ledger.rows.find((entry) => entry.id === 'CAP-0013');
if (install) {
  install.ui_location = 'Extensions → Plugins advanced actions';
  install.gap =
    'Installs a plugin bundle without trusting or enabling it. Mona shows the exact command; installation is not performed from the renderer.';
}

const counts = ledger.rows.reduce(
  (summary, entry) => {
    summary.rows += 1;
    if (entry.status === 'qualified') summary.qualified += 1;
    else if (entry.status === 'read-qualified') summary.read_qualified += 1;
    else if (entry.status === 'discovered') summary.discovered += 1;
    else if (entry.status === 'unavailable-by-choice') summary.unavailable_by_choice += 1;
    return summary;
  },
  { rows: 0, qualified: 0, read_qualified: 0, discovered: 0, unavailable_by_choice: 0 },
);
ledger.coverage_notes = {
  ...ledger.coverage_notes,
  ...counts,
  note: 'qualified = exercised against the live 0.10.2 binary; read-qualified = read path exercised without mutation; discovered = help captured only; unavailable-by-choice = intentionally not surfaced in 1.0.',
};
ledger.captured_utc = captured;
ledger.inventory_scope =
  'Top-level CLI commands with captured help, the runtime route table extracted from the installed binary, effective configuration, transports, and the extension surfaces read or exercised at P17 (MCP, skills, plugins, hooks, workspace instructions). Remaining subcommand and terminal deep-dive stays P18.';

await writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(
  `updated ${LEDGER}: ${counts.rows} rows (${counts.qualified} qualified, ${counts.read_qualified} read-qualified)`,
);
