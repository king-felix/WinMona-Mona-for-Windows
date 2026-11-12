import { describe, expect, it } from 'vitest';
import { LAUNCH_CHANNELS, type LaunchStateView } from '../shared/launch.js';
import { registerLaunchIpc } from './launch-ipc.js';

function harness(trusted = true): {
  channels: string[];
  invoke: (channel: string, payload: unknown) => unknown;
  state: LaunchStateView;
} {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const state: LaunchStateView = {
    latest: {
      seq: 2,
      at: '2026-11-12T00:00:00.000Z',
      source: 'second-instance',
      requestedPath: 'C:\\Work\\Alpha',
      openedPath: 'c:\\work\\alpha',
      status: 'ready',
      detail: 'Alpha is open from Explorer. No task was sent.',
      warnings: [],
      project: null,
      engine: null,
      profile: null,
      focusComposer: true,
    },
    count: 2,
  };
  const channels = registerLaunchIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    isTrustedSender: () => trusted,
    state: () => state,
  });
  return {
    channels,
    state,
    invoke: (channel, payload) => handlers.get(channel)?.({}, payload),
  };
}

describe('launch IPC', () => {
  it('registers exactly the snapshot channel and returns the receipt state', () => {
    const h = harness();
    expect(h.channels).toEqual([LAUNCH_CHANNELS.state]);
    expect(h.invoke(LAUNCH_CHANNELS.state, {})).toEqual({ ok: true, data: h.state });
  });

  it('refuses an untrusted sender before reading any state', () => {
    const h = harness(false);
    expect(h.invoke(LAUNCH_CHANNELS.state, {})).toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('accepts only an empty payload', () => {
    const h = harness();
    expect(h.invoke(LAUNCH_CHANNELS.state, { path: 'C:\\Work\\Alpha' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
