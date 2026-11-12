import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeService, ProjectStore, applyMigrations } from '@mona/project-state';
import { ChangesService, countDiffLines, isProjectRelativePath } from './changes-service.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p23-changes-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string): Promise<{
  service: ChangesService;
  changes: ChangeService;
  store: ProjectStore;
  projectId: string;
  workspace: string;
}> {
  const root = await tempDir(label);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'one.txt'), 'one\n', 'utf8');
  const store = new ProjectStore({ file: path.join(root, 'mona.sqlite') });
  stores.push(store);
  await applyMigrations(store.database);
  const outcome = await store.registerProject(workspace, { label });
  if (outcome.status === 'relocation_required') throw new Error('unexpected relocation');
  const changes = new ChangeService(store);
  return {
    service: new ChangesService(store, changes),
    changes,
    store,
    projectId: outcome.project.id,
    workspace,
  };
}

describe('change path validation', () => {
  it('accepts project-relative paths and refuses anything that can leave the workspace', () => {
    expect(isProjectRelativePath('src/app.ts')).toBe(true);
    expect(isProjectRelativePath('a\\b\\c.txt')).toBe(true);
    expect(isProjectRelativePath('../outside.txt')).toBe(false);
    expect(isProjectRelativePath('src/../../outside.txt')).toBe(false);
    expect(isProjectRelativePath('C:\\Windows\\win.ini')).toBe(false);
    expect(isProjectRelativePath('/etc/passwd')).toBe(false);
    expect(isProjectRelativePath('src/\u0000hidden')).toBe(false);
    expect(isProjectRelativePath('')).toBe(false);
  });

  it('counts real added and removed lines without counting the file headers', () => {
    const counts = countDiffLines('--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one\n+two\n');
    expect(counts).toEqual({ lines: 5, added: 1, removed: 1 });
    expect(countDiffLines('')).toEqual({ lines: 0, added: 0, removed: 0 });
  });
});

describe('ChangesService', () => {
  it('says no baseline exists rather than presenting an empty change list', async () => {
    const { service, projectId, workspace } = await setup('nobaseline');
    const view = await service.view(projectId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.comparable).toBe(false);
    expect(view.data.baseline).toBeNull();
    expect(view.data.changes).toEqual([]);
    expect(view.data.workspaceExists).toBe(true);
    expect(view.data.repository.kind).toBe('none');
    expect(view.data.attributionNote).toContain('not an empty diff');
    expect(view.data.scan.maxFiles).toBeGreaterThan(0);
    expect(view.data.scan.excluded).toContain('node_modules');
    expect(workspace).toContain('workspace');
  });

  it('reports a real change against a captured baseline without claiming agent authorship', async () => {
    const { service, projectId, workspace } = await setup('changed');
    const captured = await service.capture(projectId, 'task start');
    expect(captured.ok).toBe(true);
    if (captured.ok) expect(captured.data.fileCount).toBe(1);

    await writeFile(path.join(workspace, 'one.txt'), 'one changed\n', 'utf8');
    await writeFile(path.join(workspace, 'two.txt'), 'two\n', 'utf8');

    const view = await service.view(projectId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.comparable).toBe(true);
    expect(view.data.changes.map((entry) => entry.path)).toEqual(['one.txt', 'two.txt']);
    expect(view.data.changes.map((entry) => entry.change)).toEqual(['modified', 'added']);
    expect(view.data.counts).toMatchObject({ added: 1, modified: 1, deleted: 0, toolRecorded: 0, unattributed: 2 });
    expect(view.data.attributionNote).toContain('tool_recorded');
  });

  it('states that a diff is unavailable without Git instead of inventing one', async () => {
    const { service, projectId } = await setup('nogit');
    await service.capture(projectId, 'baseline');
    const diff = await service.diff(projectId, 'one.txt');
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.data.available).toBe(false);
    expect(diff.data.text).toBe('');
    expect(diff.data.reason).toContain('no textual baseline');
  });

  it('refuses a traversal path before Git sees it', async () => {
    const { service, projectId } = await setup('traversal');
    const diff = await service.diff(projectId, '../../secret.txt');
    expect(diff.ok).toBe(false);
    if (!diff.ok) expect(diff.error.code).toBe('invalid_request');
  });

  it('reports a missing folder as unavailable, not as no changes', async () => {
    const { service, projectId, workspace } = await setup('missing');
    await rm(workspace, { recursive: true, force: true });
    const view = await service.view(projectId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.workspaceExists).toBe(false);
    expect(view.data.unavailableReason).toContain('missing');
    expect(view.data.comparable).toBe(false);
  });

  it('returns recorded test receipts with their real outcome and output digest', async () => {
    const { service, changes, projectId } = await setup('receipts');
    await changes.recordTestReceipt({
      projectId,
      command: 'npm test',
      exitCode: 0,
      outcome: 'passed',
      output: 'all good',
    });
    const view = await service.view(projectId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.receipts).toHaveLength(1);
    expect(view.data.receipts[0]).toMatchObject({ command: 'npm test', outcome: 'passed', exitCode: 0 });
    expect(view.data.receipts[0]?.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
