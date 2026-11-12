/**
 * One serialized path for every launch. Explorer can deliver several selections
 * faster than a runtime starts; each selection becomes one ordered receipt and
 * the newest ready project is the one the window shows.
 *
 * The dispatcher opens or registers a project, selects it, records the studio
 * view and starts the owned runtime. It never submits a prompt: a launch is not
 * work, and no model request follows from right-clicking a folder.
 */
import type { ErrorResult } from '@mona/contracts';
import type { CatalogProject, EngineView, OpenProjectResult, ProjectView } from '../shared/catalog.js';
import type { LaunchReceipt, LaunchSource, LaunchStatus } from '../shared/launch.js';
import { inspectLaunchPath, workspaceCaveat, type LaunchPathDeps, type LaunchPathInspection } from './launch-target.js';

type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorResult };

/** The part of CatalogService a launch needs; the real service satisfies it. */
export type LaunchCatalog = {
  open(target: string): Promise<Result<OpenProjectResult>>;
  select(projectId: string): Promise<Result<{ project: CatalogProject | null; engine: EngineView }>>;
  startEngine(projectId: string): Promise<Result<{ engine: EngineView; project: CatalogProject }>>;
};

export type LaunchIntent = {
  source: LaunchSource;
  paths: string[];
  profile: string | null;
  /** A command-line problem detected before any folder was touched. */
  problem: { code: string; detail: string } | null;
};

export type SavedProfileView = { label: string; profile: string; permissionPosture: string };

export type LaunchDispatcherDeps = {
  service: LaunchCatalog;
  ui: { setView(projectId: string, view: ProjectView): unknown };
  engine: { summary(): { state: string; workspace: string | null } };
  profile: () => SavedProfileView;
  pickFolder: () => Promise<string | null>;
  emit?: (receipt: LaunchReceipt) => void;
  cwd?: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
  inspectPath?: (raw: string, deps: LaunchPathDeps) => Promise<LaunchPathInspection>;
};

const MAX_RECEIPTS = 50;

function pathKey(value: string | null, platform: NodeJS.Platform): string {
  if (!value) return '';
  return platform === 'win32' ? value.toLowerCase() : value;
}

export class LaunchDispatcher {
  private readonly deps: LaunchDispatcherDeps;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private chain: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Promise<LaunchReceipt[]>>();
  private readonly listeners = new Set<(receipt: LaunchReceipt) => void>();
  private receipts: LaunchReceipt[] = [];
  private counter = 0;

  constructor(deps: LaunchDispatcherDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? (() => new Date());
  }

  /** Queue an intent. Identical intents waiting in the queue share one attempt. */
  enqueue(intent: LaunchIntent): Promise<LaunchReceipt[]> {
    const key = this.intentKey(intent);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const next = this.chain.then(() => this.process(intent));
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(key, next);
    void next.finally(() => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    });
    return next;
  }

  /** Resolves when every request queued so far has settled. */
  async idle(): Promise<void> {
    await this.chain;
  }

  latest(): LaunchReceipt | null {
    return this.receipts.at(-1) ?? null;
  }

  all(): LaunchReceipt[] {
    return [...this.receipts];
  }

  count(): number {
    return this.counter;
  }

  onReceipt(listener: (receipt: LaunchReceipt) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private intentKey(intent: LaunchIntent): string {
    const paths = intent.paths.map((entry) => pathKey(entry, this.platform)).join('\u0000');
    return `${paths}\u0001${intent.profile ?? ''}\u0001${intent.problem?.code ?? ''}`;
  }

  private async process(intent: LaunchIntent): Promise<LaunchReceipt[]> {
    if (intent.problem) {
      const receipt = this.record({
        source: intent.source,
        requestedPath: intent.paths[0] ?? null,
        status: 'rejected',
        detail: intent.problem.detail,
        warnings: [],
        project: null,
        engine: null,
        openedPath: null,
      });
      return [receipt];
    }

    const produced: LaunchReceipt[] = [];
    for (const selected of intent.paths) {
      produced.push(await this.handlePath(selected, intent, 0));
    }
    if (produced.length === 0) {
      produced.push(
        this.record({
          source: intent.source,
          requestedPath: null,
          status: 'rejected',
          detail: 'No folder was selected for Mona to open.',
          warnings: [],
          project: null,
          engine: null,
          openedPath: null,
        }),
      );
    }
    return produced;
  }

  private async handlePath(selected: string, intent: LaunchIntent, depth: number): Promise<LaunchReceipt> {
    const inspect = this.deps.inspectPath ?? inspectLaunchPath;
    const inspected = await inspect(selected, {
      cwd: this.deps.cwd ?? process.cwd(),
      platform: this.platform,
    });

    if (!inspected.ok) {
      if (inspected.kind === 'needs-selection' && depth === 0) {
        const picked = await this.deps.pickFolder();
        if (picked) return await this.handlePath(picked, intent, depth + 1);
        return this.record({
          source: intent.source,
          requestedPath: inspected.path,
          status: 'needs-selection',
          detail: `${inspected.detail} No project folder was opened.`,
          warnings: [],
          project: null,
          engine: null,
          openedPath: null,
        });
      }
      return this.record({
        source: intent.source,
        requestedPath: inspected.path,
        status: 'rejected',
        detail: inspected.detail,
        warnings: [],
        project: null,
        engine: null,
        openedPath: null,
      });
    }

    const warnings: string[] = [];
    const caveat = workspaceCaveat(inspected.shape);
    if (caveat) warnings.push(caveat);
    return await this.openFolder(inspected.path, intent, warnings);
  }

  private async openFolder(target: string, intent: LaunchIntent, warnings: string[]): Promise<LaunchReceipt> {
    const opened = await this.deps.service.open(target);
    if (!opened.ok) {
      return this.record({
        source: intent.source,
        requestedPath: target,
        status: 'failed',
        detail: opened.error.message,
        warnings,
        project: null,
        engine: null,
        openedPath: null,
      });
    }

    const outcome = opened.data;
    if (outcome.status === 'relocation_required') {
      return this.record({
        source: intent.source,
        requestedPath: target,
        status: 'relocation-required',
        detail: `${outcome.reason}. Mona did not create a second project for the new location.`,
        warnings,
        project: outcome.project,
        engine: null,
        openedPath: outcome.project.canonicalPath,
      });
    }

    let project = outcome.project;
    const selected = await this.deps.service.select(project.id);
    if (!selected.ok) {
      return this.record({
        source: intent.source,
        requestedPath: target,
        status: 'failed',
        detail: `The folder was registered, but it could not be selected: ${selected.error.message}`,
        warnings,
        project,
        engine: null,
        openedPath: project.canonicalPath,
      });
    }

    // A launch always lands in the studio with a shell ready to accept a task.
    const view = this.deps.ui.setView(project.id, 'studio');
    if (view && typeof view === 'object' && 'ok' in view && view.ok === false) {
      warnings.push('The studio view could not be recorded; the project is still open.');
    }

    const profile = this.profileReceipt(intent, warnings);
    let engine = selected.data.engine;
    let status: LaunchStatus = 'opened';
    let detail: string;

    const summary = this.deps.engine.summary();
    if (
      summary.state === 'connected' &&
      pathKey(summary.workspace, this.platform) === pathKey(project.canonicalPath, this.platform)
    ) {
      status = 'ready';
      detail = `${project.label} is open from Explorer and the runtime is serving it. No task was sent.`;
    } else if (
      summary.state === 'connected' &&
      summary.workspace &&
      pathKey(summary.workspace, this.platform) !== pathKey(project.canonicalPath, this.platform)
    ) {
      detail = `${project.label} is open from Explorer, but the runtime is serving ${summary.workspace}. Stop it before starting this project's runtime. No task was sent.`;
    } else {
      const started = await this.deps.service.startEngine(project.id);
      if (started.ok) {
        engine = started.data.engine;
        project = started.data.project;
        status = 'ready';
        detail = `${project.label} is open from Explorer and the runtime is ready. No task was sent.`;
      } else {
        detail = `${project.label} is open from Explorer, but the runtime did not start: ${started.error.message}`;
      }
    }

    return this.record({
      source: intent.source,
      requestedPath: target,
      status,
      detail,
      warnings,
      project,
      engine,
      openedPath: project.canonicalPath,
      profile,
      focusComposer: true,
    });
  }

  private profileReceipt(intent: LaunchIntent, warnings: string[]): LaunchReceipt['profile'] {
    const saved = this.deps.profile();
    if (intent.profile && saved.profile.toLowerCase() !== 'ds') {
      warnings.push(
        `The launcher asked for ${intent.profile}, but the saved profile is "${saved.profile}". Mona keeps the saved profile.`,
      );
    }
    if (saved.permissionPosture !== 'full_access') {
      warnings.push(
        `The saved profile "${saved.label}" records ${saved.permissionPosture}, not full access. Mona does not change a saved posture.`,
      );
    }
    return { label: saved.label, profile: saved.profile, posture: saved.permissionPosture };
  }

  private record(input: {
    source: LaunchSource;
    requestedPath: string | null;
    status: LaunchStatus;
    detail: string;
    warnings: string[];
    project: CatalogProject | null;
    engine: EngineView | null;
    openedPath: string | null;
    profile?: LaunchReceipt['profile'];
    focusComposer?: boolean;
  }): LaunchReceipt {
    this.counter += 1;
    const receipt: LaunchReceipt = {
      seq: this.counter,
      at: this.now().toISOString(),
      source: input.source,
      requestedPath: input.requestedPath,
      openedPath: input.openedPath,
      status: input.status,
      detail: input.detail,
      warnings: input.warnings,
      project: input.project,
      engine: input.engine,
      profile: input.profile ?? null,
      focusComposer: input.focusComposer ?? false,
    };
    this.receipts.push(receipt);
    if (this.receipts.length > MAX_RECEIPTS) this.receipts = this.receipts.slice(-MAX_RECEIPTS);
    this.deps.emit?.(receipt);
    for (const listener of this.listeners) listener(receipt);
    return receipt;
  }
}
