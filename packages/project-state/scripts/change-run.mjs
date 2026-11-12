import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openState, ChangeService } from '../dist/index.js';

/**
 * Deterministic P13 sample. It uses a throwaway Git repository, the real change
 * service and no provider at all.
 */

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

const root = await mkdtemp(path.join(tmpdir(), 'mona-p13-sample-'));
const workspace = path.join(root, 'sample-project');
await mkdir(workspace, { recursive: true });
const state = await openState({ directory: path.join(root, 'state') });
const steps = [];
const sha = (content) => createHash('sha256').update(content).digest('hex');
const git = (cwd, gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });

function record(name, detail) {
  steps.push({ name, detail });
}

try {
  const registered = await state.store.registerProject(workspace, { label: 'P13 sample' });
  if (registered.status === 'relocation_required') throw new Error('unexpected relocation');
  const projectId = registered.project.id;
  const service = new ChangeService(state.store);

  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'P13 sample']);
  git(workspace, ['config', 'user.email', 'p13@example.invalid']);
  git(workspace, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(workspace, 'a.txt'), 'a committed\n', 'utf8');
  await writeFile(path.join(workspace, 'b.txt'), 'b committed\n', 'utf8');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'initial']);
  record('repository', await service.gitStatus(workspace));

  const baseline = await service.captureBaseline({
    projectId,
    workspace,
    label: 'task start',
  });
  record('baseline', { id: baseline.id, fileCount: baseline.fileCount });

  // A user stages a change before the agent work, then the agent changes b.txt.
  await writeFile(path.join(workspace, 'a.txt'), 'a user staged\n', 'utf8');
  git(workspace, ['add', 'a.txt']);
  await writeFile(path.join(workspace, 'b.txt'), 'b agent change\n', 'utf8');
  await writeFile(path.join(workspace, 'new.txt'), 'agent new file\n', 'utf8');

  const diff = await service.diff({ projectId, workspace, touchedPaths: ['b.txt', 'new.txt'] });
  record('change report', {
    baseline: diff.baseline,
    counts: diff.counts,
    changes: diff.changes,
    attributionNote: diff.attributionNote,
  });
  record('text diff', await service.diffText(workspace, 'b.txt'));

  const committed = await service.commit(workspace, { message: 'P13 sample: change b only', paths: ['b.txt'] });
  record('selected commit', committed);
  const afterCommit = await service.gitStatus(workspace);
  record('status after selected commit', {
    branch: afterCommit.branch,
    staged: afterCommit.staged.map((entry) => entry.path),
    unstaged: afterCommit.unstaged.map((entry) => entry.path),
    untracked: afterCommit.untracked,
  });

  const receipt = await service.recordTestReceipt({
    projectId,
    command: 'node check.mjs',
    exitCode: 0,
    outcome: 'passed',
    output: 'MONA_P13_CHECK_PASS\n',
    commit: committed.commit,
  });
  record('test receipt', receipt);

  // Restore preview and conflict handling.
  await writeFile(path.join(workspace, 'b.txt'), 'b restored? no: later edit\n', 'utf8');
  const preview = await service.restorePreview(workspace, ['b.txt']);
  record('restore preview', preview);
  const refused = await service.restore(projectId, workspace, {
    paths: ['b.txt'],
    expectedSha256: { 'b.txt': sha('a stale hash') },
  });
  record('restore refused', refused);
  const current = await readFile(path.join(workspace, 'b.txt'), 'utf8');
  const applied = await service.restore(projectId, workspace, {
    paths: ['b.txt'],
    expectedSha256: { 'b.txt': sha(current) },
  });
  record('restore applied', applied);
  record('content after restore', (await readFile(path.join(workspace, 'b.txt'), 'utf8')).trim());

  const report = {
    prompt: 'P13',
    generatedUtc: new Date().toISOString(),
    providerRequests: 0,
    steps,
  };
  if (outFile) await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  state.store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
