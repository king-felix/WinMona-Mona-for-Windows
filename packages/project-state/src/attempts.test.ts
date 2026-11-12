import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptService, ENGINE_ATTEMPT_INSTRUCTION } from './attempts.js';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';
import { TaskService, type WorkTask } from './tasks.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p11-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string) {
  const dir = await tempDir(label);
  const file = path.join(dir, 'mona.sqlite');
  const store = new ProjectStore({ file, now: () => new Date('2026-11-12T12:00:00.000Z') });
  stores.push(store);
  await applyMigrations(store.database);
  const tasks = new TaskService(store, { now: () => new Date('2026-11-12T12:00:00.000Z') });
  const attempts = new AttemptService(store, {
    now: () => new Date('2026-11-12T12:00:00.000Z'),
    tasks,
  });
  const folder = await tempDir(`${label}-folder`);
  const registered = await store.registerProject(folder, { label });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  return { store, tasks, attempts, projectId: registered.project.id, folder, file };
}

async function evidence(folder: string, name: string, body = 'observed output'): Promise<string> {
  const target = path.join(folder, 'evidence', name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, 'utf8');
  return target;
}

async function makeTask(
  tasks: TaskService,
  projectId: string,
  title: string,
  dependsOn: string[] = [],
): Promise<WorkTask> {
  return await tasks.createTask({
    projectId,
    title,
    owner: 'mona_queue',
    criteria: [{ description: 'the check passes' }],
    steps: [{ title: 'do the work' }],
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  });
}

describe('three-attempt rule', () => {
  it('blocks a problem at the third consecutive no-progress attempt and gives up the fourth', async () => {
    const { attempts, projectId, folder } = await setup('three');
    const problem = await attempts.openProblem({
      projectId,
      requirementId: 'MONA-011',
      title: 'flaky packaging step',
      symptomFingerprint: 'pack: exit 1 with TS2345 after rebuild',
    });
    expect(problem.id).toMatch(/^prb_[0-9a-f]{32}$/);

    const first = await attempts.recordAttempt({
      problemId: problem.id,
      hypothesis: 'the stale declaration is the cause',
      action: 'rebuilt the declarations',
      observedResult: 'same TS2345',
      evidencePath: await evidence(folder, 'attempt-1.txt'),
      materialProgress: false,
    });
    expect(first.problem.consecutiveNoProgress).toBe(1);
    expect(first.blockedNow).toBe(false);

    const second = await attempts.recordAttempt({
      problemId: problem.id,
      hypothesis: 'the dependency is duplicated',
      action: 'deduped the lockfile',
      observedResult: 'same TS2345 at the same line',
      evidencePath: await evidence(folder, 'attempt-2.txt'),
      materialProgress: false,
    });
    expect(second.problem.consecutiveNoProgress).toBe(2);

    const third = await attempts.recordAttempt({
      problemId: problem.id,
      hypothesis: 'the build cache is poisoned',
      action: 'cleared the cache',
      observedResult: 'same TS2345',
      evidencePath: await evidence(folder, 'attempt-3.txt'),
      materialProgress: false,
      helpNeeded: 'Victor: confirm whether the private registry serves the expected type package version.',
    });
    expect(third.blockedNow).toBe(true);
    expect(third.problem.status).toBe('blocked');
    expect(third.problem.totalAttempts).toBe(3);
    expect(third.handoff?.helpNeeded).toContain('private registry');
    expect(third.handoff?.attempts.map((attempt) => attempt.attemptNo)).toEqual([1, 2, 3]);

    await expect(
      attempts.recordAttempt({
        problemId: problem.id,
        hypothesis: 'one more try',
        action: 'rebuilt again',
        observedResult: 'still failing',
        evidencePath: await evidence(folder, 'attempt-4.txt'),
        materialProgress: false,
      }),
    ).rejects.toMatchObject({ code: 'not_eligible' });

    const rows = await attempts.attemptsFor(problem.id);
    expect(rows).toHaveLength(3);
  });

  it('resets only the consecutive counter with linked evidence and preserves the total', async () => {
    const { attempts, projectId, folder } = await setup('progress');
    const problem = await attempts.openProblem({
      projectId,
      title: 'unclear failure',
      symptomFingerprint: 'turn fails without a tool error',
    });
    const attempt = (material: boolean, reason?: string) =>
      attempts.recordAttempt({
        problemId: problem.id,
        hypothesis: 'hypothesis',
        action: 'action',
        observedResult: material ? 'a required test now passes' : 'same failure',
        evidencePath: path.join(folder, `evidence-${Date.now()}-${Math.random()}.txt`),
        materialProgress: material,
        ...(reason ? { progressReason: reason } : {}),
      });

    await attempt(false);
    await attempt(false);
    const progressed = await attempt(true, 'the failing test now passes: reproduction narrowed to the tool bridge');
    expect(progressed.problem.consecutiveNoProgress).toBe(0);
    expect(progressed.problem.totalAttempts).toBe(3);
    expect(progressed.problem.status).toBe('open');

    await expect(attempt(true)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(attempt(false, 'made some progress')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('keeps the counters across a session restart and never resets by acknowledgement', async () => {
    const { attempts, projectId, folder, store, file } = await setup('restart');
    const problem = await attempts.openProblem({
      projectId,
      title: 'restart problem',
      symptomFingerprint: 'interrupted run does not resume',
    });
    for (let index = 0; index < 2; index += 1) {
      await attempts.recordAttempt({
        problemId: problem.id,
        hypothesis: `h${index}`,
        action: `a${index}`,
        observedResult: 'same',
        evidencePath: await evidence(folder, `restart-${index}.txt`),
        materialProgress: false,
      });
    }
    const acknowledged = await attempts.acknowledge(problem.id, { actor: 'victor', note: 'seen in the tray' });
    expect(acknowledged.consecutiveNoProgress).toBe(2);
    expect(acknowledged.totalAttempts).toBe(2);

    store.close();
    stores.pop();
    const reopened = new ProjectStore({ file, now: () => new Date('2026-11-13T09:00:00.000Z') });
    stores.push(reopened);
    await applyMigrations(reopened.database);
    const resumed = new AttemptService(reopened, { now: () => new Date('2026-11-13T09:00:00.000Z') });
    const found = await resumed.getProblem(problem.id);
    expect(found?.consecutiveNoProgress).toBe(2);
    expect(found?.totalAttempts).toBe(2);

    const third = await resumed.recordAttempt({
      problemId: problem.id,
      hypothesis: 'after restart',
      action: 'same command',
      observedResult: 'same',
      evidencePath: await evidence(folder, 'restart-3.txt'),
      materialProgress: false,
      helpNeeded: 'Victor: check whether the runtime start is permitted in this session.',
    });
    expect(third.blockedNow).toBe(true);

    const transitions = await resumed.transitionsFor(problem.id);
    expect(transitions.some((row) => row.reason.startsWith('acknowledged'))).toBe(true);
    expect(transitions.some((row) => row.toStatus === 'blocked')).toBe(true);
  });

  it('reopens only with new evidence or a Victor decision, and keeps the total', async () => {
    const { attempts, projectId, folder } = await setup('reopen');
    const problem = await attempts.openProblem({
      projectId,
      title: 'reopen problem',
      symptomFingerprint: 'provider returns 401 on the first turn',
    });
    for (let index = 0; index < 3; index += 1) {
      await attempts.recordAttempt({
        problemId: problem.id,
        hypothesis: `h${index}`,
        action: `a${index}`,
        observedResult: 'same 401',
        evidencePath: await evidence(folder, `reopen-${index}.txt`),
        materialProgress: false,
        ...(index === 2 ? { helpNeeded: 'Victor: rotate the provider key or confirm the current one.' } : {}),
      });
    }
    await expect(
      attempts.reopenProblem(problem.id, { actor: 'mona', reason: 'trying again without evidence' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    const reopened = await attempts.reopenProblem(problem.id, {
      actor: 'victor',
      reason: 'key rotated and the route re-probed',
      evidencePath: await evidence(folder, 'doctor-probe.txt', 'doctor --probe-api: ok'),
    });
    expect(reopened.status).toBe('open');
    expect(reopened.consecutiveNoProgress).toBe(0);
    expect(reopened.totalAttempts).toBe(3);

    const fourth = await attempts.recordAttempt({
      problemId: problem.id,
      hypothesis: 'the rotated key works',
      action: 'sent one turn',
      observedResult: 'a required test now passes',
      evidencePath: await evidence(folder, 'reopen-4.txt'),
      materialProgress: true,
      progressReason: 'a previously failing live turn now succeeds with the new route',
    });
    expect(fourth.attempt.attemptNo).toBe(4);
    expect(fourth.blockedNow).toBe(false);
  });

  it('blocks the linked task and propagates the block to dependants while independent work continues', async () => {
    const { attempts, tasks, projectId, folder } = await setup('propagate');
    const blockedTask = await makeTask(tasks, projectId, 'blocked work');
    const dependent = await makeTask(tasks, projectId, 'dependent work', [blockedTask.id]);
    const independent = await makeTask(tasks, projectId, 'independent work');
    const claimed = await tasks.claim(blockedTask.id, 'test');
    expect(claimed.task.status).toBe('running');

    const problem = await attempts.openProblem({
      projectId,
      taskId: blockedTask.id,
      requirementId: 'MONA-011',
      title: 'blocked work cannot finish',
      symptomFingerprint: 'task step fails repeatedly',
    });
    for (let index = 0; index < 3; index += 1) {
      await attempts.recordAttempt({
        problemId: problem.id,
        hypothesis: `h${index}`,
        action: `a${index}`,
        observedResult: 'same failure',
        evidencePath: await evidence(folder, `prop-${index}.txt`),
        materialProgress: false,
        ...(index === 2 ? { helpNeeded: 'Victor: supply the missing fixture.' } : {}),
      });
    }

    const task = await tasks.getTask(blockedTask.id);
    expect(task?.status).toBe('blocked');

    const board = await tasks.board(projectId);
    const entry = (id: string) => board.tasks.find((row) => row.task.id === id);
    expect(entry(blockedTask.id)?.eligibility.eligible).toBe(false);
    expect(entry(blockedTask.id)?.eligibility.blockedByProblemIds).toEqual([problem.id]);
    expect(entry(dependent.id)?.eligibility.eligible).toBe(false);
    expect(entry(dependent.id)?.eligibility.checks.find((check) => check.name === 'prerequisites')?.detail).toContain(
      problem.id,
    );
    expect(entry(independent.id)?.eligibility.eligible).toBe(true);

    const next = await tasks.nextEligible(projectId, { owner: 'mona_queue' });
    expect(next?.task.id).toBe(independent.id);
    await expect(tasks.claim(blockedTask.id, 'test')).rejects.toMatchObject({ code: 'not_eligible' });
  });

  it('states the cooperative engine instruction instead of claiming semantic enforcement', () => {
    expect(ENGINE_ATTEMPT_INSTRUCTION).toContain('Three-attempt rule');
    expect(ENGINE_ATTEMPT_INSTRUCTION).toContain('Do not make a fourth disguised attempt');
    expect(ENGINE_ATTEMPT_INSTRUCTION).toContain('does not reset the counter');
  });
});
