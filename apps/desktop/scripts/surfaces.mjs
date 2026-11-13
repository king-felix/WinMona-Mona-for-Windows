// P25 surfaces probe: the Cost lens and the Work board, driven against real rows.
// Cost is ingested through CostLedger and tasks through TaskService, so the probe
// reads what a user could have produced. No thread is opened and no prompt is
// submitted: provider requests stay at zero.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_SURFACES_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P25-surfaces.json');
const logFile = process.env.MONA_SURFACES_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P25-surfaces-log.txt');
const shotsDir = process.env.MONA_SURFACES_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-p25');
const packagedExe = process.env.MONA_SURFACES_EXE?.trim() || null;
await mkdir(path.dirname(out), { recursive: true });
await mkdir(shotsDir, { recursive: true });

const root = await mkdtemp(path.join(tmpdir(), 'mona-p25-surfaces-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'surfaces-project');
const exportPath = path.join(root, 'mona-cost-export.csv');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Surfaces fixture\n', 'utf8');

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
await git(['config', 'user.name', 'Mona surfaces probe']);
await git(['add', '.']);
await git(['commit', '--quiet', '-m', 'surfaces probe baseline']);

const child = spawn(electronPath, packagedExe ? ['--surfaces-probe'] : ['.', '--surfaces-probe'], {
  cwd: packagedExe ? repoRoot : appDir,
  env: {
    ...process.env,
    MONA_SURFACES_OUT: out,
    MONA_SURFACES_SHOTS: shotsDir,
    MONA_SURFACES_WORKSPACE: workspace,
    MONA_SURFACES_EXPORT: exportPath,
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
  console.error('surfaces probe exceeded its watchdog; terminating');
  child.kill('SIGKILL');
}, 300_000);

const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(watchdog);
await writeFile(logFile, `executable: ${electronPath}\nworkspace: ${workspace}\n\n${stdout}${stderr}`, 'utf8');

// Keep the exported CSV beside the evidence, then remove the throwaway profile.
if (existsSync(exportPath)) {
  await writeFile(path.join(repoRoot, 'docs', 'evidence', 'P25-cost-export.csv'), await readFile(exportPath), 'utf8');
}
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
console.log(`P25 surfaces probe: ${report.steps.length} steps passed, ${report.shots?.length ?? 0} screenshots`);
