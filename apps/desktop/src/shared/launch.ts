import type { CatalogProject, EngineView, IpcResult } from './catalog.js';

/**
 * The launcher surface. A shell selection becomes one receipt; the renderer
 * applies the receipt instead of guessing why the window changed.
 */
export const LAUNCH_CHANNELS = {
  state: 'mona:launch-state',
  event: 'mona:launch-event',
} as const;

export type LaunchSource = 'startup' | 'second-instance' | 'manual';

export type LaunchStatus = 'ready' | 'opened' | 'needs-selection' | 'relocation-required' | 'rejected' | 'failed';

export type LaunchReceipt = {
  seq: number;
  at: string;
  source: LaunchSource;
  /** What the shell asked for, before resolution. */
  requestedPath: string | null;
  /** The folder Mona resolved and registered, when it got that far. */
  openedPath: string | null;
  status: LaunchStatus;
  detail: string;
  warnings: string[];
  project: CatalogProject | null;
  engine: EngineView | null;
  profile: { label: string; profile: string; posture: string } | null;
  /** The studio composer is the next thing the user should type into. */
  focusComposer: boolean;
};

export type LaunchStateView = {
  latest: LaunchReceipt | null;
  count: number;
};

export type LaunchBridge = {
  getLaunchState(): Promise<IpcResult<LaunchStateView>>;
  onLaunchEvent(handler: (receipt: LaunchReceipt) => void): () => void;
};
