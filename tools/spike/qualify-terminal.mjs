// Record the Mona-owned Windows terminal in the capability ledger. The engine's
// own terminal routes stay unavailable-on-platform; this row is explicitly a
// Mona surface, not an engine feature claim.
// Usage: node tools/spike/qualify-terminal.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const LEDGER = join(ROOT, 'docs', 'codewhale-capabilities.json');
const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
const captured = new Date().toISOString();

const row = {
  id: 'CAP-0057',
  upstream: {
    name: 'terminal (Mona ConPTY)',
    surface: 'native',
    source: 'node-pty 1.1.0 ConPTY + @xterm/xterm 6.0.0',
    version: 'node-pty 1.1.0',
  },
  platform: 'windows-x64',
  class: 'read/write',
  permission_implications:
    'A local shell runs with the user’s own rights inside the open project folder. Mona applies no per-command approval inside the shell; it enforces that model output, Markdown, hooks, MCP content and tool output cannot reach it, and strips injected runtime/provider credentials from its environment.',
  cost_implications: 'none (no provider request)',
  required_arguments: 'projectId, cols, rows',
  chosen_integration: 'Native view',
  ui_location: 'Bottom drawer — Ctrl+` or the Terminal button',
  tests: [
    'apps/desktop/src/main/terminal-host.test.ts',
    'apps/desktop/src/main/terminal-service.test.ts',
    'apps/desktop/src/main/terminal-ipc.test.ts',
    'apps/desktop/src/renderer/TerminalDrawer.test.tsx',
    'docs/evidence/P18-terminal.json',
  ],
  status: 'qualified',
  gap: 'Mona-owned, not an engine feature. No sandbox or per-command approval inside the shell. node-pty must be unpacked from the installer archive at P21. Screen-reader mode, OSC 52 copy intent and pointer drag-selection still need a human pass (ISSUE-0019, ISSUE-0021). node-pty’s console-list helper can print AttachConsole failed during a forced kill; the process still exits (ISSUE-0020).',
  evidence: {
    help_capture: null,
    captured_utc: captured,
    contract_report: 'docs/evidence/P18-terminal.json',
  },
};

const index = ledger.rows.findIndex((entry) => entry.id === row.id);
if (index === -1) ledger.rows.push(row);
else ledger.rows[index] = row;

const engineTerminal = ledger.rows.find((entry) => entry.id === 'CAP-0053');
if (engineTerminal) {
  engineTerminal.gap =
    'The runtime reports terminal_stream, terminal_input, terminal_resize and terminal_kill as false. A direct route check returned HTTP 501: "terminal sessions are Unix-only in this build; native Windows PTY support is not implemented yet". Mona now provides its own ConPTY terminal (CAP-0057); this engine route is still unavailable and is not claimed.';
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
  'Top-level CLI commands with captured help, the runtime route table extracted from the installed binary, effective configuration, transports, extension surfaces, the capability-explorer inputs, and the Mona-owned Windows terminal (CAP-0057, marked native rather than engine). Unsupported rows stay visible.';

await writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(
  `updated ${LEDGER}: ${counts.rows} rows (${counts.qualified} qualified, ${counts.read_qualified} read-qualified, ${counts.unavailable_on_platform} unavailable-on-platform)`,
);
