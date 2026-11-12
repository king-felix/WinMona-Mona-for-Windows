import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';
import { identifyPath } from './identity.js';
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

async function openStore(
  label: string,
  hooks?: ConstructorParameters<typeof ProjectStore>[0]['hooks'],
): Promise<ProjectStore> {
  const dir = await tempDir(label);
  const store = new ProjectStore({ file: path.join(dir, 'mona.sqlite'), ...(hooks ? { hooks } : {}) });
  stores.push(store);
  await applyMigrations(store.database);
  return store;
}

async function projectFolder(label: string): Promise<string> {
  const dir = await tempDir(label);
  const folder = path.join(dir, 'alpha');
  await mkdir(folder, { recursive: true });
  return folder;
}

describe('single write path and revision checks', () => {
  it('refuses a stale revision instead of overwriting newer state', async () => {
    const store = await openStore('revision');
    const folder = await projectFolder('revision-proj');
    const registered = await store.registerProject(folder, { label: 'Alpha' });
    if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
    const project = registered.project;

    const first = await store.updateProject(project.id, project.revision, { label: 'Alpha 2' });
    expect(first.revision).toBe(project.revision + 1);

    const stale = await store
      .updateProject(project.id, project.revision, { label: 'Alpha stale' })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(StateError);
    expect((stale as StateError).code).toBe('stale_revision');

    const reread = await store.getProject(project.id);
    expect(reread?.label).toBe('Alpha 2');
  });

  it('rolls back the whole transaction when a write fails part way', async () => {
    const store = await openStore('rollback');
    const folder = await projectFolder('rollback-proj');
    const registered = await store.registerProject(folder, { label: 'Beta' });
    if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
    const project = registered.project;

    const failure = await store
      .write((tx) => {
        tx.insertTask({ projectId: project.id, title: 'first' });
        tx.insertTask({ projectId: project.id, title: 'second' });
        throw new Error('simulated failure before commit');
      })
      .catch((error: unknown) => error);
    expect(String(failure)).toContain('simulated failure');

    const tasks = store.database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
    expect(tasks.count).toBe(0);
    expect(store.integrityCheck()).toBe('ok');

    // The connection is still usable and the next write commits normally.
    await store.write((tx) => tx.insertTask({ projectId: project.id, title: 'third' }));
    const after = store.database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
    expect(after.count).toBe(1);
  });

  it('a hook failure before commit leaves no partial rows', async () => {
    let armed = false;
    const store = await openStore('hook', {
      beforeCommit: () => {
        if (armed) throw new Error('crash before commit');
      },
    });
    const folder = await projectFolder('hook-proj');
    const registered = await store.registerProject(folder, { label: 'Gamma' });
    if (registered.status === 'relocation_required') throw new Error('unexpected relocation');

    armed = true;
    await expect(
      store.write((tx) => tx.insertTask({ projectId: registered.project.id, title: 'lost' })),
    ).rejects.toThrow('crash before commit');
    const count = store.database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('survives a real process crash during an open transaction', async () => {
    const store = await openStore('crash');
    const folder = await projectFolder('crash-proj');
    const registered = await store.registerProject(folder, { label: 'Delta' });
    if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
    const project = registered.project;
    await store.write((tx) => tx.insertTask({ projectId: project.id, title: 'durable' }));

    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO tasks(id, project_id, title, status, prompt_id, created_at, updated_at) VALUES ('tsk_crash', ?, 'in flight', 'pending', NULL, '2026-01-01', '2026-01-01')").run(process.argv[2]);
      process.exit(9);
    `;
    const child = spawn(process.execPath, ['-e', script, store.file, project.id], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (value) => resolve(value)));
    expect(code).toBe(9);

    // Reopening the same file must be valid and must not show the uncommitted row.
    const reopened = new ProjectStore({ file: store.file });
    stores.push(reopened);
    expect(reopened.integrityCheck()).toBe('ok');
    const rows = reopened.database.prepare('SELECT id FROM tasks ORDER BY id').all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).not.toContain('tsk_crash');
    expect(rows.length).toBe(1);
    await reopened.write((tx) => tx.insertTask({ projectId: project.id, title: 'after crash' }));
    const after = reopened.database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number };
    expect(after.count).toBe(2);
  });
});

describe('project identity', () => {
  it('registering the same folder twice yields one project', async () => {
    const store = await openStore('same');
    const folder = await projectFolder('same-proj');
    const first = await store.registerProject(folder, { label: 'One' });
    const second = await store.registerProject(folder, { label: 'One again' });
    expect(first.status).toBe('created');
    expect(second.status).toBe('existing');
    if (first.status === 'relocation_required' || second.status === 'relocation_required')
      throw new Error('relocation');
    expect(second.project.id).toBe(first.project.id);
    expect((await store.listProjects()).length).toBe(1);
  });

  it('a second path alias of one folder does not create a duplicate project', async () => {
    const store = await openStore('alias');
    const folder = await projectFolder('alias-proj');
    const created = await store.registerProject(folder, { label: 'Alias' });
    if (created.status === 'relocation_required') throw new Error('relocation');

    const aliasPath = path.join(path.dirname(folder), 'alias-link');
    let linked = true;
    try {
      await symlink(folder, aliasPath, 'junction');
    } catch {
      linked = false;
    }
    if (linked) {
      const viaAlias = await store.registerProject(aliasPath, { label: 'Alias link' });
      expect(['existing', 'alias']).toContain(viaAlias.status);
      if (viaAlias.status !== 'relocation_required') {
        expect(viaAlias.project.id).toBe(created.project.id);
      }
      expect((await store.listProjects()).length).toBe(1);
    } else {
      // Without junction permission, the canonical-path rule is still proven.
      const viaDot = await store.registerProject(path.join(folder, '.'), { label: 'Dot' });
      expect(viaDot.status).toBe('existing');
      expect((await store.listProjects()).length).toBe(1);
    }
  });

  it('a moved folder requires an explicit rebind instead of a second project', async () => {
    const store = await openStore('relocate');
    const firstFolder = await projectFolder('relocate-a');
    const created = await store.registerProject(firstFolder, { label: 'Mover' });
    if (created.status === 'relocation_required') throw new Error('relocation');
    const marker = JSON.parse(await readFile(path.join(firstFolder, '.mona', 'project', 'project.json'), 'utf8'));
    expect(marker.project_id).toBe(created.project.id);

    // Simulate a move: same marker id at a genuinely different path.
    const secondFolder = await projectFolder('relocate-b');
    await mkdir(path.join(secondFolder, '.mona', 'project'), { recursive: true });
    await writeFile(path.join(secondFolder, '.mona', 'project', 'project.json'), JSON.stringify(marker), 'utf8');

    const detected = await store.registerProject(secondFolder, { label: 'Moved' });
    expect(detected.status).toBe('relocation_required');
    if (detected.status === 'relocation_required') {
      expect(detected.observedPath).toBe(identifyPath(secondFolder).canonicalPath);
      expect(detected.project.id).toBe(created.project.id);
    }
    expect((await store.listProjects()).length).toBe(1);

    const rebound = await store.registerProject(secondFolder, { rebind: true });
    expect(rebound.status).toBe('rebound');
    if (rebound.status !== 'relocation_required') {
      expect(rebound.project.id).toBe(created.project.id);
      expect(rebound.project.canonicalPath).toBe(identifyPath(secondFolder).canonicalPath);
      expect(rebound.project.revision).toBe(created.project.revision + 1);
    }
    expect((await store.listProjects()).length).toBe(1);
  });

  it('nested worktrees stay distinct roots sharing one repository key', async () => {
    const store = await openStore('worktree');
    const mainRepo = await projectFolder('repo-main');
    await mkdir(path.join(mainRepo, '.git'), { recursive: true });
    const createdMain = await store.registerProject(mainRepo, { label: 'main' });

    const worktree = path.join(path.dirname(mainRepo), 'wt-feature');
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(mainRepo, '.git', 'worktrees', 'wt-feature')}\n`);

    const createdTree = await store.registerProject(worktree, { label: 'feature' });
    if (createdMain.status === 'relocation_required' || createdTree.status === 'relocation_required') {
      throw new Error('unexpected relocation');
    }
    expect(createdTree.project.id).not.toBe(createdMain.project.id);
    expect(createdTree.project.repoKind).toBe('worktree');
    expect(createdTree.project.sharedRepoKey).not.toBeNull();
    expect(createdMain.project.sharedRepoKey).toBe(createdTree.project.sharedRepoKey);

    const siblings = await store.listWorktreeSiblings(createdTree.project.sharedRepoKey as string);
    expect(siblings.map((row) => row.id)).toEqual([createdMain.project.id, createdTree.project.id]);
  });

  it('removing a catalog entry never deletes the folder', async () => {
    const store = await openStore('remove');
    const folder = await projectFolder('remove-proj');
    const created = await store.registerProject(folder, { label: 'Keep me' });
    if (created.status === 'relocation_required') throw new Error('relocation');
    const result = await store.removeProject(created.project.id);
    expect(result.removed).toBe(true);
    expect(await store.getProject(created.project.id)).toBeNull();
    const stillThere = await readFile(path.join(folder, '.mona', 'project', 'project.json'), 'utf8');
    expect(stillThere).toContain(created.project.id);
  });
});
