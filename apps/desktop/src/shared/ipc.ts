import { z } from 'zod';
import type { ErrorResult } from '@mona/contracts';

/** The only request the preload bridge may send in P02. */
export const AppInfoRequest = z.object({}).strict();
export type AppInfoRequest = z.infer<typeof AppInfoRequest>;

export const APP_INFO_VERSION = 1;

export type AppInfo = {
  schemaVersion: 1;
  name: 'Mona';
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  engine: { status: 'not_connected'; detail: string };
};

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorResult };
