import { z } from 'zod';
import type { ErrorResult } from '@mona/contracts';
import { ENGINE_STATUS_VALUES, type EngineStatus } from './engine-status.js';

export { ENGINE_STATUS_LABEL } from './engine-status.js';
export type { EngineStatus } from './engine-status.js';

/** The only request the preload bridge may send. */
export const AppInfoRequest = z.object({}).strict();
export type AppInfoRequest = z.infer<typeof AppInfoRequest>;

export const APP_INFO_VERSION = 1;

/**
 * Runtime ownership states Mona can actually observe. There is no single
 * "not connected": an unopened project, a failed start, and a crashed runtime
 * are different facts and carry different labels.
 */
export const EngineStatusSchema = z.enum(ENGINE_STATUS_VALUES as [EngineStatus, ...EngineStatus[]]);

export type AppInfo = {
  schemaVersion: 1;
  name: 'Mona';
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  engine: {
    status: EngineStatus;
    detail: string;
    /** Short, already-redacted lifecycle facts; never tokens or secret paths. */
    descriptors: string[];
  };
};

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorResult };
