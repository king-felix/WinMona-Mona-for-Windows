// Seed a real SQLite project, then drive the actual shell through the P14
// surfaces: Resume Brief, Since you left, Focus Mode, settings, both themes,
// notification focus, dedupe and quiet hours. No runtime is started and no
// prompt is submitted, so provider requests stay at zero.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ChangeService, CostLedger, TaskService, openState } from '@mona/project-state';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_POLISH_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'P14-polish.json');
const logFile = process.env.MONA_POLISH_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'P14-polish-log.txt');
const shotsDir = process.env.MONA_POLISH_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-p14');
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

const root = await mkdtemp(path.join(tmpdir(), 'mona-p14-polish-'));
const workspace = path.join(root, 'polish-project');
const profile = path.join(root, 'profile');
await mkdir(workspace, { recursive: true });
await mkdir(path.join(profile, 'state'), { recursive: true });

const git = (args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
// Create parents before writing a fixture file.
async function put(relative, body) {
  const file = path.join(workspace, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
}

try {
  await put('README.md', '# P14 polish fixture\n\nA small project for the daily-use probe.\n');
  await put('src/app.ts', 'export const version = 1;\n');
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'P14 Probe']);
  git(['config', 'user.email', 'p14@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const state = await openState({ directory: path.join(profile, 'state') });
  const registered = await state.store.registerProject(workspace, { label: 'polish-project' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;

  const tasks = new TaskService(state.store);
  const costs = new CostLedger(state.store);
  const changes = new ChangeService(state.store);

  // A completed task with verified evidence.
  const completedTask = await tasks.createTask({
    projectId,
    title: 'Record the first brief',
    owner: 'mona_queue',
    ordinal: 1,
    steps: [{ title: 'write the evidence file' }],
    criteria: [{ description: 'the evidence file exists' }],
    requirements: [{ requirementId: 'MONA-029', criterionId: 'resume-brief' }],
  });
  await tasks.claim(completedTask.id);
  await tasks.completeStep(completedTask.id, completedTask.steps[0].id);
  await put('docs/evidence/P14-check.txt', 'P14 fixture evidence\n');
  await tasks.recordCheck(completedTask.id, completedTask.criteria[0].id, {
    path: 'docs/evidence/P14-check.txt',
    note: 'fixture evidence recorded',
  });
  await tasks.requestVerification(completedTask.id);
  await tasks.completeTask(completedTask.id, 'victor');

  // A blocked task that needs a human decision.
  const blockedTask = await tasks.createTask({
    projectId,
    title: 'Repair the retention worker',
    owner: 'mona_queue',
    ordinal: 2,
    criteria: [{ description: 'the worker test passes' }],
  });
  await tasks.claim(blockedTask.id);
  await tasks.blockTask(blockedTask.id, 'requires a decision about retention policy');

  // The current prompt, paused at a recorded step.
  const runningTask = await tasks.createTask({
    projectId,
    title: 'Ship the daily-use polish',
    owner: 'mona_queue',
    ordinal: 3,
    steps: [{ title: 'read recorded rows' }, { title: 'render the brief' }],
    criteria: [{ description: 'the brief matches the record' }],
    requirements: [
      { requirementId: 'MONA-017', criterionId: 'deterministic-digest' },
      { requirementId: 'MONA-029', criterionId: 'focus-mode' },
    ],
  });
  await tasks.claim(runningTask.id);
  await tasks.beginStep(runningTask.id, runningTask.steps[0].id);
  await tasks.recordCheck(runningTask.id, runningTask.criteria[0].id, {
    path: 'docs/evidence/P14-check.txt',
    note: 'fixture evidence recorded for the running task',
  });

  await changes.recordTestReceipt({
    projectId,
    command: 'npm test',
    exitCode: 1,
    outcome: 'failed',
    output: '1 test failed in the fixture',
  });

  await costs.ingest({
    projectId,
    provider: 'deepseek',
    model: 'deepseek-flash',
    turnId: 'turn_p14_known',
    buckets: { input: 1_200, output: 240 },
    cost: { kind: 'provider_reported', micros: 2_500, source: 'runtime' },
    source: 'studio',
    dedupeKey: 'p14-usage-known',
  });
  await costs.ingest({
    projectId,
    provider: 'deepseek',
    model: 'deepseek-flash',
    turnId: 'turn_p14_unknown',
    buckets: { input: 200, output: 40 },
    cost: { kind: 'unknown', reason: 'runtime omitted pricing' },
    source: 'studio',
    dedupeKey: 'p14-usage-unknown',
  });

  // Uncommitted work for the changed-file count.
  await put('README.md', '# P14 polish fixture\n\nA small project for the daily-use probe.\n\nChanged for P14.\n');
  await put('src/new-file.ts', 'export const added = true;\n');

  const status = await changes.gitStatus(workspace);
  const changedPaths = new Set([
    ...status.staged.map((entry) => entry.path),
    ...status.unstaged.map((entry) => entry.path),
    ...status.untracked,
    ...status.conflicts,
  ]).size;

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  await writeFile(
    path.join(profile, 'state', 'ui-state.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        currentProjectId: projectId,
        preferences: {
          notificationsEnabled: true,
          quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'local' },
          density: 'comfortable',
          firstCloseNotified: false,
        },
        projects: {
          [projectId]: {
            view: 'home',
            layout: 'standard',
            currentSessionId: 'ses_p14_fixture',
            sessions: [{ sessionId: 'ses_p14_fixture', updatedAt: now.toISOString(), text: '' }],
            favorites: [
              {
                id: 'pfv_p14_fixture',
                label: 'Review the failing check',
                text: 'Review the failing test and report the exact command and its output.',
                createdAt: now.toISOString(),
              },
            ],
            lastOpenedAt: now.toISOString(),
            lastSeenAt: yesterday,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const fixtures = {
    projectId,
    workspace,
    runningTaskId: runningTask.id,
    spendLabel: '$0.0025 + 1 unknown record(s)',
    changedPaths,
    evidencePath: 'docs/evidence/P14-check.txt',
  };
  const fixturesFile = path.join(root, 'fixtures.json');
  await writeFile(fixturesFile, JSON.stringify(fixtures, null, 2), 'utf8');
  state.store.close();

  // A rerun must not mix fresh captures with old ones; evidence directories are
  // replaced, not appended to.
  await rm(shotsDir, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(shotsDir, { recursive: true });

  const child = spawn(electronPath, ['.', '--polish-test'], {
    cwd: appDir,
    env: {
      ...process.env,
      MONA_POLISH_OUT: out,
      MONA_POLISH_FIXTURES: fixturesFile,
      MONA_POLISH_SHOTS: shotsDir,
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
    console.error('polish probe exceeded 240 s; terminating');
    child.kill('SIGKILL');
  }, 240_000);
  const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
  clearTimeout(timer);
  await writeFile(logFile, `${stdout}${stderr}`, 'utf8');

  const manifest = JSON.parse(await readFile(out, 'utf8'));
  const failures = manifest.steps?.filter((step) => !step.ok).map((step) => step.name) ?? [
    'probe did not report steps',
  ];
  if (!manifest.ok) failures.unshift('probe reported ok=false');
  if ((manifest.shots?.length ?? 0) < 9) failures.push('fewer than nine live screenshots');
  if (manifest.providerRequests !== 0) failures.push('probe reported a provider request');
  if (code !== 0) failures.push(`electron exited with ${code}`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(
    `P14 polish probe: ${manifest.steps.length} steps passed, ${manifest.shots.length} live screenshots, provider requests ${manifest.providerRequests}`,
  );
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}
