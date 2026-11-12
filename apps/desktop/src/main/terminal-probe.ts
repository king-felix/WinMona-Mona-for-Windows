import type { BrowserWindow } from 'electron';
import { app, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * P18/PTY live probe in a real Electron window: a real ConPTY, the real xterm
 * renderer, the real IPC path. It proves a command runs, its output reaches the
 * screen, output arrives as inert text, resize reaches the PTY, search finds
 * text, and ending the session is the only thing that kills it.
 */
export type TerminalProbeResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: unknown }>;
  shots: Array<{ file: string; label: string }>;
  session: unknown;
  typedVia: 'keyboard' | 'bridge' | 'none';
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  capturedAt: string;
};

export type TerminalProbeInput = {
  window: BrowserWindow;
  rendererIndex: string;
  workspace: string;
  shotsDirectory: string;
  outputPath: string;
};

type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };
type ProjectView = { id: string; label: string; canonicalPath: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loaded(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function createWorkspace(root: string): string {
  const folder = path.join(root, 'p18-terminal-project');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# PTY fixture\n', 'utf8');
  return folder;
}

export async function runTerminalProbe(input: TerminalProbeInput): Promise<TerminalProbeResult> {
  const steps: TerminalProbeResult['steps'] = [];
  const shots: TerminalProbeResult['shots'] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 700)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const call = async <T>(expression: string): Promise<Envelope<T>> => evaluate<Envelope<T>>(expression);
  const text = async (selector: string): Promise<string | null> =>
    evaluate<string | null>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? (node.textContent ?? '') : null; })()`,
    );
  const waitFor = async (probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await delay(200);
    }
    return false;
  };
  const clickText = async (prefix: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent ?? '').trim().startsWith(${JSON.stringify(prefix)}));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
  const shot = async (label: string): Promise<boolean> => {
    const file = path.join(input.shotsDirectory, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await delay(600);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        shots.push({ file, label });
        return true;
      } catch (error) {
        process.stdout.write(`capture ${label} attempt ${attempt} failed: ${String(error)}\n`);
        await delay(500);
      }
    }
    return false;
  };
  const screenText = async (): Promise<string> =>
    evaluate<string>(
      `(() => { const rows = document.querySelector('.xterm-rows'); return rows ? (rows.textContent ?? '') : ''; })()`,
    );

  const folder = createWorkspace(input.workspace);
  fs.mkdirSync(input.shotsDirectory, { recursive: true });
  await loaded(window);
  await delay(600);

  const opened = await call<{ status: string; project: ProjectView }>(
    `window.mona.openProject(${JSON.stringify(folder)})`,
  );
  check(
    'the fixture project opens in the real catalog',
    opened.ok && (opened.data?.project.canonicalPath ?? '').toLowerCase() === folder.toLowerCase(),
    opened.ok ? { status: opened.data?.status } : opened.error,
  );
  if (!opened.ok || !opened.data) throw new Error('the probe could not register its fixture project');
  const projectId = opened.data.project.id;

  await window.loadFile(input.rendererIndex);
  await loaded(window);
  await delay(800);

  const toggled = await clickText('Terminal');
  check('the Terminal control opens the drawer', toggled);
  const drawerVisible = await waitFor(async () => {
    const hidden = await evaluate<boolean>(
      `(() => { const node = document.querySelector('[data-testid="terminal-drawer"]'); return node ? node.hasAttribute('hidden') : true; })()`,
    );
    return !hidden;
  }, 10_000);
  check('the drawer is visible', drawerVisible);

  const started = await waitFor(async () => {
    const cwd = await text('[data-testid="terminal-cwd"]');
    return cwd !== null && cwd.toLowerCase().includes('p18-terminal-project');
  }, 20_000);
  check('a shell starts in the open project folder', started, {
    cwd: await text('[data-testid="terminal-cwd"]'),
  });
  check(
    'the terminal rendered through xterm',
    (await evaluate<boolean>(`Boolean(document.querySelector('.xterm'))`)) === true,
  );
  await shot('terminal-started');

  // Type through the real xterm textarea. If a synthetic key does not reach
  // xterm's key handling in this environment, fall back to the same bridge the
  // renderer uses and record which path produced the output.
  let typedVia: TerminalProbeResult['typedVia'] = 'none';
  const command = 'echo MONA_TERMINAL_OK';
  // Focus the real window first: Chromium only routes text input to a focused
  // document, and a hidden probe window would silently drop it.
  window.show();
  window.focus();
  window.webContents.focus();
  app.focus({ steal: true });
  await delay(400);

  const typed = await evaluate<boolean>(`(() => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!textarea) return false;
    textarea.focus();
    const value = ${JSON.stringify(command)};
    // xterm reads typed text from the textarea's input event, exactly as a real
    // keyboard does in Chromium; synthetic keydown alone inserts nothing.
    textarea.value = value;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    textarea.value = '';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    const focused = document.activeElement === textarea;
    return focused;
  })()`);
  if (typed) {
    const echoed = await waitFor(async () => (await screenText()).split('MONA_TERMINAL_OK').length > 1, 6_000);
    if (echoed) typedVia = 'keyboard';
  }

  if (typedVia === 'none') {
    const sessionId = await evaluate<string | null>(
      `(() => { const node = document.querySelector('[data-testid="terminal-drawer"]'); return node ? node.getAttribute('data-session-id') : null; })()`,
    );
    if (sessionId) {
      const sent = await call<{ accepted: number }>(
        `window.mona.terminalInput({ projectId: ${JSON.stringify(projectId)}, sessionId: ${JSON.stringify(sessionId)}, data: ${JSON.stringify(`${command}\r`)} })`,
      );
      if (sent.ok) typedVia = 'bridge';
    }
  }

  const bootOk = await waitFor(async () => (await screenText()).includes('MONA_TERMINAL_OK'), 8_000);
  check('a command typed at the prompt produces real shell output', bootOk, {
    typedVia,
    screen: (await screenText()).slice(0, 400),
  });
  check(
    'terminal output contains no clickable links',
    (await evaluate<number>(`document.querySelectorAll('.xterm a').length`)) === 0,
  );
  check(
    'terminal output contains no images or frames',
    (await evaluate<number>(`document.querySelectorAll('.xterm img, .xterm iframe').length`)) === 0,
  );

  // Resize: the drawer fits to the window and reports the new size to the PTY.
  const before = await text('[data-testid="terminal-cwd"]');
  window.setContentSize(1100, 760);
  await delay(700);
  const resized = await waitFor(async () => {
    const now = await text('[data-testid="terminal-cwd"]');
    return now !== null && now !== before;
  }, 6_000);
  check('resizing the window resizes the terminal and the PTY reports it', resized, {
    before,
    after: await text('[data-testid="terminal-cwd"]'),
  });
  await shot('terminal-resized');

  // Copy with nothing selected must say so instead of copying something stale.
  await clickText('Copy');
  const emptyNotice = await waitFor(async () => {
    const notice = await text('[data-testid="terminal-notice"]');
    return notice !== null && notice.startsWith('Select text');
  }, 3_000);
  check('Copy with no selection explains what to do', emptyNotice, {
    notice: await text('[data-testid="terminal-notice"]'),
  });

  // Search: the search control reports whether it found the text.
  await evaluate<boolean>(`(() => {
    const input = document.querySelector('[data-testid="terminal-search"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, 'MONA_TERMINAL_OK');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  const found = await waitFor(
    async () => (await text('[data-testid="terminal-search-status"]')) === 'Match found',
    4_000,
  );
  const missing = await evaluate<boolean>(`(() => {
    const input = document.querySelector('[data-testid="terminal-search"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, 'ZZZ_NOT_IN_OUTPUT');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const notFound = await waitFor(
    async () => (await text('[data-testid="terminal-search-status"]')) === 'No match',
    4_000,
  );
  check('search reports a real hit and a real miss', found && missing && notFound, {
    hit: await text('[data-testid="terminal-search-status"]'),
  });
  await shot('terminal-search');

  // Copy all writes the real buffer to the OS clipboard; the probe reads it
  // back from the main process, so this is not a mocked clipboard.
  clipboard.writeText('');
  await delay(150);
  await clickText('Copy all');
  const copiedNotice = await waitFor(async () => {
    const notice = await text('[data-testid="terminal-notice"]');
    return notice !== null && notice.startsWith('Copied');
  }, 4_000);
  await delay(300);
  const clipboardText = await clipboard.readText();
  check(
    'Copy all puts the real terminal buffer on the OS clipboard',
    copiedNotice && clipboardText.includes('MONA_TERMINAL_OK'),
    { chars: clipboardText.length, hasCommand: clipboardText.includes('MONA_TERMINAL_OK') },
  );

  // The session survives leaving the drawer; only End session kills it.
  const sessionId = await evaluate<string | null>(
    `(() => { const node = document.querySelector('[data-testid="terminal-drawer"]'); return node ? node.getAttribute('data-session-id') : null; })()`,
  );
  await clickText('Close');
  await delay(400);
  const drawerGone = await evaluate<boolean>(`document.querySelector('[data-testid="terminal-drawer"]') === null`);
  check('closing the drawer releases the renderer surface', drawerGone, { sessionId });
  const stillAlive = sessionId
    ? await call<{ session: { state: string }; data: string }>(
        `window.mona.terminalRefresh({ projectId: ${JSON.stringify(projectId)}, sessionId: ${JSON.stringify(sessionId)} })`,
      )
    : null;
  check(
    'the shell keeps running in main after the drawer closes',
    stillAlive?.ok === true &&
      stillAlive.data?.session.state === 'running' &&
      (stillAlive.data?.data ?? '').includes('MONA_TERMINAL_OK'),
    stillAlive?.ok ? { state: stillAlive.data?.session.state, bytes: stillAlive.data?.data.length } : stillAlive?.error,
  );
  await clickText('Terminal');
  await delay(500);
  const replayed = await waitFor(async () => (await screenText()).includes('MONA_TERMINAL_OK'), 8_000);
  check('reopening the drawer replays bounded scrollback', replayed, {
    screen: (await screenText()).slice(0, 200),
  });
  await shot('terminal-reopened');

  const ended = await clickText('End session');
  check('End session is available', ended);
  const exitShown = await waitFor(async () => {
    const exit = await text('[data-testid="terminal-exit"]');
    const notice = await text('[data-testid="terminal-notice"]');
    return exit !== null || (notice ?? '').includes('Session ended');
  }, 8_000);
  check('ending the session reports an exit instead of a silent close', exitShown, {
    exit: await text('[data-testid="terminal-exit"]'),
    notice: await text('[data-testid="terminal-notice"]'),
  });
  await shot('terminal-ended');

  // The renderer bridge must not expose any shell or exec capability.
  const bridge = await evaluate<{ keys: string[]; hasExec: boolean; hasSpawn: boolean; hasRequire: boolean }>(
    `(() => {
      const keys = Object.keys(window.mona ?? {});
      return {
        keys,
        hasExec: keys.some((key) => /^(exec|spawn|shell|runCommand|eval)$/i.test(key)),
        hasSpawn: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
        hasRequire: typeof window.ipcRenderer !== 'undefined',
      };
    })()`,
  );
  check(
    'the bridge exposes only named terminal methods and no shell or Node globals',
    bridge.keys.includes('terminalInput') &&
      bridge.keys.includes('terminalKill') &&
      !bridge.hasExec &&
      !bridge.hasSpawn &&
      !bridge.hasRequire,
    { keys: bridge.keys.filter((key) => key.startsWith('terminal')), hasExec: bridge.hasExec },
  );

  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    session: {
      screen: (await screenText()).slice(0, 2_000),
      cwd: await text('[data-testid="terminal-cwd"]'),
      exit: await text('[data-testid="terminal-exit"]'),
    },
    typedVia,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: process.platform,
    capturedAt: new Date().toISOString(),
  };
}

export function writeTerminalProbe(result: TerminalProbeResult, outputPath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
