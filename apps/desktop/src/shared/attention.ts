import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing attention vocabulary: notification settings, quiet hours,
 * tray state, and the focus event a notification click produces. No raw
 * notification object and no channel name crosses the preload boundary.
 */
export const ATTENTION_CHANNELS = {
  get: 'mona:attention-get',
  set: 'mona:attention-set',
  quitStop: 'mona:attention-quit-stop',
  focus: 'mona:attention-focus',
} as const;

export type AttentionKind = 'run_completed' | 'run_failed' | 'blocker' | 'limit';

export type QuietHours = {
  enabled: boolean;
  /** Minutes after local midnight, 0–1439. */
  startMinute: number;
  endMinute: number;
  /** 'local' follows the operating system's current zone. */
  timeZone: string;
};

export type Density = 'comfortable' | 'compact';

export type AttentionSettings = {
  notificationsEnabled: boolean;
  quietHours: QuietHours;
};

export type AttentionPreferences = AttentionSettings & {
  density: Density;
  firstCloseNotified: boolean;
};

export type TrayTone = 'idle' | 'running' | 'attention' | 'complete';

export type TrayView = {
  tone: TrayTone;
  tooltip: string;
  detail: string;
};

export type AttentionEventView = {
  kind: AttentionKind;
  projectId: string;
  projectLabel: string;
  at: string;
  taskId: string | null;
  turnId: string | null;
  evidencePath: string | null;
  outcome: string | null;
};

export type AttentionView = {
  settings: AttentionPreferences;
  tray: TrayView;
  quietNow: boolean;
  quietDetail: string;
  lastEvent: AttentionEventView | null;
};

/** A notification click focuses a project and its evidence; it never starts a task. */
export type AttentionFocus = {
  projectId: string;
  evidencePath: string | null;
  kind: AttentionKind;
};

export type QuietHoursPatch = {
  enabled?: boolean | undefined;
  startMinute?: number | undefined;
  endMinute?: number | undefined;
  timeZone?: string | undefined;
};

export type AttentionPatch = {
  notificationsEnabled?: boolean | undefined;
  density?: Density | undefined;
  firstCloseNotified?: boolean | undefined;
  quietHours?: QuietHoursPatch | undefined;
};

export type AttentionBridge = {
  attentionGet(): Promise<IpcResult<AttentionView>>;
  attentionSet(patch: AttentionPatch): Promise<IpcResult<AttentionView>>;
  /** Quit and stop owned work; the same path as the tray menu. */
  attentionQuitStop(): Promise<IpcResult<{ requested: boolean; detail: string }>>;
  /** The latest notification focus, and pushes for new ones. */
  onAttentionFocus(handler: (focus: AttentionFocus) => void): () => void;
};
