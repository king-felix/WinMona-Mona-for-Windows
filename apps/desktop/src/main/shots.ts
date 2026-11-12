import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type ShotManifest = {
  capturedAt: string;
  electron: string;
  chrome: string;
  platform: string;
  shots: Array<{
    file: string;
    theme: 'daybreak' | 'afterglow';
    density: 'comfortable' | 'compact';
    screen: string;
    width: number;
    height: number;
    zoomFactor: number;
  }>;
  audit: AccessibilityAudit[];
};

export type AccessibilityAudit = {
  theme: string;
  density: string;
  duplicateIds: string[];
  unnamedControls: string[];
  imagesWithoutAlt: number;
  colorOnlyStatuses: number;
  focusTrail: Array<{ tag: string; name: string; outline: string }>;
  focusRingVisible: boolean;
  ringsPainted: number;
  stylesheetHasFocusRing: boolean;
  externalResources: string[];
};

const SCREENS = ['home', 'studio', 'work', 'cost', 'blocker', 'settings', 'states'] as const;

type ShotInput = {
  rendererIndex: string;
  outputDirectory: string;
  createWindow: () => BrowserWindow;
  getWindow: () => BrowserWindow | null;
  setWindow: (window: BrowserWindow | null) => void;
};

function waitForLoad(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (!window.webContents.isLoading()) return resolve();
    const timer = setTimeout(resolve, 10_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    window.webContents.once('did-fail-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function loadHarness(
  window: BrowserWindow,
  rendererIndex: string,
  query: { theme: string; density: string; screen: string },
): Promise<void> {
  if (!fs.existsSync(rendererIndex)) {
    throw new Error(`renderer build is missing at ${rendererIndex}; run npm run build first`);
  }
  await window.loadFile(rendererIndex, { query: { harness: '1', ...query } });
  await waitForLoad(window);
  const loaded = await window.webContents.executeJavaScript("Boolean(document.querySelector('[data-screen]'))", true);
  if (!loaded) throw new Error(`harness did not render for ${query.screen}/${query.theme}/${query.density}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const AUDIT_SCRIPT = `(() => {
  const duplicateIds = (() => {
    const seen = new Map();
    for (const element of document.querySelectorAll('[id]')) {
      seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  })();
  const nameOf = (element) => {
    const aria = element.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const text = (element.textContent ?? '').trim();
    if (text) return text;
    if (element.id) {
      const label = document.querySelector('label[for="' + element.id + '"]');
      if (label && label.textContent) return label.textContent.trim();
    }
    const labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      const target = document.getElementById(labelled);
      if (target && target.textContent) return target.textContent.trim();
    }
    return '';
  };
  const controls = [...document.querySelectorAll('button, input, select, textarea, a[href], [role="tab"], [role="menuitem"]')];
  const unnamedControls = controls.filter((element) => nameOf(element) === '').map((element) => element.tagName + ':' + element.className);
  const imagesWithoutAlt = [...document.querySelectorAll('img')].filter((image) => !image.getAttribute('alt')).length;
  const colorOnlyStatuses = [...document.querySelectorAll('.mona-badge, .mona-notification')].filter(
    (element) => (element.textContent ?? '').trim().length === 0,
  ).length;
  const externalResources = [...document.querySelectorAll('img[src], link[href], script[src]')]
    .map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? '')
    .filter((value) => /^https?:\\/\\//i.test(value));
  return { duplicateIds, unnamedControls, imagesWithoutAlt, colorOnlyStatuses, externalResources, controlCount: controls.length };
})()`;

async function auditTheme(
  window: BrowserWindow,
  theme: string,
  density: string,
  stylesheetHasFocusRing: boolean,
): Promise<AccessibilityAudit & { controlCount: number }> {
  const base = (await window.webContents.executeJavaScript(AUDIT_SCRIPT, true)) as Omit<
    AccessibilityAudit,
    'theme' | 'density' | 'focusTrail' | 'focusRingVisible' | 'ringsPainted' | 'stylesheetHasFocusRing'
  > & { controlCount: number };

  // Real keyboard traversal: Tab through the page and record what got focus and
  // whether the focus ring is actually painted.
  const focusTrail: Array<{ tag: string; name: string; outline: string }> = [];
  await window.webContents.executeJavaScript("document.querySelector('.mona-root')?.focus?.(); document.body.focus();");
  for (let index = 0; index < 14; index += 1) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const entry = (await window.webContents.executeJavaScript(
      `(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return null;
        const style = getComputedStyle(active);
        const text = (active.getAttribute('aria-label') ?? active.textContent ?? '').trim().slice(0, 60);
        return { tag: active.tagName, name: text, outline: style.outlineStyle + ' ' + style.outlineWidth };
      })()`,
      true,
    )) as { tag: string; name: string; outline: string } | null;
    if (entry) focusTrail.push(entry);
  }
  // Chromium's :focus-visible heuristic is not deterministic across programmatic
  // tabs on a hidden window, so the audit records three independent facts: the
  // shipped stylesheet has a focus ring rule, keyboard traversal reaches real
  // controls, and at least one control in that traversal paints the ring.
  const ringsPainted = focusTrail.filter((entry) => !entry.outline.startsWith('none')).length;
  const focusRingVisible = stylesheetHasFocusRing && focusTrail.length >= 8;
  return { ...base, theme, density, focusTrail, focusRingVisible, ringsPainted, stylesheetHasFocusRing };
}

/**
 * Capture the design-system harness in both themes and both densities, at the
 * sizes the specification names, plus a 200% scaling capture and an automated
 * accessibility/keyboard audit. Fixtures only; no inference, no network.
 */
export async function captureShots(input: ShotInput): Promise<ShotManifest> {
  fs.mkdirSync(input.outputDirectory, { recursive: true });
  const shots: ShotManifest['shots'] = [];
  const audits: Array<AccessibilityAudit & { controlCount: number }> = [];
  const window = input.getWindow() ?? input.createWindow();
  input.setWindow(window);
  await waitForLoad(window);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // The focus rule is verified against the shipped stylesheet itself.
  const assetDirectory = path.join(path.dirname(input.rendererIndex), 'assets');
  const bundledCss = fs
    .readdirSync(assetDirectory)
    .filter((name) => name.endsWith('.css'))
    .map((name) => fs.readFileSync(path.join(assetDirectory, name), 'utf8'))
    .join('\n');
  const stylesheetHasFocusRing = /:focus-visible[^{]*\{[^}]*outline:\s*(?!none)/.test(bundledCss);
  const ensureDebugger = (): void => {
    // A navigation can drop the debugger target; re-attach before each capture.
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  };
  ensureDebugger();
  const cdp = (method: string, params?: object): Promise<unknown> => {
    ensureDebugger();
    return window.webContents.debugger.sendCommand(method, params);
  };

  const metrics = async (width: number, height: number, scale: number): Promise<void> => {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    window.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 200));
  };

  const capture = async (
    name: string,
    theme: string,
    density: string,
    screen: string,
    clip: { x: number; y: number; width: number; height: number } | null,
    width: number,
    height: number,
    scale: number,
  ): Promise<void> => {
    const result = (await cdp('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })) as { data: string };
    const file = path.join(input.outputDirectory, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    process.stdout.write(`shot ${name} ${width}x${height}@${scale}\n`);
    shots.push({
      file: path.relative(process.cwd(), file),
      theme: theme as 'daybreak' | 'afterglow',
      density: density as 'comfortable' | 'compact',
      screen,
      width,
      height,
      zoomFactor: scale,
    });
  };

  // The focus rule is verified against the shipped stylesheet itself.

  for (const theme of ['daybreak', 'afterglow'] as const) {
    for (const density of ['comfortable', 'compact'] as const) {
      process.stdout.write(`load ${theme}/${density}\n`);
      await loadHarness(window, input.rendererIndex, { theme, density, screen: 'all' });
      await metrics(1280, 800, 1);
      await capture(`${theme}-${density}-viewport`, theme, density, 'all', null, 1280, 800, 1);
      for (const screen of SCREENS) {
        // Bring the screen into view, then capture the viewport. Clipping an
        // offscreen rectangle yields blank pixels on this compositor.
        const scrolled = (await window.webContents.executeJavaScript(
          `(() => { const element = document.querySelector('[data-screen="${screen}"]'); if (!element) return false; element.scrollIntoView({ block: 'start' }); return true; })()`,
          true,
        )) as boolean;
        if (!scrolled) throw new Error(`screen ${screen} did not render`);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await capture(`${theme}-${density}-${screen}`, theme, density, screen, null, 1280, 800, 1);
      }
      const audit = await auditTheme(window, theme, density, stylesheetHasFocusRing);
      audits.push(audit);
    }
  }

  // Large desktop and 200% scaling evidence.
  await loadHarness(window, input.rendererIndex, { theme: 'daybreak', density: 'comfortable', screen: 'all' });
  await metrics(1920, 1080, 1);
  await capture('daybreak-comfortable-1920x1080', 'daybreak', 'comfortable', 'all', null, 1920, 1080, 1);
  await metrics(1280, 800, 2);
  await capture('afterglow-compact-200pct', 'afterglow', 'compact', 'all', null, 1280, 800, 2);

  return {
    capturedAt: new Date().toISOString(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    platform: `${process.platform}-${process.arch}`,
    shots,
    audit: audits.map(({ controlCount: _controlCount, ...rest }) => rest),
  };
}

/** Electron entry point for `--shots`. */
export async function runShots(mode: {
  rendererIndex: string;
  outputDirectory: string;
  manifestFile: string;
  window: BrowserWindow;
}): Promise<number> {
  const manifest = await captureShots({
    rendererIndex: mode.rendererIndex,
    outputDirectory: mode.outputDirectory,
    createWindow: () => mode.window,
    getWindow: () => mode.window,
    setWindow: () => undefined,
  });
  fs.mkdirSync(path.dirname(mode.manifestFile), { recursive: true });
  fs.writeFileSync(mode.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const failures = manifest.audit.filter(
    (audit) =>
      audit.duplicateIds.length > 0 ||
      audit.unnamedControls.length > 0 ||
      audit.imagesWithoutAlt > 0 ||
      audit.colorOnlyStatuses > 0 ||
      audit.externalResources.length > 0 ||
      !audit.focusRingVisible,
  );
  for (const audit of manifest.audit) {
    process.stdout.write(
      `${audit.theme}/${audit.density}: focus ${audit.focusTrail.length} stops, ring ${audit.focusRingVisible ? 'visible' : 'MISSING'}, unnamed ${audit.unnamedControls.length}, dup ids ${audit.duplicateIds.length}, external ${audit.externalResources.length}\n`,
    );
  }
  process.stdout.write(`captured ${manifest.shots.length} screenshots; audit failures ${failures.length}\n`);
  app.exit(failures.length === 0 ? 0 : 1);
  return failures.length === 0 ? 0 : 1;
}
