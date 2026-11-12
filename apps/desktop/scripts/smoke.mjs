// Launch the built app once, capture the real rendered state, the live security
// behaviour and the process footprint, then exit. No engine process is started
// and the window makes no network request of its own.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

const userData = await mkdtemp(path.join(tmpdir(), 'mona-smoke-profile-'));
const child = spawn(electronPath, ['.', '--smoke-test'], {
  cwd: appDir,
  env: { ...process.env, MONA_SMOKE_OUT: out, MONA_USER_DATA: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
child.stdout.on('data', () => {});
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
await rm(userData, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
if (stderr.trim()) console.error(stderr.trim().slice(-2000));
if (code !== 0) {
  console.error(`electron exited with ${code}`);
  process.exit(code ?? 1);
}

const report = JSON.parse(await readFile(out, 'utf8'));
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!report.ok) failures.push('main process did not report ok');
if (report.dom?.version !== `v${report.appVersion}`) failures.push('renderer did not report the real app version');
if (report.dom?.hasFixtureMarker) failures.push('test fixtures leaked into the production renderer');
if (report.dom?.hasHarness) failures.push('the fixture harness rendered in a production window');
if (!report.dom?.emptyCatalog) failures.push('a fresh window did not show the empty catalog state');
if (!report.dom?.palette) failures.push('the command palette entry point is missing');
if (!report.dom?.contextModel || !report.dom?.contextPermission)
  failures.push('the context bar is missing route facts');
if (report.rendererProcessCount < 1) failures.push('no renderer process metric');

const security = report.security ?? {};
if (!security.navigationRefused) failures.push('remote navigation was not refused');
if (!security.popupRefused) failures.push('remote popup was not refused');
if (security.windowCount !== 1) failures.push(`unexpected window count ${String(security.windowCount)}`);
if (security.devToolsAllowed) failures.push('devtools are open in a production window');

const bridge = report.bridge ?? {};
const keys = [...(bridge.keys ?? [])].sort();
const expectedKeys = [
  'createProject',
  'engineState',
  'getAppInfo',
  'getUiState',
  'listProjects',
  'newSession',
  'openProject',
  'pickFolder',
  'projectSpend',
  'relocateProject',
  'removeProject',
  'revealProject',
  'saveDraft',
  'selectProject',
  'setProjectView',
  'startEngine',
  'stopEngine',
  'updateProject',
].sort();
if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
  failures.push(`preload exposes unexpected keys: ${keys.join(',')}`);
}
if (!bridge.frozen) failures.push('preload bridge is not frozen');
if (keys.includes('invoke') || keys.includes('send') || keys.includes('require')) {
  failures.push('preload exposes a generic IPC primitive');
}
if (bridge.hasNodeRequire || bridge.hasProcess || bridge.hasIpcRenderer) {
  failures.push('Node or ipcRenderer leaked into the renderer global scope');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `smoke security checks passed: navigation refused, popup refused, ${keys.length} named bridge methods, footprint ${String(
    report.totalWorkingSetMb,
  )} MB`,
);
