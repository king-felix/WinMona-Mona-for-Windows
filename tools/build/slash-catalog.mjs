/**
 * Slash-command catalog build tool.
 *
 * The pinned runtime exposes its real slash-command registry at GET /v1/commands
 * on the canonical HTTP surface. This tool does two things, and only these:
 *
 *   capture  start the installed engine on a loopback port in a throwaway
 *            CODEWHALE_HOME, read /v1/commands once, and record it with the
 *            engine identity, binary hash and route as provenance
 *   build    merge that capture with the curated annotations in
 *            tools/catalog/slash-annotations.json and write the versioned
 *            catalog the product ships (apps/desktop/src/shared/slash-catalog.ts)
 *   check    re-derive the catalog and fail if the committed file differs
 *
 * Nothing here runs at product runtime: Mona ships the generated catalog and
 * makes no provider request to describe a command. This is developer tooling,
 * not product framework.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const RAW_FILE = path.join(ROOT, 'docs', 'evidence', 'W04-commands-raw.json');
const ANNOTATIONS_FILE = path.join(ROOT, 'tools', 'catalog', 'slash-annotations.json');
const CATALOG_FILE = path.join(ROOT, 'apps', 'desktop', 'src', 'shared', 'slash-catalog.ts');

const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function resolveExecutable() {
  const env = process.env;
  const explicit = env.MONA_ENGINE_EXECUTABLE ?? env.MONA_ENGINE;
  if (explicit && explicit.trim()) return explicit.trim();
  const candidates = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codewhale.exe') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Codewhale', 'codewhale.exe') : null,
    env.USERPROFILE ? path.join(env.USERPROFILE, '.codewhale', 'bin', 'codewhale.exe') : null,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return 'codewhale';
}

function engineIdentity(executable) {
  const versionLine = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const match = /codewhale\s+([0-9][^\s(]*)\s*(?:\(([0-9a-f]+)\))?/i.exec(versionLine);
  return {
    version: match?.[1] ?? versionLine,
    commit: match?.[2] ?? null,
    versionLine,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await predicate()) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function capture() {
  const executable = resolveExecutable();
  const identity = engineIdentity(executable);
  const binary = fs.readFileSync(executable);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-slash-home-'));
  // A throwaway home has no credentials, and usage reporting is switched off
  // explicitly so a capture cannot send even aggregate counters.
  try {
    execFileSync(executable, ['config', 'set', 'telemetry', 'false'], {
      env: { ...process.env, CODEWHALE_HOME: home },
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    /* older builds may spell the key differently; the empty home has no delivery configured */
  }
  const port = await freePort();
  const token = crypto.randomUUID();
  const child = spawn(executable, ['app-server', '--http', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'mona-slash-cwd-')),
    env: { ...process.env, CODEWHALE_HOME: home, CODEWHALE_RUNTIME_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
        return response.ok;
      },
      30_000,
      'the runtime health route',
    );
    const response = await fetch(`${base}/v1/commands`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`/v1/commands returned ${response.status}`);
    const body = await response.json();
    const commands = Array.isArray(body.commands) ? body.commands : Array.isArray(body) ? body : null;
    if (!commands || commands.length === 0) throw new Error('/v1/commands returned no commands');
    const raw = {
      schema: 1,
      captured_at: utcNow(),
      engine: {
        product: 'Codewhale',
        version: identity.version,
        commit: identity.commit,
        version_line: identity.versionLine,
        executable,
        binary_sha256: sha256(binary),
        binary_bytes: binary.length,
      },
      route: { method: 'GET', path: '/v1/commands', bind: '127.0.0.1', auth: 'ephemeral bearer token, not recorded' },
      method:
        'installed engine started with `app-server --http` on a loopback port in a throwaway CODEWHALE_HOME; one read of /v1/commands; server process tree stopped afterwards',
      command_count: commands.length,
      commands,
    };
    fs.mkdirSync(path.dirname(RAW_FILE), { recursive: true });
    fs.writeFileSync(RAW_FILE, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    console.log(`captured ${commands.length} commands -> ${path.relative(ROOT, RAW_FILE)}`);
  } finally {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* already gone */
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    if (stderr.trim()) console.log(`runtime stderr (tail): ${stderr.trim().slice(-400)}`);
  }
}

/** Placeholder rows that are not part of the shipping catalog. */
function buildCatalog() {
  const raw = readJson(RAW_FILE);
  const annotations = readJson(ANNOTATIONS_FILE);
  const rows = raw.commands.map((command) => {
    const name = String(command.name ?? '').trim();
    if (!name) throw new Error('registry row without a name');
    const override = annotations.commands?.[name];
    const groupMatches = (annotations.groups ?? []).filter((entry) => entry.commands.includes(name));
    if (groupMatches.length > 1) {
      throw new Error(`"${name}" is annotated in more than one group: ${groupMatches.map((g) => g.label).join(', ')}`);
    }
    const group = groupMatches[0];
    const chosen = override ?? group;
    if (!chosen) throw new Error(`no annotation for registry command "${name}"`);
    const costClass = chosen.costClass ?? annotations.defaults.costClass;
    const route = chosen.route ?? annotations.defaults.route;
    if (!['none', 'model', 'unknown'].includes(costClass)) throw new Error(`bad cost class for ${name}`);
    if (!['mona', 'tui-only', 'unsupported'].includes(route)) throw new Error(`bad route for ${name}`);
    return {
      name,
      aliases: Array.isArray(command.aliases) ? command.aliases.map(String) : [],
      summary: String(command.summary ?? ''),
      usage: String(command.usage ?? `/${name}`),
      subcommands: Array.isArray(command.subcommands) ? command.subcommands.map(String) : [],
      takesArguments: command.takes_arguments === true,
      requiresArgument: command.requires_required_argument === true,
      discovery: command.discovery === 'primary' ? 'primary' : 'advanced',
      hidden: command.hidden === true,
      costClass,
      sideEffects: chosen.sideEffects ?? annotations.defaults.sideEffects,
      route,
      routeNote: chosen.routeNote ?? annotations.defaults.routeNote,
    };
  });

  // Coverage in both directions: every registry row is annotated, and no
  // annotation names a command the captured engine does not have.
  const names = new Set(rows.map((row) => row.name));
  for (const [name] of Object.entries(annotations.commands ?? {})) {
    if (!names.has(name)) throw new Error(`annotation names "${name}", which the captured registry does not have`);
  }
  for (const group of annotations.groups ?? []) {
    for (const name of group.commands) {
      if (!names.has(name)) throw new Error(`group annotation names "${name}", which the registry does not have`);
    }
  }
  const annotated = new Set([...Object.keys(annotations.commands ?? {})]);
  for (const group of annotations.groups ?? []) for (const name of group.commands) annotated.add(name);
  for (const name of names) if (!annotated.has(name)) throw new Error(`registry command "${name}" is unannotated`);

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const aliases = new Map();
  for (const row of rows) {
    for (const alias of row.aliases) {
      if (names.has(alias)) throw new Error(`alias "${alias}" collides with a command name`);
      if (aliases.has(alias)) throw new Error(`alias "${alias}" is claimed twice`);
      aliases.set(alias, row.name);
    }
  }
  return { raw, rows, aliasCount: aliases.size };
}

function renderModule({ raw, rows }) {
  const provenance = {
    engineVersion: raw.engine.version,
    engineCommit: raw.engine.commit,
    capturedAt: raw.captured_at,
    source: 'GET /v1/commands',
    registryCount: raw.commands.length,
  };
  const body = rows
    .map(
      (row) =>
        `  {\n` +
        `    name: ${JSON.stringify(row.name)},\n` +
        `    aliases: ${JSON.stringify(row.aliases)},\n` +
        `    summary: ${JSON.stringify(row.summary)},\n` +
        `    usage: ${JSON.stringify(row.usage)},\n` +
        `    subcommands: ${JSON.stringify(row.subcommands)},\n` +
        `    takesArguments: ${row.takesArguments},\n` +
        `    requiresArgument: ${row.requiresArgument},\n` +
        `    discovery: ${JSON.stringify(row.discovery)},\n` +
        `    hidden: ${row.hidden},\n` +
        `    costClass: ${JSON.stringify(row.costClass)},\n` +
        `    sideEffects: ${JSON.stringify(row.sideEffects)},\n` +
        `    route: ${JSON.stringify(row.route)},\n` +
        `    routeNote: ${JSON.stringify(row.routeNote)},\n` +
        `  },`,
    )
    .join('\n');
  return `/**
 * GENERATED by tools/build/slash-catalog.mjs — do not edit by hand.
 *
 * The pinned engine's own slash-command registry, captured from
 * ${provenance.source} on ${provenance.capturedAt}, plus the curated cost class,
 * side-effect note and Mona support route for each row. Rebuild with:
 *   node tools/build/slash-catalog.mjs capture   (needs the installed engine)
 *   node tools/build/slash-catalog.mjs build
 *   node tools/build/slash-catalog.mjs check
 */
import type { SlashCommandRow } from './slash.js';

export const SLASH_CATALOG_PROVENANCE = {
  engineVersion: ${JSON.stringify(provenance.engineVersion)},
  engineCommit: ${JSON.stringify(provenance.engineCommit)},
  capturedAt: ${JSON.stringify(provenance.capturedAt)},
  source: ${JSON.stringify(provenance.source)},
  registryCount: ${provenance.registryCount},
} as const;

export const SLASH_CATALOG: readonly SlashCommandRow[] = [
${body}
];
`;
}

function build() {
  return (async () => {
    const derived = buildCatalog();
    const text = await formatModule(renderModule(derived));
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
    fs.writeFileSync(CATALOG_FILE, text, 'utf8');
    console.log(
      `wrote ${derived.rows.length} rows and ${derived.aliasCount} aliases -> ${path.relative(ROOT, CATALOG_FILE)}`,
    );
  })();
}

/** The repository formats with Prettier; the generated file must match it. */
async function formatModule(text) {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(CATALOG_FILE)) ?? {};
  return await prettier.format(text, { ...config, parser: 'typescript' });
}

function check() {
  return (async () => {
    const derived = buildCatalog();
    const expected = await formatModule(renderModule(derived));
    const actual = fs.existsSync(CATALOG_FILE) ? fs.readFileSync(CATALOG_FILE, 'utf8') : '';
    if (actual !== expected) {
      console.error('slash catalog is stale; run: node tools/build/slash-catalog.mjs build');
      process.exitCode = 1;
      return;
    }
    console.log(`slash catalog is current: ${derived.rows.length} rows, ${derived.aliasCount} aliases`);
  })();
}

const command = process.argv[2] ?? 'help';
if (command === 'capture') await capture();
else if (command === 'build') await build();
else if (command === 'check') await check();
else {
  console.log('usage: node tools/build/slash-catalog.mjs <capture|build|check>');
  process.exitCode = command === 'help' ? 0 : 2;
}
