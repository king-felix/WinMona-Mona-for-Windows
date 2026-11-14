import { errorResult } from '@mona/contracts';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { WINDOW_CHANNELS, type WindowState } from '../shared/window.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';

/**
 * The desktop window's fullscreen state, owned by the main process.
 *
 * Electron reports the real state after the native transition; the renderer only
 * ever reads it. F11 is handled here, in `before-input-event`, because there is
 * no application menu and because a focused terminal or editor should not be
 * able to swallow the shortcut — and, with no renderer handler, the toggle cannot
 * fire twice for one key press.
 */
export function readWindowState(window: BrowserWindow): WindowState {
  const bounds = window.getBounds();
  const normal = window.getNormalBounds();
  return {
    fullScreen: window.isFullScreen(),
    maximized: window.isMaximized(),
    focused: window.isFocused(),
    width: bounds.width,
    height: bounds.height,
    normalWidth: normal.width,
    normalHeight: normal.height,
  };
}

const SetFullScreenRequest = z.object({ fullScreen: z.boolean() }).strict();

export function registerWindowIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  window: () => BrowserWindow | null;
}): string[] {
  const channels: string[] = [];
  const register = (channel: string, handler: (payload: unknown) => IpcResult<unknown>): void => {
    channels.push(channel);
    deps.handle(channel, (event, payload) => {
      if (!deps.isTrustedSender(event)) {
        return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
      }
      const window = deps.window();
      if (!window || window.isDestroyed()) {
        return { ok: false, error: errorResult('internal', 'The application window is not available.') };
      }
      try {
        return handler(payload);
      } catch {
        return { ok: false, error: errorResult('internal', 'The window action failed.', true) };
      }
    });
  };

  register(WINDOW_CHANNELS.get, () => {
    const window = deps.window();
    return window && !window.isDestroyed()
      ? { ok: true, data: readWindowState(window) }
      : { ok: false, error: errorResult('internal', 'The application window is not available.') };
  });

  register(WINDOW_CHANNELS.setFullScreen, (payload) => {
    const parsed = SetFullScreenRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'A fullscreen request needs a boolean.') };
    }
    const window = deps.window();
    if (!window || window.isDestroyed()) {
      return { ok: false, error: errorResult('internal', 'The application window is not available.') };
    }
    if (window.isFullScreen() !== parsed.data.fullScreen) window.setFullScreen(parsed.data.fullScreen);
    return { ok: true, data: readWindowState(window) };
  });

  return channels;
}

/**
 * Pushes the observed native state on every transition that matters. Fullscreen
 * is never persisted: a relaunch starts in the window state the desktop chose.
 */
export function attachWindowState(window: BrowserWindow): () => void {
  const send = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(WINDOW_CHANNELS.event, readWindowState(window));
  };
  const events = [
    'enter-full-screen',
    'leave-full-screen',
    'maximize',
    'unmaximize',
    'focus',
    'blur',
    'resize',
    'restore',
  ] as const;
  const emitter = window as unknown as {
    on(event: string, listener: () => void): void;
    removeListener(event: string, listener: () => void): void;
  };
  for (const name of events) emitter.on(name, send);

  // F11 belongs to the window, not to whichever editor has focus.
  const onInput = (
    event: { preventDefault: () => void },
    input: { type: string; key: string; alt: boolean; control: boolean; meta: boolean },
  ): void => {
    if (input.type !== 'keyDown' || input.key !== 'F11') return;
    if (input.alt || input.control || input.meta) return;
    event.preventDefault();
    window.setFullScreen(!window.isFullScreen());
  };
  const contents = window.webContents as unknown as {
    on(event: string, listener: typeof onInput): void;
    removeListener(event: string, listener: typeof onInput): void;
  };
  contents.on('before-input-event', onInput);

  return () => {
    for (const name of events) emitter.removeListener(name, send);
    if (!window.isDestroyed()) contents.removeListener('before-input-event', onInput);
  };
}
