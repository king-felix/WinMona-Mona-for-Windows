import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

/**
 * Live probe for the two layout controls Victor asked for: a collapsible
 * Inspector, and Ctrl +/-/0 window scaling.
 *
 * It drives the real window, measures the DOM it produces, presses the keys
 * through Electron's own input path (so the main-process shortcut handler is the
 * thing under test, not a unit stub), and captures what the screen showed. It
 * starts no runtime and submits no prompt: provider requests stay at zero.
 */
export type AppearanceProbeInput = {
  window: BrowserWindow;
  outputPath: string;
  shotsDirectory: string;
  workspace: string;
  openProject: (target: string) => Promise<{ projectId: string; canonicalPath: string } | null>;
  zoomFile: string;
};

type Step = { name: string; ok: boolean; detail?: unknown };
type Shot = { file: string; label: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAppearanceProbe(input: AppearanceProbeInput): Promise<{
  ok: boolean;
  steps: Step[];
  shots: Shot[];
  zoomFile: string | null;
  capturedAt: string;
  providerRequests: 0;
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
  const shot = async (label: string): Promise<boolean> => {
    const file = path.join(input.shotsDirectory, `${label}.png`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        shots.push({ file, label });
        return true;
      } catch {
        await delay(400);
      }
    }
    return false;
  };
  const key = async (keyCode: string): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] });
    await delay(350);
  };
  const zoom = (): number => window.webContents.getZoomFactor();

  await waitFor(async () => (await evaluate<boolean>("document.readyState === 'complete'")) === true, 45_000);
  const project = await input.openProject(input.workspace);
  check('a real project opens through the catalog', project !== null, project?.canonicalPath ?? null);
  if (!project) {
    return { ok: false, steps, shots, zoomFile: null, capturedAt: new Date().toISOString(), providerRequests: 0 };
  }

  await evaluate(`document.querySelector('[data-testid="nav-studio"]')?.click()`);
  const studioUp = await waitFor(
    async () => (await evaluate<boolean>("Boolean(document.querySelector('.timeline'))")) === true,
  );
  check('the studio timeline is on screen', studioUp);
  await delay(800);

  const width = async (selector: string): Promise<number> =>
    evaluate<number>(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? Math.round(node.getBoundingClientRect().width) : 0; })()`,
    );

  // 1. The Inspector starts closed, so the agent timeline owns the width.
  const collapsedByDefault =
    (await evaluate<boolean>('!document.querySelector(\'aside[aria-label="Inspector"]\')')) === true;
  const railPresent = await evaluate<boolean>(
    'Boolean(document.querySelector(\'button[aria-label="Show Inspector"]\'))',
  );
  const collapsedWorkspace = (await evaluate<string>("document.querySelector('.workspace')?.className ?? ''")) ?? '';
  const narrow = await width('.workspace-main');
  check('the Inspector is closed by default', collapsedByDefault, { collapsedWorkspace, railPresent });
  check('a labelled control reopens it', railPresent);
  check(
    'the collapsed state is the layout class, not a hidden panel',
    collapsedWorkspace.includes('inspector-collapsed'),
  );
  check('the timeline column is captured while collapsed', await shot('studio-inspector-collapsed'), { narrow });

  // 2. Opening it takes width back, and closing restores it.
  await evaluate(`document.querySelector('button[aria-label="Show Inspector"]')?.click()`);
  const opened = await waitFor(
    async () =>
      (await evaluate<boolean>('Boolean(document.querySelector(\'aside[aria-label="Inspector"]\'))')) === true,
  );
  await delay(400);
  const wide = await width('.workspace-main');
  check('the Inspector opens from the rail', opened, { timelineWidthCollapsed: narrow, timelineWidthOpen: wide });
  check('opening it costs the timeline width, so closing it really gives space back', wide < narrow - 100);
  check('the open Inspector is captured', await shot('studio-inspector-open'));

  await evaluate(`document.querySelector('button[aria-label="Hide Inspector"]')?.click()`);
  const closed = await waitFor(
    async () => (await evaluate<boolean>('!document.querySelector(\'aside[aria-label="Inspector"]\')')) === true,
  );
  const restored = await width('.workspace-main');
  check('the Inspector closes again and the width returns', closed && restored >= narrow - 2, {
    restored,
    narrow,
  });

  // 3. Ctrl+= steps the real window scale through the main-process handler.
  const startZoom = zoom();
  await key('+');
  const afterPlus = zoom();
  const label = await evaluate<string | null>(
    'document.querySelector(\'[data-testid="zoom-value"]\')?.textContent ?? null',
  );
  check('Ctrl+= makes everything larger', afterPlus > startZoom, { startZoom, afterPlus });
  check('the status bar reports the applied scale, not an intention', label === `${Math.round(afterPlus * 100)}%`, {
    label,
  });

  await key('-');
  const afterMinus = zoom();
  check('Ctrl+- makes everything smaller', afterMinus < afterPlus, { afterPlus, afterMinus });

  // 4. Two more steps: layout must reflow rather than overflow.
  await key('+');
  await key('+');
  await key('+');
  await delay(600);
  const largeZoom = zoom();
  const layout = await evaluate<{ overflow: number; composer: number; strip: number; overlap: number }>(`(() => {
    const root = document.documentElement;
    const composer = document.querySelector('.composer');
    const strip = document.querySelector('.control-meta, .control-actions, .studio-head');
    const region = document.querySelector('.studio-region');
    const bar = document.querySelector('.statusbar');
    // The scroll region must end above the status bar; content painting over it
    // hides controls behind chrome, which is the failure this check exists for.
    const overlap = region && bar ? Math.round(region.getBoundingClientRect().bottom - bar.getBoundingClientRect().top) : -1;
    return {
      overflow: root.scrollWidth - root.clientWidth,
      composer: composer ? Math.round(composer.getBoundingClientRect().width) : 0,
      strip: strip ? Math.round(strip.getBoundingClientRect().height) : 0,
      overlap,
    };
  })()`);
  check('at a larger scale the page has no horizontal overflow', layout.overflow <= 1, {
    zoom: largeZoom,
    ...layout,
  });
  check('the work area ends above the status bar instead of painting over it', layout.overlap <= 1, {
    overlap: layout.overlap,
  });
  check('the composer is still laid out at a larger scale', layout.composer > 0);
  check('the larger scale is captured', await shot('studio-scaled-up'));

  // 5. Ctrl+0 returns to the design scale.
  await key('0');
  const reset = zoom();
  check('Ctrl+0 returns to 100%', Math.abs(reset - 1) < 0.001, { reset });

  // 6. The choice is written to disk, so a restart keeps it.
  let persisted: { zoomFactor?: number } | null = null;
  try {
    persisted = JSON.parse(fs.readFileSync(input.zoomFile, 'utf8')) as { zoomFactor?: number };
  } catch {
    // No file yet: the check below reports that as a failure, not as a pass.
  }
  check('the chosen scale is persisted beside the other UI preferences', persisted?.zoomFactor === 1, {
    file: input.zoomFile,
    persisted,
  });

  return {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    zoomFile: input.zoomFile,
    capturedAt: new Date().toISOString(),
    providerRequests: 0,
  };
}
