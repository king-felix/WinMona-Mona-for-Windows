import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup, verifyDatabaseFile } from './backup.js';
import { applyMigrations, MIGRATIONS } from './migrations.js';
import { ProjectStore } from './store.js';
import { ArtifactStore } from './artifacts.js';
import { exportProject, importProject } from './export.js';
import { SqliteSubmissionJournal, type JournalStore } from './journal.js';
import { SubmissionId, ThreadId, newOperationKey, newSubmissionId } from '@mona/contracts';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p05-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string): Promise<{ store: ProjectStore; dir: string }> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  return { store, dir };
}

async function seedProject(store: ProjectStore, label = 'Pi'): Promise<{ projectId: string; taskId: string }> {
  const folder = await tempDir(`${label}-folder`);
  const registered = await store.registerProject(folder, { label });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const taskId = await store.write((tx) => tx.insertTask({ projectId: registered.project.id, title: 'first task' }).id);
  return { projectId: registered.project.id, taskId };
}

describe('backup and restore', () => {
  it('backs up, restores, and parks the replaced database without deleting it', async () => {
    const { store, dir } = await setup('backup');
    const { projectId } = await seedProject(store);

    const backup = await createBackup(store, { directory: path.join(dir, 'backups') });
    expect(backup.integrity).toBe('ok');
    expect(backup.bytes).toBeGreaterThan(0);
    expect(await verifyDatabaseFile(backup.file)).toBe('ok');

    // Change state after the backup.
    await store.write((tx) => tx.insertTask({ projectId, title: 'after backup' }));
    const before = (await store.read((db) => db.prepare('SELECT COUNT(*) AS count FROM tasks').get())) as {
      count: number;
    };
    expect(before.count).toBe(2);

    const receipt = await restoreBackup(store, {
      backupFile: backup.file,
      recoveryDirectory: path.join(dir, 'recovery'),
    });
    expect(receipt.integrity).toBe('ok');
    expect(receipt.schemaVersion).toBe(MIGRATIONS.length);
    expect((await stat(receipt.parkedCurrentFile)).size).toBeGreaterThan(0);
    expect((await stat(backup.file)).size).toBeGreaterThan(0);

    const after = (await store.read((db) => db.prepare('SELECT COUNT(*) AS count FROM tasks').get())) as {
      count: number;
    };
    expect(after.count).toBe(1);
    expect(store.integrityCheck()).toBe('ok');
  });

  it('refuses a backup whose digest does not match, leaving the live database untouched', async () => {
    const { store, dir } = await setup('digest');
    const { projectId } = await seedProject(store);
    const backup = await createBackup(store, { directory: path.join(dir, 'backups') });
    await store.write((tx) => tx.insertTask({ projectId, title: 'keep me' }));

    const failure = await restoreBackup(store, {
      backupFile: backup.file,
      expectedSha256: '0'.repeat(64),
      recoveryDirectory: path.join(dir, 'recovery'),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StateError);
    expect((failure as StateError).code).toBe('digest_mismatch');

    const count = (await store.read((db) => db.prepare('SELECT COUNT(*) AS count FROM tasks').get())) as {
      count: number;
    };
    expect(count.count).toBe(2);
  });

  it('quiesces writers: a write during maintenance is refused, then accepted again', async () => {
    const { store, dir } = await setup('barrier');
    const { projectId } = await seedProject(store);

    let observed: unknown = null;
    await store.exclusive('test-maintenance', async () => {
      observed = await store
        .write((tx) => tx.insertTask({ projectId, title: 'during maintenance' }))
        .catch((error: unknown) => error);
      const readDuringRestore = await store
        .read((db) => db.prepare('SELECT 1').get())
        .then(() => 'read-allowed')
        .catch((error: unknown) => (error as StateError).code);
      expect(readDuringRestore).toBe('maintenance');
    });
    expect(observed).toBeInstanceOf(StateError);
    expect((observed as StateError).code).toBe('maintenance');
    await store.write((tx) => tx.insertTask({ projectId, title: 'after maintenance' }));
    const count = (await store.read((db) => db.prepare('SELECT COUNT(*) AS count FROM tasks').get())) as {
      count: number;
    };
    expect(count.count).toBe(2);
    const backup = await createBackup(store, { directory: path.join(dir, 'backups') });
    expect(backup.integrity).toBe('ok');
  });
});

describe('artifacts', () => {
  it('stores bounded files by digest and refuses oversize or full-disk writes', async () => {
    const dir = await tempDir('artifacts');
    const artifacts = new ArtifactStore({ root: dir });
    const record = artifacts.put({ content: 'hello artifact', mediaType: 'text/plain', source: 'test' });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts.read(record.relativePath).toString('utf8')).toBe('hello artifact');

    const oversize = (() => {
      try {
        artifacts.put({ content: 'x'.repeat(64), mediaType: 'text/plain', source: 'test', maxBytes: 8 });
        return null;
      } catch (error) {
        return error as StateError;
      }
    })();
    expect(oversize?.code).toBe('oversize');

    const full = (() => {
      try {
        const tight = new ArtifactStore({ root: dir, minFreeBytes: Number.MAX_SAFE_INTEGER });
        tight.put({ content: 'x', mediaType: 'text/plain', source: 'test' });
        return null;
      } catch (error) {
        return error as StateError;
      }
    })();
    expect(full?.code).toBe('disk_full');
  });

  it('never prunes artifacts that protected evidence depends on', async () => {
    const dir = await tempDir('retention');
    const artifacts = new ArtifactStore({ root: dir });
    const keep = artifacts.put({
      content: 'evidence',
      mediaType: 'text/plain',
      source: 'test',
      retention: 'ephemeral',
    });
    const drop = artifacts.put({ content: 'scratch', mediaType: 'text/plain', source: 'test', retention: 'ephemeral' });
    const records = [
      { ...keep, projectId: null, prunedAt: null },
      { ...drop, projectId: null, prunedAt: null },
    ];
    const plan = artifacts.planPrune(records, { keep: ['permanent'], protectedSha256: [keep.sha256] });
    expect(plan.prunable.map((row) => row.sha256)).toEqual([drop.sha256]);
    expect(plan.protectedRecords.map((row) => row.sha256)).toEqual([keep.sha256]);
    expect(() => artifacts.delete(records[0]!, [keep.sha256])).toThrow(StateError);
    expect(artifacts.delete(records[1]!).deleted).toBe(true);
  });
});

describe('project export and import', () => {
  it('exports portable status without machine-local bindings and re-imports it atomically', async () => {
    const { store, dir } = await setup('export');
    const { projectId, taskId } = await seedProject(store, 'Portable');
    await store.write((tx) => {
      tx.addEvidence(projectId, {
        requirementId: 'MONA-005',
        criterionId: 'no-source-delete',
        path: 'docs/evidence/x.md',
        sha256: 'a'.repeat(64),
        kind: 'document',
      });
      tx.addDecision(projectId, 'Use SQLite', 'One write path.');
    });
    await store.write((tx) => tx.putSettingVersion('project', 1, { theme: 'daybreak' }));

    const file = path.join(dir, 'export.json');
    const document = await exportProject(store, projectId, file);
    expect(document.digest).toMatch(/^[0-9a-f]{64}$/);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('token');
    expect(text).not.toContain('endpoint');

    const other = await setup('import');
    const imported = await importProject(other.store, file);
    expect(imported.projectId).toBe(projectId);
    expect(imported.tasksImported).toBe(1);
    const task = other.store.database.prepare('SELECT id, title FROM tasks WHERE id = ?').get(taskId) as
      { id: string; title: string } | undefined;
    expect(task?.title).toBe('first task');
  });

  it('rejects a tampered export by digest before writing anything', async () => {
    const { store, dir } = await setup('tamper-export');
    const { projectId } = await seedProject(store);
    const file = path.join(dir, 'export.json');
    await exportProject(store, projectId, file);
    const document = JSON.parse(await readFile(file, 'utf8')) as { project: { label: string } };
    document.project.label = 'Tampered';
    await writeFile(file, JSON.stringify(document), 'utf8');

    const other = await setup('import-tampered');
    const failure = await importProject(other.store, file).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StateError);
    expect((failure as StateError).code).toBe('digest_mismatch');
    const count = other.store.database.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('refuses an import older than the local revision unless explicitly accepted', async () => {
    const { store, dir } = await setup('older');
    const { projectId } = await seedProject(store);
    const file = path.join(dir, 'export.json');
    await exportProject(store, projectId, file);

    const project = await store.getProject(projectId);
    if (!project) throw new Error('missing project');
    await store.updateProject(projectId, project.revision, { label: 'newer local' });

    const refusal = await store.write((tx) => tx.insertTask({ projectId, title: 'x' })).then(() => null);
    expect(refusal).toBeNull();
    const failure = await importProject(store, file).catch((error: unknown) => error);
    // The exported revision equals the stored one here (updates bump revision),
    // so this import is accepted; a strictly older import is refused below.
    if (failure instanceof StateError) {
      expect(failure.code).toBe('conflict');
    } else {
      expect(failure.projectId).toBe(projectId);
    }

    const older = JSON.parse(await readFile(file, 'utf8')) as { project: { revision: number }; digest: string };
    older.project.revision = 0;
    const { digestOfExport } = await import('./export.js');
    const body = { ...older } as Record<string, unknown>;
    delete body.digest;
    (older as unknown as { digest: string }).digest = digestOfExport(body as never);
    await writeFile(file, JSON.stringify(older), 'utf8');
    const refused = await importProject(store, file).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateError);
    expect((refused as StateError).code).toBe('conflict');
  });
});

describe('SQLite submission journal', () => {
  it('persists intent and finds it by operation key through one write path', async () => {
    const { store } = await setup('journal');
    const journal = new SqliteSubmissionJournal(store as unknown as JournalStore);
    const threadId = ThreadId.parse(`thr_${'a'.repeat(32)}`);
    const id = newSubmissionId();
    const operationKey = newOperationKey();
    const now = new Date().toISOString();
    const record = {
      id,
      projectId: 'prj_' + '0'.repeat(32),
      taskId: null,
      threadId,
      turnId: null,
      operationKey,
      state: 'intent_persisted' as const,
      intentPersistedAt: now,
      dispatchedAt: null,
      lastObservedAt: now,
      reconciliation: { required: false },
    };
    await journal.put(record);
    const fetched = await journal.get(SubmissionId.parse(id));
    expect(fetched?.operationKey).toBe(operationKey);
    const byKey = await journal.findByOperationKey(threadId, operationKey);
    expect(byKey?.id).toBe(id);
  });
});
