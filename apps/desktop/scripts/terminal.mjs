// Live Windows PTY probe: launch the built app, open the terminal drawer in a
// real Electron window, run a real ConPTY shell, verify output, resize, search,
// copy, reconnect and exit, and record screenshots.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_TERMINAL_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P18-terminal.json');
const logFile = process.env.MONA_TERMINAL_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P18-terminal-log.txt');
const shotsDir = process.env.MONA_TERMINAL_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-p18-terminal');
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

const workspace = await mkdtemp(path.join(tmpdir(), 'mona-p18-terminal-'));
const profile = await mkdtemp(path.join(tmpdir(), 'mona-p18-terminal-profile-'));
const child = spawn(electronPath, ['.', '--terminal-test'], {
  cwd: appDir,
  env: {
    ...process.env,
    MONA_TERMINAL_OUT: out,
    MONA_TERMINAL_WORKSPACE: workspace,
    MONA_TERMINAL_SHOTS: shotsDir,
    MONA_USER_DATA: profile,
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
  console.error('terminal probe exceeded 300 s; terminating');
  child.kill('SIGKILL');
}, 300_000);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(timer);
await writeFile(logFile, `${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (!process.env.MONA_TERMINAL_KEEP) {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}
if (stderr.trim()) console.error(stderr.trim().slice(-2000));

const manifest = JSON.parse(await readFile(out, 'utf8'));
const failures = manifest.steps?.filter((step) => !step.ok).map((step) => step.name) ?? ['probe did not report steps'];
if (!manifest.ok) failures.unshift('probe reported ok=false');
if ((manifest.shots?.length ?? 0) < 4) failures.push('fewer than four live terminal screenshots');
if (code !== 0) failures.push(`electron exited with ${code}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `P18 terminal probe: ${manifest.steps.length} steps passed, ${manifest.shots.length} live screenshots, ` +
    `typed via ${manifest.typedVia}`,
);
