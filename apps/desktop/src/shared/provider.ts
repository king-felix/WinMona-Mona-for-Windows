import type { ConfigurationChangeReceipt, ProviderWorkbenchView, SettingsChangeReceipt } from '@mona/contracts';
import type { IpcResult } from './catalog.js';

export const PROVIDER_CHANNELS = {
  get: 'mona:provider-get',
  applyRoute: 'mona:provider-apply-route',
  applyPermission: 'mona:provider-apply-permission',
  applyMode: 'mona:provider-apply-mode',
} as const;

export type ProviderBridge = {
  providerGet(input: {
    projectId: string;
    sessionId: string;
    providerId?: string;
  }): Promise<IpcResult<ProviderWorkbenchView>>;
  providerApplyRoute(input: {
    projectId: string;
    sessionId: string;
    provider: string;
    model: string;
    expectedRevision: string;
  }): Promise<IpcResult<ConfigurationChangeReceipt>>;
  providerApplyPermission(input: {
    projectId: string;
    sessionId: string;
    posture: 'ask' | 'auto-review' | 'full-access';
    expectedRevision: string;
  }): Promise<IpcResult<SettingsChangeReceipt>>;
  providerApplyMode(input: {
    projectId: string;
    sessionId: string;
    mode: 'agent' | 'plan';
    expectedRevision: string;
  }): Promise<IpcResult<SettingsChangeReceipt>>;
};
