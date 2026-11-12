import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeRelativePath,
  digestOfPortable,
  exportPortable,
  extractPortableFiles,
  importPortable,
  parsePortableBundle,
  type PortableBundle,
} from './handoff.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p19-handoff-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function openStore(label: string): Promise<ProjectStore> {
  const dir = await tempDir(label);
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  return store;
}

async function setupProject(label: string) {
  const store = await openStore(label);
  const workspace = await tempDir(`${label}-workspace`);
  const registered = await store.registerProject(workspace, { label: 'Portable Lab' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;
  const tasks = new TaskService(store);
  const proof = 'proof of completion\n';
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'docs', 'proof.txt'), proof, 'utf8');

  const first = await tasks.createTask({
    projectId,
    title: 'Record the proof',
    description: 'Write the proof artifact and record it as evidence.',
    promptText: 'Create docs/proof.txt and record it.',
    owner: 'mona_queue',
    ordinal: 1,
    criteria: [{ description: 'The proof artifact exists' }],
    requirements: [{ requirementId: 'MONA-099', criterionId: 'proof' }],
  });
  const second = await tasks.createTask({
    projectId,
    title: 'Verify the proof',
    description: 'Read the proof after the first task completes.',
    owner: 'mona_queue',
    ordinal: 2,
    dependsOn: [first.id],
  });
  await tasks.claim(first.id);
  await tasks.recordCheck(first.id, first.criteria[0]?.id as string, {
    path: 'docs/proof.txt',
    kind: 'document',
    note: 'artifact recorded',
    passed: true,
  });
  await tasks.requestVerification(first.id);
  await tasks.completeTask(first.id, 'victor');

  const digest = createHash('sha256').update(proof, 'utf8').digest('hex');
  await store.write((tx) => {
    tx.db
      .prepare('INSERT INTO decisions(id, project_id, title, body, decided_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        'dec_portable',
        projectId,
        'Keep handoffs redacted',
        'No credentials travel in a bundle.',
        '2026-11-12T10:00:00.000Z',
      );
    tx.db
      .prepare(
        `INSERT INTO requirement_evidence(id, project_id, requirement_id, criterion_id, path, sha256, kind, note, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'reqev_portable',
        projectId,
        'MONA-099',
        'proof',
        'docs/proof.txt',
        digest,
        'document',
        'proof artifact',
        '2026-11-12T10:00:00.000Z',
      );
  });

  return { store, workspace, projectId, tasks, firstId: first.id, secondId: second.id };
}

async function importIntoCleanStore(bundleFile: string, options: { writeProof?: boolean } = {}) {
  const store = await openStore('clean');
  const workspace = await tempDir('clean-workspace');
  if (options.writeProof !== false) {
    await mkdir(path.join(workspace, 'docs'), { recursive: true });
    await writeFile(path.join(workspace, 'docs', 'proof.txt'), 'proof of completion\n', 'utf8');
  }
  const report = await importPortable(store, bundleFile, { targetFolder: workspace });
  return { store, workspace, report };
}

describe('portable handoff export', () => {
  it('carries state, decisions and evidence pointers without machine-local bindings', async () => {
    const { store, workspace, projectId, firstId, secondId } = await setupProject('export');
    const file = path.join(await tempDir('out'), 'handoff.json');
    const bundle = await exportPortable(store, projectId, { file });

    expect(bundle.kind).toBe('mona.handoff');
    expect(bundle.project).not.toHaveProperty('canonical_path');
    expect(bundle.tasks).toHaveLength(2);
    expect(bundle.tasks.map((task) => task.id)).toEqual([firstId, secondId]);
    expect(bundle.dependencies).toEqual([{ taskId: secondId, dependsOn: firstId }]);
    expect(bundle.decisions[0]?.id).toBe('dec_portable');
    expect(bundle.requirementEvidence[0]?.path).toBe('docs/proof.txt');
    expect(bundle.files).toEqual([]);
    expect(bundle.notTransferred.join(' ')).toContain('Engine-owned thread');
    expect(bundle.resume.nextTaskId).toBe(secondId);
    expect(bundle.resume.counts).toMatchObject({ tasks: 2, completed: 1 });
    expect(bundle.resume.spend.confidence).toBe('none');

    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(workspace);
    expect(text).not.toMatch(/"endpoint"|"pid"|"token_sha256"|"engine_thread_id"/);
    const { digest, ...body } = bundle;
    expect(digestOfPortable(body)).toBe(digest);
  });

  it('includes only explicitly selected files and refuses credential-shaped ones', async () => {
    const { store, projectId } = await setupProject('files');
    const out = await tempDir('files-out');
    const bundle = await exportPortable(store, projectId, {
      file: path.join(out, 'with-files.json'),
      includeFiles: ['docs/proof.txt'],
    });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]).toMatchObject({ path: 'docs/proof.txt', encoding: 'utf8' });
    expect(bundle.files[0]?.content).toBe('proof of completion\n');
    await writeFile(
      path.join((await store.getProject(projectId))?.canonicalPath as string, '.env'),
      'TOKEN=abc\n',
      'utf8',
    );
    await expect(
      exportPortable(store, projectId, { file: path.join(out, 'bad.json'), includeFiles: ['.env'] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      exportPortable(store, projectId, { file: path.join(out, 'traversal.json'), includeFiles: ['../outside.txt'] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('portable handoff import', () => {
  it('requalifies a folder and reconstructs pointers without executing anything', async () => {
    const { store, projectId, firstId, secondId } = await setupProject('roundtrip');
    const file = path.join(await tempDir('roundtrip-out'), 'handoff.json');
    const bundle = await exportPortable(store, projectId, { file });
    const { store: clean, workspace, report } = await importIntoCleanStore(file);

    expect(report.kind).toBe('mona.handoff');
    expect(report.tasksImported).toBe(2);
    expect(report.decisionsImported).toBe(1);
    expect(report.missingFiles).toEqual([]);
    expect(report.staleEvidence).toEqual([]);
    expect(report.reopenedTasks).toEqual([]);
    expect(report.requalified).toBe(true);
    expect(report.targetFolder.toLowerCase()).toBe(workspace.toLowerCase());
    expect(report.autoExecuted).toBe(false);
    expect(report.filesExtracted).toBe(0);
    expect(report.projectId).not.toBe(projectId);

    const imported = await clean.getProject(report.projectId);
    expect(imported?.canonicalPath.toLowerCase()).toBe(workspace.toLowerCase());
    const tasks = new TaskService(clean);
    const list = await tasks.listTasks(report.projectId);
    expect(list.map((task) => [task.id, task.status])).toEqual([
      [firstId, 'completed'],
      [secondId, 'pending'],
    ]);
    expect(list[0]?.criteria[0]?.satisfiedAt).not.toBeNull();
    expect(list[0]?.requirements[0]?.requirementId).toBe('MONA-099');
    expect(await clean.getRuntimeBinding(report.projectId)).toBeNull();
    const evidence = await clean.read(
      (db) =>
        db.prepare('SELECT stale, path FROM task_evidence WHERE task_id = ?').get(firstId) as {
          stale: number;
          path: string;
        },
    );
    expect(evidence).toMatchObject({ stale: 0, path: 'docs/proof.txt' });
    expect(bundle.tasks[0]?.status).toBe('completed');
  });

  it('identifies missing evidence and refuses to carry completion over', async () => {
    const { store, projectId, firstId } = await setupProject('missing');
    const file = path.join(await tempDir('missing-out'), 'handoff.json');
    await exportPortable(store, projectId, { file });
    const { store: clean, report } = await importIntoCleanStore(file, { writeProof: false });

    expect(report.missingFiles).toEqual(['docs/proof.txt']);
    expect(report.staleEvidence[0]).toMatchObject({ taskId: firstId, path: 'docs/proof.txt' });
    expect(report.reopenedTasks[0]?.taskId).toBe(firstId);
    const row = await clean.read(
      (db) =>
        db
          .prepare(
            'SELECT t.status AS status, e.stale AS stale FROM tasks t JOIN task_evidence e ON e.task_id = t.id WHERE t.id = ?',
          )
          .get(firstId) as { status: string; stale: number },
    );
    expect(row).toEqual({ status: 'verifying', stale: 1 });
  });

  it('identifies a changed artifact digest', async () => {
    const { store, projectId } = await setupProject('changed');
    const file = path.join(await tempDir('changed-out'), 'handoff.json');
    await exportPortable(store, projectId, { file });
    const clean = await openStore('changed-clean');
    const workspace = await tempDir('changed-workspace');
    await mkdir(path.join(workspace, 'docs'), { recursive: true });
    await writeFile(path.join(workspace, 'docs', 'proof.txt'), 'different content\n', 'utf8');
    const report = await importPortable(clean, file, { targetFolder: workspace });
    expect(report.missingFiles).toEqual([]);
    expect(report.staleEvidence[0]?.reason).toMatch(/changed/);
    expect(report.reopenedTasks).toHaveLength(1);
  });

  it('refuses a tampered bundle, a missing folder and a non-empty target', async () => {
    const { store, projectId } = await setupProject('refusals');
    const out = await tempDir('refusals-out');
    const file = path.join(out, 'handoff.json');
    await exportPortable(store, projectId, { file });
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PortableBundle;
    const tampered = { ...parsed, project: { ...parsed.project, label: 'Changed' } };
    const tamperedFile = path.join(out, 'tampered.json');
    await writeFile(tamperedFile, JSON.stringify(tampered), 'utf8');
    const clean = await openStore('refusals-clean');
    const workspace = await tempDir('refusals-workspace');
    await expect(importPortable(clean, tamperedFile, { targetFolder: workspace })).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
    await expect(importPortable(clean, file, { targetFolder: path.join(workspace, 'missing') })).rejects.toMatchObject({
      code: 'not_found',
    });

    await importPortable(clean, file, { targetFolder: workspace });
    await expect(importPortable(clean, file, { targetFolder: workspace })).rejects.toMatchObject({ code: 'conflict' });
    const replaced = await importPortable(clean, file, { targetFolder: workspace, replaceExisting: true });
    expect(replaced.tasksImported).toBe(2);
  });

  it('exports a concise resume packet that re-imports the same pointers', async () => {
    const { store, projectId, firstId } = await setupProject('resume');
    const file = path.join(await tempDir('resume-out'), 'resume.json');
    const bundle = await exportPortable(store, projectId, {
      file,
      kind: 'mona.resume-packet',
      includeFiles: ['docs/proof.txt'],
    });
    expect(bundle.kind).toBe('mona.resume-packet');
    expect(bundle.files).toEqual([]);
    const { store: clean, report } = await importIntoCleanStore(file);
    expect(report.kind).toBe('mona.resume-packet');
    expect(report.tasksImported).toBe(2);
    const task = await new TaskService(clean).getTask(firstId);
    expect(task?.status).toBe('completed');
  });
});

describe('bundle paths cannot escape the extraction root', () => {
  it('rejects traversal, absolute paths and Windows device names', () => {
    for (const bad of [
      '../escape.txt',
      'a/../../escape.txt',
      '/etc/passwd',
      'C:/Windows/system32',
      '\\\\server\\share\\x',
      'con.txt',
      'dir\\file.txt',
      'C:stream',
    ]) {
      expect(() => assertSafeRelativePath(bad)).toThrowError(/bundle member path|must be relative|escape/i);
    }
    expect(assertSafeRelativePath('docs/proof.txt')).toBe('docs/proof.txt');
    expect(assertSafeRelativePath('a/../b.txt')).toBe('b.txt');
  });

  it('refuses a malicious member at import and extraction time', async () => {
    const { store, projectId } = await setupProject('malicious');
    const out = await tempDir('malicious-out');
    const file = path.join(out, 'handoff.json');
    const bundle = await exportPortable(store, projectId, { file, includeFiles: ['docs/proof.txt'] });
    const hostile: PortableBundle = {
      ...bundle,
      files: [{ ...(bundle.files[0] as PortableBundle['files'][number]), path: '../escape.txt' }],
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { digest: _digest, ...body } = hostile;
    const hostileFile = path.join(out, 'hostile.json');
    await writeFile(hostileFile, JSON.stringify({ ...body, digest: digestOfPortable(body) }), 'utf8');
    expect(() => parsePortableBundle(JSON.parse(readFileSync(hostileFile, 'utf8')))).toThrowError(
      /bundle member path/i,
    );

    const root = await tempDir('extract-root');
    expect(() => extractPortableFiles(hostile, root)).toThrowError(/bundle member path|escape/i);
    expect(existsSync(path.join(root, '..', 'escape.txt'))).toBe(false);

    const extracted = extractPortableFiles(bundle, root);
    expect(extracted.written).toEqual([expect.objectContaining({ path: 'docs/proof.txt' })]);
    expect(readFileSync(path.join(root, 'docs', 'proof.txt'), 'utf8')).toBe('proof of completion\n');
    expect(() => extractPortableFiles(bundle, root)).toThrowError(/already exists/);
  });
});
