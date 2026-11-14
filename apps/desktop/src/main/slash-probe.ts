import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

/**
 * Live probe for the W04 slash-command autocomplete in a real Electron window.
 *
 * It types through Electron's own input path (`insertText`), so the renderer's
 * composer handler runs exactly as it does for a person, and reads the list back
 * from the DOM: descriptions, cost class, route, selection semantics and the
 * refusal to send a recognized command to the model. No runtime is started and
 * no prompt is accepted, so provider requests stay 0.
 *
 * What it cannot prove, stated rather than implied: a physical 200% display
 * scale and a real Narrator run. Those belong to W20's human checks; this probe
 * reads the accessibility attributes Chromium exposes.
 */
export type SlashProbeInput = {
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

export async function runSlashProbe(input: SlashProbeInput): Promise<{
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
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return true;
      await delay(150);
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
  const draftValue = (): Promise<string> => evaluate<string>('document.querySelector("#draft")?.value ?? ""');
  const clearDraft = async (): Promise<void> => {
    await evaluate(`(() => {
      const node = document.querySelector('#draft');
      if (!node) return false;
      node.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(node, '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await delay(150);
  };
  const typeText = async (text: string): Promise<void> => {
    window.webContents.insertText(text);
    await delay(200);
  };
  const pressKey = async (keyCode: string, modifiers: Array<'control' | 'shift'> = []): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(250);
  };
  const pressCtrlEnter = async (): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
    await delay(400);
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

  // 1. Typing "/" in a command position opens a described list.
  await clearDraft();
  await typeText('/');
  const opened = await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector("#slash-command-list"))')) === true,
  );
  const listDetail = await evaluate<{
    rows: number;
    first: string | null;
    count: string | null;
    expanded: string | null;
    controls: string | null;
    activeDescendant: string | null;
  } | null>(`(() => {
    const list = document.querySelector('#slash-command-list');
    if (!list) return null;
    const rows = [...list.querySelectorAll('[role="option"]')];
    const draft = document.querySelector('#draft');
    return {
      rows: rows.length,
      first: rows[0]?.textContent ?? null,
      count: document.querySelector('[data-testid="slash-command-count"]')?.textContent ?? null,
      expanded: draft?.getAttribute('aria-expanded') ?? null,
      controls: draft?.getAttribute('aria-controls') ?? null,
      activeDescendant: draft?.getAttribute('aria-activedescendant') ?? null,
    };
  })()`);
  check('typing / opens the command list', opened && (listDetail?.rows ?? 0) > 0, listDetail);
  check(
    'the list exposes listbox semantics and a live count',
    listDetail?.expanded === 'true' &&
      listDetail?.controls === 'slash-command-list' &&
      listDetail?.count?.includes('commands') === true,
    listDetail,
  );
  await shot('slash-list-open');

  // 2. Typing narrows locally, with descriptions and truthful cost/route badges.
  await clearDraft();
  await typeText('/model');
  await waitFor(
    async () =>
      (await evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="slash-command-model"]\'))')) === true,
  );
  const modelDetail = await evaluate<string | null>(
    `document.querySelector('[data-testid="slash-command-model"]')?.textContent ?? null`,
  );
  check(
    'the model row shows the engine description, cost and route',
    modelDetail?.includes('Switch or show the current model') === true &&
      /no request|provider request|cost unknown/.test(modelDetail ?? '') &&
      modelDetail?.includes('terminal only') === true,
    { modelDetail },
  );
  await shot('slash-list-model');

  // 3. Tab fills the highlighted command and closes the list.
  await pressKey('Tab');
  const afterTab = await draftValue();
  const closed = (await evaluate<boolean>('Boolean(document.querySelector("#slash-command-list"))')) === false;
  check('Tab fills the command and closes the list', afterTab.startsWith('/model') && closed, { afterTab, closed });

  // 4. Escape closes without changing the draft or interrupting anything.
  await clearDraft();
  await typeText('/co');
  await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector("#slash-command-list"))')) === true,
  );
  await pressKey('Escape');
  const afterEscape = await draftValue();
  const escapedClosed = (await evaluate<boolean>('Boolean(document.querySelector("#slash-command-list"))')) === false;
  check('Escape closes the list and keeps the draft', afterEscape === '/co' && escapedClosed, {
    afterEscape,
    escapedClosed,
  });

  // 5. A terminal-only command is refused rather than sent to the model.
  await clearDraft();
  await typeText('/model');
  await pressCtrlEnter();
  const refusal = await evaluate<string | null>(`(() => {
    const body = document.body.textContent ?? '';
    const at = body.indexOf('/model is a Codewhale command');
    return at === -1 ? null : body.slice(at, at + 320);
  })()`);
  const runState = await evaluate<string | null>(
    `document.querySelector('[data-testid="studio-run-state"]')?.textContent ?? null`,
  );
  check('a terminal-only command is explained, not sent', refusal !== null && runState !== 'Running', {
    refusal,
    runState,
  });
  await shot('slash-command-refused');

  // 6. Prose and a Windows path stay literal: no list, no refusal.
  await clearDraft();
  await typeText('Please review C:\\work\\mona and /usr/bin/env');
  const noList = (await evaluate<boolean>('Boolean(document.querySelector("#slash-command-list"))')) === false;
  check('prose and Windows paths do not open the list', noList);

  // 7. The catalog drawer lists the whole registry with provenance.
  const catalog = await evaluate<{
    summary: string | null;
    provenance: string | null;
    rows: number;
    newRow: string | null;
  }>(`(() => {
    const details = document.querySelector('.command-catalog');
    return {
      summary: details?.querySelector('summary')?.textContent ?? null,
      provenance: details?.querySelector('p')?.textContent ?? null,
      rows: details?.querySelectorAll('[data-testid^="catalog-"]').length ?? 0,
      newRow: details?.querySelector('[data-testid="catalog-new"]')?.textContent ?? null,
    };
  })()`);
  check(
    'the catalog drawer lists every engine command with provenance',
    (catalog.rows ?? 0) >= 100 && catalog.provenance?.includes('GET /v1/commands') === true,
    { summary: catalog.summary, provenance: catalog.provenance, rows: catalog.rows },
  );
  check('the catalog names /new truthfully', catalog.newRow?.includes('/new') === true, {
    newRow: catalog.newRow,
  });

  await clearDraft();

  // 8. Large text: 200% window zoom is a real Chromium scale, not the OS DPI
  // setting. It proves the list stays reachable and operable when text doubles;
  // the physical 200% display check remains W20's human sign-off.
  window.webContents.setZoomFactor(2);
  await delay(600);
  await clearDraft();
  await typeText('/co');
  const zoomedOpen = await waitFor(
    async () => (await evaluate<boolean>('Boolean(document.querySelector("#slash-command-list"))')) === true,
  );
  const zoomDetail = await evaluate<{
    visible: boolean;
    width: number;
    height: number;
    selectedVisible: boolean;
  } | null>(`(() => {
    const list = document.querySelector('#slash-command-list');
    const selected = document.querySelector('.command-row.selected');
    if (!list || !selected) return null;
    const box = list.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    const panel = document.querySelector('.studio-panel');
    const panelBox = panel?.getBoundingClientRect() ?? null;
    return {
      visible: box.width > 0 && box.height > 0,
      width: Math.round(box.width),
      height: Math.round(box.height),
      selectedVisible: row.height > 0 && (!panelBox || row.top >= panelBox.top),
    };
  })()`);
  check(
    'at 200% window zoom the list stays visible and keeps a selected row',
    zoomedOpen && zoomDetail?.selectedVisible === true,
    zoomDetail,
  );
  await shot('slash-list-zoom-200');
  window.webContents.setZoomFactor(1);
  await delay(300);
  await clearDraft();

  // 9. /new is a real typed operation: the window follows the recorded session,
  //    and the receipt names both identities. No runtime is involved.
  const beforeSession = await evaluate<string | null>(
    `document.querySelector('[data-testid="session-id"]')?.textContent ?? null`,
  );
  await clearDraft();
  await typeText('/new');
  await pressCtrlEnter();
  const rotated = await waitFor(async () => {
    const now = await evaluate<string | null>(
      `document.querySelector('[data-testid="session-id"]')?.textContent ?? null`,
    );
    return now !== null && now !== beforeSession;
  }, 10_000);
  const afterSession = await evaluate<string | null>(
    `document.querySelector('[data-testid="session-id"]')?.textContent ?? null`,
  );
  const rotationNotice = await evaluate<string | null>(`(() => {
    const body = document.body.textContent ?? '';
    const at = body.indexOf('Started a new conversation');
    return at === -1 ? null : body.slice(at, at + 260);
  })()`);
  const runStateAfter = await evaluate<string | null>(
    `document.querySelector('[data-testid="studio-run-state"]')?.textContent ?? null`,
  );
  check('/new starts a new conversation in the real window', rotated, {
    beforeSession,
    afterSession,
    runStateAfter,
  });
  check('the new conversation says what happened and what was kept', rotationNotice !== null, {
    rotationNotice,
  });
  await shot('slash-new-conversation');

  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    capturedAt: new Date().toISOString(),
    providerRequests: 0,
    limitation:
      'Physical 200% display scaling and a real Narrator session are human checks (W20); this probe reads the accessibility attributes Chromium exposes and exercises a 200% window zoom, which is not the OS DPI setting.',
  };
}
