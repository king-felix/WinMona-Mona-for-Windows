// W13: the runner's contract and state model are only useful if they refuse the
// things that would make a queue dishonest â€” a second send under a reused key, a
// report that describes a different turn, an acceptance claim with no engine
// completion behind it, or evidence paths that leave the workspace.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptService } from './attempts.js';
import { applyMigrations, MIGRATIONS } from './migrations.js';
import { RunnerService, containPath, type RunnerPolicy } from './runner.js';
import { ProjectStore } from './store.js';
import { TaskService } from './tasks.js';

const cleanup: Array<() => Promise<void>> = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-runner-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function openStore(label: string): Promise<ProjectStore> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  return store;
}

async function fixture(label: string): Promise<{
  store: ProjectStore;
  runner: RunnerService;
  tasks: TaskService;
  projectId: string;
  projectPath: string;
  taskId: string;
  taskPrompt: string;
  promptSha256: string;
  sourcePath: string;
}> {
  const store = await openStore(label);
  const root = await tempDir(`${label}-folder`);
  const folder = path.join(root, 'workspace');
  await mkdir(folder, { recursive: true });
  const outcome = await store.registerProject(folder, { label });
  if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = outcome.project.id;
  const projectPath = outcome.project.canonicalPath;
  const tasks = new TaskService(store, { now: () => new Date('2026-11-14T12:00:00.000Z') });
  const taskPrompt = '### W13 â€” Runner contract\n\nDo the bounded thing.';
  const task = await tasks.createTask({
    projectId,
    title: 'Runner contract',
    promptText: taskPrompt,
    owner: 'mona_queue',
    criteria: [
      { description: 'state tests reject stale reports' },
      { description: 'Narrator read the new screen', kind: 'human' },
    ],
  });
  const sourcePath = path.join(root, 'prompts.md');
  await writeFile(sourcePath, '# prompts\n', 'utf8');
  const runner = new RunnerService(store, { now: () => new Date('2026-11-14T12:00:00.000Z') });
  return {
    store,
    runner,
    tasks,
    projectId,
    projectPath,
    taskId: task.id,
    taskPrompt,
    promptSha256: createHash('sha256').update(taskPrompt).digest('hex'),
    sourcePath,
  };
}

function reportFor(
  base: { runId: string; taskId: string; dispatchId: string; promptSha256: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    report_version: 1,
    run_id: base.runId,
    task_id: base.taskId,
    dispatch_id: base.dispatchId,
    prompt_sha256: base.promptSha256,
    disposition: 'ready_for_verification',
    summary: 'Implemented the contract and its tests.',
    acceptance: [{ description: 'state tests reject stale reports', status: 'met' }],
    evidence: [],
    problems: [],
    questions: [],
    next_action: 'Run the acceptance gate.',
    ...overrides,
  };
}

async function dispatched(label: string, policy?: Partial<RunnerPolicy>) {
  const setup = await fixture(label);
  const source = {
    path: setup.sourcePath,
    sha256: createHash('sha256').update('# prompts\n').digest('hex'),
    revision: 'p1',
  };
  const run = await setup.runner.createRun({
    projectId: setup.projectId,
    title: 'Run',
    taskIds: [setup.taskId],
    source,
    ...(policy ? { policy } : {}),
    actor: 'victor',
  });
  await setup.runner.startRun(run.run.id, 'victor');
  const dispatch = await setup.runner.recordDispatch({
    runId: run.run.id,
    taskId: setup.taskId,
    operationKey: 'op-1',
    sessionId: 'ses-1',
    promptSha256: setup.promptSha256,
    actor: 'controller',
  });
  return { ...setup, run: run.run, dispatch };
}

describe('prompt runner contract', () => {
  it('adds the runner tables without touching earlier migrations', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(MIGRATIONS[9]?.name).toBe('prompt-runner');
    expect(MIGRATIONS[9]?.sql).toContain('prompt_dispatches');
    expect(MIGRATIONS[0]?.sql).not.toContain('prompt_runs');
    expect(MIGRATIONS[8]?.sql).not.toContain('runner_reports');
  });

  it('preserves existing project and task state across the new migration', async () => {
    const dir = await tempDir('migrate');
    const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
    stores.push(store);
    await applyMigrations(store.database, { migrations: MIGRATIONS.slice(0, 9) });
    const root = await tempDir('migrate-project');
    const folder = path.join(root, 'workspace');
    await mkdir(folder, { recursive: true });
    const outcome = await store.registerProject(folder, { label: 'kept' });
    if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
    const tasks = new TaskService(store);
    const task = await tasks.createTask({
      projectId: outcome.project.id,
      title: 'Existing work',
      promptText: 'do not lose me',
      owner: 'mona_queue',
    });

    const report = await applyMigrations(store.database);
    expect(report.applied.map((migration) => migration.version)).toEqual([10]);
    const kept = await tasks.getTask(task.id);
    expect(kept?.title).toBe('Existing work');
    const project = await store.getProject(outcome.project.id);
    expect(project?.canonicalPath).toBe(outcome.project.canonicalPath);
    const tables = store.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('prompt_runs','prompt_dispatches','runner_reports')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(['prompt_dispatches', 'prompt_runs', 'runner_reports']);
  });

  it('freezes plan order and prompt hashes, and refuses foreign tasks', async () => {
    const setup = await fixture('freeze');
    const source = {
      path: setup.sourcePath,
      sha256: createHash('sha256').update('# prompts\n').digest('hex'),
      revision: 'p1',
    };
    const run = await setup.runner.createRun({
      projectId: setup.projectId,
      title: 'Run',
      taskIds: [setup.taskId],
      source,
      actor: 'victor',
    });
    expect(run.run.status).toBe('draft');
    expect(run.run.planRevision).toBe(1);
    expect(run.tasks).toHaveLength(1);
    expect(run.tasks[0]?.promptSha256).toBe(setup.promptSha256);
    expect(run.run.policy.continuationAllowance).toBe(3);

    const otherRoot = await tempDir('freeze-other-project');
    const otherFolder = path.join(otherRoot, 'workspace');
    await mkdir(otherFolder, { recursive: true });
    const otherProject = await setup.store.registerProject(otherFolder, { label: 'other' });
    if (otherProject.status === 'relocation_required') throw new Error('unexpected relocation');
    await expect(
      setup.runner.createRun({
        projectId: otherProject.project.id,
        title: 'Wrong project',
        taskIds: [setup.taskId],
        source,
        actor: 'victor',
      }),
    ).rejects.toThrow(/belongs to another project/);

    await expect(
      setup.runner.createRun({ projectId: setup.projectId, title: 'Empty', taskIds: [], source, actor: 'victor' }),
    ).rejects.toThrow(/at least one task/);
    await expect(
      setup.runner.createRun({
        projectId: setup.projectId,
        title: 'Allowance',
        taskIds: [setup.taskId],
        source,
        policy: { continuationAllowance: 11 },
        actor: 'victor',
      }),
    ).rejects.toThrow(/continuationAllowance/);
    await expect(
      setup.runner.createRun({
        projectId: setup.projectId,
        title: 'Repair',
        taskIds: [setup.taskId],
        source,
        policy: { reportRepairAllowance: 2 },
        actor: 'victor',
      }),
    ).rejects.toThrow(/reportRepairAllowance/);
  });

  it('makes a dispatch idempotent per operation key and refuses a reused key', async () => {
    const { runner, run, taskId, promptSha256 } = await dispatched('dispatch');
    const again = await runner.recordDispatch({
      runId: run.id,
      taskId,
      operationKey: 'op-1',
      sessionId: 'ses-1',
      promptSha256,
      actor: 'controller',
    });
    expect(again.id).toBe((await runner.getRun(run.id))?.dispatches[0]?.id);
    await expect(
      runner.recordDispatch({
        runId: run.id,
        taskId,
        operationKey: 'op-1',
        sessionId: 'ses-2',
        promptSha256,
        actor: 'controller',
      }),
    ).rejects.toThrow(/already used for a different dispatch/);
    await expect(
      runner.recordDispatch({
        runId: run.id,
        taskId,
        operationKey: 'op-2',
        sessionId: 'ses-1',
        promptSha256: 'f'.repeat(64),
        actor: 'controller',
      }),
    ).rejects.toThrow(/does not match the frozen plan revision/);
  });

  it('holds one unsettled dispatch per workspace and counts continuations', async () => {
    const { runner, run, taskId, promptSha256 } = await dispatched('workspace', { continuationAllowance: 1 });
    await expect(
      runner.recordDispatch({
        runId: run.id,
        taskId,
        operationKey: 'op-2',
        sessionId: 'ses-2',
        promptSha256,
        actor: 'controller',
      }),
    ).rejects.toThrow(/already has unsettled dispatch/);

    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id, { threadId: 'thr-1' });
    await runner.bindTurn(dispatch!.id, { turnId: 'trn-1' });
    await runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' });

    const second = await runner.recordDispatch({
      runId: run.id,
      taskId,
      operationKey: 'op-2',
      sessionId: 'ses-2',
      promptSha256,
      actor: 'controller',
    });
    expect(second.continuationIndex).toBe(1);
    await runner.markAccepted(second.id);
    await runner.markTurnCompleted(second.id, { turnId: 'trn-2' });
    await expect(
      runner.recordDispatch({
        runId: run.id,
        taskId,
        operationKey: 'op-3',
        sessionId: 'ses-3',
        promptSha256,
        actor: 'controller',
      }),
    ).rejects.toThrow(/continuation turn/);
  });

  it('keeps transport acceptance, turn completion and task completion distinct', async () => {
    const { runner, tasks, run, taskId, promptSha256 } = await dispatched('distinct');
    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id, { threadId: 'thr-1' });
    expect((await tasks.getTask(taskId))?.status).toBe('pending');

    await runner.bindTurn(dispatch!.id, { turnId: 'trn-1' });
    const receipt = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor({ runId: run.id, taskId, dispatchId: dispatch!.id, promptSha256 }),
      actor: 'agent',
    });
    expect(receipt.accepted).toBe(false);
    expect(receipt.reasons.join(' ')).toMatch(/only after the engine's own turn completion/);

    await runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' });
    const accepted = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor({ runId: run.id, taskId, dispatchId: dispatch!.id, promptSha256 }),
      actor: 'agent',
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.disposition).toBe('ready_for_verification');
    // An accepted report writes no task evidence and completes nothing.
    expect((await tasks.getTask(taskId))?.status).toBe('pending');
    expect((await tasks.getTask(taskId))?.evidence).toEqual([]);
  });

  it('refuses a second accepted report and keeps the rejected attempt in history', async () => {
    const { runner, run, taskId, promptSha256 } = await dispatched('duplicate');
    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id);
    await runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' });
    const base = { runId: run.id, taskId, dispatchId: dispatch!.id, promptSha256 };
    expect(
      (await runner.submitReport({ dispatchId: dispatch!.id, report: reportFor(base), actor: 'agent' })).accepted,
    ).toBe(true);
    await expect(
      runner.submitReport({ dispatchId: dispatch!.id, report: reportFor(base, { summary: 'again' }), actor: 'agent' }),
    ).rejects.toThrow(/already has an accepted report/);
  });

  it('rejects mismatched identities, unknown fields and internally contradictory reports', async () => {
    const { runner, run, taskId, promptSha256 } = await dispatched('reject');
    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id);
    await runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' });
    const base = { runId: run.id, taskId, dispatchId: dispatch!.id, promptSha256 };

    const wrongRun = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { run_id: 'run_other' }),
      actor: 'agent',
    });
    expect(wrongRun.accepted).toBe(false);
    expect(wrongRun.reasons.join(' ')).toMatch(/run_id run_other/);

    const wrongPrompt = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { prompt_sha256: 'a'.repeat(64) }),
      actor: 'agent',
    });
    expect(wrongPrompt.accepted).toBe(false);
    expect(wrongPrompt.reasons.join(' ')).toMatch(/prompt_sha256/);

    const smuggled = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: { ...reportFor(base), tasks: [{ id: 'W99' }] },
      actor: 'agent',
    });
    expect(smuggled.accepted).toBe(false);
    expect(smuggled.reasons.join(' ')).toMatch(/unrecognized|Unrecognized/);

    const contradictory = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { acceptance: [{ description: 'not done', status: 'unmet' }] }),
      actor: 'agent',
    });
    expect(contradictory.accepted).toBe(false);
    expect(contradictory.reasons.join(' ')).toMatch(/contradicts/);

    const noQuestion = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { disposition: 'needs_human' }),
      actor: 'agent',
    });
    expect(noQuestion.accepted).toBe(false);
    expect(noQuestion.reasons.join(' ')).toMatch(/needs at least one question/);

    await expect(
      runner.submitReport({
        dispatchId: dispatch!.id,
        report: reportFor(base, { summary: 'x'.repeat(70 * 1024) }),
        actor: 'agent',
      }),
    ).rejects.toThrow(/larger than/);
  });

  it('refuses statuses a human must satisfy and unknown problem ids', async () => {
    const { runner, tasks, store, projectId, run, taskId, promptSha256 } = await dispatched('claims');
    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id);
    await runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' });
    const base = { runId: run.id, taskId, dispatchId: dispatch!.id, promptSha256 };
    const humanCriterion = (await tasks.getTask(taskId))?.criteria.find((criterion) => criterion.kind === 'human');

    const humanMet = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, {
        acceptance: [{ criterion_id: humanCriterion!.id, description: 'Narrator read it', status: 'met' }],
      }),
      actor: 'agent',
    });
    expect(humanMet.accepted).toBe(false);
    expect(humanMet.reasons.join(' ')).toMatch(/human-only/);

    const invented = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { disposition: 'blocked', problems: [{ problem_id: 'prb_invented' }] }),
      actor: 'agent',
    });
    expect(invented.accepted).toBe(false);
    expect(invented.reasons.join(' ')).toMatch(/not a recorded problem/);

    const attempts = new AttemptService(store);
    const problem = await attempts.openProblem({
      projectId,
      taskId,
      title: 'Known problem',
      symptomFingerprint: 'known-symptom',
    });
    const known = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, {
        disposition: 'blocked',
        acceptance: [],
        problems: [{ problem_id: problem.id, attempts: 2, material_progress: 'no' }],
      }),
      actor: 'agent',
    });
    expect(known.accepted).toBe(true);
    expect(known.disposition).toBe('blocked');
  });

  it('refuses evidence outside the workspace, missing files and wrong hashes', async () => {
    const { runner, projectPath, run, taskId, promptSha256 } = await dispatched('evidence');
    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id);
    await runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' });
    const base = { runId: run.id, taskId, dispatchId: dispatch!.id, promptSha256 };

    await writeFile(path.join(projectPath, 'report.md'), 'real evidence\n', 'utf8');
    const goodHash = createHash('sha256').update('real evidence\n').digest('hex');

    const escaped = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { evidence: [{ path: '..\\outside.md' }] }),
      actor: 'agent',
    });
    expect(escaped.accepted).toBe(false);
    expect(escaped.reasons.join(' ')).toMatch(/escapes the workspace/);

    const absolute = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { evidence: [{ path: path.join(projectPath, 'report.md') }] }),
      actor: 'agent',
    });
    expect(absolute.accepted).toBe(false);
    expect(absolute.reasons.join(' ')).toMatch(/workspace-relative/);

    const missing = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { evidence: [{ path: 'does-not-exist.md' }] }),
      actor: 'agent',
    });
    expect(missing.accepted).toBe(false);
    expect(missing.reasons.join(' ')).toMatch(/does not exist/);

    const mismatch = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { evidence: [{ path: 'report.md', sha256: 'b'.repeat(64) }] }),
      actor: 'agent',
    });
    expect(mismatch.accepted).toBe(false);
    expect(mismatch.reasons.join(' ')).toMatch(/hash does not match/);

    const accepted = await runner.submitReport({
      dispatchId: dispatch!.id,
      report: reportFor(base, { evidence: [{ path: 'report.md', sha256: goodHash, kind: 'document' }] }),
      actor: 'agent',
    });
    expect(accepted.accepted).toBe(true);
  });

  it('contains report paths and reads them back with a size cap', async () => {
    const { runner, projectPath } = await fixture('files');
    const relativePath = runner.writeReportFile(projectPath, 'dsp_abc123', { hello: 'world' });
    expect(relativePath).toBe('.mona/runner/reports/dsp_abc123.json');
    expect(runner.readReportFile(projectPath, 'dsp_abc123')).toEqual({ hello: 'world' });
    expect(() => containPath(projectPath, '..\\escape.json', { mustExist: false })).toThrow(/escapes/);
    expect(() => runner.reportRelativePath('..\\..\\evil')).toThrow(/not safe/);
    await writeFile(path.join(projectPath, '.mona', 'runner', 'reports', 'dsp_big.json'), 'x'.repeat(70 * 1024));
    expect(() => runner.readReportFile(projectPath, 'dsp_big')).toThrow(/limit is/);
  });

  it('reconciles an unsettled dispatch as uncertain and never retries it silently', async () => {
    const { runner, run, taskId, promptSha256 } = await dispatched('reconcile');
    const dispatch = (await runner.getRun(run.id))?.dispatches[0];
    await runner.markAccepted(dispatch!.id);
    const settled = await runner.reconcile((await runner.getRun(run.id))!.run.projectId);
    expect(settled.map((row) => row.status)).toEqual(['uncertain']);
    await expect(runner.markTurnCompleted(dispatch!.id, { turnId: 'trn-1' })).rejects.toThrow(
      /reconcile it, do not retry/,
    );

    const again = await runner.recordDispatch({
      runId: run.id,
      taskId,
      operationKey: 'op-2',
      sessionId: 'ses-2',
      promptSha256,
      actor: 'controller',
    });
    expect(again.operationKey).toBe('op-2');
  });

  it('finishes a run only when every task is completed or skipped', async () => {
    const { runner, tasks, run, taskId } = await dispatched('finish');
    await expect(
      runner.finishRun(run.id, { status: 'completed', reason: 'done', actor: 'controller' }),
    ).rejects.toThrow(/unfinished tasks/);
    await tasks.skipTask(taskId, { decision: 'out of scope for this pass', actor: 'victor' });
    await runner.markAccepted((await runner.getRun(run.id))!.dispatches[0]!.id);
    const settled = await runner.reconcile((await runner.getRun(run.id))!.run.projectId);
    expect(settled).toHaveLength(1);
    const finished = await runner.finishRun(run.id, {
      status: 'completed',
      reason: 'all tasks settled',
      actor: 'controller',
    });
    expect(finished.status).toBe('completed');
  });
});

describe('prompt runner path containment', () => {
  it('refuses a junction that points outside the workspace', async () => {
    const { runner, projectPath } = await fixture('junction');
    const outside = await tempDir('junction-target');
    await writeFile(path.join(outside, 'secret.txt'), 'not yours\n', 'utf8');
    const junction = path.join(projectPath, 'linked');
    const made = spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, outside], { windowsHide: true }).status === 0;
    if (!made) return; // creating a junction needs the privilege; the syntactic checks still cover .. and absolute paths
    expect(() => containPath(projectPath, 'linked/secret.txt', { mustExist: true })).toThrow(/outside the workspace/);
    expect(() => runner.writeReportFile(projectPath, 'dsp_link', {})).not.toThrow();
  });
});

describe('prompt runner migration safety', () => {
  it('takes a pre-migration backup and keeps the task rows when opening a v9 database', async () => {
    const { openState } = await import('./index.js');
    const dir = await tempDir('open-v9');
    const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
    await applyMigrations(store.database, { migrations: MIGRATIONS.slice(0, 9) });
    const root = await tempDir('open-v9-project');
    const folder = path.join(root, 'workspace');
    await mkdir(folder, { recursive: true });
    const registered = await store.registerProject(folder, { label: 'kept' });
    if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
    const tasks = new TaskService(store);
    const task = await tasks.createTask({
      projectId: registered.project.id,
      title: 'Survives migration 10',
      promptText: 'keep me',
      owner: 'mona_queue',
    });
    store.close();

    const opened = await openState({ directory: dir });
    stores.push(opened.store);
    expect(opened.migrations.applied.map((migration) => migration.version)).toEqual([10]);
    expect(opened.preMigrationBackup?.file).toBeTruthy();
    expect(opened.preMigrationBackup?.schemaVersion).toBe(9);
    expect(opened.schemaVersion).toBe(10);
    const kept = await new TaskService(opened.store).getTask(task.id);
    expect(kept?.title).toBe('Survives migration 10');
  });
});
