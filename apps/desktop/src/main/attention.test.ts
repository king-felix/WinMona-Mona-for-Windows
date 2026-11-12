import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTENTION_SETTINGS,
  DEFAULT_QUIET_HOURS,
  NotificationPlanner,
  describeQuiet,
  isQuietAt,
  minutesInZone,
  publicNotification,
  trayView,
  validTimeZone,
  type AttentionEvent,
} from './attention.js';

const quiet = (overrides: Partial<typeof DEFAULT_QUIET_HOURS> = {}): typeof DEFAULT_QUIET_HOURS => ({
  ...DEFAULT_QUIET_HOURS,
  enabled: true,
  startMinute: 22 * 60,
  endMinute: 7 * 60,
  timeZone: 'UTC',
  ...overrides,
});

function event(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    key: 'prj_1:turn:trn_1:completed',
    kind: 'run_completed',
    projectId: 'prj_1',
    projectLabel: 'secret-client-project',
    at: '2026-11-12T12:00:00.000Z',
    taskId: 'tsk_1',
    turnId: 'trn_1',
    evidencePath: 'docs/private/customer-notes.md',
    outcome: 'completed',
    ...overrides,
  };
}

describe('quiet hours', () => {
  it('reads the wall clock in the configured zone, including DST', () => {
    expect(minutesInZone(new Date('2026-11-12T12:30:00.000Z'), 'America/New_York')).toBe(7 * 60 + 30);
    expect(minutesInZone(new Date('2026-07-01T12:30:00.000Z'), 'America/New_York')).toBe(8 * 60 + 30);
    expect(minutesInZone(new Date('2026-11-12T12:30:00.000Z'), 'Asia/Tokyo')).toBe(21 * 60 + 30);
  });

  it('is half-open and wraps across midnight', () => {
    expect(isQuietAt(new Date('2026-11-12T21:59:00.000Z'), quiet())).toBe(false);
    expect(isQuietAt(new Date('2026-11-12T22:00:00.000Z'), quiet())).toBe(true);
    expect(isQuietAt(new Date('2026-11-13T06:59:00.000Z'), quiet())).toBe(true);
    expect(isQuietAt(new Date('2026-11-13T07:00:00.000Z'), quiet())).toBe(false);
    expect(isQuietAt(new Date('2026-11-12T12:00:00.000Z'), quiet({ startMinute: 9 * 60, endMinute: 17 * 60 }))).toBe(
      true,
    );
  });

  it('treats a zero-length window as empty and an invalid window as off', () => {
    expect(isQuietAt(new Date('2026-11-12T22:00:00.000Z'), quiet({ startMinute: 60, endMinute: 60 }))).toBe(false);
    expect(isQuietAt(new Date('2026-11-12T22:00:00.000Z'), quiet({ startMinute: -1 }))).toBe(false);
    expect(isQuietAt(new Date('2026-11-12T22:00:00.000Z'), quiet({ enabled: false }))).toBe(false);
  });

  it('moves with a timezone change instead of caching an offset', () => {
    const tokyo = quiet({ timeZone: 'Asia/Tokyo' });
    expect(isQuietAt(new Date('2026-11-12T12:30:00.000Z'), tokyo)).toBe(false);
    expect(isQuietAt(new Date('2026-11-12T13:30:00.000Z'), tokyo)).toBe(true);
    const newYork = quiet({ timeZone: 'America/New_York' });
    expect(isQuietAt(new Date('2026-11-12T12:30:00.000Z'), newYork)).toBe(false);
    expect(isQuietAt(new Date('2026-11-12T03:30:00.000Z'), newYork)).toBe(true);
  });

  it('handles the spring-forward boundary by wall clock', () => {
    const newYork = quiet({ timeZone: 'America/New_York' });
    expect(isQuietAt(new Date('2026-03-08T06:30:00.000Z'), newYork)).toBe(true);
    expect(isQuietAt(new Date('2026-03-08T07:30:00.000Z'), newYork)).toBe(true);
    expect(isQuietAt(new Date('2026-03-08T11:30:00.000Z'), newYork)).toBe(false);
  });

  it('validates zones and describes the policy without claiming work pauses', () => {
    expect(validTimeZone('local')).toBe(true);
    expect(validTimeZone('Asia/Tokyo')).toBe(true);
    expect(validTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(describeQuiet(quiet())).toContain('Work continues');
    expect(describeQuiet({ ...DEFAULT_QUIET_HOURS, enabled: false })).toContain('off');
  });
});

describe('NotificationPlanner', () => {
  it('delivers a completion once and refuses a replayed reconnect', () => {
    const planner = new NotificationPlanner();
    const now = new Date('2026-11-12T12:00:00.000Z');
    const first = planner.plan(event(), DEFAULT_ATTENTION_SETTINGS, now);
    const replay = planner.plan(event(), DEFAULT_ATTENTION_SETTINGS, now);
    expect(first).toMatchObject({ deliver: true, reason: 'delivered', quiet: false });
    expect(replay).toMatchObject({ deliver: false, reason: 'duplicate' });
    expect(planner.size).toBe(1);
  });

  it('deduplicates when the same completion arrives through a new connection', () => {
    const planner = new NotificationPlanner();
    const settings = DEFAULT_ATTENTION_SETTINGS;
    expect(planner.plan(event(), settings, new Date('2026-11-12T12:00:00.000Z')).deliver).toBe(true);
    expect(
      planner.plan(event({ at: '2026-11-12T12:03:00.000Z' }), settings, new Date('2026-11-12T12:03:00.000Z')).reason,
    ).toBe('duplicate');
  });

  it('silences delivery during quiet hours and never delivers it late', () => {
    const planner = new NotificationPlanner();
    const settings = { ...DEFAULT_ATTENTION_SETTINGS, quietHours: quiet() };
    const during = planner.plan(event(), settings, new Date('2026-11-12T23:30:00.000Z'));
    expect(during).toMatchObject({ deliver: false, reason: 'quiet_hours', quiet: true });
    const after = planner.plan(event(), settings, new Date('2026-11-13T08:00:00.000Z'));
    expect(after).toMatchObject({ deliver: false, reason: 'duplicate' });
  });

  it('honours disabled notifications and foreground state without replaying later', () => {
    const disabled = new NotificationPlanner();
    expect(
      disabled.plan(event(), { ...DEFAULT_ATTENTION_SETTINGS, notificationsEnabled: false }, new Date()).reason,
    ).toBe('disabled');
    const foreground = new NotificationPlanner();
    expect(foreground.plan(event(), DEFAULT_ATTENTION_SETTINGS, new Date(), { foreground: true }).reason).toBe(
      'foreground',
    );
    expect(foreground.plan(event(), DEFAULT_ATTENTION_SETTINGS, new Date()).reason).toBe('duplicate');
  });

  it('keeps prompt, file, and project details out of the notification payload', () => {
    const payload = publicNotification(event());
    const text = `${payload.title} ${payload.body}`;
    expect(text).toContain('Open Mona');
    expect(text).not.toContain('secret-client-project');
    expect(text).not.toContain('customer-notes');
    expect(text).not.toContain('trn_1');
    expect(publicNotification(event({ kind: 'blocker' })).title).toContain('attention');
    expect(publicNotification(event({ kind: 'run_failed' })).title).toContain('could not finish');
  });
});

describe('trayView', () => {
  const base = {
    running: false,
    blocked: false,
    failed: false,
    engineState: 'connected',
    activeProjectLabel: 'Mona',
    lastCompletedAt: null,
  };

  it('reflects running, blocked, completed and idle states honestly', () => {
    expect(trayView({ ...base, running: true })).toMatchObject({ tone: 'running' });
    expect(trayView({ ...base, blocked: true })).toMatchObject({ tone: 'attention' });
    expect(trayView({ ...base, failed: true })).toMatchObject({ tone: 'attention' });
    expect(trayView({ ...base, lastCompletedAt: '2026-11-12T12:00:00.000Z' })).toMatchObject({ tone: 'complete' });
    expect(trayView(base)).toMatchObject({ tone: 'idle', tooltip: 'Mona is idle' });
  });

  it('says closing hides Mona rather than stopping work', () => {
    expect(trayView({ ...base, running: true }).detail).toContain('does not stop the work');
    expect(trayView({ ...base, blocked: true }).detail).toContain('blocked');
  });
});
