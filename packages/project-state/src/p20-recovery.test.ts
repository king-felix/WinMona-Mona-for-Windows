import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from './backup.js';
import { openState } from './index.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p20-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string) {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  const workspace = await tempDir(`${label}-folder`);
  const registered = await store.registerProject(workspace, { label: 'P20 recovery' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  return { store, dir, workspace, projectId: registered.project.id };
}

async function taskCount(store: ProjectStore): Promise<number> {
  const row = (await store.read((db) => db.prepare('SELECT COUNT(*) AS count FROM tasks').get())) as {
    count: number;
  };
  return Number(row.count);
}

describe('interrupted restore', () => {
  it.each(['afterPark', 'afterCopy', 'beforeReplace'] as const)(
    'leaves the live database intact when the restore fails at %s',
    async (hook) => {
      const { store, dir, projectId } = await setup(`restore-${hook}`);
      await store.write((tx) => tx.insertTask({ projectId, title: 'before backup' }));
      const backup = await createBackup(store, { directory: path.join(dir, 'backups') });
      await store.write((tx) => tx.insertTask({ projectId, title: 'after backup' }));

      const failure = await restoreBackup(store, {
        backupFile: backup.file,
        recoveryDirectory: path.join(dir, 'recovery'),
        hooks: {
          [hook]: () => {
            throw new Error(`injected interruption at ${hook}`);
          },
        },
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('injected interruption');

      // The store was reopened, the live data is still the newer state, and no
      // staged file is left behind pretending to be a restore.
      expect(store.integrityCheck()).toBe('ok');
      expect(await taskCount(store)).toBe(2);
      const parked = await readdir(path.join(dir, 'recovery'));
      expect(parked.length).toBeGreaterThan(0);
      const root = await readdir(dir);
      expect(root.some((name) => name.includes('.mona-restore-'))).toBe(false);
      await expect(stat(backup.file)).resolves.toBeTruthy();

      // The same backup still restores cleanly afterwards.
      const receipt = await restoreBackup(store, {
        backupFile: backup.file,
        recoveryDirectory: path.join(dir, 'recovery'),
      });
      expect(receipt.integrity).toBe('ok');
      expect(await taskCount(store)).toBe(1);
      const after = await readdir(dir);
      expect(after.some((name) => name.includes('.mona-restore-'))).toBe(false);
    },
  );

  it('keeps the backup and parked copy when the live path cannot be replaced', async () => {
    const { store, dir, projectId } = await setup('restore-refused');
    await store.write((tx) => tx.insertTask({ projectId, title: 'one' }));
    const backup = await createBackup(store, { directory: path.join(dir, 'backups') });
    const failure = await restoreBackup(store, {
      backupFile: backup.file,
      recoveryDirectory: path.join(dir, 'recovery'),
      hooks: {
        beforeReplace: () => {
          throw new Error('injected replace refusal');
        },
      },
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain('injected replace refusal');
    expect(await taskCount(store)).toBe(1);
    const parked = await readdir(path.join(dir, 'recovery'));
    expect(parked).toHaveLength(1);
  });
});

describe('corrupted local state', () => {
  it('refuses to open a garbage database and preserves it for inspection', async () => {
    const dir = await tempDir('corrupt-state');
    const file = path.join(dir, 'mona.sqlite');
    const garbage = Buffer.from('this is not a SQLite database\n', 'utf8');
    await writeFile(file, garbage);

    await expect(openState({ directory: dir, backupBeforeMigration: false })).rejects.toBeTruthy();
    const after = await readFile(file);
    expect(after.equals(garbage)).toBe(true);
    const entries = await readdir(dir);
    expect(entries).toContain('mona.sqlite');
    // No live SQLite handle survives the failed open: the file can be moved.
    await rename(file, `${file}.preserved`);
    expect(await readdir(dir)).toEqual(['mona.sqlite.preserved']);
  });

  it('opens a fresh directory without inventing state and keeps the schema version honest', async () => {
    const dir = await tempDir('fresh-state');
    const opened = await openState({ directory: dir, backupBeforeMigration: false });
    expect(opened.schemaVersion).toBeGreaterThan(0);
    expect(await opened.store.listProjects()).toEqual([]);
    opened.store.close();
  });
});

describe('suspicious folders and paths', () => {
  it('registers a folder with spaces, symbols and non-ASCII characters exactly once', async () => {
    const { store } = await setup('suspicious');
    const parent = await tempDir('suspicious-parent');
    const folder = path.join(parent, 'proj #1 100% 数据');
    await mkdir(folder, { recursive: true });

    const first = await store.registerProject(folder, { label: 'symbols' });
    expect(first.status).toBe('created');
    const same = await store.registerProject(`${folder}${path.sep}`, { label: 'again' });
    expect(['existing', 'alias']).toContain(same.status);
    expect(same.project.id).toBe(first.project.id);
    const upper = await store.registerProject(folder.toUpperCase(), { label: 'upper' });
    expect(['existing', 'alias']).toContain(upper.status);
    expect(upper.project.id).toBe(first.project.id);
  });

  it('refuses evidence paths that traverse outside the workspace', async () => {
    const { store, workspace, projectId } = await setup('evidence-paths');
    const tasks = new TaskService(store);
    await mkdir(path.join(workspace, 'docs'), { recursive: true });
    await writeFile(path.join(workspace, 'docs', 'proof.txt'), 'proof\n', 'utf8');
    const task = await tasks.createTask({
      projectId,
      title: 'Path guard',
      owner: 'mona_queue',
      criteria: [{ description: 'proof exists' }],
    });
    await tasks.claim(task.id);
    const criterionId = task.criteria[0]?.id as string;

    for (const bad of ['../outside.txt', '..\\outside.txt', 'C:\\Windows\\win.ini', '/etc/passwd']) {
      await expect(tasks.recordCheck(task.id, criterionId, { path: bad, passed: true })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    const evidence = await store.read(
      (db) =>
        db.prepare('SELECT COUNT(*) AS count FROM task_evidence WHERE task_id = ?').get(task.id) as {
          count: number;
        },
    );
    expect(Number(evidence.count)).toBe(0);

    const recorded = await tasks.recordCheck(task.id, criterionId, {
      path: 'docs/../docs/proof.txt',
      passed: true,
    });
    expect(recorded.path).toBe('docs/proof.txt');
  });
});
