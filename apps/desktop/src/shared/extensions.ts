import type { ExtensionActionReceipt, ExtensionsView, McpHealthView } from '@mona/contracts';
import type { IpcResult } from './catalog.js';

export const EXTENSION_CHANNELS = {
  get: 'mona:extensions-get',
  setMcp: 'mona:extensions-set-mcp',
  checkMcp: 'mona:extensions-check-mcp',
} as const;

export type ExtensionBridge = {
  extensionsGet(input: { projectId: string }): Promise<IpcResult<ExtensionsView>>;
  extensionsSetMcp(input: {
    projectId: string;
    name: string;
    enabled: boolean;
    expectedRevision: string;
  }): Promise<IpcResult<ExtensionActionReceipt>>;
  extensionsCheckMcp(input: {
    projectId: string;
    name: string;
    expectedRevision: string;
  }): Promise<IpcResult<McpHealthView>>;
};
