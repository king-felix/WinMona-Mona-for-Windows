import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing appearance vocabulary: the window's zoom scale, and nothing
 * else. Zoom is a presentation preference — it changes no product behaviour, it
 * never reaches the engine, and it makes no provider request.
 *
 * The steps are a fixed list rather than a free number so a stray key event
 * cannot request 800% or 5%, and so the same list can be used by the keyboard
 * handler, the status bar controls, and the tests.
 */
export const APPEARANCE_CHANNELS = {
  get: 'mona:appearance-get',
  zoom: 'mona:appearance-zoom',
  event: 'mona:appearance-event',
} as const;

/** Smallest to largest. 1 is the design scale. */
export const ZOOM_FACTORS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const ZOOM_MIN = ZOOM_FACTORS[0];
export const ZOOM_MAX = ZOOM_FACTORS[ZOOM_FACTORS.length - 1];

export type ZoomDirection = 'in' | 'out' | 'reset';

export type AppearanceView = {
  /** Chromium zoom factor actually applied to the window. */
  zoomFactor: number;
  /** The same value as a whole percentage, for display. */
  zoomPercent: number;
  /** False at the end of the ladder, so a control can be honestly disabled. */
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** Already-redacted fact for the status bar, e.g. "Scale 90%". */
  detail: string;
};

export type AppearanceBridge = {
  appearanceGet(): Promise<IpcResult<AppearanceView>>;
  /** Step the window scale. Structural, not a data mutation. */
  appearanceZoom(input: { direction: ZoomDirection }): Promise<IpcResult<AppearanceView>>;
  /** Pushes the new scale after a keyboard shortcut handled in the main process. */
  onAppearance(handler: (view: AppearanceView) => void): () => void;
};
