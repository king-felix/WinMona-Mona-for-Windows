// Per-user classic Explorer context-menu registration for "Start new DS project
// with Mona". Windows 11 may show this under "Show more options"; the modern
// IExplorerCommand menu is P21's work and is not claimed here.
//
// The registered command never contains a selected folder. Explorer substitutes
// the quoted "%V" placeholder, so a folder named `a & calc.exe` stays one
// argument. Every value is written with an argument array through reg.exe; no
// path is ever concatenated into a cmd or PowerShell script.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MENU_LABEL = 'Start new DS project with Mona';
export const PROFILE_TOKEN = 'ds-full-access';
export const MENU_KEYS = Object.freeze({
  folder: 'HKCU\\Software\\Classes\\Directory\\shell\\Mona.StartNewProject',
  background: 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Mona.StartNewProject',
});
const OWNED_MARKER = 'MonaOwned';

function assertPathValue(label, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/["\u0000-\u001f]/.test(value)) throw new Error(`${label} contains a quote or control character.`);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

function quote(value) {
  return `"${value}"`;
}

/**
 * The exact command Explorer will run. `%V` is the selected folder (or the
 * current folder for a background click) and stays inside its own quotes.
 */
export function buildLaunchCommand({ executable, appPath = null }) {
  assertPathValue('The Mona executable', executable);
  if (appPath !== null) assertPathValue('The application directory', appPath);
  const parts = [quote(executable)];
  if (appPath) parts.push(quote(appPath));
  parts.push('project', 'open', '--path', '"%V"', '--profile', PROFILE_TOKEN);
  return parts.join(' ');
}

function valueOps(key, name, value) {
  return name === null
    ? ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f']
    : ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'];
}

/** Every registry write for both Mona-owned keys, in creation order. */
export function planRegistration({ executable, appPath = null }) {
  const command = buildLaunchCommand({ executable, appPath });
  const ops = [];
  for (const key of [MENU_KEYS.folder, MENU_KEYS.background]) {
    ops.push(
      { key, name: null, value: MENU_LABEL, args: valueOps(key, null, MENU_LABEL) },
      { key, name: 'Icon', value: executable, args: valueOps(key, 'Icon', executable) },
      { key, name: OWNED_MARKER, value: '1', args: valueOps(key, OWNED_MARKER, '1') },
      { key, name: 'NeverDefault', value: '', args: valueOps(key, 'NeverDefault', '') },
      { key, name: 'MultiSelectModel', value: 'Single', args: valueOps(key, 'MultiSelectModel', 'Single') },
      { key: `${key}\\command`, name: null, value: command, args: valueOps(`${key}\\command`, null, command) },
    );
  }
  return { command, ops };
}

/** Removal names only Mona's two keys and nothing above them. */
export function planRemoval() {
  return Object.values(MENU_KEYS).map((key) => ({ key, args: ['delete', key, '/f'] }));
}

/** The values a registered key must carry for this command. */
export function expectedValues({ executable, appPath = null }) {
  return {
    '@': MENU_LABEL,
    Icon: executable,
    [OWNED_MARKER]: '1',
    NeverDefault: '',
    MultiSelectModel: 'Single',
    command: { '@': buildLaunchCommand({ executable, appPath }) },
  };
}

function unescapeRegString(value) {
  return value.replace(/\\([\s\S])/g, '$1');
}

function parseRegValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.lastIndexOf('"');
    return unescapeRegString(trimmed.slice(1, end));
  }
  if (trimmed === '-') return null;
  return trimmed;
}

/**
 * Parse `reg export` output. The .reg format is UTF-16LE and escapes quotes and
 * backslashes, so the command value is read back exactly as Explorer will see it.
 */
export function parseRegExport(text) {
  const sections = new Map();
  let current = null;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1];
      sections.set(current, {});
      continue;
    }
    if (!current || line.startsWith(';')) continue;
    const match = /^(@|"(?:[^"\\]|\\.)*")=(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1] === '@' ? '@' : unescapeRegString(match[1].slice(1, -1));
    sections.get(current)[name] = parseRegValue(match[2]);
  }
  return sections;
}

function normalizeRoot(key) {
  return key
    .replace(/^HKEY_CURRENT_USER/i, 'HKCU')
    .replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM')
    .replace(/^HKEY_CLASSES_ROOT/i, 'HKCR');
}

/** The values under one key from a parsed export, matched by suffix. */
export function sectionFor(sections, key) {
  const wanted = normalizeRoot(key).toLowerCase();
  for (const [name, values] of sections) {
    if (normalizeRoot(name).toLowerCase() === wanted) return values;
  }
  return null;
}

function runRegSync(args) {
  const regExe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe';
  const result = spawnSync(regExe, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Execute a plan, one argument array at a time. Stops at the first refusal unless told otherwise. */
export function executePlan(ops, runReg = runRegSync, options = {}) {
  const stopOnFailure = options.stopOnFailure ?? true;
  const results = [];
  for (const op of ops) {
    const result = runReg(op.args);
    results.push({ args: op.args, status: result.status, stderr: (result.stderr ?? '').trim().slice(0, 400) });
    if (result.status !== 0 && stopOnFailure) break;
  }
  return results;
}

export async function readKey(key, runReg = runRegSync) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mona-reg-'));
  const file = path.join(directory, 'key.reg');
  try {
    const exported = await runReg(['export', key, file, '/y']);
    if (exported.status !== 0) return null;
    const text = await readFile(file, 'utf16le');
    return sectionFor(parseRegExport(text), key);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

export async function keyExists(key, runReg = runRegSync) {
  return (await runReg(['query', key])).status === 0;
}

/** Read back both keys and compare every value Mona owns. */
export async function verifyRegistration({ executable, appPath = null }, runReg = runRegSync) {
  const expected = expectedValues({ executable, appPath });
  const report = { folder: null, background: null, verified: false, problems: [] };
  for (const [name, key] of Object.entries(MENU_KEYS)) {
    const values = await readKey(key, runReg);
    if (!values) {
      report[name] = null;
      report.problems.push(`${key} is not registered.`);
      continue;
    }
    const command = await readKey(`${key}\\command`, runReg);
    const observed = { ...values, command: command ?? null };
    report[name] = observed;
    for (const [valueName, wanted] of Object.entries(expected)) {
      if (valueName === 'command') {
        if (!command || command['@'] !== wanted['@']) report.problems.push(`${key}\\command does not match.`);
        continue;
      }
      if (observed[valueName] !== wanted) report.problems.push(`${key}\\${valueName} does not match.`);
    }
  }
  report.verified = report.problems.length === 0;
  return report;
}

export async function register({ executable, appPath = null }, runReg = runRegSync) {
  if (process.platform !== 'win32') throw new Error('Classic Explorer registration is a Windows feature.');
  if (!existsSync(executable)) throw new Error(`The executable does not exist: ${executable}`);
  if (appPath !== null && !existsSync(appPath)) throw new Error(`The application directory does not exist: ${appPath}`);

  const before = await verifyRegistration({ executable, appPath }, runReg);
  const plan = planRegistration({ executable, appPath });
  const results = executePlan(plan.ops, runReg);
  const failures = results.filter((result) => result.status !== 0);
  const after = await verifyRegistration({ executable, appPath }, runReg);
  return {
    command: plan.command,
    keys: MENU_KEYS,
    changed: !before.verified,
    writes: results,
    failures,
    verified: after.verified,
    state: after,
  };
}

export async function unregister(runReg = runRegSync) {
  if (process.platform !== 'win32') throw new Error('Classic Explorer registration is a Windows feature.');
  const present = [];
  for (const [name, key] of Object.entries(MENU_KEYS)) {
    present.push({ name, key, existed: await keyExists(key, runReg) });
  }
  // A key that was already absent is not a failed uninstall; delete both keys
  // and let the read-back decide whether anything of Mona's remains.
  const results = executePlan(planRemoval(), runReg, { stopOnFailure: false });
  const remaining = [];
  for (const [name, key] of Object.entries(MENU_KEYS)) {
    remaining.push({ name, key, exists: await keyExists(key, runReg) });
  }
  return {
    removed: present.filter((entry) => entry.existed).map((entry) => entry.name),
    absent: present.filter((entry) => !entry.existed).map((entry) => entry.name),
    writes: results,
    remaining,
    verified: remaining.every((entry) => !entry.exists),
  };
}

function parseCli(argv) {
  const command = argv[0] ?? 'status';
  const options = { exe: null, app: null, json: null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--exe' || arg === '--app' || arg === '--json') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value.`);
      if (arg === '--exe') options.exe = value;
      else if (arg === '--app') options.app = value;
      else options.json = value;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported option: ${arg}`);
  }
  return { command, options };
}

function defaults() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const appPath = path.join(root, 'apps', 'desktop');
  return { executable, appPath };
}

async function main() {
  const { command, options } = parseCli(process.argv.slice(2));
  const fallback = defaults();
  const executable = options.exe ? path.resolve(options.exe) : fallback.executable;
  const appPath = options.app ? path.resolve(options.app) : options.exe ? null : fallback.appPath;

  let output;
  if (command === 'plan') {
    output = { command: `planned for ${executable}`, registration: planRegistration({ executable, appPath }) };
  } else if (command === 'register') {
    output = await register({ executable, appPath });
  } else if (command === 'unregister') {
    output = await unregister();
  } else if (command === 'status') {
    output = await verifyRegistration({ executable, appPath });
  } else {
    throw new Error(`Unknown command "${command}". Use plan, register, unregister or status.`);
  }
  const text = JSON.stringify(output, null, 2);
  if (options.json) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.json, `${text}\n`, 'utf8');
  }
  process.stdout.write(`${text}\n`);
  if (command === 'register' && !output.verified) process.exitCode = 1;
  if (command === 'unregister' && !output.verified) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
