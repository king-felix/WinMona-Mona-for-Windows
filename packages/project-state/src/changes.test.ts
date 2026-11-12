import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeService, writeFileFresh } from './changes.js';
import { applyMigrations } from './migrations.js';
import { ProjectStore } from './store.js';

const cleanup: Array<() => Promise<void>> = [];
const stores: ProjectStore[] = [];

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p13-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function setup(label: string, options: { previewBytes?: number } = {}) {
  const dir = await tempDir(label);
  const store = new ProjectStore({
    file: path.join(dir, 'mona.sqlite'),
    now: () => new Date('2026-11-12T12:00:00.000Z'),
  });
  stores.push(store);
  await applyMigrations(store.database);
  const folder = await tempDir(`${label}-folder`);
  const registered = await store.registerProject(folder, { label });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const service = new ChangeService(store, {
    now: () => new Date('2026-11-12T12:00:00.000Z'),
    ...(options.previewBytes === undefined ? {} : { previewBytes: options.previewBytes }),
  });
  return { store, service, projectId: registered.project.id, workspace: registered.project.canonicalPath };
}

async function initRepo(workspace: string): Promise<void> {
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Mona Test']);
  git(workspace, ['config', 'user.email', 'mona@example.invalid']);
  git(workspace, ['config', 'commit.gpgsign', 'false']);
}

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

describe('fresh-revision writes', () => {
  it('refuses to overwrite a file that changed after it was read', async () => {
    const dir = await tempDir('fresh');
    const file = path.join(dir, 'note.txt');
    await writeFile(file, 'first', 'utf8');
    const hash = createHash('sha256').update('first').digest('hex');
    await writeFile(file, 'external edit', 'utf8');
    expect(() => writeFileFresh({ file, content: 'agent edit', expectedSha256: hash })).toThrowError(/changed on disk/);
    expect(await readFile(file, 'utf8')).toBe('external edit');
    expect(() => writeFileFresh({ file, content: 'new', expectedSha256: null })).toThrowError(/already exists/);
    const created = writeFileFresh({ file: path.join(dir, 'new.txt'), content: 'hello', expectedSha256: null });
    expect(created.bytes).toBe(5);
  });
});

describe('workspace change receipts', () => {
  it('reports added, modified and deleted paths against a baseline without claiming authorship', async () => {
    const { service, projectId, workspace } = await setup('diff', { previewBytes: 16 });
    await writeFile(path.join(workspace, 'keep.txt'), 'same', 'utf8');
    await writeFile(path.join(workspace, 'edit.txt'), 'before', 'utf8');
    await writeFile(path.join(workspace, 'gone.txt'), 'delete me', 'utf8');
    const baseline = await service.captureBaseline({ projectId, workspace, label: 'task start' });
    expect(baseline.fileCount).toBe(3);

    await writeFile(path.join(workspace, 'edit.txt'), 'after, changed by a tool', 'utf8');
    await writeFile(path.join(workspace, 'added.txt'), 'new file', 'utf8');
    await rm(path.join(workspace, 'gone.txt'));
    await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(64), 'utf8');

    const report = await service.diff({
      projectId,
      workspace,
      touchedPaths: ['edit.txt', 'added.txt'],
    });
    expect(report.baseline?.id).toBe(baseline.id);
    expect(report.counts).toEqual({ added: 3, modified: 1, deleted: 1, toolRecorded: 2, unattributed: 3 });
    const byPath = new Map(report.changes.map((change) => [change.path, change]));
    expect(byPath.get('edit.txt')?.attribution).toBe('tool_recorded');
    expect(byPath.get('added.txt')?.attribution).toBe('tool_recorded');
    expect(byPath.get('binary.bin')?.binary).toBe(true);
    expect(byPath.get('binary.bin')?.preview).toBe('binary');
    expect(byPath.get('large.txt')?.preview).toBe('oversized');
    expect(report.attributionNote).toContain('unattributed workspace change');
  });

  it('does not present pre-existing user edits as agent changes', async () => {
    const { service, projectId, workspace } = await setup('preexisting');
    await writeFile(path.join(workspace, 'user.txt'), 'original', 'utf8');
    await writeFile(path.join(workspace, 'user.txt'), 'user edited before the run', 'utf8');
    await service.captureBaseline({ projectId, workspace, label: 'task start' });
    const report = await service.diff({ projectId, workspace, touchedPaths: [] });
    expect(report.changes).toEqual([]);
    expect(report.attributionNote).toContain('pre-existing user edits');
  });

  it('says plainly that a missing baseline is not an empty diff', async () => {
    const { service, projectId, workspace } = await setup('nobaseline');
    await writeFile(path.join(workspace, 'file.txt'), 'content', 'utf8');
    const report = await service.diff({ projectId, workspace });
    expect(report.baseline).toBeNull();
    expect(report.comparable).toBe(false);
    expect(report.changes).toEqual([]);
    expect(report.attributionNote).toContain('not an empty diff');
  });
});

describe.skipIf(!gitAvailable)('git selection and restore', () => {
  it('commits only the selected path and preserves unrelated staged work', async () => {
    const { service, projectId, workspace } = await setup('git-commit');
    void projectId;
    await initRepo(workspace);
    await writeFile(path.join(workspace, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(workspace, 'b.txt'), 'b', 'utf8');
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'initial']);

    await writeFile(path.join(workspace, 'a.txt'), 'a user change', 'utf8');
    git(workspace, ['add', 'a.txt']);
    await writeFile(path.join(workspace, 'b.txt'), 'b agent change', 'utf8');

    const status = await service.gitStatus(workspace);
    expect(status.kind).toBe('git');
    expect(status.branch).toBe('main');
    expect(status.staged.map((entry) => entry.path)).toContain('a.txt');

    const committed = await service.commit(workspace, { message: 'agent: change b', paths: ['b.txt'] });
    expect(committed.committed).toBe(true);
    const after = await service.gitStatus(workspace);
    expect(after.staged.map((entry) => entry.path)).toContain('a.txt');
    expect(after.unstaged.map((entry) => entry.path)).not.toContain('b.txt');
    const files = git(workspace, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    expect(files).toEqual(['b.txt']);
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('a user change');
  });

  it('shows a text diff from Git instead of inventing one', async () => {
    const { service, workspace } = await setup('git-diff');
    await initRepo(workspace);
    await writeFile(path.join(workspace, 'file.txt'), '--- one\n', 'utf8');
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'initial']);
    await writeFile(path.join(workspace, 'file.txt'), '+++ two\n', 'utf8');
    const diff = await service.diffText(workspace, 'file.txt');
    expect(diff.available).toBe(true);
    expect(diff.text).toContain('+++ two');
    const untracked = await service.diffText(workspace, 'missing.txt');
    expect(untracked.available).toBe(false);
    expect(untracked.reason).toContain('no recorded baseline');
  });

  it('refuses a restore when the file changed after the preview', async () => {
    const { service, projectId, workspace } = await setup('git-restore');
    await initRepo(workspace);
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'committed\n', 'utf8');
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'initial']);
    await writeFile(file, 'agent edit\n', 'utf8');
    const sha = (content: string) => createHash('sha256').update(content).digest('hex');
    const preview = await service.restorePreview(workspace, ['file.txt']);
    expect(preview.conflicts).toEqual([]);
    expect(preview.current[0]?.sha256).toBe(sha('agent edit\n'));

    await writeFile(file, 'later user edit\n', 'utf8');
    const refused = await service.restore(projectId, workspace, {
      paths: ['file.txt'],
      expectedSha256: { 'file.txt': sha('agent edit\n') },
    });
    expect(refused.outcome).toBe('refused');
    expect(refused.detail).toContain('refusing to overwrite later work');
    expect(await readFile(file, 'utf8')).toBe('later user edit\n');

    const applied = await service.restore(projectId, workspace, {
      paths: ['file.txt'],
      expectedSha256: { 'file.txt': sha('later user edit\n') },
    });
    expect(applied.outcome).toBe('applied');
    expect((await readFile(file, 'utf8')).trim()).toBe('committed');
  });

  it('refuses to restore paths that would discard staged changes', async () => {
    const { service, workspace } = await setup('git-staged-restore');
    await initRepo(workspace);
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'committed\n', 'utf8');
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-m', 'initial']);
    await writeFile(file, 'staged edit\n', 'utf8');
    git(workspace, ['add', 'file.txt']);
    const preview = await service.restorePreview(workspace, ['file.txt']);
    expect(preview.conflicts[0]?.reason).toContain('staged changes');
  });

  it('reports non-Git folders honestly and leaves them untouched', async () => {
    const { service, projectId, workspace } = await setup('nongit');
    await writeFile(path.join(workspace, 'file.txt'), 'content', 'utf8');
    const status = await service.gitStatus(workspace);
    expect(status.kind).toBe('none');
    expect(status.unavailableReason).toBe('not a git repository');
    const diff = await service.diffText(workspace, 'file.txt');
    expect(diff.available).toBe(false);
    expect(diff.reason).toContain('no textual baseline');
    const preview = await service.restorePreview(workspace, ['file.txt']);
    expect(preview.unsupported[0]).toContain('no native snapshot engine');
    await expect(service.commit(workspace, { message: 'nope', paths: ['file.txt'] })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    void projectId;
  });
});

describe('test receipts', () => {
  it('links a real command, exit status and bounded output', async () => {
    const { service, projectId } = await setup('receipts');
    const passed = await service.recordTestReceipt({
      projectId,
      command: 'npm test',
      exitCode: 0,
      outcome: 'passed',
      output: '12 tests passed',
      durationMs: 1200,
      commit: 'abc1234',
    });
    expect(passed.outcome).toBe('passed');
    expect(passed.exitCode).toBe(0);
    expect(passed.outputSha256).toBe(createHash('sha256').update('12 tests passed').digest('hex'));
    expect(passed.outputTruncated).toBe(false);

    const failed = await service.recordTestReceipt({
      projectId,
      command: 'npm test',
      exitCode: 1,
      outcome: 'failed',
      output: '1 test failed',
    });
    expect(failed.outcome).toBe('failed');
    const listed = await service.testReceipts(projectId);
    expect(listed).toHaveLength(2);

    await expect(
      service.recordTestReceipt({ projectId, command: 'npm test', exitCode: 1, outcome: 'passed' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const huge = await service.recordTestReceipt({
      projectId,
      command: 'npm test',
      exitCode: 0,
      outcome: 'passed',
      output: 'x'.repeat(300_000),
    });
    expect(huge.outputTruncated).toBe(true);
    expect(huge.outputPath).toBeNull();
  });
});
