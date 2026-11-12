import type { CapabilityExplorerView, LogContent, TerminalCheck } from '@mona/contracts';
import type { IpcResult } from './catalog.js';

export const CAPABILITY_CHANNELS = {
  get: 'mona:capabilities-get',
  readLog: 'mona:capabilities-read-log',
  checkTerminal: 'mona:capabilities-check-terminal',
} as const;

export type CapabilityBridge = {
  capabilitiesGet(input?: Record<string, never>): Promise<IpcResult<CapabilityExplorerView>>;
  capabilitiesReadLog(input: { name: string; offset?: number; limit?: number }): Promise<IpcResult<LogContent>>;
  capabilitiesCheckTerminal(input?: Record<string, never>): Promise<IpcResult<TerminalCheck>>;
};
