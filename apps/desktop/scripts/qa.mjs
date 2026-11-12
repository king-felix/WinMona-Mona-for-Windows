// P22 performance measurement: cold and warm startup, idle CPU, memory, and the
// real studio rendering a 10,000-event history.
//
// Two launches share one throwaway profile: the first is cold (no Chromium or
// GPU cache), the second is warm. The app measures from inside; this script
// measures the wall-clock between spawn and the shell reporting interactive, and
// records the machine so the numbers mean something.
//
// No engine turn is submitted here. Provider spend stays at zero.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_QA_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P22-performance.json');
const logFile = process.env.MONA_QA_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P22-performance-log.txt');
await mkdir(path.dirname(out), { recursive: true });

const packagedExe = process.env.MONA_QA_EXE?.trim() || null;
let electronPath;
try {
  electronPath = packagedExe ?? (await import('electron')).default;
} catch (error) {
  console.error('Electron runtime is not installed:', String(error));
  process.exit(3);
}
if (!electronPath || !existsSync(electronPath)) {
  console.error('Electron runtime binary is missing at', electronPath ?? '(unknown)');
  process.exit(3);
}

function powershell(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return (result.stdout ?? '').trim();
}

const machine = {
  os: powershell(
    '(Get-CimInstance Win32_OperatingSystem).Caption + " " + (Get-CimInstance Win32_OperatingSystem).Version',
  ),
  build: powershell('(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").CurrentBuild'),
  cpu: powershell('(Get-CimInstance Win32_Processor).Name'),
  cores: Number.parseInt(powershell('(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors'), 10),
  memoryGb: Math.round(
    (Number.parseInt(powershell('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory'), 10) || 0) / 1024 ** 3,
  ),
  node: process.version,
  electron: (await import('electron/package.json', { with: { type: 'json' } })).default.version,
  executable: electronPath,
  packaged: Boolean(packagedExe),
};

const root = await mkdtemp(path.join(tmpdir(), 'mona-p22-qa-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'qa-project');
await mkdir(workspace, { recursive: true });

const logs = [];
const runs = [];

async function launch(label) {
  const reportFile = path.join(root, `${label}.json`);
  const readyFile = `${reportFile}.ready`;
  const startedAt = Date.now();
  const child = spawn(electronPath, packagedExe ? [] : ['.'], {
    cwd: packagedExe ? repoRoot : appDir,
    env: {
      ...process.env,
      MONA_QA: '1',
      MONA_QA_OUT: reportFile,
      MONA_QA_WORKSPACE: workspace,
      MONA_USER_DATA: profile,
      MONA_QA_EVENTS: '10000',
      MONA_QA_IDLE_SECONDS: process.env.MONA_QA_IDLE_SECONDS ?? '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => logs.push(`${label}: ${chunk.toString('utf8')}`));
  child.stderr.on('data', (chunk) => logs.push(`${label}: ${chunk.toString('utf8')}`));

  let interactiveMs = null;
  const watchdogMs = (Number.parseInt(process.env.MONA_QA_IDLE_SECONDS ?? '60', 10) + 240) * 1000;
  const watchdog = setTimeout(() => {
    logs.push(`${label}: watchdog expired; terminating the app\n`);
    child.kill();
  }, watchdogMs);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      const marker = Number.parseInt((await readFile(readyFile, 'utf8')).trim(), 10);
      interactiveMs = marker - startedAt;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const exitCode = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.on('exit', (code) => resolve(code));
  });
  clearTimeout(watchdog);
  const report = existsSync(reportFile) ? JSON.parse(await readFile(reportFile, 'utf8')) : null;
  runs.push({ label, interactiveMs, exitCode, report });
  return report;
}

const cold = await launch('cold');
const warm = await launch('warm');

const summary = {
  schema: 1,
  capturedAt: new Date().toISOString(),
  machine,
  method: {
    startup:
      'wall clock from spawn to the shell reporting document.readyState=complete, measured on this machine with a throwaway profile; the cold run starts with no Chromium or GPU cache',
    fixture:
      '10,000 timeline rows inserted into the product database for one synthetic thread; the studio reads the newest 500 (its documented bound) through the product component',
    idle: 'sum of percentCPUUsage across app.getAppMetrics() every 5 s for the configured window, with no engine running and no interaction',
    memory:
      'sum of workingSetSize across app.getAppMetrics() (Mona processes only); engine measured separately by process id',
    caveat:
      'single reference machine, no statistical repetitions; treat as the measured state, not a benchmark guarantee',
  },
  startup: {
    coldMs: runs[0]?.interactiveMs ?? null,
    warmMs: runs[1]?.interactiveMs ?? null,
    coldBudgetMs: 5000,
    warmBudgetMs: 2000,
  },
  history: cold?.renderer
    ? {
        seeded: cold.seeded ?? null,
        seedMs: cold.seedMs ?? null,
        loadedRows: cold.loadedRows ?? null,
        renderedItems: cold.renderer.renderedItems ?? null,
        queryMs: cold.queryMs ?? null,
        frameMedianMs: cold.renderer.frameMedian ?? null,
        frameP95Ms: cold.renderer.frameP95 ?? null,
        frameMaxMs: cold.renderer.frameMax ?? null,
        typeMedianMs: cold.renderer.typeMedian ?? null,
        typeP95Ms: cold.renderer.typeP95 ?? null,
      }
    : null,
  idle: warm?.idle ?? cold?.idle ?? null,
  memory: {
    monaProcessesMb: (warm ?? cold)?.idle?.memoryMb ?? null,
    monaProcessCount: (warm ?? cold)?.idle?.processes ?? null,
    budgetMb: 350,
    engineMb: (warm ?? cold)?.engineMemoryMb ?? null,
    enginePid: (warm ?? cold)?.enginePid ?? null,
  },
  steps: {
    cold: cold?.steps ?? null,
    warm: warm?.steps ?? null,
  },
  ok: Boolean(cold?.ok && warm?.ok),
};

await mkdir(path.dirname(out), { recursive: true });
const { writeFile } = await import('node:fs/promises');
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
await writeFile(logFile, `${logs.join('')}\n`, 'utf8');
if (process.env.MONA_QA_KEEP) {
  console.log(`profile kept at ${root}`);
} else {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
