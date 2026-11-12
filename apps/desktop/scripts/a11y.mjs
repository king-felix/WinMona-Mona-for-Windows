// P23 accessibility probe: drives the real window and records what it observed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_A11Y_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P23-a11y.json');
const logFile = process.env.MONA_A11Y_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P23-a11y-log.txt');
const packagedExe = process.env.MONA_A11Y_EXE?.trim() || null;
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

const root = await mkdtemp(path.join(tmpdir(), 'mona-p23-a11y-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'a11y-project');
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
await git(['config', 'user.name', 'Mona a11y probe']);
await git(['add', '.']);
await git(['commit', '--quiet', '-m', 'a11y probe baseline']);

const child = spawn(electronPath, packagedExe ? ['--a11y-probe'] : ['.', '--a11y-probe'], {
  cwd: packagedExe ? repoRoot : appDir,
  env: {
    ...process.env,
    MONA_A11Y_OUT: out,
    MONA_A11Y_WORKSPACE: workspace,
    MONA_A11Y_HISTORY: process.env.MONA_A11Y_HISTORY ?? '300',
    MONA_USER_DATA: profile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));

const watchdog = setTimeout(() => {
  console.error('a11y probe exceeded its watchdog; terminating');
  child.kill('SIGKILL');
}, 300_000);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(watchdog);
await writeFile(logFile, `executable: ${electronPath}\n\n${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (stderr.trim()) console.error(stderr.trim().slice(-1200));

if (!existsSync(out)) {
  console.error('the probe wrote no report');
  process.exit(1);
}
const report = JSON.parse(await readFile(out, 'utf8'));
const failures = report.steps?.filter((step) => !step.ok).map((step) => step.name) ?? ['probe reported no steps'];
if (!report.ok) failures.unshift('probe reported ok=false');
if ((report.providerRequests ?? 1) !== 0) failures.push('the probe made a provider request');
if (code !== 0) failures.push(`the app exited with ${code}`);
for (const step of report.steps ?? []) console.log(`${step.ok ? 'PASS' : 'FAIL'} ${step.name}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`P23 a11y probe: ${report.steps.length} steps passed`);
