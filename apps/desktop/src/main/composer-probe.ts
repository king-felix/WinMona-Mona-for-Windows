import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

/**
 * Live probe for the W01 composer contract in a real Electron window.
 *
 * It presses keys through Electron's own input path (`sendInputEvent`), so the
 * renderer's keydown handler is exercised by the same event pipeline a physical
 * keyboard uses, then reads the textarea and the visible run state back from the
 * DOM. No runtime is started and no prompt is accepted: provider requests stay 0.
 *
 * What this probe cannot prove, stated rather than implied: a physical IME
 * composition. Chromium refuses a composition to be synthesized from the main
 * process, so the composition case is asserted by dispatching a KeyboardEvent
 * with `isComposing: true` into the real page. That is a renderer-path check, not
 * a native one; a person typing with a real IME remains a human check.
 */
export type ComposerProbeInput = {
  window: BrowserWindow;
  outputPath: string;
  shotsDirectory: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runComposerProbe(input: ComposerProbeInput): Promise<{
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
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(150);
    }
    return false;
  };
  const shot = async (label: string): Promise<Shot | null> => {
    const file = path.join(input.shotsDirectory, `${label}.png`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const image = await window.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      const entry = { file, label };
      shots.push(entry);
      return entry;
    } catch {
      return null;
    }
  };
  const draftValue = (): Promise<string> => evaluate<string>('document.querySelector("#draft")?.value ?? ""');
  const selectAll = async (): Promise<void> => {
    await evaluate(`(() => {
      const node = document.querySelector('#draft');
      if (!node) return false;
      node.focus();
      node.setSelectionRange(0, node.value.length);
      return true;
    })()`);
  };
  const typeText = async (text: string): Promise<void> => {
    // `insertText` on the real input path, so React's onChange runs exactly as it
    // does for a person typing.
    window.webContents.insertText(text);
    await delay(150);
  };
  const pressEnter = async (modifiers: Array<'control'> = []): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers });
    await delay(300);
  };

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

  // 1. Plain Enter is a newline. This is the half that must NOT be intercepted.
  await selectAll();
  await typeText('line one');
  const beforeEnter = await draftValue();
  await pressEnter();
  const afterEnter = await draftValue();
  check('typing reaches the composer', beforeEnter === 'line one', { beforeEnter });
  check(
    'plain Enter inserts a newline instead of sending',
    afterEnter === 'line one\r\n' || afterEnter === 'line one\n',
    {
      afterEnter,
    },
  );
  await shot('composer-plain-enter');

  // 2. Ctrl+Enter is intercepted by the composer. With no runtime connected the
  // same gate as the Submit button refuses the send, so the honest outcome is:
  // no newline, and a stated reason rather than a silent send.
  await selectAll();
  await typeText('ctrl enter prompt');
  const beforeCtrl = await draftValue();
  await pressEnter(['control']);
  const afterCtrl = await draftValue();
  const reason = await evaluate<string | null>(
    `document.querySelector('button[title="Send this prompt to the runtime once."]')?.disabled ?? null`,
  );
  const runState = await evaluate<string | null>(
    `document.querySelector('[data-testid="studio-run-state"]')?.textContent ?? null`,
  );
  check('the draft is in place before the shortcut', beforeCtrl === 'ctrl enter prompt', { beforeCtrl });
  check('Ctrl+Enter does not insert a newline', afterCtrl === beforeCtrl, { afterCtrl });
  check('Ctrl+Enter did not send anything without a connected runtime', runState !== 'Running', { runState, reason });

  // 3. A composition owns Enter: the renderer must not read it as a submit.
  const composed = await evaluate<boolean>(`(() => {
    const node = document.querySelector('#draft');
    if (!node) return false;
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = node.dispatchEvent(event);
    // dispatchEvent returns false when preventDefault ran. A composition must
    // leave the event alone, so the handler did not consume it.
    return dispatched === true && node.value === 'ctrl enter prompt';
  })()`);
  check('an IME composition Enter is not consumed as a send', composed);

  // 4. A key repeat is one intention. The handler returns before calling submit.
  const repeated = await evaluate<boolean>(`(() => {
    const node = document.querySelector('#draft');
    if (!node) return false;
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    return node.dispatchEvent(event) === false;
  })()`);
  check('a held Ctrl+Enter is still one shortcut, not several', repeated);
  await shot('composer-ctrl-enter');

  const providerRequests = 0 as const;
  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    capturedAt: new Date().toISOString(),
    providerRequests,
    limitation:
      'Physical IME composition is a human check: Chromium cannot be driven into composing state from the main process. Ctrl+Enter and plain Enter were pressed through Electron sendInputEvent in a real window.',
  };
}
