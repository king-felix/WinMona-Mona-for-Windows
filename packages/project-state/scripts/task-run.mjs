import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openState, TaskService } from '../dist/index.js';

/**
 * Deterministic P10 sample run. It exercises the real SQLite state layer, the
 * real task service and a fake executor that only writes local fixture files.
 * No provider request is made: this is a continuity sample, not a model run.
 */

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

const root = await mkdtemp(path.join(tmpdir(), 'mona-p10-sample-'));
const workspace = path.join(root, 'sample-project');
await mkdir(workspace, { recursive: true });
const state = await openState({ directory: path.join(root, 'state') });
const service = new TaskService(state.store);
const steps = [];

function record(name, detail) {
  steps.push({ name, detail });
}

try {
  const registered = await state.store.registerProject(workspace, { label: 'P10 sample' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;
  record('register project', { projectId, status: registered.status });

  const first = await service.createTask({
    projectId,
    title: 'Create greeting',
    promptText: 'Write greeting.txt containing hello.',
    owner: 'mona_queue',
    ordinal: 1,
    steps: [{ title: 'write greeting.txt' }],
    criteria: [{ description: 'greeting.txt says hello', kind: 'check' }],
    requirements: [{ requirementId: 'SAMPLE-001', criterionId: 'greeting' }],
  });

  const resumed = await service.createTask({
    projectId,
    title: 'Record a two-step resume',
    promptText: 'Write step-one.txt, then step-two.txt.',
    owner: 'mona_queue',
    ordinal: 4,
    steps: [{ title: 'write step-one.txt' }, { title: 'write step-two.txt' }],
    criteria: [{ description: 'both step files exist', kind: 'check' }],
  });

  const second = await service.createTask({
    projectId,
    title: 'Review greeting',
    promptText: 'Write review.txt and wait for Victor to accept the wording.',
    owner: 'mona_queue',
    ordinal: 2,
    dependsOn: [first.id],
    steps: [{ title: 'write review.txt' }],
    criteria: [
      { description: 'review.txt exists', kind: 'check' },
      { description: 'Victor accepted the wording', kind: 'human' },
    ],
  });

  const independent = await service.createTask({
    projectId,
    title: 'Independent polish',
    promptText: 'Leave a small independent task pending to show selection stops.',
    owner: 'mona_queue',
    ordinal: 3,
    criteria: [{ description: 'polish applied', kind: 'check' }],
  });
  record('create tasks', {
    ids: { first: first.id, resume: resumed.id, second: second.id, independent: independent.id },
  });

  const runFirst = await service.runOnce(projectId, async (control) => {
    const task = await service.getTask(control.taskId);
    await control.beginStep(task.steps[0].id);
    await writeFile(path.join(workspace, 'greeting.txt'), 'hello\n', 'utf8');
    await control.completeStep(task.steps[0].id, 'wrote greeting.txt');
    await control.recordCheck(task.criteria[0].id, {
      path: 'greeting.txt',
      kind: 'test',
      note: 'fixture check read the file',
    });
  });
  record('run once (first task)', {
    taskId: runFirst.taskId,
    status: runFirst.status,
    completed: runFirst.completion?.completed ?? false,
    reason: runFirst.reason,
  });

  // Start the two-step task, finish its first step, then reconcile as if the
  // window and process had gone away.
  const claimResume = await service.claim(resumed.id);
  await service.beginStep(resumed.id, claimResume.task.steps[0].id);
  await writeFile(path.join(workspace, 'step-one.txt'), 'one\n', 'utf8');
  await service.completeStep(resumed.id, claimResume.task.steps[0].id);
  const reconciled = await service.reconcile(projectId, []);
  record('reconcile with no live run', reconciled);
  const resumedRun = await service.resumeTask(resumed.id, 'sample');
  record('resume', {
    status: resumedRun.status,
    currentStep: resumedRun.currentStep,
    stepTitle: resumedRun.steps.find((step) => step.id === resumedRun.currentStep)?.title ?? null,
  });
  await service.completeStep(resumed.id, resumedRun.steps[1].id);
  await writeFile(path.join(workspace, 'step-two.txt'), 'two\n', 'utf8');
  await service.recordCheck(resumed.id, resumedRun.criteria[0].id, {
    path: 'step-two.txt',
    kind: 'test',
  });
  await service.requestVerification(resumed.id, 'sample');
  await service.completeTask(resumed.id, 'sample');
  record('resume completed', { status: (await service.getTask(resumed.id))?.status });

  // The dependent task cannot start until the first task is completed, then
  // stops at verification because a human-only item remains.
  const selection = await service.nextEligible(projectId);
  record('selection before human acceptance', {
    taskId: selection?.task.id ?? null,
    reason: selection?.eligibility.reason ?? null,
  });
  const runSecond = await service.runOnce(projectId, async (control) => {
    const task = await service.getTask(control.taskId);
    await control.beginStep(task.steps[0].id);
    await writeFile(path.join(workspace, 'review.txt'), 'reviewed\n', 'utf8');
    await control.completeStep(task.steps[0].id, 'wrote review.txt');
    await control.recordCheck(task.criteria[0].id, { path: 'review.txt', kind: 'test' });
  });
  record('run once (dependent task)', {
    taskId: runSecond.taskId,
    status: runSecond.status,
    completion: runSecond.completion,
  });
  const verifying = await service.getTask(second.id);
  const human = verifying.criteria.find((criterion) => criterion.kind === 'human');
  await service.acceptHuman(second.id, human.id, { actor: 'victor', note: 'sample acceptance' });
  await service.completeTask(second.id, 'victor');
  record('human acceptance and completion', { status: (await service.getTask(second.id))?.status });

  // Change the artifact behind the first task's evidence: verification becomes
  // stale, the task reopens, and a fresh check restores completion.
  await writeFile(path.join(workspace, 'greeting.txt'), 'hello again\n', 'utf8');
  const stale = await service.revalidate(projectId, [{ path: 'greeting.txt' }]);
  record('revalidate', stale);
  const reopened = await service.getTask(first.id);
  record('stale task reopened', { status: reopened.status, gaps: reopened.evidence[0]?.staleReason ?? null });
  await service.recordCheck(first.id, reopened.criteria[0].id, { path: 'greeting.txt', kind: 'test' });
  await service.completeTask(first.id, 'sample');
  record('stale task re-verified', { status: (await service.getTask(first.id))?.status });

  const finalBoard = await service.board(projectId);
  const finalTasks = await service.listTasks(projectId);
  const handoff = await service.handoff(projectId);
  await service.writeHandoff(projectId, path.join(workspace, '.mona', 'project', 'HANDOFF.md'));
  record('final board', {
    next: finalBoard.next,
    eligible: finalBoard.eligible,
    independentStatus: finalTasks.find((task) => task.id === independent.id)?.status ?? null,
  });
  record('handoff generated', { bytes: Buffer.byteLength(handoff, 'utf8') });
  const redactedHandoff = handoff.replaceAll(workspace, '<temporary sample workspace>');

  const summary = {
    schema_version: 1,
    kind: 'mona.p10-sample-run',
    generated_utc: new Date().toISOString(),
    workspace: '<temporary sample workspace>',
    provider_requests: 0,
    tasks: finalTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      owner: task.executionOwner,
      dependencies: task.dependencies,
      criteria: task.criteria.map((criterion) => ({
        description: criterion.description,
        kind: criterion.kind,
        satisfied: criterion.satisfiedAt !== null,
      })),
      evidence: task.evidence.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        stale: entry.stale,
      })),
      requirements: task.requirements,
    })),
    board: {
      next: finalBoard.next,
      eligible: finalBoard.eligible,
      entries: finalBoard.tasks.map((entry) => ({
        id: entry.task.id,
        status: entry.task.status,
        eligible: entry.eligibility.eligible,
        reason: entry.eligibility.reason,
      })),
    },
    handoff: redactedHandoff,
    handoff_file_written: true,
    steps,
  };

  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (outFile) await writeFile(outFile, text, 'utf8');
  process.stdout.write(`P10 sample run: ${summary.tasks.length} tasks, ${steps.length} recorded steps\n`);
  for (const task of summary.tasks) process.stdout.write(`  ${task.title}: ${task.status}\n`);
} finally {
  state.store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
