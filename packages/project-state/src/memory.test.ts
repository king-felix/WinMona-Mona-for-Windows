import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrations.js';
import { DEFAULT_MEMORY_POLICY, MemoryIndex, tokenizeForSearch } from './memory.js';
import { ProjectStore } from './store.js';
import { TaskService } from './tasks.js';

const SECRET = ['sk', 'abcdefghijklmnop123456'].join('-');

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p19-memory-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup() {
  const dir = await tempDir('state');
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  const workspace = await tempDir('workspace');
  const registered = await store.registerProject(workspace, { label: 'Zephyr Lab' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  return { store, workspace, projectId: registered.project.id };
}

describe('MemoryIndex', () => {
  it('indexes permitted state deterministically and finds it by AND terms', async () => {
    const { store, workspace, projectId } = await setup();
    const tasks = new TaskService(store);
    await mkdir(path.join(workspace, 'evidence'), { recursive: true });
    await writeFile(path.join(workspace, 'evidence', 'report.txt'), 'the deterministic gate passed\n', 'utf8');
    const task = await tasks.createTask({
      projectId,
      title: 'Zephyr gate',
      description: 'Investigate the zephyr gate before release.',
      owner: 'mona_queue',
      criteria: [{ description: 'The deterministic gate passes' }],
      requirements: [{ requirementId: 'LOCAL-001' }],
    });
    await tasks.claim(task.id);
    await tasks.recordCheck(task.id, task.criteria[0]?.id as string, {
      path: 'evidence/report.txt',
      note: 'check output captured',
      passed: true,
    });
    await tasks.requestVerification(task.id);
    await tasks.completeTask(task.id, 'victor');

    await store.write((tx) => {
      tx.db
        .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
        .run(
          'dec_1',
          projectId,
          'Deploy key rotation',
          `Rotate the deploy key: api_key=${SECRET} every 30 days.`,
          '2026-11-12T10:00:00.000Z',
        );
      tx.db
        .prepare(
          `INSERT INTO attempts(id, project_id, problem_id, symptom_fingerprint, hypothesis, action, observed_result,
             material_progress, consecutive_no_progress, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
        )
        .run(
          'att_1',
          projectId,
          'p-1',
          'fp-1',
          'The zephyr stream closes early',
          'reconnect once',
          'the stream resumed',
          '2026-11-12T10:00:00.000Z',
        );
      tx.db
        .prepare(
          `INSERT INTO requirement_evidence(id, project_id, requirement_id, criterion_id, path, sha256, kind, note, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'reqev_1',
          projectId,
          'LOCAL-001',
          'gate',
          'evidence/report.txt',
          '0'.repeat(64),
          'document',
          'deterministic gate proof',
          '2026-11-12T10:00:00.000Z',
        );
    });
    await store.putTimelineItem({
      id: 'tl_1',
      projectId,
      threadId: 'thr_test',
      turnId: null,
      seq: 1,
      kind: 'assistant',
      title: 'Zephyr status',
      body: 'The zephyr run finished and the gate is green.',
      status: null,
      truncated: false,
    });

    const memory = new MemoryIndex(store);
    const before = store.storeRevision();
    const report = await memory.reindexProject(projectId);

    expect(report.documents).toBe(7);
    expect(report.byKind).toMatchObject({
      project: 1,
      decision: 1,
      task: 1,
      evidence: 1,
      requirement: 1,
      attempt: 1,
      timeline: 1,
    });
    expect(report.redacted).toBe(1);
    expect(report.timelineIncluded).toBe(1);
    // Indexing state metadata is not a user-visible change of project state.
    expect(store.storeRevision()).toBe(before);

    const hits = await memory.search(projectId, 'zephyr gate');
    expect(hits.indexed).toBe(true);
    expect(hits.terms).toEqual(['zephyr', 'gate']);
    expect(hits.hits[0]?.kind).toBe('task');
    expect(hits.hits.some((hit) => hit.kind === 'timeline')).toBe(true);

    const andMiss = await memory.search(projectId, 'zephyr xylophone');
    expect(andMiss.hits).toEqual([]);

    const deploy = await memory.search(projectId, 'deploy key');
    expect(deploy.hits[0]?.kind).toBe('decision');
    const secret = await memory.search(projectId, 'abcdefghijklmnop123456');
    expect(secret.hits).toEqual([]);
    const stored = await store.read(
      (db) =>
        db.prepare("SELECT body FROM memory_documents WHERE project_id = ? AND kind = 'decision'").get(projectId) as {
          body: string;
        },
    );
    expect(stored.body).toContain('[redacted]');
    expect(stored.body).not.toContain(SECRET);

    const stats = await memory.stats(projectId);
    expect(stats.documents).toBe(7);
    expect(stats.lastIndexedAt).toBe('2026-11-12T10:00:00.000Z');
    expect(stats.distinctTerms).toBeGreaterThan(10);
  });

  it('reports a project that was never indexed instead of inventing results', async () => {
    const { store, projectId } = await setup();
    const memory = new MemoryIndex(store);
    const result = await memory.search(projectId, 'anything');
    expect(result.indexed).toBe(false);
    expect(result.hits).toEqual([]);
    expect((await memory.stats(projectId)).documents).toBe(0);
  });

  it('honours the retention policy for history projections', async () => {
    const { store, projectId } = await setup();
    await store.putTimelineItem({
      id: 'tl_2',
      projectId,
      threadId: 'thr_test',
      turnId: null,
      seq: 2,
      kind: 'assistant',
      title: 'Quiet note',
      body: 'The xylophone plan is recorded here.',
      status: null,
      truncated: false,
    });
    const memory = new MemoryIndex(store);
    const excluded = await memory.reindexProject(projectId, {
      ...DEFAULT_MEMORY_POLICY,
      includeTimeline: false,
    });
    expect(excluded.timelineIncluded).toBe(0);
    expect((await memory.search(projectId, 'xylophone')).hits).toEqual([]);
    const included = await memory.reindexProject(projectId);
    expect(included.timelineIncluded).toBe(1);
    expect((await memory.search(projectId, 'xylophone')).hits[0]?.kind).toBe('timeline');
  });

  it('tokenizes CJK one character at a time so short queries intersect', () => {
    expect(tokenizeForSearch('项目记忆')).toEqual(['项', '目', '记', '忆']);
  });
});

describe('MemoryIndex.searchFiles', () => {
  async function fileFixture() {
    const { store, workspace, projectId } = await setup();
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(workspace, 'README.md'), '# Readme\nDeterministic search appears here.\n', 'utf8');
    await writeFile(
      path.join(workspace, 'src', 'app.ts'),
      'const note = "xylophone";\nsecond xylophone line\n',
      'utf8',
    );
    await writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'xylophone is ignored\n', 'utf8');
    await writeFile(path.join(workspace, '.env'), 'DEEPSEEK_API_KEY=xylophone-secret\n', 'utf8');
    await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x78, 0x79]));
    await writeFile(path.join(workspace, 'large.txt'), `xylophone${'a'.repeat(300 * 1024)}`, 'utf8');
    return { store, workspace, projectId };
  }

  it('searches on demand, skips ignored, secret and binary files, and writes nothing', async () => {
    const { store, projectId } = await fileFixture();
    const memory = new MemoryIndex(store);
    const before = store.storeRevision();
    const result = await memory.searchFiles(projectId, 'xylophone');
    expect(result.hits.map((hit) => hit.path)).toEqual(['src/app.ts', 'src/app.ts']);
    expect(result.hits[0]?.line).toBe(1);
    expect(result.hits[1]?.line).toBe(2);
    expect(result.skipped.secretPath).toBeGreaterThanOrEqual(1);
    expect(result.skipped.binary).toBeGreaterThanOrEqual(1);
    expect(result.skipped.oversize).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((hit) => !hit.path.includes('node_modules'))).toBe(true);
    expect(store.storeRevision()).toBe(before);

    const readme = await memory.searchFiles(projectId, 'deterministic');
    expect(readme.hits[0]).toMatchObject({ path: 'README.md', line: 2 });
    expect(readme.hits[0]?.snippet).toContain('Deterministic search');
  });

  it('refuses a one-character query and a missing project folder', async () => {
    const { store, projectId } = await fileFixture();
    const memory = new MemoryIndex(store);
    await expect(memory.searchFiles(projectId, 'x')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(memory.searchFiles('prj_missing', 'word')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('bounds results and reports truncation', async () => {
    const { store, workspace, projectId } = await setup();
    await writeFile(path.join(workspace, 'a.txt'), 'needle\nneedle\nneedle\n', 'utf8');
    await writeFile(path.join(workspace, 'b.txt'), 'needle\n', 'utf8');
    const memory = new MemoryIndex(store);
    const result = await memory.searchFiles(projectId, 'needle', { maxResults: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
