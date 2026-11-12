// P23 memory investigation.
//
// Runs the real app (development build by default, installed candidate with
// MONA_MEMORY_EXE) against a real Git workspace, and records the per-process
// breakdown plus the renderer JavaScript heap. The aggregate metric is the same
// one P22 used, so a comparison to 406.4 MB is like-for-like.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_MEMORY_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P23-memory.json');
const logFile = process.env.MONA_MEMORY_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P23-memory-log.txt');
const label = process.env.MONA_MEMORY_LABEL ?? 'development';
const packagedExe = process.env.MONA_MEMORY_EXE?.trim() || null;
await mkdir(path.dirname(out), { recursive: true });

let electronPath;
if (packagedExe) {
  electronPath = packagedExe;
} else {
  try {
    electronPath = (await import('electron')).default;
  } catch (error) {
    console.error('Electron runtime is not installed:', String(error));
    process.exit(3);
  }
}
if (!electronPath || !existsSync(electronPath)) {
  console.error('Executable is missing at', electronPath ?? '(unknown)');
  process.exit(3);
}

const root = await mkdtemp(path.join(tmpdir(), 'mona-p23-memory-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'memory-project');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'one.txt'), 'one\n', 'utf8');
await writeFile(
  path.join(workspace, 'big.txt'),
  Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join('\n'),
  'utf8',
);

function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', workspace, ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}: ${stderr}`))));
  });
}
await git(['init', '--quiet']);
await git(['config', 'user.email', 'probe@example.invalid']);
await git(['config', 'user.name', 'Mona memory probe']);
await git(['add', '.']);
await git(['commit', '--quiet', '-m', 'memory probe baseline']);

const child = spawn(electronPath, packagedExe ? ['--memory-probe'] : ['.', '--memory-probe'], {
  cwd: packagedExe ? repoRoot : appDir,
  env: {
    ...process.env,
    MONA_MEMORY_OUT: out,
    MONA_MEMORY_WORKSPACE: workspace,
    MONA_MEMORY_DIFF_PATH: 'big.txt',
    MONA_MEMORY_IDLE_SECONDS: process.env.MONA_MEMORY_IDLE_SECONDS ?? '60',
    MONA_USER_DATA: profile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));

const idleSeconds = Number.parseInt(process.env.MONA_MEMORY_IDLE_SECONDS ?? '60', 10);
const watchdog = setTimeout(
  () => {
    console.error('memory probe exceeded its watchdog; terminating');
    child.kill('SIGKILL');
  },
  (idleSeconds + 180) * 1000,
);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(watchdog);
await writeFile(
  logFile,
  `executable: ${electronPath}\nlabel: ${label}\nworkspace: ${workspace}\n\n${stdout}${stderr}`,
  'utf8',
);
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (stderr.trim()) console.error(stderr.trim().slice(-1500));

if (!existsSync(out)) {
  console.error('the probe wrote no report');
  process.exit(1);
}
const report = JSON.parse(await readFile(out, 'utf8'));
const failures = report.steps?.filter((step) => !step.ok).map((step) => step.name) ?? ['probe reported no steps'];
if (!report.ok) failures.unshift('probe reported ok=false');
if (code !== 0) failures.push(`the app exited with ${code}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
const idle = report.idle ?? {};
console.log(
  `P23 memory probe (${label}): ${idle.totalWorkingSetMb} MB total working set across ${idle.processes?.length ?? 0} processes; renderer JS heap ${idle.renderer?.heapUsedMb} MB; ${idle.samples} idle samples`,
);
