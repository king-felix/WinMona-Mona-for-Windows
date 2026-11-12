import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openState, AttemptService, TaskService } from '../dist/index.js';

/**
 * Deterministic P11 sample run against the real SQLite state and the real
 * attempt service. It makes no provider request: no engine is started and no
 * turn is submitted.
 */

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

const root = await mkdtemp(path.join(tmpdir(), 'mona-p11-sample-'));
const workspace = path.join(root, 'sample-project');
await mkdir(path.join(workspace, 'evidence'), { recursive: true });
let state = await openState({ directory: path.join(root, 'state') });
const steps = [];

function record(name, detail) {
  steps.push({ name, detail });
}

async function evidence(name, body) {
  const file = path.join(workspace, 'evidence', name);
  await writeFile(file, body, 'utf8');
  // Record a workspace-relative path so the sample stays portable.
  return `evidence/${name}`;
}

try {
  const registered = await state.store.registerProject(workspace, { label: 'P11 sample' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;
  const tasks = new TaskService(state.store);
  const attempts = new AttemptService(state.store, { tasks });
  record('register project', { projectId });

  const blockedTask = await tasks.createTask({
    projectId,
    title: 'Blocked task',
    owner: 'mona_queue',
    ordinal: 1,
    steps: [{ title: 'run the failing check' }],
    criteria: [{ description: 'the check passes' }],
  });
  const dependent = await tasks.createTask({
    projectId,
    title: 'Dependent task',
    owner: 'mona_queue',
    ordinal: 2,
    dependsOn: [blockedTask.id],
    criteria: [{ description: 'dependent check passes' }],
  });
  const independent = await tasks.createTask({
    projectId,
    title: 'Independent task',
    owner: 'mona_queue',
    ordinal: 3,
    criteria: [{ description: 'independent check passes' }],
  });
  await tasks.claim(blockedTask.id, 'sample');
  record('claim blocked task', { taskId: blockedTask.id, status: 'running' });

  const problem = await attempts.openProblem({
    projectId,
    taskId: blockedTask.id,
    requirementId: 'MONA-011',
    title: 'Failing check cannot be reproduced',
    symptomFingerprint: 'check exits 1 with the same stack line',
  });
  record('open problem', { problemId: problem.id, fingerprint: problem.symptomFingerprint });

  for (let index = 0; index < 2; index += 1) {
    const outcome = await attempts.recordAttempt({
      problemId: problem.id,
      hypothesis: `hypothesis ${index + 1}`,
      action: `action ${index + 1}`,
      observedResult: 'same stack line',
      evidencePath: await evidence(`attempt-${index + 1}.txt`, `attempt ${index + 1}: same stack line`),
      materialProgress: false,
    });
    record('no-progress attempt', {
      attemptNo: outcome.attempt.attemptNo,
      total: outcome.problem.totalAttempts,
      consecutive: outcome.problem.consecutiveNoProgress,
    });
  }

  const acknowledged = await attempts.acknowledge(problem.id, { actor: 'victor', note: 'shown in the tray' });
  record('acknowledge', {
    consecutiveUnchanged: acknowledged.consecutiveNoProgress,
    totalUnchanged: acknowledged.totalAttempts,
  });

  // A fresh service instance on the same database stands in for a new session.
  const resumed = new AttemptService(state.store, { tasks });
  const persisted = await resumed.getProblem(problem.id);
  record('new session reads the persisted counter', {
    total: persisted?.totalAttempts,
    consecutive: persisted?.consecutiveNoProgress,
  });

  const third = await resumed.recordAttempt({
    problemId: problem.id,
    hypothesis: 'the fixture is stale',
    action: 'regenerated the fixture',
    observedResult: 'same stack line',
    evidencePath: await evidence('attempt-3.txt', 'attempt 3: same stack line'),
    materialProgress: false,
    helpNeeded: 'Victor: confirm the expected fixture contents for this check.',
  });
  record('third attempt blocks', {
    blockedNow: third.blockedNow,
    status: third.problem.status,
    handoff: third.handoff,
    taskBlocked: third.taskBlocked,
  });

  let fourth;
  try {
    await resumed.recordAttempt({
      problemId: problem.id,
      hypothesis: 'one more try',
      action: 'rerun',
      observedResult: 'same',
      evidencePath: await evidence('attempt-4.txt', 'attempt 4'),
      materialProgress: false,
    });
    fourth = { refused: false };
  } catch (error) {
    fourth = { refused: true, code: error.code ?? null, message: error.message };
  }
  record('fourth attempt refused by Mona-owned logic', fourth);

  const board = await tasks.board(projectId);
  record('board after the block', {
    entries: board.tasks.map((entry) => ({
      id: entry.task.id,
      title: entry.task.title,
      status: entry.task.status,
      eligible: entry.eligibility.eligible,
      reason: entry.eligibility.reason,
      blockedByProblemIds: entry.eligibility.blockedByProblemIds,
    })),
    next: board.next,
    independentId: independent.id,
    dependentId: dependent.id,
  });

  let claimRefused;
  try {
    await tasks.claim(blockedTask.id, 'sample');
    claimRefused = { refused: false };
  } catch (error) {
    claimRefused = { refused: true, code: error.code ?? null };
  }
  record('claim of the blocked task refused', claimRefused);

  const reopened = await resumed.reopenProblem(problem.id, {
    actor: 'victor',
    reason: 'the fixture contents were confirmed by Victor',
    evidencePath: await evidence('victor-note.txt', 'Victor confirmed the fixture contents'),
  });
  record('reopen with new evidence', {
    status: reopened.status,
    consecutive: reopened.consecutiveNoProgress,
    total: reopened.totalAttempts,
  });

  const transitions = await resumed.transitionsFor(problem.id);
  record(
    'audit trail',
    transitions.map((row) => `${row.fromStatus ?? '-'} -> ${row.toStatus}: ${row.reason}`),
  );

  // No adapter, runtime, submit or read call was made anywhere above.
  const report = {
    prompt: 'P11',
    generatedUtc: new Date().toISOString(),
    providerRequests: 0,
    steps,
  };
  if (outFile) await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  state.store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
