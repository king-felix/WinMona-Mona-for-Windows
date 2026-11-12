// Launch the built app and drive the real P07 shell end to end: catalog
// lifecycle, drafts, reload persistence, keyboard-only navigation, engine
// connection, project switching isolation, and live screenshots.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_CATALOG_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P07-catalog.json');
const logFile = process.env.MONA_CATALOG_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P07-catalog-log.txt');
const shotsDir = process.env.MONA_CATALOG_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-p07');
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

const workspace = await mkdtemp(path.join(tmpdir(), 'mona-p07-catalog-'));
const profile = await mkdtemp(path.join(tmpdir(), 'mona-p07-profile-'));
const child = spawn(electronPath, ['.', '--catalog-test'], {
  cwd: appDir,
  env: {
    ...process.env,
    MONA_CATALOG_OUT: out,
    MONA_CATALOG_WORKSPACE: workspace,
    MONA_CATALOG_SHOTS: shotsDir,
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
  console.error('catalog probe exceeded 180 s; terminating');
  child.kill('SIGKILL');
}, 180_000);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(timer);
await writeFile(logFile, `${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (stderr.trim()) console.error(stderr.trim().slice(-2000));

const manifest = JSON.parse(await readFile(out, 'utf8'));
const failures = manifest.steps?.filter((step) => !step.ok).map((step) => step.name) ?? ['probe did not report steps'];
if (!manifest.ok) failures.unshift('probe reported ok=false');
if ((manifest.shots?.length ?? 0) < 6) failures.push('fewer than six live shell screenshots');
if (code !== 0) failures.push(`electron exited with ${code}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `P07 catalog probe: ${manifest.steps.length} steps passed, ${manifest.shots.length} live screenshots captured`,
);
