// Capture the design-system harness in real Electron: both themes, both
// densities, the named screen sizes, a 200% zoom capture, and an automated
// accessibility/keyboard audit. Fixtures only: no inference, no network.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const shotsDir = process.env.MONA_SHOTS_DIR ?? path.join(repoRoot, 'docs', 'evidence', 'shots');
// Evidence paths are overridable so a later prompt can re-capture into its own
// artifacts instead of overwriting the prompt that first produced them.
const manifestFile = process.env.MONA_SHOTS_MANIFEST ?? path.join(repoRoot, 'docs', 'evidence', 'P06-shots.json');
const logFile = process.env.MONA_SHOTS_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P06-shots-log.txt');
await mkdir(shotsDir, { recursive: true });

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

const profile = await mkdtemp(path.join(tmpdir(), 'mona-shots-profile-'));
const child = spawn(electronPath, ['.', '--shots'], {
  cwd: appDir,
  env: {
    ...process.env,
    MONA_SHOTS_DIR: shotsDir,
    MONA_SHOTS_MANIFEST: manifestFile,
    MONA_USER_DATA: profile,
    MONA_ALLOW_HARNESS: '1',
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
  console.error('screenshot capture exceeded 180 s; terminating');
  child.kill('SIGKILL');
}, 180_000);
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(timer);
await writeFile(logFile, `${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (stderr.trim()) console.error(stderr.trim().slice(-2000));
if (code !== 0) {
  console.error(`electron exited with ${code}`);
  process.exit(code ?? 1);
}

const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const failures = [];
for (const audit of manifest.audit) {
  if (audit.duplicateIds.length > 0) failures.push(`${audit.theme}/${audit.density}: duplicate ids`);
  if (audit.unnamedControls.length > 0) failures.push(`${audit.theme}/${audit.density}: unnamed controls`);
  if (audit.colorOnlyStatuses > 0) failures.push(`${audit.theme}/${audit.density}: colour-only status`);
  if (audit.externalResources.length > 0) failures.push(`${audit.theme}/${audit.density}: external resource`);
  if (!audit.focusRingVisible) failures.push(`${audit.theme}/${audit.density}: focus ring missing`);
}
if (manifest.shots.length < 28) failures.push(`only ${manifest.shots.length} screenshots captured`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`design system captured: ${manifest.shots.length} screenshots, ${manifest.audit.length} audits clean`);
