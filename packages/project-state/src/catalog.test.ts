import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectCatalog } from './catalog.js';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';
import { readGitBranch } from './identity.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p07-${label}-`));
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

async function folder(label: string): Promise<string> {
  const dir = await tempDir(`${label}-root`);
  const target = path.join(dir, 'alpha');
  await mkdir(target, { recursive: true });
  return target;
}

async function writeHead(dir: string, branch: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
}

async function gitRepository(label: string): Promise<string> {
  const root = await folder(label);
  await writeHead(path.join(root, '.git'), 'main');
  return root;
}

describe('project catalog', () => {
  it('opens a plain folder and reports a missing branch without inventing one', async () => {
    const store = await openStore('plain');
    const catalog = new ProjectCatalog(store);
    const target = await folder('plain-proj');
    await writeFile(path.join(target, 'uncommitted.txt'), 'dirty but openable\n', 'utf8');

    const opened = await store.registerProject(target, { label: 'Plain' });
    if (opened.status === 'relocation_required') throw new Error('unexpected relocation');
    const entry = await catalog.get(opened.project.id);

    expect(entry?.repoKind).toBe('none');
    expect(entry?.branch).toBeNull();
    expect(entry?.folderExists).toBe(true);
    expect(await store.countThreads(opened.project.id)).toBe(0);
  });

  it('reads a branch from HEAD for a repository and a linked worktree', async () => {
    const store = await openStore('worktree');
    const main = await gitRepository('main');
    const worktreeRoot = await folder('worktree');
    await writeFile(path.join(worktreeRoot, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`, 'utf8');
    await writeHead(path.join(main, '.git', 'worktrees', 'wt'), 'feature/p07');

    expect(readGitBranch(main)).toBe('main');
    expect(readGitBranch(worktreeRoot)).toBe('feature/p07');
    expect(readGitBranch(await folder('no-git'))).toBeNull();

    const first = await store.registerProject(main, { label: 'Main' });
    const second = await store.registerProject(worktreeRoot, { label: 'Worktree' });
    if (first.status === 'relocation_required' || second.status === 'relocation_required') {
      throw new Error('unexpected relocation');
    }
    const catalog = new ProjectCatalog(store);
    const mainEntry = await catalog.get(first.project.id);
    const worktreeEntry = await catalog.get(second.project.id);

    expect(mainEntry?.repoKind).toBe('git');
    expect(worktreeEntry?.repoKind).toBe('worktree');
    expect(worktreeEntry?.branch).toBe('feature/p07');
    expect(worktreeEntry?.sharedRepoKey).toBe(mainEntry?.sharedRepoKey);
    expect(worktreeEntry?.worktreeSiblingIds).toEqual([first.project.id]);
    expect(mainEntry?.worktreeSiblingIds).toEqual([second.project.id]);
  });

  it('deduplicates a path alias instead of creating a second project', async () => {
    const store = await openStore('alias');
    const target = await folder('alias-proj');
    const first = await store.registerProject(target, { label: 'Alias' });
    if (first.status === 'relocation_required') throw new Error('unexpected relocation');

    const aliased = path.join(target, '..', path.basename(target), '.');
    const second = await store.registerProject(aliased);
    expect(second.status).toBe('existing');
    expect(second.project.id).toBe(first.project.id);
    expect(await store.listProjects({ includeArchived: true })).toHaveLength(1);
  });

  it('renames, pins, archives, restores and searches without touching the folder', async () => {
    const store = await openStore('lifecycle');
    const catalog = new ProjectCatalog(store);
    const alpha = await folder('alpha');
    const beta = await folder('beta');
    const opened = await store.registerProject(alpha, { label: 'Alpha' });
    await store.registerProject(beta, { label: 'Beta' });
    if (opened.status === 'relocation_required') throw new Error('unexpected relocation');

    const renamed = await store.updateProject(opened.project.id, opened.project.revision, {
      label: 'Alpha renamed',
      pinned: true,
    });
    expect(renamed.label).toBe('Alpha renamed');
    expect(renamed.pinned).toBe(true);
    expect((await catalog.list())[0]?.id).toBe(renamed.id);

    const archived = await store.updateProject(renamed.id, renamed.revision, { archived: true });
    expect(await catalog.list()).toHaveLength(1);
    expect((await catalog.list({ includeArchived: true })).map((entry) => entry.label)).toContain('Alpha renamed');
    expect((await catalog.list({ includeArchived: true, query: 'beta' })).map((entry) => entry.label)).toEqual([
      'Beta',
    ]);

    const restored = await store.updateProject(archived.id, archived.revision, { archived: false });
    expect(restored.archived).toBe(false);
    expect((await catalog.list()).map((entry) => entry.label).sort()).toEqual(['Alpha renamed', 'Beta']);
  });

  it('removes only the catalog entry and never deletes the folder or its files', async () => {
    const store = await openStore('remove');
    const target = await folder('remove-proj');
    await writeFile(path.join(target, 'keep.txt'), 'keep me\n', 'utf8');
    const opened = await store.registerProject(target, { label: 'Remove me' });
    if (opened.status === 'relocation_required') throw new Error('unexpected relocation');

    const result = await store.removeProject(opened.project.id);
    expect(result.removed).toBe(true);
    expect(await store.getProject(opened.project.id)).toBeNull();

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep me\n');
    rmSync(path.join(target, 'keep.txt'));
  });

  it('requires a deliberate rebind after a folder moves', async () => {
    const store = await openStore('relocate');
    const original = await folder('relocate-proj');
    const opened = await store.registerProject(original, { label: 'Movable' });
    if (opened.status === 'relocation_required') throw new Error('unexpected relocation');

    const moved = `${original}-moved`;
    await rename(original, moved);

    const observed = await store.registerProject(moved);
    expect(observed.status).toBe('relocation_required');
    if (observed.status !== 'relocation_required') return;
    expect(observed.project.id).toBe(opened.project.id);
    expect(observed.observedPath.toLowerCase()).toContain('moved');

    const rebound = await store.relocateProject(opened.project.id, opened.project.revision, moved);
    expect(rebound.canonicalPath.toLowerCase()).toContain('moved');
    expect(await store.getProject(opened.project.id)).toMatchObject({ canonicalPath: rebound.canonicalPath });
  });

  it('records runtime bindings and project usage without turning unknown into zero', async () => {
    const store = await openStore('binding');
    const target = await folder('binding-proj');
    const opened = await store.registerProject(target, { label: 'Binding' });
    if (opened.status === 'relocation_required') throw new Error('unexpected relocation');

    const binding = await store.putRuntimeBinding({
      projectId: opened.project.id,
      workspace: opened.project.canonicalPath,
      endpoint: 'http://127.0.0.1:7811',
      pid: 1234,
      owned: true,
      state: 'running',
      engineVersion: '0.10.2',
      engineCommit: 'ff466b2ed0bf',
      tokenSha256: 'a'.repeat(64),
    });
    expect((await store.getRuntimeBinding(opened.project.id))?.pid).toBe(1234);
    expect((await store.listRuntimeBindings())[0]?.id).toBe(binding.id);

    await store.clearRuntimeBinding(opened.project.id);
    const cleared = await store.getRuntimeBinding(opened.project.id);
    expect(cleared?.state).toBe('stopped');
    expect(cleared?.pid).toBeNull();

    await store.write((tx) => {
      tx.recordUsage({ projectId: opened.project.id, costKnown: true, costMicros: 3_500, source: 'engine' });
      tx.recordUsage({ projectId: opened.project.id, costKnown: false, source: 'engine' });
    });
    const usage = await store.projectUsage(opened.project.id);
    expect(usage.knownCostMicros).toBe(3_500);
    expect(usage.unknownCostRecords).toBe(1);
    expect(usage.turnCount).toBe(2);
  });

  it('keeps nested repositories as distinct catalog entries', async () => {
    const store = await openStore('nested');
    const outer = await gitRepository('outer');
    const inner = path.join(outer, 'packages', 'inner');
    await writeHead(path.join(inner, '.git'), 'inner-branch');

    const outerProject = await store.registerProject(outer, { label: 'Outer' });
    const innerProject = await store.registerProject(inner, { label: 'Inner' });
    if (outerProject.status === 'relocation_required' || innerProject.status === 'relocation_required') {
      throw new Error('unexpected relocation');
    }
    const catalog = new ProjectCatalog(store);
    const entries = await catalog.list();
    expect(entries.map((entry) => entry.label).sort()).toEqual(['Inner', 'Outer']);
    expect(entries.find((entry) => entry.label === 'Inner')?.repoKind).toBe('git');
    expect(entries.find((entry) => entry.label === 'Inner')?.branch).toBe('inner-branch');
  });

  it('reports a folder that disappeared without dropping its history', async () => {
    const store = await openStore('missing');
    const target = await folder('missing-proj');
    const opened = await store.registerProject(target, { label: 'Gone' });
    if (opened.status === 'relocation_required') throw new Error('unexpected relocation');
    await rm(target, { recursive: true, force: true });

    const catalog = new ProjectCatalog(store);
    const entry = await catalog.get(opened.project.id);
    expect(entry?.folderExists).toBe(false);
    expect(entry?.label).toBe('Gone');
  });
});
