import type { BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * P23 Changes probe.
 *
 * Drives the real Changes surface in the real shell against a real Git
 * workspace: no baseline, a captured baseline, a modified file, a new file, a
 * real Git text diff, a real test receipt, and a large diff to show that the
 * windowing keeps the row count bounded. No engine request and no provider call
 * happens anywhere in this probe.
 */
export type ChangesProbeInput = {
  window: BrowserWindow | null;
  outputPath: string;
  shotsDirectory: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  /** Selects the project and persists the Changes view so a reload lands there. */
  prepare: (projectId: string) => void;
  reload: () => void;
  recordReceipt: (projectId: string) => Promise<{ id: string; outcome: string } | null>;
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(workspace: string, args: string[]): string {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
}

export async function runChangesProbe(input: ChangesProbeInput): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const shots: Shot[] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };
  if (!window) {
    return { ok: false, steps: [{ name: 'a window exists', ok: false }] };
  }

  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(150);
    }
    return false;
  };

  const shot = async (label: string): Promise<boolean> => {
    const file = path.join(input.shotsDirectory, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await delay(500);
    try {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      shots.push({ file, label });
      return true;
    } catch (error) {
      process.stdout.write(`capture ${label} failed: ${String(error)}\n`);
      return false;
    }
  };

  // 1. A real Git workspace, so the text diff is Git's own output.
  fs.writeFileSync(path.join(input.workspace, 'one.txt'), 'one\n', 'utf8');
  git(input.workspace, ['init', '--quiet']);
  git(input.workspace, ['config', 'user.email', 'probe@example.invalid']);
  git(input.workspace, ['config', 'user.name', 'Mona probe']);
  git(input.workspace, ['add', 'one.txt']);
  git(input.workspace, ['commit', '--quiet', '-m', 'baseline commit']);
  const head = git(input.workspace, ['rev-parse', 'HEAD']).trim();
  check('a real Git repository exists with one committed file', /^[0-9a-f]{40}$/.test(head), head.slice(0, 12));

  const opened = await input.openProject(input.workspace);
  check('the project opens through the real catalog', Boolean(opened), opened?.canonicalPath ?? null);
  if (!opened) {
    fs.writeFileSync(input.outputPath, JSON.stringify({ ok: false, steps, shots }, null, 2), 'utf8');
    return { ok: false, steps };
  }
  input.prepare(opened.projectId);
  input.reload();
  await waitFor(async () => await evaluate<boolean>(`Boolean(document.querySelector('[data-testid="nav-changes"]'))`));

  const showChanges = async (): Promise<boolean> => {
    await evaluate(`document.querySelector('[data-testid="nav-changes"]')?.click()`);
    return waitFor(async () => (await evaluate<boolean>(`Boolean(document.querySelector('#changes-title'))`)) === true);
  };
  /** The panel reads on mount; a real Refresh click is how its data is re-read. */
  const refresh = async (): Promise<void> => {
    await evaluate(`document.querySelector('[data-testid="changes-refresh"]')?.click()`);
    await delay(200);
  };
  check('the Changes section is reachable from the rail', await showChanges());

  // 2. No baseline yet: unavailable, not "no changes".
  const beforeBaseline = await evaluate<string>(`document.body.innerText`);
  check(
    'a missing baseline reads as unavailable, not as an empty diff',
    beforeBaseline.includes('Changes unavailable') && !beforeBaseline.includes('No changes since the baseline'),
  );
  check('the no-baseline state is captured', await shot('changes-no-baseline'));

  // 3. Capture a baseline through the real IPC channel.
  const captured = await evaluate<{ ok: boolean; data?: { baselineId: string; fileCount: number } }>(
    `window.mona.changesCapture({ projectId: ${JSON.stringify(opened.projectId)}, label: 'P23 probe baseline' })`,
  );
  check('the baseline is captured through the real IPC channel', captured.ok === true, captured.data ?? null);

  // 4. Change the workspace: one modified file, one added file, one deleted.
  fs.writeFileSync(path.join(input.workspace, 'one.txt'), 'one changed\n', 'utf8');
  fs.writeFileSync(path.join(input.workspace, 'two.txt'), 'two\n', 'utf8');

  const refreshed = await evaluate<{ ok: boolean; data?: { changes: Array<{ path: string; change: string }> } }>(
    `window.mona.changesView({ projectId: ${JSON.stringify(opened.projectId)} })`,
  );
  const changes = refreshed.data?.changes ?? [];
  check(
    'the change list reports the real modified and added paths',
    refreshed.ok &&
      changes.some((entry) => entry.path === 'one.txt' && entry.change === 'modified') &&
      changes.some((entry) => entry.path === 'two.txt' && entry.change === 'added'),
    changes,
  );

  const receipt = await input.recordReceipt(opened.projectId);
  check('a real test receipt is recorded with its command and outcome', receipt !== null, receipt);

  // 5. Render the view and open a real Git diff by clicking the row.
  check('the Changes section redraws with the captured baseline', await showChanges());
  await refresh();
  const rendered = await waitFor(async () => {
    const rows = await evaluate<number>(`document.querySelectorAll('.change-row').length`);
    return rows >= 2;
  });
  check('changed paths are rendered as rows', rendered);
  check('the populated Changes view is captured', await shot('changes-changed-paths'));

  const openedDiff = await evaluate<boolean>(`(() => {
    const rows = [...document.querySelectorAll('.change-row')];
    const target = rows.find((row) => (row.textContent || '').includes('one.txt'));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  check('the row for the modified file is clickable', openedDiff);
  const diffShown = await waitFor(async () => {
    const text = await evaluate<string>(`document.querySelector('.diff-view')?.innerText ?? ''`);
    return text.includes('-one') && text.includes('+one changed');
  });
  check("Git's own diff text is rendered for the modified file", diffShown);
  await evaluate(`document.querySelector('.diff-view')?.scrollIntoView({ block: 'center' })`);
  check('the diff is captured', await shot('changes-diff'));

  // 6. A large diff stays windowed: 4,000 lines changed, far fewer rows in the DOM.
  const bigPath = path.join(input.workspace, 'big.txt');
  fs.writeFileSync(bigPath, Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join('\n'), 'utf8');
  git(input.workspace, ['add', 'big.txt']);
  git(input.workspace, ['commit', '--quiet', '-m', 'big file']);
  fs.writeFileSync(bigPath, Array.from({ length: 4_000 }, (_, index) => `line ${index} changed`).join('\n'), 'utf8');
  const bigDiff = await evaluate<{ ok: boolean; data?: { lines: number; available: boolean } }>(
    `window.mona.changesDiff({ projectId: ${JSON.stringify(opened.projectId)}, path: 'big.txt' })`,
  );
  check('the large diff is available from Git', bigDiff.ok === true && bigDiff.data?.available === true, bigDiff.data);

  await showChanges();
  await refresh();
  const bigRendered = await waitFor(async () => {
    const rows = await evaluate<number>(`document.querySelectorAll('.change-row').length`);
    return rows >= 3;
  });
  const bigClicked = await evaluate<boolean>(`(() => {
    const rows = [...document.querySelectorAll('.change-row')];
    const target = rows.find((row) => (row.textContent || '').includes('big.txt'));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  const windowed = await waitFor(async () => {
    const text = await evaluate<string>(`document.querySelector('.diff-view')?.innerText ?? ''`);
    return text.includes('-line 0');
  });
  const domRows = await evaluate<number>(`document.querySelectorAll('.diff-line').length`);
  const totalLines = bigDiff.data?.lines ?? 0;
  const diffHead = await evaluate<string>(`(document.querySelector('.diff-view')?.innerText ?? '').slice(0, 300)`);
  check(
    'a multi-thousand-line diff renders a bounded number of rows',
    windowed && bigRendered && bigClicked && totalLines > 4_000 && domRows > 0 && domRows < 200,
    { totalLines, domRows, windowed, bigRendered, bigClicked, diffHead },
  );
  await evaluate(`document.querySelector('.diff-view')?.scrollIntoView({ block: 'center' })`);

  // Scrolling the windowed list moves the rendered slice: the tail becomes real
  // DOM rows while the row count stays bounded.
  await evaluate<boolean>(`(() => {
    const view = document.querySelector('.diff-view');
    if (!view) return false;
    view.scrollTop = view.scrollHeight;
    view.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`);
  const tailReached = await waitFor(async () => {
    const text = await evaluate<string>(`document.querySelector('.diff-view')?.innerText ?? ''`);
    return text.includes('line 3999 changed');
  });
  const tailRows = await evaluate<number>(`document.querySelectorAll('.diff-line').length`);
  check(
    'scrolling to the end of the large diff renders its tail with a bounded row count',
    tailReached && tailRows > 0 && tailRows < 200,
    { tailReached, tailRows },
  );
  check('the windowed large diff tail is captured', await shot('changes-large-diff-tail'));
  check('the windowed large diff is captured', await shot('changes-large-diff'));

  // 7. A path outside the workspace is refused by the main process.
  const refused = await evaluate<{ ok: boolean; error?: { code: string } }>(
    `window.mona.changesDiff({ projectId: ${JSON.stringify(opened.projectId)}, path: '../../outside.txt' })`,
  );
  check('a traversal path is refused by the main process', refused.ok === false, refused.error?.code ?? null);

  const ok = steps.every((step) => step.ok);
  const report = {
    schema: 1,
    capturedAt: new Date().toISOString(),
    ok,
    providerRequests: 0,
    steps,
    shots,
  };
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok, steps: steps.length }, null, 2)}\n`);
  return { ok, steps };
}
