// Launch the built app and exercise the P04 lifecycle transitions in real
// Electron: owned runtime start, window close preserving work, renderer crash,
// relaunch of the existing owner, and quit-and-stop. Starting a runtime submits
// no turn, so this run spends nothing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const child = spawn(electronPath, ['.', '--lifecycle-test'], {
  cwd: appDir,
  env: {
    ...process.env,
    MONA_LIFECYCLE_OUT: out,
    MONA_LIFECYCLE_WORKSPACE: workspace,
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
await (await import('node:fs/promises')).writeFile(logPath, `${stdout}${stderr}`, 'utf8');
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);

if (code !== 0) {
  console.error(`electron exited with ${code}`);
  process.exit(code ?? 1);
}

const report = JSON.parse(await readFile(out, 'utf8'));
const failures = report.steps.filter((step) => !step.ok).map((step) => step.name);
if (!report.ok || failures.length > 0) {
  console.error(`lifecycle failures: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`lifecycle probe passed ${report.steps.length} checks in real Electron`);
