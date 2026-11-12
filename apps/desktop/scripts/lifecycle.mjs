// Launch the built app and exercise the P04 lifecycle transitions in real
// Electron: owned runtime start, window close preserving work, renderer crash,
// relaunch of the existing owner, and quit-and-stop. Starting a runtime submits
// no turn, so this run spends nothing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_LIFECYCLE_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P04-lifecycle.json');
const logPath = process.env.MONA_LIFECYCLE_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P04-lifecycle-log.txt');
await mkdir(path.dirname(out), { recursive: true });

let electronPath;
try {
  electronPath = (await import('electron')).default;
} catch (error) {
  console.error('Electron runtime is not installed:', String(error));
  process.exit(3);
}
if (!electronPath || !existsSync(electronPath)) {
  console.error('Electron runtime binary is missing at', electronPath ?? '(unknown)');
  process.exit(3);
}

const workspace = await mkdtemp(path.join(tmpdir(), 'mona-p04-lifecycle-'));
const profile = await mkdtemp(path.join(tmpdir(), 'mona-lifecycle-profile-'));
const child = spawn(electronPath, ['.', '--lifecycle-test'], {
  cwd: appDir,
  env: {
    ...process.env,
    MONA_LIFECYCLE_OUT: out,
    MONA_LIFECYCLE_WORKSPACE: workspace,
    MONA_USER_DATA: profile,
    MONA_LIFECYCLE_LOG: logPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8');
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));

const timer = setTimeout(() => {
  console.error('lifecycle probe exceeded 120 s; terminating');
  child.kill('SIGKILL');
}, 120_000);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(timer);
if (stderr.trim()) console.error(stderr.trim().slice(-2000));

await mkdir(path.dirname(logPath), { recursive: true });
await writeFile(logPath, `${stdout}${stderr}`, 'utf8');
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);

if (code !== 0) {
  console.error(`electron exited with ${code}`);
  process.exit(code ?? 1);
}

const report = JSON.parse(await readFile(out, 'utf8'));

// Local state opened by the real app: schema version, tables and integrity.
const dbFile = path.join(profile, 'state', 'mona.sqlite');
const stateEvidence = { ok: false, db_file: dbFile, schema_version: 0, tables: [], integrity: 'missing' };
if (existsSync(dbFile)) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const integrity = db.prepare('PRAGMA integrity_check').get();
    stateEvidence.schema_version = version?.version ?? 0;
    stateEvidence.tables = tables;
    stateEvidence.integrity = integrity?.integrity_check ?? 'unknown';
    stateEvidence.ok = stateEvidence.schema_version >= 1 && stateEvidence.integrity === 'ok';
  } finally {
    db.close();
  }
}
const stateOut = path.join(repoRoot, 'docs', 'evidence', 'P05-state-open.json');
await writeFile(stateOut, `${JSON.stringify(stateEvidence, null, 2)}\n`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (!stateEvidence.ok) {
  console.error('local state did not open correctly in the real app');
  process.exit(1);
}
console.log(
  `local state opened: schema v${stateEvidence.schema_version}, ${stateEvidence.tables.length} tables, integrity ${stateEvidence.integrity}`,
);
const failures = report.steps.filter((step) => !step.ok).map((step) => step.name);
if (!report.ok || failures.length > 0) {
  console.error(`lifecycle failures: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`lifecycle probe passed ${report.steps.length} checks in real Electron`);
