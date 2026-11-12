import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptService } from './attempts.js';
import { BriefingService, spendConfidence, withinWindow } from './briefing.js';
import { ChangeService } from './changes.js';
import { CostLedger } from './costs.js';
import { applyMigrations } from './migrations.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p14-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

async function setup(label: string) {
  const dir = await tempDir(label);
  let now = new Date('2026-11-12T09:00:00.000Z');
  const clock = (): Date => new Date(now);
  const advance = (iso: string): void => {
    now = new Date(iso);
  };
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite'), now: clock });
  stores.push(store);
  await applyMigrations(store.database);
  const workspace = await tempDir(`${label}-folder`);
  const registered = await store.registerProject(workspace, { label });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const tasks = new TaskService(store, { now: clock });
  const attempts = new AttemptService(store, { now: clock, tasks });
  const costs = new CostLedger(store, { now: clock });
  const changes = new ChangeService(store, { now: clock });
  const briefing = new BriefingService(store, { now: clock, tasks, attempts, costs, changes });
  return {
    store,
    workspace,
    projectId: registered.project.id,
    tasks,
    attempts,
    costs,
    changes,
    briefing,
    advance,
  };
}

async function artifact(workspace: string, name: string, body = 'ok'): Promise<string> {
  const target = path.join(workspace, 'evidence', name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, 'utf8');
  return `evidence/${name}`;
}

describe('briefing helpers', () => {
  it('labels every spend confidence without treating unknown as zero', () => {
    expect(spendConfidence({ records: 0, knownMicros: 0, unknownRecords: 0 })).toMatchObject({
      confidence: 'none',
      label: 'No usage recorded',
    });
    expect(spendConfidence({ records: 1, knownMicros: 0, unknownRecords: 1 })).toMatchObject({
      confidence: 'unknown',
    });
    expect(spendConfidence({ records: 2, knownMicros: 1_500, unknownRecords: 1 })).toMatchObject({
      confidence: 'partial',
      label: '$0.0015 + 1 unknown record(s)',
    });
    expect(spendConfidence({ records: 1, knownMicros: 2_000, unknownRecords: 0 })).toMatchObject({
      confidence: 'known',
      label: '$0.0020',
    });
  });

  it('treats the since boundary as exclusive and null as everything', () => {
    expect(withinWindow('2026-11-12T10:00:00.000Z', null)).toBe(true);
    expect(withinWindow('2026-11-12T10:00:00.000Z', '2026-11-12T10:00:00.000Z')).toBe(false);
    expect(withinWindow('2026-11-12T10:00:01.000Z', '2026-11-12T10:00:00.000Z')).toBe(true);
    expect(withinWindow(null, null)).toBe(false);
  });
});

describe('BriefingService.resumeBrief', () => {
  it('projects the recorded task, blocker, test, change and spend rows', async () => {
    const env = await setup('brief');
    const evidencePath = await artifact(env.workspace, 'check.txt', 'MONA_OK');

    const blocked = await env.tasks.createTask({
      projectId: env.projectId,
      title: 'Repair the failing worker',
      owner: 'mona_queue',
      criteria: [{ description: 'the worker test passes' }],
    });
    await env.tasks.claim(blocked.id);
    await env.tasks.blockTask(blocked.id, 'requires a decision about retention');

    const problemTask = await env.tasks.createTask({
      projectId: env.projectId,
      title: 'Retry the same import',
      owner: 'mona_queue',
      criteria: [{ description: 'the import succeeds' }],
    });
    await env.tasks.claim(problemTask.id);
    const problem = await env.attempts.openProblem({
      projectId: env.projectId,
      taskId: problemTask.id,
      requirementId: 'MONA-017',
      title: 'import fails with exit 1',
      symptomFingerprint: 'import exit 1',
      helpNeeded: 'confirm whether the import may retry after the fixture is fixed',
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await env.attempts.recordAttempt({
        problemId: problem.id,
        hypothesis: `hypothesis ${attempt}`,
        action: `action ${attempt}`,
        observedResult: 'the command still fails',
        evidencePath: await artifact(env.workspace, `attempt-${attempt}.txt`),
        materialProgress: false,
        ...(attempt === 3 ? { helpNeeded: 'confirm the fixture change' } : {}),
      });
    }

    const running = await env.tasks.createTask({
      projectId: env.projectId,
      title: 'Ship the briefing panel',
      owner: 'mona_queue',
      steps: [{ title: 'read recorded rows' }, { title: 'render the brief' }],
      criteria: [{ description: 'the brief matches the record' }],
      requirements: [{ requirementId: 'MONA-029', criterionId: 'resume-brief' }],
    });
    await env.tasks.claim(running.id);
    await env.tasks.beginStep(running.id, running.steps[0]!.id);

    env.advance('2026-11-12T09:30:00.000Z');
    await env.changes.recordTestReceipt({
      projectId: env.projectId,
      command: 'npm test',
      exitCode: 1,
      outcome: 'failed',
      output: '1 failed',
    });
    await env.costs.ingest({
      projectId: env.projectId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      turnId: 'trn_1',
      buckets: { input: 100, output: 20 },
      cost: { kind: 'provider_reported', micros: 2_500, source: 'runtime' },
      source: 'studio',
      dedupeKey: 'usage-1',
    });
    await env.costs.ingest({
      projectId: env.projectId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      turnId: 'trn_2',
      buckets: { input: 50, output: 10 },
      cost: { kind: 'unknown', reason: 'runtime omitted pricing' },
      source: 'studio',
      dedupeKey: 'usage-2',
    });

    if (gitAvailable) {
      git(env.workspace, ['init', '-b', 'main']);
      git(env.workspace, ['config', 'user.name', 'P14 Test']);
      git(env.workspace, ['config', 'user.email', 'p14@example.invalid']);
      git(env.workspace, ['config', 'commit.gpgsign', 'false']);
      git(env.workspace, ['add', '.']);
      git(env.workspace, ['commit', '-m', 'initial']);
      await writeFile(path.join(env.workspace, 'new-file.txt'), 'changed\n', 'utf8');
    }

    const brief = await env.briefing.resumeBrief(env.projectId);

    expect(brief.currentPrompt).toMatchObject({
      id: running.id,
      status: 'running',
      step: 'read recorded rows',
      requirementIds: ['MONA-029'],
    });
    expect(brief.blockers.map((blocker) => blocker.id)).toEqual(expect.arrayContaining([blocked.id, problem.id]));
    expect(brief.lastTest).toMatchObject({ outcome: 'failed', command: 'npm test' });
    expect(brief.spend).toMatchObject({ knownMicros: 2_500, unknownRecords: 1, confidence: 'partial' });
    expect(brief.progress).toMatchObject({ tasksTotal: 3, completed: 0, blocked: 2 });
    expect(brief.progress).not.toHaveProperty('percent');
    expect(brief.nextStep.text).toContain('read recorded rows');
    expect(brief.disclosure.join(' ')).toContain('no model was called');
    if (gitAvailable) {
      expect(brief.changes).toMatchObject({ count: 1, basis: 'git_status' });
    } else {
      expect(brief.changes).toMatchObject({ count: null, basis: 'none' });
    }
    expect(evidencePath).toBe('evidence/check.txt');
  });

  it('returns an honest no-change state instead of a fabricated zero', async () => {
    const env = await setup('no-change');
    const brief = await env.briefing.resumeBrief(env.projectId);
    expect(brief.currentPrompt).toBeNull();
    expect(brief.lastTest).toBeNull();
    expect(brief.spend).toMatchObject({ confidence: 'none', label: 'No usage recorded' });
    expect(brief.changes.count).toBeNull();
    expect(brief.changes.detail).toContain('unknown, not zero');
    expect(brief.nextStep.text).toContain('No eligible task');
  });
});

describe('BriefingService.sinceYouLeft', () => {
  it('groups only rows inside the window and stays deterministic', async () => {
    const env = await setup('digest');
    const task = await env.tasks.createTask({
      projectId: env.projectId,
      title: 'Finish the digest',
      owner: 'mona_queue',
      steps: [{ title: 'one step' }],
      criteria: [{ description: 'the digest is grouped' }],
    });
    await env.tasks.claim(task.id);
    await env.tasks.completeStep(task.id, task.steps[0]!.id);
    await env.tasks.recordCheck(task.id, task.criteria[0]!.id, {
      path: await artifact(env.workspace, 'digest.txt'),
      note: 'digest artifact checked',
    });
    await env.tasks.requestVerification(task.id);

    env.advance('2026-11-12T10:00:00.000Z');
    await env.tasks.completeTask(task.id, 'victor');

    env.advance('2026-11-12T10:05:00.000Z');
    await env.changes.recordTestReceipt({
      projectId: env.projectId,
      command: 'npm test',
      exitCode: 0,
      outcome: 'passed',
      output: 'all passed',
    });
    await env.costs.ingest({
      projectId: env.projectId,
      provider: 'deepseek',
      model: 'deepseek-flash',
      turnId: 'trn_digest',
      buckets: { input: 100, output: 20 },
      cost: { kind: 'provider_reported', micros: 1_000, source: 'runtime' },
      source: 'studio',
      dedupeKey: 'usage-digest',
    });

    const since = '2026-11-12T09:59:00.000Z';
    const first = await env.briefing.sinceYouLeft(env.projectId, since);
    const second = await env.briefing.sinceYouLeft(env.projectId, since);

    expect(first.counts.tasksCompleted).toBe(1);
    expect(first.counts.testsPassed).toBe(1);
    expect(first.counts.knownMicros).toBe(1_000);
    expect(first.groups.find((group) => group.id === 'completed')?.items[0]?.summary).toContain(task.id);
    expect(first.groups.find((group) => group.id === 'tests')?.items[0]?.tone).toBe('success');
    expect(first.empty).toBe(false);
    expect(second).toEqual(first);

    const later = await env.briefing.sinceYouLeft(env.projectId, '2026-11-12T11:00:00.000Z');
    expect(later.counts.tasksCompleted).toBe(0);
    expect(later.counts.testsPassed).toBe(0);
    expect(later.counts.knownMicros).toBe(0);
    expect(later.empty).toBe(true);
    expect(later.note).toContain('No summarizer');
  });
});
