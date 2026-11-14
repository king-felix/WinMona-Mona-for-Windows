/**
 * The narrow window boundary. The renderer may ask for the desktop window's
 * fullscreen state and read back what the window actually reports; it never
 * guesses, and Maximize is deliberately not the same thing as Full screen.
 */
export const WINDOW_CHANNELS = {
  get: 'mona:window-state',
  setFullScreen: 'mona:window-set-fullscreen',
  event: 'mona:window-event',
} as const;

export type WindowState = {
  /** Observed from the native window, not from a renderer flag. */
  fullScreen: boolean;
  maximized: boolean;
  focused: boolean;
  width: number;
  height: number;
  /** The window's normal (non-maximized) size, for reporting only. */
  normalWidth: number;
  normalHeight: number;
};

export type WindowBridge = {
  windowStateGet(): Promise<{ ok: true; data: WindowState } | { ok: false; error: { code: string; message: string } }>;
  windowSetFullScreen(input: {
    fullScreen: boolean;
  }): Promise<{ ok: true; data: WindowState } | { ok: false; error: { code: string; message: string } }>;
  onWindowState(handler: (state: WindowState) => void): () => void;
};
