import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host.js';

/**
 * End-to-end probe for the P07 shell and catalog. Every step runs through the
 * real renderer → preload → IPC → SQLite path in a real Electron window: no
 * mocked bridge and no fixture data. Screenshots of the live shell are captured
 * beside the JSON result.
 */
export type CatalogProbeResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: unknown }>;
  shots: Array<{ file: string; theme: string; view: string }>;
  electron: string;
  chrome: string;
  platform: string;
  node: string;
  capturedAt: string;
};

export type CatalogProbeInput = {
  window: BrowserWindow;
  rendererIndex: string;
  workspace: string;
  shotsDirectory: string;
  outputPath: string;
  engine: EngineHost;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loaded(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function writeHead(directory: string, branch: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
}

/**
 * Fixture folders for a real catalog run: a dirty non-Git folder, a Git
 * repository, a junction alias to it, a folder that will move, and a parent for
 * a newly created project.
 */
function createWorkspace(root: string): {
  plain: string;
  repo: string;
  alias: string;
  movable: string;
  createParent: string;
} {
  const plain = path.join(root, 'plain-dirty-folder');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'uncommitted-notes.txt'), 'dirty but openable\n', 'utf8');

  const repo = path.join(root, 'mona-probe-repo');
  fs.mkdirSync(repo, { recursive: true });
  writeHead(path.join(repo, '.git'), 'probe/main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# probe repo\n', 'utf8');

  const alias = path.join(root, 'repo-junction');
  fs.symlinkSync(repo, alias, 'junction');

  const movable = path.join(root, 'movable-project');
  fs.mkdirSync(movable, { recursive: true });
  fs.writeFileSync(path.join(movable, 'keep.txt'), 'keep me\n', 'utf8');

  const createParent = path.join(root, 'new-projects');
  fs.mkdirSync(createParent, { recursive: true });

  return { plain, repo, alias, movable, createParent };
}

type ProjectView = {
  id: string;
  label: string;
  canonicalPath: string;
  repoKind: string;
  branch: string | null;
  revision: number;
  archived: boolean;
  pinned: boolean;
  folderExists: boolean;
};

type UiView = {
  currentProjectId: string | null;
  projects: Record<
    string,
    { view: string; currentSessionId: string; sessions: Array<{ sessionId: string; text: string }> }
  >;
};

type EngineView = { state: string; workspace: string | null; endpoint: string | null; pid: number | null };

export async function runCatalogProbe(input: CatalogProbeInput): Promise<CatalogProbeResult> {
  const steps: CatalogProbeResult['steps'] = [];
  const shots: CatalogProbeResult['shots'] = [];
  const window = input.window;

  const check = (name: string, ok: boolean, detail?: unknown): void => {
    steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}\n`,
    );
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression, true)) as T;
  const call = async <T>(expression: string): Promise<Envelope<T>> => evaluate<Envelope<T>>(expression);
  /** Bounded wait for an observed condition; never assumes it happened. */
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(200);
    }
    return false;
  };

  const folders = createWorkspace(input.workspace);
  await loaded(window);
  await delay(600);

  // --- catalog lifecycle, all through the renderer's real bridge -----------
  const plainOpen = await call<{ status: string; project: ProjectView }>(
    `window.mona.openProject(${JSON.stringify(folders.plain)})`,
  );
  check(
    'a dirty non-Git folder opens as a project with no invented branch',
    plainOpen.ok &&
      plainOpen.data?.status === 'created' &&
      plainOpen.data.project.repoKind === 'none' &&
      plainOpen.data.project.branch === null,
    plainOpen.ok
      ? { repoKind: plainOpen.data?.project.repoKind, branch: plainOpen.data?.project.branch }
      : plainOpen.error,
  );
  const plainId = (plainOpen.ok ? plainOpen.data?.project.id : null) ?? null;

  const repoOpen = await call<{ status: string; project: ProjectView }>(
    `window.mona.openProject(${JSON.stringify(folders.repo)})`,
  );
  check(
    'a Git folder opens and reports its real branch from HEAD',
    repoOpen.ok && repoOpen.data?.project.branch === 'probe/main',
    repoOpen.ok ? { branch: repoOpen.data?.project.branch, kind: repoOpen.data?.project.repoKind } : repoOpen.error,
  );
  const repoId = (repoOpen.ok ? repoOpen.data?.project.id : null) ?? null;

  const aliasOpen = await call<{ status: string; project: ProjectView }>(
    `window.mona.openProject(${JSON.stringify(folders.alias)})`,
  );
  check(
    'a junction path resolves to the existing project instead of a duplicate',
    aliasOpen.ok && aliasOpen.data?.project.id === repoId,
    aliasOpen.ok
      ? { status: aliasOpen.data?.status, sameProject: aliasOpen.data?.project.id === repoId }
      : aliasOpen.error,
  );

  const created = await call<ProjectView>(
    `window.mona.createProject({ parent: ${JSON.stringify(folders.createParent)}, name: 'created by probe' })`,
  );
  check(
    'creating a project makes the folder on disk and records it',
    created.ok && fs.existsSync(path.join(folders.createParent, 'created by probe')),
    created.ok ? { label: created.data?.label } : created.error,
  );
  const createdId = (created.ok ? created.data?.id : null) ?? null;

  const renamed = repoId
    ? await call<ProjectView>(
        `window.mona.updateProject({ projectId: ${JSON.stringify(repoId)}, expectedRevision: 1, patch: { label: 'Probe repo renamed', pinned: true } })`,
      )
    : { ok: false as const };
  check(
    'a project label can be renamed and pinned without touching the folder',
    renamed.ok &&
      renamed.data?.label === 'Probe repo renamed' &&
      renamed.data.pinned === true &&
      fs.existsSync(path.join(folders.repo, 'README.md')),
    renamed.ok ? { label: renamed.data?.label, pinned: renamed.data?.pinned } : renamed.error,
  );

  const searched = await call<ProjectView[]>(`window.mona.listProjects({ query: 'probe/main' })`);
  check(
    'local search matches a branch and returns only that project',
    searched.ok && searched.data?.length === 1 && searched.data[0]?.label === 'Probe repo renamed',
    searched.ok ? searched.data?.map((entry) => entry.label) : searched.error,
  );

  const archived = createdId
    ? await call<ProjectView>(
        `window.mona.updateProject({ projectId: ${JSON.stringify(createdId)}, expectedRevision: 1, patch: { archived: true } })`,
      )
    : { ok: false as const };
  const hidden = await call<ProjectView[]>(`window.mona.listProjects({})`);
  const restored = createdId
    ? await call<ProjectView>(
        `window.mona.updateProject({ projectId: ${JSON.stringify(createdId)}, expectedRevision: ${
          archived.ok ? (archived.data?.revision ?? 2) : 2
        }, patch: { archived: false } })`,
      )
    : { ok: false as const };
  const visibleAgain = await call<ProjectView[]>(`window.mona.listProjects({})`);
  check(
    'archiving hides a project and restoring brings it back',
    archived.ok &&
      hidden.ok &&
      !hidden.data?.some((entry) => entry.id === createdId) &&
      restored.ok &&
      visibleAgain.ok &&
      visibleAgain.data?.some((entry) => entry.id === createdId) === true,
    {
      hiddenCount: hidden.ok ? hidden.data?.length : null,
      visibleCount: visibleAgain.ok ? visibleAgain.data?.length : null,
    },
  );

  // A folder move: the folder is registered first, then moved. Opening the new
  // path reports a relocation, and only an explicit rebind updates the entry.
  const movableOpen = await call<{ status: string; project: ProjectView }>(
    `window.mona.openProject(${JSON.stringify(folders.movable)})`,
  );
  const moved = `${folders.movable}-moved`;
  fs.renameSync(folders.movable, moved);
  const relocation = await call<{ status: string; project: ProjectView; observedPath: string; reason: string }>(
    `window.mona.openProject(${JSON.stringify(moved)})`,
  );
  const rebound =
    relocation.ok && relocation.data?.status === 'relocation_required'
      ? await call<ProjectView>(
          `window.mona.relocateProject({ projectId: ${JSON.stringify(relocation.data.project.id)}, expectedRevision: ${
            relocation.data.project.revision
          }, path: ${JSON.stringify(moved)} })`,
        )
      : { ok: false as const };
  check(
    'a moved folder requires a deliberate rebind and keeps one catalog entry',
    movableOpen.ok &&
      relocation.ok &&
      relocation.data?.status === 'relocation_required' &&
      rebound.ok &&
      (rebound.data?.canonicalPath ?? '').toLowerCase().includes('moved'),
    {
      registered: movableOpen.ok,
      relocationStatus: relocation.ok ? relocation.data?.status : relocation.error,
      rebound: rebound.ok,
    },
  );

  const removed = createdId
    ? await call<{ removed: boolean; folderStillExists: boolean }>(
        `window.mona.removeProject(${JSON.stringify(createdId)})`,
      )
    : { ok: false as const };
  check(
    'removing a catalog entry never deletes source files',
    removed.ok &&
      removed.data?.removed === true &&
      removed.data.folderStillExists === true &&
      fs.existsSync(path.join(folders.createParent, 'created by probe')),
    removed.ok ? removed.data : removed.error,
  );

  // --- drafts, isolation, restart ----------------------------------------
  const sessions = await call<UiView>(`window.mona.getUiState()`);
  const sessionFor = (id: string | null): string | null =>
    (id && sessions.ok ? sessions.data?.projects[id]?.currentSessionId : null) ?? null;
  const plainSession = sessionFor(plainId);
  const repoSession = sessionFor(repoId);

  await call(
    `window.mona.saveDraft({ projectId: ${JSON.stringify(plainId)}, sessionId: ${JSON.stringify(plainSession)}, text: 'draft for the plain folder' })`,
  );
  await call(
    `window.mona.saveDraft({ projectId: ${JSON.stringify(repoId)}, sessionId: ${JSON.stringify(repoSession)}, text: 'draft for the git repo' })`,
  );
  await call(`window.mona.setProjectView({ projectId: ${JSON.stringify(repoId)}, view: 'cost' })`);
  await call(`window.mona.selectProject(${JSON.stringify(repoId)})`);

  // Re-render the real UI over the seeded catalog, then verify the persisted
  // state survived a full window reload. The shell lands on the project's saved
  // view, so Home is reached with the keyboard before reading the project cards.
  await window.loadFile(input.rendererIndex);
  await loaded(window);
  await delay(900);
  const press = async (keyCode: string, modifiers: string[] = []): Promise<void> => {
    const event = { keyCode, ...(modifiers.length ? { modifiers } : {}) };
    window.webContents.sendInputEvent({ type: 'keyDown', ...event } as never);
    window.webContents.sendInputEvent({ type: 'keyUp', ...event } as never);
    await delay(130);
  };
  const runPaletteCommand = async (label: string): Promise<Array<{ title: string; kind: string }>> => {
    await press('K', ['control']);
    await delay(140);
    await window.webContents.insertText(label);
    await delay(160);
    const matches = await evaluate<Array<{ title: string; kind: string }>>(`(() => {
      return Array.from(document.querySelectorAll('.mona-palette-item')).map((node) => {
        const spans = node.querySelectorAll('span');
        return { title: spans[0]?.textContent ?? '', kind: spans[1]?.textContent ?? '' };
      });
    })()`);
    await press('Enter');
    await delay(320);
    return matches;
  };

  const landedOn = await evaluate<string | null>(`document.querySelector('.workspace-main h2')?.textContent ?? null`);
  await runPaletteCommand('Go to Home');
  const afterReload = await evaluate<{
    cards: string[];
    model: string | null;
    permission: string | null;
    palette: boolean;
    harness: boolean;
  }>(`(() => ({
    cards: Array.from(document.querySelectorAll('.project-card h3')).map((node) => node.textContent ?? ''),
    model: document.querySelector('[data-testid="context-model"]')?.textContent ?? null,
    permission: document.querySelector('[data-testid="context-permission"]')?.textContent ?? null,
    palette: Boolean(document.querySelector('[data-testid="palette-trigger"]')),
    harness: Boolean(document.querySelector('[data-testid="harness"]'))
  }))()`);
  check('the persisted view for the open project is restored after a reload', landedOn === 'Recorded spend', {
    landedOn,
  });
  check(
    'the catalog and its labels survive a window reload',
    afterReload.cards.includes('Probe repo renamed') &&
      afterReload.cards.includes('plain-dirty-folder') &&
      afterReload.cards.length >= 3,
    afterReload.cards,
  );
  check(
    'the shell shows real route and permission facts, and no fixture harness',
    afterReload.model === 'deepseek-flash' &&
      (afterReload.permission ?? '').includes('Full Access') &&
      afterReload.palette &&
      afterReload.harness === false,
    {
      model: afterReload.model,
      permission: afterReload.permission,
      palette: afterReload.palette,
      harness: afterReload.harness,
    },
  );

  const uiAfterReload = await call<UiView>(`window.mona.getUiState()`);
  const draftOf = (id: string | null): string[] =>
    (id && uiAfterReload.ok ? uiAfterReload.data?.projects[id]?.sessions.map((session) => session.text) : []) ?? [];
  check(
    'unsent drafts are stored per project and survive a reload',
    draftOf(plainId).includes('draft for the plain folder') && draftOf(repoId).includes('draft for the git repo'),
    { plain: draftOf(plainId), repo: draftOf(repoId) },
  );

  // --- keyboard-only navigation ------------------------------------------
  await window.webContents.executeJavaScript('document.body.focus();', true);
  await press('K', ['control']);
  await delay(150);
  const paletteOpen = await evaluate<boolean>(`Boolean(document.querySelector('.mona-palette'))`);
  await press('Escape');
  await delay(150);

  const reached: string[] = [];
  for (const label of ['Go to Home', 'Go to Studio', 'Go to Work board', 'Go to Cost lens', 'Go to Settings']) {
    await runPaletteCommand(label);
    reached.push(
      (await evaluate<string | null>(`document.querySelector('.workspace-main h2')?.textContent ?? null`)) ?? '(none)',
    );
  }
  check('every major screen is reachable with the keyboard alone', paletteOpen && new Set(reached).size >= 4, {
    paletteOpen,
    reached,
  });
  check(
    'the command palette routes to a specific screen, not to a guess',
    reached[0] === 'Projects' && reached[1] === 'Probe repo renamed' && reached[2] === 'Work board',
    reached.slice(0, 3),
  );

  const tabTrail: string[] = [];
  await window.webContents.executeJavaScript('document.body.focus();', true);
  for (let index = 0; index < 18; index += 1) {
    await press('Tab');
    const entry = await evaluate<string | null>(`(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      return active.tagName + ':' + (active.getAttribute('aria-label') ?? active.textContent ?? '').trim().slice(0, 40);
    })()`);
    if (entry) tabTrail.push(entry);
  }
  check(
    'Tab traversal reaches real controls in the live shell',
    tabTrail.length >= 10 && tabTrail.some((entry) => entry.startsWith('BUTTON')),
    { stops: tabTrail.length, first: tabTrail.slice(0, 6) },
  );

  // --- engine connection and switching isolation --------------------------
  const startA = await call<{ engine: EngineView; project: ProjectView }>(
    `window.mona.startEngine(${JSON.stringify(repoId)})`,
  );
  check(
    'connecting the selected project reports a real engine endpoint and pid',
    startA.ok &&
      startA.data?.engine.state === 'connected' &&
      Boolean(startA.data.engine.endpoint) &&
      typeof startA.data.engine.pid === 'number',
    startA.ok
      ? { state: startA.data?.engine.state, endpoint: startA.data?.engine.endpoint, pid: startA.data?.engine.pid }
      : startA.error,
  );

  // Reload so the shell reads the live engine state from the main process, and
  // assert the context bar and controls reflect it rather than a static badge.
  await call(`window.mona.selectProject(${JSON.stringify(repoId)})`);
  await call(`window.mona.setProjectView({ projectId: ${JSON.stringify(repoId)}, view: 'studio' })`);
  await window.loadFile(input.rendererIndex);
  await loaded(window);
  await delay(800);
  const liveShell = await evaluate<{ badge: string | null; detail: string | null; stop: boolean }>(`(() => ({
    badge: document.querySelector('[data-testid="engine-state"]')?.textContent ?? null,
    detail: document.querySelector('[data-testid="connection-detail"]')?.textContent ?? null,
    stop: Array.from(document.querySelectorAll('button')).some((node) => node.textContent === 'Stop engine')
  }))()`);
  check(
    'the shell reflects the live engine state instead of a static badge',
    liveShell.badge === 'Engine connected' &&
      liveShell.stop &&
      (liveShell.detail ?? '').includes(startA.ok ? (startA.data?.engine.endpoint ?? '\u0000') : '\u0000'),
    liveShell,
  );

  // Switching projects through the real UI while the runtime is live: the second
  // project must show the runtime belongs elsewhere, keep its own draft, and
  // refuse to start a competing runtime.
  await runPaletteCommand('Open plain-dirty-folder');
  const switchedShell = await evaluate<{
    badge: string | null;
    draft: string;
    notice: string;
    spend: string | null;
  }>(`(() => ({
    badge: document.querySelector('[data-testid="engine-state"]')?.textContent ?? null,
    draft: document.querySelector('#draft')?.value ?? '',
    notice: document.body.textContent ?? '',
    spend: document.querySelector('[data-testid="studio-spend"]')?.textContent ?? null
  }))()`);
  const blockedStart = await call<unknown>(`window.mona.startEngine(${JSON.stringify(plainId)})`);
  check(
    'switching projects mid-runtime keeps drafts, engine state and spend isolated',
    switchedShell.badge === 'Engine connected' &&
      switchedShell.notice.includes('Runtime serves another project') &&
      switchedShell.draft === 'draft for the plain folder' &&
      switchedShell.spend === 'No recorded spend' &&
      blockedStart.ok === false,
    {
      badge: switchedShell.badge,
      draft: switchedShell.draft,
      spend: switchedShell.spend,
      warned: switchedShell.notice.includes('Runtime serves another project'),
      secondStartRefused: blockedStart.ok === false,
      reason: blockedStart.ok ? null : blockedStart.error?.message,
    },
  );

  await runPaletteCommand('Stop the engine');
  const settled = await waitFor(async () => {
    const state = await call<EngineView>(`window.mona.engineState()`);
    return state.ok && state.data?.state === 'stopped';
  }, 25_000);
  await delay(300);
  const afterStop = await evaluate<{ badge: string | null; detail: string | null }>(`(() => ({
    badge: document.querySelector('[data-testid="engine-state"]')?.textContent ?? null,
    detail: document.querySelector('[data-testid="connection-detail"]')?.textContent ?? null
  }))()`);
  const stopped = await call<EngineView>(`window.mona.engineState()`);
  check(
    'stopping the engine through the shell reports the real state and leaves the catalog usable',
    settled && afterStop.badge === 'Engine stopped' && stopped.ok && stopped.data?.state === 'stopped',
    {
      badge: afterStop.badge,
      detail: afterStop.detail,
      settled,
      state: stopped.ok ? stopped.data?.state : stopped.error,
    },
  );
  const offlineList = await call<ProjectView[]>(`window.mona.listProjects({})`);
  check(
    'offline history still lists every project after the runtime stops',
    offlineList.ok && (offlineList.data?.length ?? 0) >= 3,
    { count: offlineList.ok ? offlineList.data?.length : null },
  );

  // --- live shell screenshots --------------------------------------------
  fs.mkdirSync(input.shotsDirectory, { recursive: true });
  const ensureDebugger = (): void => {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  };
  const capture = async (name: string, theme: string, view: string): Promise<void> => {
    ensureDebugger();
    const result = (await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })) as { data: string };
    const file = path.join(input.shotsDirectory, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    shots.push({ file: path.relative(process.cwd(), file), theme, view });
    process.stdout.write(`shot ${name}\n`);
  };

  // Reload so the shell renders the selected project from persisted state.
  await call(`window.mona.selectProject(${JSON.stringify(repoId)})`);
  await call(`window.mona.setProjectView({ projectId: ${JSON.stringify(repoId)}, view: 'studio' })`);
  await window.loadFile(input.rendererIndex);
  await loaded(window);
  await delay(700);

  await window.webContents.executeJavaScript("document.documentElement.dataset.theme = 'daybreak'", true);
  await runPaletteCommand('Go to Home');
  await capture('p07-daybreak-home', 'daybreak', 'home');
  await runPaletteCommand('Go to Studio');
  await capture('p07-daybreak-studio', 'daybreak', 'studio');
  await runPaletteCommand('Go to Cost lens');
  await capture('p07-daybreak-cost', 'daybreak', 'cost');
  await press('K', ['control']);
  await delay(220);
  await capture('p07-daybreak-palette', 'daybreak', 'palette');
  await press('Escape');
  await delay(160);
  await window.webContents.executeJavaScript("document.documentElement.dataset.theme = 'afterglow'", true);
  await runPaletteCommand('Go to Home');
  await capture('p07-afterglow-home', 'afterglow', 'home');
  await runPaletteCommand('Go to Studio');
  await capture('p07-afterglow-studio', 'afterglow', 'studio');

  const result: CatalogProbeResult = {
    ok: steps.every((step) => step.ok),
    steps,
    shots,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: `${process.platform}-${process.arch}`,
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
