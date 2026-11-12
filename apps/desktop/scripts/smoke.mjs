// Launch the built app once, capture the real rendered state and process
// footprint, then exit. No engine process is started and no network request is
// made by this script.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_SMOKE_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P02-smoke.json');
await mkdir(path.dirname(out), { recursive: true });

let electronPath;
try {
  electronPath = (await import('electron')).default;
} catch (error) {
  console.error('Electron runtime is not installed:', String(error));
  console.error('See .mona/build/BLOCKERS.md P02-ELECTRON-BINARY for the exact prerequisite.');
  process.exit(3);
}
if (!electronPath || !existsSync(electronPath)) {
  console.error('Electron runtime binary is missing at', electronPath ?? '(unknown)');
  console.error('See .mona/build/BLOCKERS.md P02-ELECTRON-BINARY for the exact prerequisite.');
  process.exit(3);
}
const child = spawn(electronPath, ['.', '--smoke-test'], {
  cwd: appDir,
  env: { ...process.env, MONA_SMOKE_OUT: out },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
child.stdout.on('data', () => {});
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
if (stderr.trim()) console.error(stderr.trim().slice(-2000));
if (code !== 0) {
  console.error(`electron exited with ${code}`);
  process.exit(code ?? 1);
}
const report = JSON.parse(await readFile(out, 'utf8'));
console.log(JSON.stringify(report, null, 2));
if (!report.ok || report.dom?.version !== `v${report.appVersion}`) {
  console.error('smoke check failed: renderer did not report the app version');
  process.exit(1);
}
if (report.dom?.hasFixtureMarker) {
  console.error('smoke check failed: test fixtures leaked into the production renderer');
  process.exit(1);
}
if (report.rendererProcessCount < 1) {
  console.error('smoke check failed: no renderer process metric');
  process.exit(1);
}
