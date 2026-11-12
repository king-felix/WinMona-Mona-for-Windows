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
    workspace: string | null;
    pid: number | null;
    endpoint: string | null;
    compatibility: 'qualified' | 'compatible_unqualified' | 'unsupported' | null;
  };
  /** Durable local state availability, reported honestly at launch. */
  localState: {
    available: boolean;
    schemaVersion: number | null;
    detail: string;
  };
  /** The route Mona will present. It does not contact the provider to read it. */
  route: {
    provider: string;
    model: string;
    endpoint: string;
    source: string;
  };
  /** Full Access is the saved profile's posture, not renderer authority. */
  permission: {
    label: string;
    profile: string | null;
    detail: string;
  };
  /** Credentials belong to Codewhale; Mona never reads or echoes them. */
  credentials: {
    state: 'unknown';
    detail: string;
  };
  /** The P06 fixture harness renders only when a development flag enables it. */
  harnessEnabled: boolean;
};

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorResult };

export type { CatalogBridge } from './catalog.js';
