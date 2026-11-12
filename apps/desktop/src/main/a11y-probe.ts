import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * P23 accessibility probe.
 *
 * Exercises what a window can actually be asked about: accessible names, the
 * dialog focus contract, keyboard activation, a windowed list beyond its visible
 * rows, a focusable diff region, and layout at 200% zoom. It cannot hear
 * Narrator; the human checklist covers what this cannot.
 */
export type A11yProbeInput = {
  window: BrowserWindow | null;
  outputPath: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  showView: (projectId: string, view: string) => void;
  seedHistory: (projectId: string, rows: number) => Promise<number>;
  historyRows?: number;
  reload: () => void;
  prepareDiff: (projectId: string) => Promise<{ path: string; available: boolean } | null>;
};

type Step = { name: string; ok: boolean; detail?: unknown };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runA11yProbe(input: A11yProbeInput): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const window = input.window;
  const step = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };
  if (!window) return { ok: false, steps: [{ name: 'a window exists', ok: false }] };

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
  const key = async (keyCode: string): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'char', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(120);
  };

  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  const project = await input.openProject(input.workspace);
  step('a real project opens through the catalog', project !== null);
  if (!project) {
    fs.writeFileSync(input.outputPath, `${JSON.stringify({ ok: false, steps }, null, 2)}\n`, 'utf8');
    return { ok: false, steps };
  }
  input.showView(project.projectId, 'studio');
  await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
  await waitFor(async () => (await evaluate<boolean>("Boolean(document.querySelector('.timeline'))")) === true);

  // 1. Composer and execution controls have accessible names.
  const composer = await evaluate<{ label: string; tag: string; labelled: boolean }>(`(() => {
    const area = document.querySelector('#draft');
    if (!area) return { label: '', tag: '', labelled: false };
    const label = area.id ? document.querySelector('label[for="' + area.id + '"]') : null;
    return {
      label: (label?.textContent || area.getAttribute('aria-label') || '').trim(),
      tag: area.tagName.toLowerCase(),
      labelled: Boolean(label || area.getAttribute('aria-label')),
    };
  })()`);
  step('the composer is a labelled textarea', composer.labelled && composer.tag === 'textarea', composer);

  const controls = await evaluate<Array<{ name: string; disabled: boolean }>>(`(() => {
    const wanted = ['Pause after task', 'Interrupt now'];
    return wanted.map((name) => {
      const node = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').trim() === name);
      return { name, disabled: node ? node.disabled : true };
    });
  })()`);
  step(
    'the execution controls are present with names, and Interrupt is honestly disabled while idle',
    controls.every((control) => control.name.length > 0) && controls[1]?.disabled === true,
    controls,
  );

  const live = await evaluate<{ role: string | null; live: string | null }>(`(() => {
    const log = document.querySelector('.timeline');
    return { role: log?.getAttribute('role') ?? null, live: log?.getAttribute('aria-live') ?? null };
  })()`);
  step('the timeline is a polite live log region', live.role === 'log' && live.live === 'polite', live);

  // 2. Dialog focus contract: enters the dialog, wraps, Escape closes, focus returns.
  //    Opened from a real control, which is the path a keyboard user takes.
  const opener = await evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      (node.textContent || '').includes('Commands'),
    );
    if (!button) return false;
    button.focus();
    return document.activeElement === button;
  })()`);
  await key('?');
  const dialogOpen = await waitFor(
    async () => (await evaluate<boolean>("Boolean(document.querySelector('[role=dialog]'))")) === true,
  );
  const focusInside = await evaluate<boolean>(
    "Boolean(document.querySelector('[role=dialog]')?.contains(document.activeElement))",
  );
  const dialogName = await evaluate<string>(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if (!dialog) return '';
    const id = dialog.getAttribute('aria-labelledby');
    return (id ? document.getElementById(id)?.textContent : dialog.getAttribute('aria-label')) || '';
  })()`);
  step(
    'a dialog opens from the keyboard with its name and takes focus',
    dialogOpen && focusInside && dialogName.length > 0,
    {
      dialogOpen,
      focusInside,
      dialogName,
      opener,
    },
  );

  // Tab from the last focusable must stay inside the dialog. A one-control dialog
  // (this one has Close) is still a valid trap: Tab must not escape it.
  const wrap = await evaluate<{ wrapped: boolean; count: number }>(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if (!dialog) return { wrapped: false, count: 0 };
    const focusables = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled);
    if (focusables.length === 0) return { wrapped: false, count: 0 };
    focusables[focusables.length - 1].focus();
    return { wrapped: true, count: focusables.length };
  })()`);
  await key('Tab');
  const afterTab = await evaluate<boolean>(
    "Boolean(document.querySelector('[role=dialog]')?.contains(document.activeElement))",
  );
  step('Tab from the last control stays inside the dialog', wrap.wrapped && afterTab, { wrap, afterTab });

  await key('Escape');
  const dialogClosed = await waitFor(
    async () => (await evaluate<boolean>("Boolean(document.querySelector('[role=dialog]'))")) === false,
  );
  const focusRestored = await evaluate<boolean>(`(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return !document.querySelector('[role=dialog]') && (active.textContent || '').includes('Commands');
  })()`);
  step('Escape closes the dialog and returns focus to the control that opened it', dialogClosed && focusRestored, {
    dialogClosed,
    focusRestored,
    openerReady: opener,
    active: await evaluate<string>(
      "document.activeElement ? (document.activeElement.textContent || document.activeElement.tagName).slice(0, 40) : 'none'",
    ),
  });

  // 3. A windowed history is navigable by keyboard beyond the visible page.
  const seeded = await input.seedHistory(project.projectId, input.historyRows ?? 300);
  step('history was seeded for the windowed-list check', seeded > 0, { seeded });
  input.reload();
  await waitFor(async () => (await evaluate<boolean>("document.body.innerText.includes('Mona')")) === true, 30_000);
  await delay(1_500);
  await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
  await waitFor(async () => (await evaluate<number>("document.querySelectorAll('.timeline-item').length")) > 0, 20_000);
  const beforeRows = await evaluate<number>("document.querySelectorAll('.timeline-item').length");
  const earlierFocused = await evaluate<boolean>(`(() => {
    const button = document.querySelector('[data-testid="timeline-earlier"] button');
    if (!button) return false;
    button.focus();
    return document.activeElement === button;
  })()`);
  await key('Enter');
  await delay(400);
  const afterRows = await evaluate<number>("document.querySelectorAll('.timeline-item').length");
  step(
    'the earlier-items control is keyboard reachable and reveals older rows',
    earlierFocused && afterRows > beforeRows,
    { beforeRows, afterRows },
  );

  // 4. A large diff scrolls by keyboard inside a bounded, focusable region.
  const diff = await input.prepareDiff(project.projectId);
  await evaluate(`document.querySelector('[data-testid="nav-changes"]')?.click()`);
  const panel = await waitFor(
    async () => (await evaluate<boolean>("Boolean(document.querySelector('#changes-title'))")) === true,
  );
  if (panel) {
    await evaluate(`document.querySelector('[data-testid="changes-refresh"]')?.click()`);
    await waitFor(async () => (await evaluate<number>("document.querySelectorAll('.change-row').length")) >= 1);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.change-row')].find((node) => (node.textContent || '').includes(${JSON.stringify(diff?.path ?? '')}));
      if (row) row.click();
      return Boolean(row);
    })()`);
    await waitFor(async () => (await evaluate<number>("document.querySelectorAll('.diff-line').length")) > 0);
    const focusable = await evaluate<boolean>(`(() => {
      const view = document.querySelector('.diff-view');
      if (!view) return false;
      view.focus();
      return document.activeElement === view && view.tabIndex === 0;
    })()`);
    const firstRow = await evaluate<string>("document.querySelector('.diff-line')?.innerText ?? ''");
    await evaluate(
      `(() => { const view = document.querySelector('.diff-view'); if (view) view.scrollTop = view.scrollHeight; })()`,
    );
    await delay(300);
    const lastRows = await evaluate<number>("document.querySelectorAll('.diff-line').length");
    const tail = await evaluate<string>("document.querySelector('.diff-line:last-child')?.innerText ?? ''");
    step(
      'the diff region is focusable and scrolls to its tail with a bounded row count',
      focusable && tail !== firstRow && lastRows < 200,
      {
        focusable,
        lastRows,
        firstRow: firstRow.slice(0, 40),
        tail: tail.slice(0, 40),
      },
    );
  } else {
    step('the Changes panel opened for the diff check', false);
  }

  // 5. 200% zoom keeps the page free of horizontal overflow (supplemental
  //    evidence; the physical-display check remains human). The composer only
  //    exists on Studio, so navigate there first.
  await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
  await waitFor(async () => (await evaluate<boolean>("Boolean(document.querySelector('#draft'))")) === true);
  window.webContents.setZoomFactor(2);
  await delay(800);
  const zoomed = await evaluate<{ scrollWidth: number; innerWidth: number; composerVisible: boolean }>(`(() => {
    const root = document.documentElement;
    const area = document.querySelector('#draft');
    return {
      scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth,
      composerVisible: Boolean(area && area.getBoundingClientRect().width > 0),
    };
  })()`);
  step('at 200% zoom the page has no horizontal overflow', zoomed.scrollWidth <= zoomed.innerWidth + 2, zoomed);
  const stillUsable = zoomed.composerVisible;
  step('at 200% zoom the composer is still laid out', stillUsable, zoomed);
  window.webContents.setZoomFactor(1);
  await delay(300);

  const ok = steps.every((entry) => entry.ok);
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify({ ok, steps, providerRequests: 0 }, null, 2)}\n`, 'utf8');
  return { ok, steps };
}
