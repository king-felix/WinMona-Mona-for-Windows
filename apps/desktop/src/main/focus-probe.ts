import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BrowserWindow } from 'electron';

/**
 * Live probe for W06: Focus Studio and the desktop window's real fullscreen.
 *
 * It seeds a long stored timeline for the session the window is showing (so the
 * reader has somewhere to scroll back to), then drives the real composer and the
 * real native window: Focus on/off, fullscreen through the button and through
 * F11, a drawer held open across the transition, minimize/restore, and a scroll
 * position that must survive all of it. No runtime is started and no prompt is
 * accepted, so provider requests stay 0.
 *
 * The window state it reports comes from the main process (`isFullScreen()`),
 * not from a flag the renderer set.
 */
export type FocusProbeInput = {
  window: BrowserWindow;
  outputPath: string;
  shotsDirectory: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  database: () => DatabaseSync | null;
  sessionId: (projectId: string) => string | null;
  reload: () => void;
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runFocusProbe(input: FocusProbeInput): Promise<{
  ok: boolean;
  steps: Step[];
  shots: Shot[];
  capturedAt: string;
  providerRequests: 0;
  limitation: string;
}> {
  const steps: Step[] = [];
  const shots: Shot[] = [];
  const window = input.window;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(120);
    }
    return false;
  };
  const shot = async (label: string): Promise<void> => {
    const file = path.join(input.shotsDirectory, `${label}.png`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const image = await window.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      shots.push({ file, label });
    } catch {
      /* a capture failure is not a contract failure */
    }
  };
  const nativeState = async (): Promise<{ fullScreen: boolean; maximized: boolean; width: number; height: number }> => {
    const result = (await evaluate<unknown>(`window.mona.windowStateGet().then((r) => (r.ok ? r.data : null))`)) as {
      fullScreen: boolean;
      maximized: boolean;
      width: number;
      height: number;
    } | null;
    if (!result) throw new Error('window state unavailable');
    return result;
  };
  const focusMode = async (): Promise<boolean> =>
    (await evaluate<boolean>(`document.querySelector('.app-shell')?.classList.contains('focus-mode') === true`)) ===
    true;
  const click = async (testId: string): Promise<boolean> =>
    (await evaluate<boolean>(`(() => {
      const node = document.querySelector('[data-testid="${testId}"]');
      if (!node) return false;
      node.click();
      return true;
    })()`)) === true;

  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  const project = await input.openProject(input.workspace);
  check('a real project opens through the catalog', project !== null, project?.canonicalPath ?? null);
  if (!project) {
    return {
      ok: false,
      steps,
      shots,
      capturedAt: new Date().toISOString(),
      providerRequests: 0,
      limitation: 'no project opened',
    };
  }
  await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
  const composerUp = await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector("#draft"))')) === true,
  );
  check('the real composer is on screen', composerUp);
  if (!composerUp) {
    return {
      ok: false,
      steps,
      shots,
      capturedAt: new Date().toISOString(),
      providerRequests: 0,
      limitation: 'no composer',
    };
  }
  await delay(400);

  // 1. Seed a long stored conversation for the session the window is showing,
  //    then reload so the studio replays it. No runtime and no provider request.
  const session = input.sessionId(project.projectId);
  const database = input.database();
  let seeded = 0;
  if (session && database) {
    const threadId = `thr_w06_${Date.now().toString(36)}`;
    const stamp = new Date().toISOString();
    database
      .prepare(
        'INSERT INTO threads (id, project_id, engine_thread_id, workspace, last_seq, created_at, updated_at, session_id, mode, profile_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(threadId, project.projectId, `w06-${threadId}`, project.canonicalPath, 400, stamp, stamp, session, 'agent');
    const insert = database.prepare(
      'INSERT INTO timeline_items (id, project_id, thread_id, turn_id, seq, kind, title, body, status, truncated, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)',
    );
    database.exec?.('BEGIN');
    for (let index = 1; index <= 400; index += 1) {
      insert.run(
        `w06_${threadId}_${index}`,
        project.projectId,
        threadId,
        index,
        index % 5 === 0 ? 'tool' : 'assistant',
        `Stored event ${index}`,
        `Fixture body ${index}: the timeline must keep what the reader was reading.`,
        stamp,
        stamp,
      );
      seeded += 1;
    }
    database.exec?.('COMMIT');
    input.reload();
    await waitFor(async () => (await evaluate<boolean>('Boolean(document.querySelector("#draft"))')) === true);
    await waitFor(
      async () => (await evaluate<number>("document.querySelectorAll('.timeline-item').length")) > 0,
      20_000,
    );
    await delay(700);
  }
  check('a stored conversation is on screen for the scroll test', seeded > 0, { seeded });

  // 2. Typing, caret and scroll position are set up before the transitions.
  await evaluate(`(() => {
    const node = document.querySelector('#draft');
    if (!node) return false;
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(node, 'keep this draft while the window changes');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.setSelectionRange(9, 9);
    return true;
  })()`);
  await delay(200);
  const before = {
    state: await nativeState(),
    focus: await focusMode(),
    draft: await evaluate<string>('document.querySelector("#draft")?.value ?? ""'),
    caret: await evaluate<number>('document.querySelector("#draft")?.selectionStart ?? -1'),
    scrollTop: await evaluate<number>(`(() => {
      const node = document.querySelector('.timeline');
      if (!node) return -1;
      node.scrollTop = Math.max(0, Math.round(node.scrollHeight * 0.35));
      node.dataset.w06Tag = 'anchor';
      return node.scrollTop;
    })()`),
    topSeq: await evaluate<number | null>(`(() => {
      const node = document.querySelector('.timeline');
      if (!node) return null;
      const top = node.getBoundingClientRect().top;
      const first = [...node.querySelectorAll('[data-seq]')].find((item) => item.getBoundingClientRect().bottom > top + 1);
      return first ? Number(first.getAttribute('data-seq')) : null;
    })()`),
  };
  check('the window starts normal, not full screen', before.state.fullScreen === false && before.focus === false, {
    ...before.state,
    focus: before.focus,
  });
  await shot('focus-01-normal');

  // 3. Focus Studio: the conversation fills the content area, controls stay.
  await click('studio-focus-toggle');
  const focused = await waitFor(async () => (await focusMode()) === true);
  const focusDetail = await evaluate<{
    topbarHidden: boolean;
    railHidden: boolean;
    interruptVisible: boolean;
    exitVisible: boolean;
    draft: string;
    caret: number;
    scrollTop: number;
    topSeq: number | null;
  }>(`(() => {
    const topbar = document.querySelector('.topbar');
    const rail = document.querySelector('.rail');
    const exit = document.querySelector('[data-testid="studio-focus-toggle"]');
    const interrupt = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Interrupt now');
    const draft = document.querySelector('#draft');
    const timeline = document.querySelector('.timeline');
    const top = timeline?.getBoundingClientRect().top ?? 0;
    const first = timeline
      ? [...timeline.querySelectorAll('[data-seq]')].find((item) => item.getBoundingClientRect().bottom > top + 1)
      : undefined;
    return {
      topbarHidden: !topbar || getComputedStyle(topbar).display === 'none',
      railHidden: !rail || getComputedStyle(rail).display === 'none',
      interruptVisible: Boolean(interrupt && interrupt.getBoundingClientRect().height > 0),
      exitVisible: Boolean(exit && exit.getBoundingClientRect().height > 0),
      draft: draft?.value ?? '',
      caret: draft?.selectionStart ?? -1,
      scrollTop: timeline?.scrollTop ?? -1,
      topSeq: first ? Number(first.getAttribute('data-seq')) : null,
    };
  })()`);
  check(
    'Focus fills the window and keeps exit, context and interrupt',
    focused &&
      focusDetail.topbarHidden &&
      focusDetail.railHidden &&
      focusDetail.exitVisible &&
      focusDetail.interruptVisible,
    focusDetail,
  );
  check(
    'Focus keeps the draft, the caret and the scroll anchor',
    focusDetail.draft === before.draft && focusDetail.caret === before.caret && focusDetail.topSeq === before.topSeq,
    {
      draft: focusDetail.draft,
      caret: focusDetail.caret,
      topSeq: focusDetail.topSeq,
      expectedTopSeq: before.topSeq,
      scrollTop: focusDetail.scrollTop,
      expectedScrollTop: before.scrollTop,
    },
  );
  await shot('focus-02-focus');

  // 4. Real fullscreen through the narrow window boundary.
  await click('studio-fullscreen-toggle');
  const entered = await waitFor(async () => (await nativeState()).fullScreen === true);
  const fullDetail = await evaluate<{
    draft: string;
    caret: number;
    scrollTop: number;
    topSeq: number | null;
    focus: boolean;
  }>(`(() => {
    const draft = document.querySelector('#draft');
    const timeline = document.querySelector('.timeline');
    const top = timeline?.getBoundingClientRect().top ?? 0;
    const first = timeline
      ? [...timeline.querySelectorAll('[data-seq]')].find((item) => item.getBoundingClientRect().bottom > top + 1)
      : undefined;
    return {
      draft: draft?.value ?? '',
      caret: draft?.selectionStart ?? -1,
      scrollTop: timeline?.scrollTop ?? -1,
      tagged: timeline?.dataset.w06Tag ?? null,
      clientHeight: timeline?.clientHeight ?? -1,
      scrollHeight: timeline?.scrollHeight ?? -1,
      topSeq: first ? Number(first.getAttribute('data-seq')) : null,
      focus: document.querySelector('.app-shell')?.classList.contains('focus-mode') === true,
    };
  })()`);
  check('the native window reports full screen', entered && (await nativeState()).fullScreen === true);
  check(
    'full screen keeps the draft, caret, scroll anchor and Focus',
    fullDetail.draft === before.draft &&
      fullDetail.caret === before.caret &&
      fullDetail.topSeq === before.topSeq &&
      fullDetail.focus,
    fullDetail,
  );
  await shot('focus-03-fullscreen');

  // 5. F11 belongs to the window: it leaves fullscreen once, not twice.
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
  const leftByF11 = await waitFor(async () => (await nativeState()).fullScreen === false);
  check('F11 leaves full screen exactly once', leftByF11 && (await nativeState()).fullScreen === false);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
  const backByF11 = await waitFor(async () => (await nativeState()).fullScreen === true);
  check('F11 re-enters full screen', backByF11);

  // 6. A drawer stays open across the transition.
  const drawerOpened = await evaluate<boolean>(
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Terminal');
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  await delay(600);
  const drawerBefore = await evaluate<boolean>(`Boolean(document.querySelector('.terminal-drawer'))`);
  await click('studio-fullscreen-toggle');
  await waitFor(async () => (await nativeState()).fullScreen === false);
  const drawerAfter = await evaluate<boolean>(`Boolean(document.querySelector('.terminal-drawer'))`);
  check('an open drawer survives leaving full screen', drawerOpened && drawerBefore && drawerAfter, {
    drawerOpened,
    drawerBefore,
    drawerAfter,
  });
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Terminal');
    if (button) button.click();
    return true;
  })()`);
  await delay(300);

  // 7. Minimize and restore must not lose the window or the renderer.
  window.minimize();
  await delay(500);
  const minimized = window.isMinimized();
  window.restore();
  await delay(700);
  const restored = !window.isMinimized() && !window.isDestroyed();
  check('minimize and restore keep the window usable', minimized && restored, { minimized, restored });

  // 8. Leaving Focus restores the normal shell and the normal window state.
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  // The composer still holds focus, so Escape must not leave Focus from there.
  const stillFocusedAfterComposerEscape = await focusMode();
  const focusedElement = await evaluate<string>(`(() => {
    const timeline = document.querySelector('.timeline');
    if (!timeline) return 'no-timeline';
    timeline.focus();
    return document.activeElement?.className ?? 'none';
  })()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  const leftFocus = await waitFor(async () => (await focusMode()) === false);
  const after = await nativeState();
  const afterDraft = await evaluate<string>('document.querySelector("#draft")?.value ?? ""');
  check('Escape in the composer does not leave Focus', stillFocusedAfterComposerEscape);
  check('Escape from the page leaves Focus', leftFocus, { focus: await focusMode(), focusedElement });
  check(
    'the window is not left in full screen, and the draft survived every transition',
    after.fullScreen === false && afterDraft === before.draft,
    { fullScreen: after.fullScreen, draft: afterDraft },
  );
  await shot('focus-04-exited');

  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    capturedAt: new Date().toISOString(),
    providerRequests: 0,
    limitation:
      "No runtime was started, so these transitions were not exercised during a live streaming turn; that needs a paid turn and is recorded as such. The window state is the main process's own isFullScreen() reading.",
  };
}
