/**
 * Renderer-safe engine vocabulary. This module must stay free of zod and any
 * other schema library so the preload/renderer bundle never carries validation
 * machinery or schema URLs.
 */
export const EngineStatus = {
  notStarted: 'not_started',
  starting: 'starting',
  connected: 'connected',
  failed: 'failed',
  stopping: 'stopping',
  stopped: 'stopped',
  crashed: 'crashed',
} as const;

export type EngineStatus = (typeof EngineStatus)[keyof typeof EngineStatus];

export const ENGINE_STATUS_VALUES: readonly EngineStatus[] = [
  'not_started',
  'starting',
  'connected',
  'failed',
  'stopping',
  'stopped',
  'crashed',
];

export const ENGINE_STATUS_LABEL: Record<EngineStatus, string> = {
  not_started: 'Engine not connected',
  starting: 'Engine starting',
  connected: 'Engine connected',
  failed: 'Engine unavailable',
  stopping: 'Engine stopping',
  stopped: 'Engine stopped',
  crashed: 'Engine crashed',
};
