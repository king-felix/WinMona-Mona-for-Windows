#!/usr/bin/env node
// P00 seed for docs/codewhale-capabilities.json.
//
// Seeds one row per top-level command of the pinned Codewhale build so the
// coverage ledger exists from day one. Rows are intentionally unqualified:
// P01 (G2) and P18 fill in arguments, permissions, cost class, integration
// label and tests from the installed binary. Re-run with --force to reseed;
// the previous file is preserved.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = process.argv.slice(2);
const force = args.includes('--force');
const rootFlag = args.indexOf('--root');
const root = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : ROOT;

let version = 'unknown';
let commit = null;
try {
  const out = execFileSync('codewhale', ['--version'], { encoding: 'utf8' }).trim();
  const m = /^codewhale\s+(\S+)(?:\s+\(([0-9a-f]+)\))?/.exec(out);
  if (m) [, version, commit] = m;
} catch {
  // Discovery still succeeds with an explicit unknown; the CLI reports it.
}

// [command, class, cost, note]
const COMMANDS = [
  ['run', 'mixed', 'model', 'interactive or non-interactive task runner (TUI)'],
  ['doctor', 'read', 'none-by-default', 'diagnostics; --probe-api/--probe-search make live calls only when asked'],
  ['session-diagnostics', 'read', 'none', 'summarizes failure signals without raw content'],
  ['scorecard', 'read', 'none', 'scores recorded turn metrics'],
  ['models', 'read', 'none', 'cached model list; --update refreshes catalogs over the network'],
  ['speech', 'write', 'model', 'TTS audio generation (paid model call)'],
  ['sessions', 'read', 'none', 'lists saved sessions'],
  ['receipts', 'read', 'none', 'files, commands, web/MCP calls, agents and failures for a session'],
  ['resume', 'mixed', 'model', 'resumes a saved session; may send model requests'],
  ['rc', 'mixed', 'model', 'interactive session handed to the Codewhale web app'],
  ['fork', 'write', 'none', 'forks a saved session'],
  ['init', 'write', 'none', 'creates a default AGENTS.md'],
  ['install', 'write', 'none', 'installs a plugin bundle without trusting/enabling it'],
  ['setup', 'write', 'none', 'scaffolds MCP config and skills directories'],
  ['remote-setup', 'write', 'none', 'generates a remote deploy bundle'],
  ['exec', 'mixed', 'model', 'headless one-shot; --auto adds tools and defaults to Full Access'],
  ['fleet', 'mixed', 'model', 'durable fleet runs; schedules native child agents'],
  ['workflow', 'mixed', 'model', 'runs checked-in workflows'],
  ['lane', 'mixed', 'model', 'manages running workflow instances and runtime backends'],
  ['review', 'mixed', 'model', 'code review over a git diff'],
  ['apply', 'write', 'none', 'applies a patch file or stdin to the working tree'],
  ['eval', 'mixed', 'model', 'offline evaluation harness'],
  ['mcp', 'write', 'none', 'MCP server configuration'],
  ['features', 'read', 'none', 'inspects feature flags'],
  ['integrations', 'write', 'none', 'connects third-party harnesses (e.g. dsh)'],
  ['serve', 'mixed', 'model', 'local server; compatibility alias of app-server --http/--mobile'],
  ['web', 'mixed', 'model', 'opens the bundled browser client over the Runtime API'],
  ['login', 'write', 'none', 'account/provider sign-in; writes credentials'],
  ['logout', 'destructive', 'none', 'removes saved authentication state for every provider'],
  ['auth', 'write', 'none', 'credential and provider-mode management'],
  ['account', 'mixed', 'none', 'Codewhale account management (cloud)'],
  ['dispatch', 'unknown', 'model', 'cloud computer task; help states cloud computers are paused'],
  ['mcp-server', 'mixed', 'none', 'runs Codewhale as an MCP server over stdio'],
  ['config', 'write', 'none', 'read/write/list configuration values'],
  ['model', 'read', 'none', 'resolves or lists available models'],
  ['thread', 'write', 'none', 'thread/session metadata, resume and fork flows'],
  ['sandbox', 'read', 'none', 'evaluates sandbox/approval policy decisions'],
  ['app-server', 'mixed', 'model', 'HTTP/SSE runtime API (--http), stdio/socket compatibility transports'],
  ['completion', 'read', 'none', 'generates shell completions'],
  ['metrics', 'read', 'none', 'usage rollup from the audit log and session store'],
  ['update', 'write', 'none', 'updates the release binary (package-managed installs get migration instructions)'],
  ['providers', 'read', 'none', 'exports the provider route catalog'],
  ['help', 'read', 'none', 'help for commands'],
];

const rows = COMMANDS.map(([name, cls, cost, note], i) => ({
  id: `CAP-${String(i + 1).padStart(4, '0')}`,
  upstream: {
    name,
    surface: 'cli',
    source: 'codewhale --help',
    version: `${version}${commit ? `+${commit}` : ''}`,
  },
  platform: 'windows-x64',
  class: cls,
  permission_implications: 'not yet qualified (see P01/P18)',
  cost_implications: cost,
  required_arguments: 'not yet qualified (see P01/P18)',
  chosen_integration: null,
  ui_location: null,
  tests: [],
  status: cls === 'unknown' ? 'unqualified' : 'unqualified',
  gap: `P00 seed only: ${note}. Arguments, permissions, integration label and tests are qualified at P01 (G2) and P18.`,
}));

const doc = {
  schema_version: 1,
  captured_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  engine: {
    product: 'Codewhale',
    version,
    commit,
    install_method: 'winget package HunterBown.CodeWhale',
    executable: 'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Links\\codewhale.exe',
    resolved_binary:
      'C:\\Users\\victo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\HunterBown.CodeWhale_Microsoft.Winget.Source_8wekyb3d8bbwe\\codewhale.exe',
    platform: 'windows-x64',
    home: '%USERPROFILE%\\.codewhale',
  },
  transports: [
    {
      name: 'app-server --http',
      description: 'Full HTTP/SSE Runtime API under /v1/*; documented canonical surface',
      default_bind: '127.0.0.1:7878',
      auth: '--auth-token, CODEWHALE_RUNTIME_TOKEN, or DEEPSEEK_RUNTIME_TOKEN',
      qualified: false,
    },
    {
      name: 'app-server --stdio',
      description: 'Smaller JSON-RPC compatibility control transport; tool-free turns need allowed_tools: []',
      default_bind: 'stdio',
      auth: 'process boundary',
      qualified: false,
    },
    {
      name: 'app-server --socket',
      description: 'Desktop daemon JSON-RPC on a user-private local endpoint; requires daemon/attach',
      default_bind: 'named pipe under ~/.codewhale/run',
      auth: 'client authentication + daemon/attach',
      qualified: false,
    },
    {
      name: 'exec',
      description: 'Headless one-shot CLI; --auto offers tools with Full Access by default',
      default_bind: 'n/a',
      auth: 'existing provider credentials',
      qualified: false,
    },
  ],
  inventory_scope:
    'Top-level CLI commands of the pinned build. Subcommand arguments, config schema, HTTP routes, tools, skills, plugins and hooks remain to be enumerated at P01/P18.',
  coverage_notes: {
    upstream_overlap:
      'This build already ships a browser client (`codewhale web`, `codewhale rc`) and a runtime server (`serve`, `app-server`). Per spec section 2.3, reassess upstream desktop progress at G0 and before release instead of duplicating it blindly.',
    rows: rows.length,
    qualified: 0,
  },
  rows,
};

const target = path.join(root, 'docs', 'codewhale-capabilities.json');
if (fs.existsSync(target) && !force) {
  console.error(`refusing to overwrite ${path.relative(root, target)} (pass --force; previous file is backed up)`);
  process.exit(2);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  fs.copyFileSync(target, `${target}.bak-${Date.now()}`);
}
fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`wrote ${path.relative(root, target)}: ${rows.length} command rows for codewhale ${version}`);
