import type { AttentionKind, AttentionSettings, QuietHours, TrayTone, TrayView } from '../shared/attention.js';

/**
 * Attention policy is pure and local: it decides whether a recorded transition
 * may become a desktop notification, when quiet hours apply, and how the tray
 * describes current work. It never calls a model, and it never puts prompt or
 * file text into a lock-screen notification.
 */

export type AttentionEvent = {
  /**
   * Stable identity for deduplication. A replayed turn completion must reuse
   * the same key so a reconnect cannot deliver the same notification twice.
   */
  key: string;
  kind: AttentionKind;
  projectId: string;
  projectLabel: string;
  at: string;
  taskId: string | null;
  turnId: string | null;
  evidencePath: string | null;
  outcome: string | null;
};

export type NotificationReason = 'delivered' | 'duplicate' | 'quiet_hours' | 'disabled' | 'foreground';

export type NotificationPlan = {
  deliver: boolean;
  reason: NotificationReason;
  quiet: boolean;
  title: string;
  body: string;
};

export type PlannerOptions = {
  /** Bounded memory; the oldest delivered keys are forgotten first. */
  capacity?: number;
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startMinute: 22 * 60,
  endMinute: 7 * 60,
  // 'local' follows the operating system's current zone, so travel and a
  // timezone change move the quiet window with the clock Victor is living in.
  timeZone: 'local',
};

export const DEFAULT_ATTENTION_SETTINGS: AttentionSettings = {
  notificationsEnabled: true,
  quietHours: DEFAULT_QUIET_HOURS,
};

const MAX_MINUTE = 24 * 60 - 1;

export function validMinute(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MINUTE;
}

export function validTimeZone(value: string): boolean {
  if (value === 'local') return true;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneFor(quiet: QuietHours): string {
  return quiet.timeZone === 'local' ? localTimeZone() : quiet.timeZone;
}

/** Wall-clock minutes in the configured zone; never a cached UTC offset. */
export function minutesInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone === 'local' ? localTimeZone() : timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * A quiet window is half-open: [start, end). A window that starts and ends at
 * the same minute is treated as empty rather than as all day.
 */
export function isQuietAt(now: Date, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  if (!validMinute(quiet.startMinute) || !validMinute(quiet.endMinute)) return false;
  if (quiet.startMinute === quiet.endMinute) return false;
  const minute = minutesInZone(now, zoneFor(quiet));
  if (quiet.startMinute < quiet.endMinute) {
    return minute >= quiet.startMinute && minute < quiet.endMinute;
  }
  return minute >= quiet.startMinute || minute < quiet.endMinute;
}

/** Quiet hours silence delivery; they never pause computation. */
export function describeQuiet(quiet: QuietHours): string {
  if (!quiet.enabled) return 'Quiet hours are off. Notifications can be delivered at any time.';
  const format = (value: number): string =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const zone = quiet.timeZone === 'local' ? `the current timezone (${localTimeZone()})` : quiet.timeZone;
  return `Quiet from ${format(quiet.startMinute)} to ${format(quiet.endMinute)} in ${zone}. Work continues; only notification delivery is silenced.`;
}

/**
 * Public notification content is deliberately generic: no prompt text, file
 * paths, task titles, or project names are exposed on the lock screen.
 */
export function publicNotification(event: AttentionEvent): { title: string; body: string } {
  const title =
    event.kind === 'blocker'
      ? 'Mona needs attention'
      : event.kind === 'run_failed'
        ? 'Mona could not finish a run'
        : event.kind === 'limit'
          ? 'Mona reached a limit'
          : 'Mona finished a run';
  const body =
    'Open Mona to review the result. Prompt text, file names, and project names are not shown in this notification.';
  return { title, body };
}

export class NotificationPlanner {
  private readonly capacity: number;
  private readonly seen = new Map<string, string>();

  constructor(options: PlannerOptions = {}) {
    this.capacity = Math.max(8, options.capacity ?? 500);
  }

  /**
   * Decide once. Every planned key is remembered, including suppressed ones, so
   * a reconnect cannot replay an old completion and a suppressed alert is not
   * delivered late when quiet hours end.
   */
  plan(
    event: AttentionEvent,
    settings: AttentionSettings,
    now: Date,
    options: { foreground?: boolean } = {},
  ): NotificationPlan {
    const quiet = isQuietAt(now, settings.quietHours);
    const payload = publicNotification(event);
    const previous = this.seen.get(event.key);
    if (previous !== undefined) {
      return { deliver: false, reason: 'duplicate', quiet, ...payload };
    }
    this.remember(event.key, event.at);
    if (!settings.notificationsEnabled) {
      return { deliver: false, reason: 'disabled', quiet, ...payload };
    }
    if (quiet) {
      return { deliver: false, reason: 'quiet_hours', quiet, ...payload };
    }
    if (options.foreground) {
      return { deliver: false, reason: 'foreground', quiet, ...payload };
    }
    return { deliver: true, reason: 'delivered', quiet, ...payload };
  }

  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  get size(): number {
    return this.seen.size;
  }

  private remember(key: string, at: string): void {
    this.seen.set(key, at);
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

export type TrayInput = {
  running: boolean;
  blocked: boolean;
  failed: boolean;
  engineState: string;
  activeProjectLabel: string | null;
  lastCompletedAt: string | null;
};

/** The tray says what is true: running, blocked, completed, or idle. */
export function trayView(input: TrayInput): TrayView {
  const tone: TrayTone =
    input.blocked || input.failed
      ? 'attention'
      : input.running
        ? 'running'
        : input.lastCompletedAt
          ? 'complete'
          : 'idle';
  const detail = input.blocked
    ? 'Work is blocked until the recorded problem is reopened or a decision is recorded.'
    : input.failed
      ? 'The last turn needs attention. Its outcome is not reported as success.'
      : input.running
        ? 'A turn is running. Closing the window hides Mona; it does not stop the work.'
        : input.lastCompletedAt
          ? `Last run finished at ${input.lastCompletedAt}.`
          : input.engineState === 'connected'
            ? 'The runtime is connected and idle. Idle Mona makes no request.'
            : 'No runtime is running. Idle Mona makes no request.';
  const label = input.activeProjectLabel ? ` — ${input.activeProjectLabel}` : '';
  const tooltip =
    tone === 'attention'
      ? `Mona needs attention${label}`
      : tone === 'running'
        ? `Mona is working${label}`
        : tone === 'complete'
          ? `Mona finished${label}`
          : 'Mona is idle';
  return { tone, tooltip, detail };
}
