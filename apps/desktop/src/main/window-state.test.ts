import { describe, expect, it } from 'vitest';
import { attachWindowState, readWindowState, registerWindowIpc } from './window-state.js';
import type { IpcHandle } from './ipc.js';
import { WINDOW_CHANNELS } from '../shared/window.js';

type Listener = (...args: unknown[]) => void;

/** A stand-in for the parts of BrowserWindow this module touches. */
function fakeWindow(options: { fullScreen?: boolean; maximized?: boolean } = {}) {
  const state = {
    fullScreen: options.fullScreen ?? false,
    maximized: options.maximized ?? false,
    focused: true,
    calls: 0,
  };
  const listeners = new Map<string, Set<Listener>>();
  const inputListeners = new Set<(event: { preventDefault: () => void }, input: Record<string, unknown>) => void>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const window = {
    getBounds: () => ({ width: 1280, height: 800, x: 0, y: 0 }),
    getNormalBounds: () => ({ width: 1200, height: 760, x: 0, y: 0 }),
    isFullScreen: () => state.fullScreen,
    isMaximized: () => state.maximized,
    isFocused: () => state.focused,
    isDestroyed: () => false,
    setFullScreen: (value: boolean) => {
      state.calls += 1;
      state.fullScreen = value;
    },
    on: (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      on: (
        event: string,
        listener: (event: { preventDefault: () => void }, input: Record<string, unknown>) => void,
      ) => {
        if (event === 'before-input-event') inputListeners.add(listener);
      },
      removeListener: (
        event: string,
        listener: (event: { preventDefault: () => void }, input: Record<string, unknown>) => void,
      ) => {
        if (event === 'before-input-event') inputListeners.delete(listener);
      },
    },
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    press: (input: Record<string, unknown>) => {
      let prevented = false;
      for (const listener of inputListeners) {
        listener(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          input,
        );
      }
      return prevented;
    },
  };
  return { window, state, sent, listeners, inputListeners };
}

function harness(options: { trusted?: boolean; fullScreen?: boolean; maximized?: boolean } = {}) {
  const fake = fakeWindow(options);
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const channels = registerWindowIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    window: () => fake.window as never,
  });
  const invoke = (channel: string, payload: unknown): unknown => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return listener({}, payload);
  };
  return { ...fake, channels, invoke };
}

describe('native window state', () => {
  it('reports what the window says, not what the renderer asked for', () => {
    const { window } = fakeWindow({ fullScreen: true, maximized: false });
    const state = readWindowState(window as never);
    expect(state).toMatchObject({ fullScreen: true, maximized: false, width: 1280, height: 800 });
    expect(state.normalWidth).toBe(1200);
  });

  it('changes fullscreen only when the window is not already there', () => {
    const h = harness({ fullScreen: false });
    const entered = h.invoke(WINDOW_CHANNELS.setFullScreen, { fullScreen: true }) as {
      ok: boolean;
      data: { fullScreen: boolean };
    };
    expect(entered.ok).toBe(true);
    expect(entered.data.fullScreen).toBe(true);
    expect(h.state.calls).toBe(1);

    // Asking for the state it already has is a no-op, not a second transition.
    h.invoke(WINDOW_CHANNELS.setFullScreen, { fullScreen: true });
    expect(h.state.calls).toBe(1);

    const left = h.invoke(WINDOW_CHANNELS.setFullScreen, { fullScreen: false }) as {
      ok: boolean;
      data: { fullScreen: boolean };
    };
    expect(left.data.fullScreen).toBe(false);
    expect(h.state.calls).toBe(2);
  });

  it('refuses an untrusted sender and a non-boolean request', () => {
    const untrusted = harness({ trusted: false });
    expect(untrusted.invoke(WINDOW_CHANNELS.setFullScreen, { fullScreen: true })).toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
    expect(untrusted.state.calls).toBe(0);

    const h = harness();
    for (const payload of [{ fullScreen: 'yes' }, {}, { fullScreen: true, extra: 1 }, null]) {
      expect(h.invoke(WINDOW_CHANNELS.setFullScreen, payload)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
    expect(h.state.calls).toBe(0);
  });

  it('pushes the observed state on native transitions', () => {
    const h = harness();
    const detach = attachWindowState(h.window as never);
    // The native layer reports the transition after the state has changed.
    h.state.fullScreen = true;
    h.window.emit('enter-full-screen');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.channel).toBe(WINDOW_CHANNELS.event);
    expect((h.sent[0]?.payload as { fullScreen: boolean }).fullScreen).toBe(true);
    h.state.fullScreen = false;
    h.window.emit('leave-full-screen');
    expect((h.sent[1]?.payload as { fullScreen: boolean }).fullScreen).toBe(false);
    detach();
    h.window.emit('maximize');
    expect(h.sent).toHaveLength(2);
  });

  it('owns F11 and ignores a modified F11', () => {
    const h = harness();
    const detach = attachWindowState(h.window as never);
    expect(h.window.press({ type: 'keyDown', key: 'F11', alt: false, control: false, meta: false })).toBe(true);
    expect(h.state.fullScreen).toBe(true);
    h.window.press({ type: 'keyDown', key: 'F11', alt: false, control: false, meta: false });
    expect(h.state.fullScreen).toBe(false);
    h.window.press({ type: 'keyDown', key: 'F11', alt: true, control: false, meta: false });
    expect(h.state.fullScreen).toBe(false);
    h.window.press({ type: 'keyUp', key: 'F11', alt: false, control: false, meta: false });
    expect(h.state.fullScreen).toBe(false);
    detach();
  });
});
