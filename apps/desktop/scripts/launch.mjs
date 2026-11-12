// P09 live launch evidence:
//  1. register the classic folder and folder-background menu twice (idempotent)
//  2. start Mona with the exact launcher command line the registration produces
//  3. let the app's own probe spawn real second instances with hostile folder
//     names, a missing folder and two fast launches
//  4. uninstall while a foreign menu entry exists, and keep that entry
//  5. register once more, leaving a working right-click for the milestone
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENU_KEYS,
  buildLaunchCommand,
  register,
  unregister,
  verifyRegistration,
} from '../../../tools/launch/context-menu.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_LAUNCH_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P09-launch.json');
const logFile = process.env.MONA_LAUNCH_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P09-launch-log.txt');
const shotsDir = process.env.MONA_LAUNCH_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-p09');
const registrationOut =
  process.env.MONA_LAUNCH_REGISTRATION_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P09-launch-registration.json');
const FOREIGN_KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\MonaP09ForeignProbe';
await mkdir(path.dirname(out), { recursive: true });
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

const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
};

function reg(args) {
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe';
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const root = await mkdtemp(path.join(tmpdir(), 'mona-p09-launch-'));
const profile = await mkdtemp(path.join(tmpdir(), 'mona-p09-profile-'));
const fixtureA = path.join(root, "mona p09 alpha & (beta) 'quoted' — ünïcode");
const fixtureB = path.join(root, 'mona p09 second');
await mkdir(fixtureA, { recursive: true });
await mkdir(fixtureB, { recursive: true });
await writeFile(
  path.join(fixtureA, 'README.md'),
  '# P09 launch fixture\n\nA non-Git folder opened from Explorer.\n',
  'utf8',
);
await writeFile(path.join(fixtureB, 'README.md'), '# P09 second fixture\n', 'utf8');
const fixturesFile = path.join(root, 'fixtures.json');
await writeFile(fixturesFile, `${JSON.stringify({ a: fixtureA, b: fixtureB }, null, 2)}\n`, 'utf8');

let appChild = null;
let stdout = '';
let stderr = '';
const registration = {};

try {
  // 1. Clean slate, then register twice.
  const cleaned = await unregister();
  step('uninstall on a clean machine is a verified no-op', cleaned.verified, {
    removed: cleaned.removed,
    absent: cleaned.absent,
  });

  const first = await register({ executable: electronPath, appPath: appDir });
  step('the classic folder and background menus register', first.verified, {
    changed: first.changed,
    command: first.command,
  });
  const second = await register({ executable: electronPath, appPath: appDir });
  step('registering again repairs in place and changes nothing', second.verified && second.changed === false, {
    verified: second.verified,
    changed: second.changed,
  });

  const expectedCommand = buildLaunchCommand({ executable: electronPath, appPath: appDir });
  const folderCommand = second.state.folder?.command?.['@'] ?? null;
  const backgroundCommand = second.state.background?.command?.['@'] ?? null;
  step('Explorer would run exactly the documented launcher command', folderCommand === expectedCommand, {
    folderCommand,
    expectedCommand,
  });
  step('folder and folder-background use the same quoted %V command', backgroundCommand === folderCommand, {
    backgroundCommand,
  });
  step('the registration quotes the placeholder instead of a path', /--path "%V"/.test(folderCommand ?? ''), {
    command: folderCommand,
  });

  // 2. A foreign entry that uninstall must not touch.
  const foreign = reg(['add', FOREIGN_KEY, '/ve', '/t', 'REG_SZ', '/d', 'Foreign probe entry', '/f']);
  step('a foreign menu entry exists for the uninstall check', foreign.status === 0, { status: foreign.status });

  // 3. Start Mona with the launcher argv the command produces.
  appChild = spawn(electronPath, [appDir, 'project', 'open', '--path', fixtureA, '--profile', 'ds-full-access'], {
    cwd: appDir,
    env: {
      ...process.env,
      MONA_LAUNCH_TEST: '1',
      MONA_LAUNCH_OUT: out,
      MONA_LAUNCH_SHOTS: shotsDir,
      MONA_LAUNCH_FIXTURES: fixturesFile,
      MONA_USER_DATA: profile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  appChild.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    process.stdout.write(chunk);
  });
  appChild.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const timer = setTimeout(() => {
    console.error('launch probe exceeded 420 s; terminating');
    appChild?.kill('SIGKILL');
  }, 420_000);
  const code = await new Promise((resolve) => appChild.on('exit', (value) => resolve(value)));
  clearTimeout(timer);
  step('the app exited after the launch probe', code === 0, { exitCode: code });
  await writeFile(logFile, `${stdout}${stderr}`, 'utf8');

  let probe = null;
  try {
    probe = JSON.parse(await readFile(out, 'utf8'));
  } catch (error) {
    step('the launch probe wrote its report', false, { error: String(error) });
  }
  if (probe) {
    step('every in-app launch step passed', probe.ok === true, {
      steps: probe.steps?.length ?? 0,
      failures: (probe.steps ?? []).filter((entry) => !entry.ok).map((entry) => entry.name),
    });
    step('the probe captured live screenshots', (probe.shots?.length ?? 0) >= 3, { shots: probe.shots?.length ?? 0 });
  }

  // 4. Uninstall removes only Mona's entries.
  const removed = await unregister();
  const foreignSurvived = reg(['query', FOREIGN_KEY]).status === 0;
  step('uninstall removes Mona registration only', removed.verified && foreignSurvived, {
    removed: removed.removed,
    foreignSurvived,
  });
  step(
    'both Mona keys are gone after uninstall',
    removed.remaining.every((entry) => !entry.exists),
    {
      remaining: removed.remaining,
    },
  );

  // 5. Leave a working registration for the milestone.
  const final = await register({ executable: electronPath, appPath: appDir });
  step('the milestone leaves a verified classic registration in place', final.verified, {
    command: final.command,
    keys: MENU_KEYS,
  });
  const finalStatus = await verifyRegistration({ executable: electronPath, appPath: appDir });
  step('the final read-back matches every value Mona owns', finalStatus.verified, {
    problems: finalStatus.problems,
  });

  Object.assign(registration, {
    executable: electronPath,
    appPath: appDir,
    command: expectedCommand,
    folderCommand,
    backgroundCommand,
    firstChanged: first.changed,
    secondChanged: second.changed,
    uninstall: { removed: removed.removed, verified: removed.verified, foreignKeySurvived: foreignSurvived },
    finalVerified: finalStatus.verified,
    keys: MENU_KEYS,
  });
} finally {
  // Remove the foreign probe entry even if a check failed.
  reg(['delete', FOREIGN_KEY, '/f']);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  if (!process.env.MONA_LAUNCH_KEEP) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
  if (stderr.trim()) console.error(stderr.trim().slice(-2000));
}

const report = {
  ok: steps.every((entry) => entry.ok),
  steps,
  registration,
  probeReport: path.relative(repoRoot, out).split(path.sep).join('/'),
  log: path.relative(repoRoot, logFile).split(path.sep).join('/'),
  capturedAt: new Date().toISOString(),
};
await writeFile(registrationOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const failures = steps.filter((entry) => !entry.ok);
console.log(
  `P09 launch probe: ${steps.length - failures.length}/${steps.length} checks passed; registration ${registration.finalVerified ? 'verified' : 'NOT verified'}`,
);
if (!report.ok) {
  console.error(failures.map((entry) => entry.name).join('\n'));
  process.exit(1);
}
