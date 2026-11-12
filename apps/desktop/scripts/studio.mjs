// P08 live studio probe: launch the built app, start the real owned runtime,
// submit one bounded task through the rendered composer, and verify the file
// change and test result on disk match what the timeline reported.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_STUDIO_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P08-studio.json');
const logFile = process.env.MONA_STUDIO_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P08-studio-log.txt');
const shotsDir = process.env.MONA_STUDIO_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-p08');
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

const taskText =
  'Create a file named hello.txt in this project containing exactly MONA_STUDIO_OK with no extra text. ' +
  'Then run `node check.mjs` in this project and report whether it passed. Do not change any other file.';

const workspace = await mkdtemp(path.join(tmpdir(), 'mona-p08-studio-'));
const profile = await mkdtemp(path.join(tmpdir(), 'mona-p08-profile-'));
const child = spawn(electronPath, ['.', '--studio-test'], {
  cwd: appDir,
  env: {
    ...process.env,
    MONA_STUDIO_OUT: out,
    MONA_STUDIO_WORKSPACE: workspace,
    MONA_STUDIO_SHOTS: shotsDir,
    MONA_STUDIO_TASK: taskText,
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
  console.error('studio probe exceeded 420 s; terminating');
  child.kill('SIGKILL');
}, 420_000);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(timer);
await writeFile(logFile, `${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
// The fixture project is kept when MONA_STUDIO_KEEP is set, for inspection.
if (!process.env.MONA_STUDIO_KEEP) {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}
if (stderr.trim()) console.error(stderr.trim().slice(-2000));

const manifest = JSON.parse(await readFile(out, 'utf8'));
const failures = manifest.steps?.filter((step) => !step.ok).map((step) => step.name) ?? ['probe did not report steps'];
if (!manifest.ok) failures.unshift('probe reported ok=false');
if ((manifest.shots?.length ?? 0) < 5) failures.push('fewer than five live studio screenshots');
if (code !== 0) failures.push(`electron exited with ${code}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `P08 studio probe: ${manifest.steps.length} steps passed, ${manifest.shots.length} live screenshots, ` +
    `changed ${manifest.evidence.changedFilesOnDisk.join(', ')}`,
);
