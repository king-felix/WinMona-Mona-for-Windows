// W04 slash-command autocomplete probe: types into the real composer through
// Electron's input path, reads the list, cost badges and route notes back from
// the DOM, and proves a recognized command is explained rather than sent. No
// runtime starts and no prompt is accepted, so provider requests stay 0.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_SLASH_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'W04-slash.json');
const logFile = process.env.MONA_SLASH_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'W04-slash-log.txt');
const shotsDir = process.env.MONA_SLASH_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-w04');
const packagedExe = process.env.MONA_SLASH_EXE?.trim() || null;
await mkdir(path.dirname(out), { recursive: true });
await mkdir(shotsDir, { recursive: true });

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

const root = await mkdtemp(path.join(tmpdir(), 'mona-w04-slash-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'slash-project');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Slash fixture\n\nA small project.\n', 'utf8');

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
await git(['config', 'user.name', 'Mona slash probe']);
await git(['add', '.']);
await git(['commit', '--quiet', '-m', 'slash probe baseline']);

const child = spawn(electronPath, packagedExe ? ['--slash-probe'] : ['.', '--slash-probe'], {
  cwd: packagedExe ? repoRoot : appDir,
  env: {
    ...process.env,
    MONA_SLASH_OUT: out,
    MONA_SLASH_SHOTS: shotsDir,
    MONA_SLASH_WORKSPACE: workspace,
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
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
  process.stderr.write(chunk);
});

const watchdog = setTimeout(() => {
  console.error('slash probe exceeded its watchdog; terminating');
  child.kill('SIGKILL');
}, 300_000);

const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(watchdog);
await writeFile(logFile, `executable: ${electronPath}\nworkspace: ${workspace}\n\n${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);

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
console.log(`W04 slash probe: ${report.steps.length} steps passed, ${report.shots?.length ?? 0} screenshots`);
