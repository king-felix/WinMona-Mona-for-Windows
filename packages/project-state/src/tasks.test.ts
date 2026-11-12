import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportProject, importProject, digestOfExport } from './export.js';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';
import { TaskService, type WorkTask } from './tasks.js';
import { StateError } from './errors.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p10-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string): Promise<{ store: ProjectStore; service: TaskService; dir: string }> {
  const dir = await tempDir(label);
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T12:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  const service = new TaskService(store, { now: () => new Date('2026-11-12T12:00:00.000Z') });
  return { store, service, dir };
}

async function project(store: ProjectStore, label: string): Promise<{ id: string; path: string }> {
  const folder = await tempDir(`${label}-folder`);
  const outcome = await store.registerProject(folder, { label });
  if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
  return { id: outcome.project.id, path: outcome.project.canonicalPath };
}

async function simpleTask(
  service: TaskService,
  projectId: string,
  input: {
    title?: string;
    ordinal?: number;
    dependsOn?: string[];
    owner?: 'mona_queue' | 'native_workflow';
    criteria?: Array<{ description: string; kind?: 'check' | 'human'; required?: boolean }>;
    steps?: Array<{ title: string }>;
    promptText?: string;
  } = {},
): Promise<WorkTask> {
  return await service.createTask({
    projectId,
    title: input.title ?? 'bounded task',
    owner: input.owner ?? 'mona_queue',
    criteria: input.criteria ?? [{ description: 'the check passes' }],
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
    ...(input.steps === undefined ? {} : { steps: input.steps }),
    ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
  });
}

async function writeEvidence(folder: string, name: string, content: string): Promise<string> {
  const file = path.join(folder, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return name;
}

function shaOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function finishCheckTask(service: TaskService, task: WorkTask, file: string): Promise<WorkTask> {
  const criterion = task.criteria[0];
  if (!criterion) throw new Error('task has no criterion');
  await service.claim(task.id);
  await service.recordCheck(task.id, criterion.id, { path: file, kind: 'test', note: 'fixture check' });
  await service.requestVerification(task.id);
  await service.completeTask(task.id);
  const done = await service.getTask(task.id);
  if (!done) throw new Error('missing task');
  return done;
}

describe('task dependencies and deterministic eligibility', () => {
  it('rejects dependency cycles, self-links and cross-workspace links without losing prior edges', async () => {
    const { store, service } = await setup('cycles');
    const alpha = await project(store, 'alpha');
    const beta = await project(store, 'beta');

    const a = await simpleTask(service, alpha.id, { title: 'A' });
    const b = await simpleTask(service, alpha.id, { title: 'B' });
    const foreign = await simpleTask(service, beta.id, { title: 'foreign' });

    await service.addDependency(b.id, a.id);
    const cycle = await service.addDependency(a.id, b.id).catch((error: unknown) => error);
    expect(cycle).toBeInstanceOf(StateError);
    expect((cycle as StateError).code).toBe('dependency_cycle');

    const self = await service.addDependency(a.id, a.id).catch((error: unknown) => error);
    expect((self as StateError).code).toBe('dependency_cycle');

    const cross = await service.addDependency(a.id, foreign.id).catch((error: unknown) => error);
    expect((cross as StateError).code).toBe('invalid_request');
    expect((cross as StateError).message).toContain('another workspace');

    const after = await service.getTask(a.id);
    expect(after?.dependencies).toEqual([]);
    expect((await service.getTask(b.id))?.dependencies).toEqual([a.id]);
  });

  it('keeps a blocked prompt from starting until its prerequisite is verified', async () => {
    const { store, service } = await setup('deps');
    const alpha = await project(store, 'alpha');
    const first = await simpleTask(service, alpha.id, { title: 'first' });
    const second = await simpleTask(service, alpha.id, { title: 'second', dependsOn: [first.id] });

    const selection = await service.nextEligible(alpha.id);
    expect(selection?.task.id).toBe(first.id);
    const secondEntry = (await service.board(alpha.id)).tasks.find((entry) => entry.task.id === second.id);
    expect(secondEntry?.eligibility.eligible).toBe(false);
    expect(secondEntry?.eligibility.reason).toContain('waiting on');

    const refused = await service.claim(second.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateError);
    expect((refused as StateError).code).toBe('not_eligible');

    const file = await writeEvidence(alpha.path, 'check.txt', 'verified');
    await finishCheckTask(service, first, file);
    expect((await service.nextEligible(alpha.id))?.task.id).toBe(second.id);
  });

  it('does not change an independent task status when work runs out of order', async () => {
    const { store, service } = await setup('order');
    const alpha = await project(store, 'alpha');
    const a = await simpleTask(service, alpha.id, { title: 'A', ordinal: 1 });
    const b = await simpleTask(service, alpha.id, { title: 'B', ordinal: 2 });
    const file = await writeEvidence(alpha.path, 'b.txt', 'b');

    await service.claim(b.id);
    await service.recordCheck(b.id, b.criteria[0]!.id, { path: file });
    await service.requestVerification(b.id);
    await service.completeTask(b.id);
    expect((await service.getTask(a.id))?.status).toBe('pending');
    expect((await service.nextEligible(alpha.id))?.task.id).toBe(a.id);

    await service.claim(a.id);
    await service.interruptTask(a.id, 'window closed');
    const c = await simpleTask(service, alpha.id, { title: 'C', ordinal: 0 });
    expect(c.status).toBe('pending');
    // Interrupted work resumes before a newly added, lower-ordinal task.
    expect((await service.nextEligible(alpha.id))?.task.id).toBe(a.id);
  });

  it('allows one active task per workspace but one per workspace across two workspaces', async () => {
    const { store, service } = await setup('owners');
    const alpha = await project(store, 'alpha');
    const beta = await project(store, 'beta');
    const a = await simpleTask(service, alpha.id, { title: 'A' });
    const b = await simpleTask(service, alpha.id, { title: 'B' });
    const foreign = await simpleTask(service, beta.id, { title: 'C' });

    await service.claim(a.id);
    const second = await service.claim(b.id).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(StateError);
    expect((second as StateError).code).toBe('not_eligible');
    expect((second as StateError).message).toContain('one mutating run per workspace');

    const other = await service.claim(foreign.id);
    expect(other.task.status).toBe('running');
  });

  it('never lets Mona schedule a native-owned task', async () => {
    const { store, service } = await setup('native');
    const alpha = await project(store, 'alpha');
    const native = await simpleTask(service, alpha.id, { title: 'native', owner: 'native_workflow' });

    expect(await service.nextEligible(alpha.id)).toBeNull();
    expect(await service.nextEligible(alpha.id, { owner: 'native_workflow' })).not.toBeNull();
    const refused = await service.claim(native.id).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('not_eligible');
    expect((refused as StateError).message).toContain('native_workflow');
  });
});

describe('task state machine and evidence-gated completion', () => {
  it('refuses completion until every required check and human item is satisfied', async () => {
    const { store, service } = await setup('gate');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, {
      criteria: [
        { description: 'a check artifact exists', kind: 'check' },
        { description: 'Victor reviewed the result', kind: 'human' },
      ],
    });
    const check = task.criteria[0]!;
    const human = task.criteria[1]!;
    const file = await writeEvidence(alpha.path, 'result.txt', 'ok');

    await service.claim(task.id);
    const wrongKind = await service
      .acceptHuman(task.id, check.id, { actor: 'victor', note: 'looks fine' })
      .catch((error: unknown) => error);
    expect((wrongKind as StateError).code).toBe('invalid_request');

    await service.recordCheck(task.id, check.id, { path: file, kind: 'test' });
    await service.requestVerification(task.id);
    const blocked = await service.completeTask(task.id).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(StateError);
    expect((blocked as StateError).code).toBe('criteria_unsatisfied');
    expect((blocked as StateError).detail).toContain('human-only');

    await service.acceptHuman(task.id, human.id, { actor: 'victor', note: 'reviewed the artifact' });
    const report = await service.completeTask(task.id);
    expect(report.completed).toBe(true);
    expect((await service.getTask(task.id))?.status).toBe('completed');
  });

  it('records a failing check without satisfying the criterion and reopens verification', async () => {
    const { store, service } = await setup('failing');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, { criteria: [{ description: 'tests pass' }] });
    const criterion = task.criteria[0]!;
    const file = await writeEvidence(alpha.path, 'test.log', '1 failed');

    await service.claim(task.id);
    await service.requestVerification(task.id);
    await service.recordCheck(task.id, criterion.id, { path: file, kind: 'test', passed: false });
    const after = await service.getTask(task.id);
    expect(after?.status).toBe('running');
    expect(after?.criteria[0]?.satisfiedAt).toBeNull();
    expect(after?.evidence[0]?.kind).toBe('test');

    const refused = await service.completeTask(task.id).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('invalid_request');
  });

  it('rejects an evidence hash that does not match the artifact', async () => {
    const { store, service } = await setup('hash');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id);
    const criterion = task.criteria[0]!;
    const file = await writeEvidence(alpha.path, 'artifact.txt', 'actual');

    await service.claim(task.id);
    const mismatch = await service
      .recordCheck(task.id, criterion.id, { path: file, sha256: 'f'.repeat(64) })
      .catch((error: unknown) => error);
    expect((mismatch as StateError).code).toBe('evidence_mismatch');
    expect((await service.getTask(task.id))?.evidence).toHaveLength(0);

    await service.recordCheck(task.id, criterion.id, { path: file, sha256: shaOf('actual') });
    expect((await service.getTask(task.id))?.criteria[0]?.satisfiedAt).not.toBeNull();
  });

  it('cannot complete a task that never configured acceptance criteria', async () => {
    const { store, service } = await setup('empty-criteria');
    const alpha = await project(store, 'alpha');
    const task = await service.createTask({
      projectId: alpha.id,
      title: 'no criteria',
      owner: 'mona_queue',
    });
    await service.claim(task.id);
    await service.requestVerification(task.id);
    const refused = await service.completeTask(task.id).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('criteria_unsatisfied');
    expect((refused as StateError).detail).toContain('no acceptance criteria');
  });

  it('makes a completed task stale when its evidence artifact changes', async () => {
    const { store, service } = await setup('stale');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id);
    const file = await writeEvidence(alpha.path, 'evidence.txt', 'first');
    await finishCheckTask(service, task, file);
    expect((await service.getTask(task.id))?.status).toBe('completed');

    const unchanged = await service.revalidate(alpha.id, [{ path: file }]);
    expect(unchanged.invalidated).toHaveLength(0);

    await writeFile(path.join(alpha.path, file), 'second', 'utf8');
    const stale = await service.revalidate(alpha.id, [{ path: file }]);
    expect(stale.invalidated).toHaveLength(1);
    expect(stale.reopened).toEqual([task.id]);
    const reopened = await service.getTask(task.id);
    expect(reopened?.status).toBe('verifying');
    expect(reopened?.evidence[0]?.stale).toBe(true);

    const refused = await service.completeTask(task.id).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('criteria_unsatisfied');
    expect((refused as StateError).detail).toContain('stale');

    await service.recordCheck(task.id, reopened!.criteria[0]!.id, { path: file });
    await service.completeTask(task.id);
    expect((await service.getTask(task.id))?.status).toBe('completed');
  });

  it('re-hashes linked evidence at completion even without an explicit revalidate', async () => {
    const { store, service } = await setup('stale-at-completion');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id);
    const file = await writeEvidence(alpha.path, 'late.txt', 'first');

    await service.claim(task.id);
    await service.recordCheck(task.id, task.criteria[0]!.id, { path: file });
    await service.requestVerification(task.id);
    await writeFile(path.join(alpha.path, file), 'changed after the check', 'utf8');

    const refused = await service.completeTask(task.id).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('criteria_unsatisfied');
    const after = await service.getTask(task.id);
    expect(after?.status).toBe('verifying');
    expect(after?.evidence[0]?.stale).toBe(true);
    expect(after?.evidence[0]?.staleReason).toContain('changed');

    await service.recordCheck(task.id, task.criteria[0]!.id, { path: file });
    await service.completeTask(task.id);
    expect((await service.getTask(task.id))?.status).toBe('completed');
  });

  it('blocks and unblocks only with recorded material', async () => {
    const { store, service } = await setup('blocked');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id);
    await service.claim(task.id);
    await service.blockTask(task.id, 'three no-progress attempts');
    expect((await service.nextEligible(alpha.id))?.task.id).toBeUndefined();

    const weak = await service
      .unblockTask(task.id, { reason: 'try again', actor: 'victor' })
      .catch((error: unknown) => error);
    expect((weak as StateError).code).toBe('invalid_request');

    const unblocked = await service.unblockTask(task.id, {
      reason: 'new evidence shows the DNS failure was transient',
      actor: 'victor',
    });
    expect(unblocked.status).toBe('running');
  });

  it('skips only with an explicit recorded decision', async () => {
    const { store, service } = await setup('skip');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id);
    const skipped = await service.skipTask(task.id, {
      decision: 'Victor deferred this scope to a later milestone',
      actor: 'victor',
    });
    expect(skipped.status).toBe('skipped');
    expect(skipped.skippedReason).toContain('deferred');
    expect(await service.nextEligible(alpha.id)).toBeNull();
  });
});

describe('resume, reconciliation and queue boundaries', () => {
  it('resumes an interrupted task at its recorded step', async () => {
    const { store, service } = await setup('resume');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, {
      steps: [{ title: 'gather inputs' }, { title: 'write output' }, { title: 'review output' }],
    });
    const claim = await service.claim(task.id);
    const step1 = claim.task.steps[0]!;
    const step2 = claim.task.steps[1]!;
    const step3 = claim.task.steps[2]!;

    await service.completeStep(task.id, step1.id);
    const interrupted = await service.interruptTask(task.id, 'window closed');
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.currentStep).toBe(step2.id);

    const resumed = await service.resumeTask(task.id, 'victor');
    expect(resumed.status).toBe('running');
    expect(resumed.currentStep).toBe(step2.id);
    expect(resumed.steps.find((step) => step.id === step2.id)?.status).toBe('running');

    await service.completeStep(task.id, step2.id);
    await service.completeStep(task.id, step3.id);
    const file = await writeEvidence(alpha.path, 'resume.txt', 'done');
    await service.recordCheck(task.id, task.criteria[0]!.id, { path: file });
    await service.requestVerification(task.id);
    await service.completeTask(task.id);
    expect((await service.getTask(task.id))?.status).toBe('completed');
  });

  it('reconciles an active task with no live run to interrupted and keeps its step', async () => {
    const { store, service } = await setup('reconcile');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, { steps: [{ title: 'one' }, { title: 'two' }] });
    const claim = await service.claim(task.id);
    const step1 = claim.task.steps[0]!;

    const receipts = await service.reconcile(alpha.id, []);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.taskId).toBe(task.id);
    expect(receipts[0]?.step).toBe(step1.id);
    const after = await service.getTask(task.id);
    expect(after?.status).toBe('interrupted');
    expect(after?.currentStep).toBe(step1.id);

    const resumed = await service.resumeTask(task.id, 'victor');
    expect(resumed.status).toBe('running');
    expect(resumed.currentStep).toBe(step1.id);
  });

  it('runs exactly one selected task and then stops', async () => {
    const { store, service } = await setup('queue');
    const alpha = await project(store, 'alpha');
    const first = await simpleTask(service, alpha.id, { title: 'first', ordinal: 1 });
    const second = await simpleTask(service, alpha.id, { title: 'second', ordinal: 2 });
    await writeEvidence(alpha.path, 'first.txt', 'first');
    await writeEvidence(alpha.path, 'second.txt', 'second');

    const runReturn = async (control: {
      taskId: string;
      recordCheck: (id: string, input: { path: string }) => Promise<void>;
    }) => {
      const task = await service.getTask(control.taskId);
      const criterion = task?.criteria[0];
      if (!criterion) throw new Error('missing criterion');
      await control.recordCheck(criterion.id, { path: `${task?.title}.txt` });
    };

    const one = await service.runOnce(alpha.id, runReturn);
    expect(one.ran).toBe(true);
    expect(one.taskId).toBe(first.id);
    expect(one.status).toBe('completed');
    expect((await service.getTask(second.id))?.status).toBe('pending');

    const two = await service.runOnce(alpha.id, runReturn);
    expect(two.ran).toBe(true);
    expect(two.taskId).toBe(second.id);

    const three = await service.runOnce(alpha.id, runReturn);
    expect(three.ran).toBe(false);
    expect(three.reason).toContain('no eligible');
  });

  it('interrupts rather than completes when the executor throws or leaves steps unfinished', async () => {
    const { store, service } = await setup('queue-failure');
    const alpha = await project(store, 'alpha');
    const throwing = await simpleTask(service, alpha.id, { title: 'throws', ordinal: 1 });
    const unfinished = await simpleTask(service, alpha.id, {
      title: 'unfinished',
      ordinal: 2,
      steps: [{ title: 'one' }, { title: 'two' }],
    });

    const failed = await service.runOnce(alpha.id, () => {
      throw new Error('runtime vanished');
    });
    expect(failed.taskId).toBe(throwing.id);
    expect(failed.status).toBe('interrupted');
    expect(failed.error).toContain('runtime vanished');
    expect((await service.getTask(throwing.id))?.status).toBe('interrupted');
    await service.skipTask(throwing.id, { decision: 'Victor skipped after the runtime vanished', actor: 'victor' });

    const partial = await service.runOnce(alpha.id, async (control) => {
      const task = await service.getTask(control.taskId);
      await control.beginStep(task!.steps[0]!.id);
      await control.completeStep(task!.steps[0]!.id);
    });
    expect(partial.taskId).toBe(unfinished.id);
    expect(partial.status).toBe('interrupted');
    expect((await service.getTask(unfinished.id))?.currentStep).toBe(unfinished.steps[1]?.id);
  });
});

describe('context preview, handoff and imports', () => {
  it('previews exactly the prompt that dispatch will submit and injects no documents', async () => {
    const { store, service } = await setup('preview');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, {
      title: 'bounded prompt',
      promptText: 'Implement the bounded behavior described here.',
      steps: [{ title: 'inspect' }, { title: 'implement' }],
    });
    const preview = await service.previewContext(task.id);
    expect(preview.documentsInjected).toBe(0);
    expect(preview.text).toContain('Implement the bounded behavior described here.');
    expect(preview.text).not.toContain('Mona_Project.md');
    expect(preview.notes.join(' ')).toContain('never injected');

    const claim = await service.claim(task.id);
    expect(claim.prompt.text).toBe(preview.text);
    expect(claim.prompt.sha256).toBe(preview.sha256);
    expect(claim.prompt.characters).toBe(preview.characters);
  });

  it('refuses an oversized prompt at claim time instead of truncating silently', async () => {
    const { store, service } = await setup('oversize');
    const alpha = await project(store, 'alpha');
    const task = await service.createTask({
      projectId: alpha.id,
      title: 'large',
      owner: 'mona_queue',
      promptText: 'x'.repeat(25_000),
      criteria: [{ description: 'done' }],
    });
    const preview = await service.previewContext(task.id);
    expect(preview.characters).toBeGreaterThan(24_000);
    expect(preview.notes.join(' ')).toContain('dispatch limit');

    const refused = await service.claim(task.id).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('oversize');
    expect((await service.getTask(task.id))?.status).toBe('pending');
  });

  it('generates a concise handoff from recorded state', async () => {
    const { store, service } = await setup('handoff');
    const alpha = await project(store, 'alpha');
    const active = await simpleTask(service, alpha.id, {
      title: 'finish continuity',
      steps: [{ title: 'write state' }, { title: 'verify resume' }],
    });
    const blocked = await simpleTask(service, alpha.id, { title: 'blocked work', ordinal: 2 });
    const claim = await service.claim(active.id);
    await service.completeStep(active.id, claim.task.steps[0]!.id);
    await service.interruptTask(active.id, 'session ended');
    await service.claim(blocked.id);
    await service.blockTask(blocked.id, 'three no-progress attempts');

    const text = await service.handoff(alpha.id);
    expect(text).toContain('# alpha — handoff');
    expect(text).toContain('finish continuity');
    expect(text).toContain('Resume at: verify resume');
    expect(text).toContain('## Open blockers');
    expect(text).toContain('Workspace:');
    expect(text).not.toContain('Mona_Project.md');

    const file = path.join(alpha.path, '.mona', 'project', 'HANDOFF.md');
    const written = await service.writeHandoff(alpha.id, file);
    expect(written.bytes).toBeGreaterThan(0);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('imports a prompt pack as inert pending tasks only when apply is explicit', async () => {
    const { store, service } = await setup('plan');
    const alpha = await project(store, 'alpha');
    const plan = {
      schema_version: 1 as const,
      kind: 'mona.task-plan' as const,
      project_id: alpha.id,
      name: 'bounded plan',
      tasks: [
        {
          id: 'plan-first',
          title: 'first plan task',
          prompt_text: 'Do the first bounded thing.',
          owner: 'mona_queue' as const,
          acceptance: [
            { description: 'first artifact exists', kind: 'check' as const },
            { description: 'Victor reviewed it', kind: 'human' as const },
          ],
          requirements: [{ requirement_id: 'MONA-009', criterion_id: 'prompt-catalog' }],
        },
        {
          id: 'plan-second',
          title: 'second plan task',
          owner: 'mona_queue' as const,
          depends_on: ['plan-first'],
          acceptance: [{ description: 'second artifact exists' }],
        },
      ],
    };

    const preview = await service.importPlan(plan);
    expect(preview.applied).toBe(false);
    expect(await service.listTasks(alpha.id)).toHaveLength(0);

    const applied = await service.importPlan(plan, { apply: true });
    expect(applied.applied).toBe(true);
    const imported = await service.listTasks(alpha.id);
    expect(imported.map((task) => task.status)).toEqual(['pending', 'pending']);
    expect(imported[0]?.claimedAt).toBeNull();
    expect(imported[0]?.criteria).toHaveLength(2);
    expect(imported[0]?.requirements).toEqual([{ requirementId: 'MONA-009', criterionId: 'prompt-catalog' }]);
    expect(imported[1]?.dependencies).toEqual(['plan-first']);
    expect((await service.nextEligible(alpha.id))?.task.id).toBe('plan-first');

    const again = await service.importPlan(plan, { apply: true }).catch((error: unknown) => error);
    expect((again as StateError).code).toBe('conflict');
  });

  it('rejects a cyclic plan before writing anything', async () => {
    const { store, service } = await setup('plan-cycle');
    const alpha = await project(store, 'alpha');
    const plan = {
      schema_version: 1 as const,
      kind: 'mona.task-plan' as const,
      project_id: alpha.id,
      tasks: [
        { id: 'one', title: 'one', owner: 'mona_queue', depends_on: ['two'], acceptance: [{ description: 'ok' }] },
        { id: 'two', title: 'two', owner: 'mona_queue', depends_on: ['one'], acceptance: [{ description: 'ok' }] },
      ],
    };
    const refused = await service.importPlan(plan, { apply: true }).catch((error: unknown) => error);
    expect((refused as StateError).code).toBe('dependency_cycle');
    expect(await service.listTasks(alpha.id)).toHaveLength(0);
  });
});

describe('project export and import carry task provenance', () => {
  it('round-trips user-authored criteria, requirements and completed evidence', async () => {
    const { store, service, dir } = await setup('export-tasks');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, {
      title: 'portable task',
      promptText: 'Portable prompt text.',
      criteria: [
        { description: 'artifact exists', kind: 'check' },
        { description: 'human reviewed', kind: 'human' },
      ],
    });
    await service.updateTask(task.id, {
      requirements: [{ requirementId: 'MONA-010', criterionId: 'handoff' }],
      steps: [{ title: 'write' }, { title: 'verify' }],
    });
    const file = await writeEvidence(alpha.path, 'portable.txt', 'portable');
    const fresh = (await service.getTask(task.id))!;
    await service.claim(task.id);
    await service.completeStep(task.id, fresh.steps[0]!.id);
    await service.completeStep(task.id, fresh.steps[1]!.id);
    await service.recordCheck(task.id, fresh.criteria[0]!.id, { path: file, kind: 'test' });
    await service.requestVerification(task.id);
    await service.acceptHuman(task.id, fresh.criteria[1]!.id, { actor: 'victor', note: 'reviewed' });
    await service.completeTask(task.id);

    const exportFile = path.join(dir, 'project.json');
    await exportProject(store, alpha.id, exportFile);
    const document = JSON.parse(await readFile(exportFile, 'utf8')) as {
      schema_version: number;
      tasks: Array<{ id: string; acceptance?: unknown[]; requirements?: unknown[]; evidence?: unknown[] }>;
    };
    expect(document.schema_version).toBe(2);
    expect(document.tasks[0]?.acceptance).toHaveLength(2);
    expect(document.tasks[0]?.requirements).toHaveLength(1);
    expect(document.tasks[0]?.evidence).toHaveLength(1);

    const other = await setup('import-tasks');
    await importProject(other.store, exportFile);
    const imported = await other.service.getTask(task.id);
    expect(imported?.status).toBe('completed');
    expect(imported?.promptText).toBe('Portable prompt text.');
    expect(imported?.criteria).toHaveLength(2);
    expect(imported?.requirements).toEqual([{ requirementId: 'MONA-010', criterionId: 'handoff' }]);
    expect(imported?.evidence).toHaveLength(1);
    expect(imported?.steps.map((step) => step.status)).toEqual(['done', 'done']);

    const markdown = await other.service.handoff(alpha.id);
    expect(markdown).toContain('portable task');
    expect(markdown).toContain('Verified work');
  });

  it('refuses a digest-valid export that claims completion without satisfied criteria', async () => {
    const { store, service, dir } = await setup('forged-export');
    const alpha = await project(store, 'alpha');
    const task = await simpleTask(service, alpha.id, { title: 'completed claim' });
    const file = await writeEvidence(alpha.path, 'claim.txt', 'claim');
    await finishCheckTask(service, task, file);

    const exportFile = path.join(dir, 'project.json');
    await exportProject(store, alpha.id, exportFile);
    const document = JSON.parse(await readFile(exportFile, 'utf8')) as {
      digest: string;
      tasks: Array<{ acceptance: Array<{ satisfied_at: string | null }> }>;
    };
    document.tasks[0]!.acceptance[0]!.satisfied_at = null;
    const body = { ...document } as Record<string, unknown>;
    delete body.digest;
    document.digest = digestOfExport(body as never);
    await writeFile(exportFile, JSON.stringify(document), 'utf8');

    const other = await setup('forged-import');
    const refused = await importProject(other.store, exportFile).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateError);
    expect((refused as StateError).code).toBe('criteria_unsatisfied');
    expect(await other.store.listProjects()).toHaveLength(0);
  });
});
