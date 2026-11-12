import type { AttentionBridge } from '../shared/attention.js';
import type { AgentBridge } from '../shared/agents.js';
import type { BriefingBridge } from '../shared/briefing.js';
import type { CatalogBridge } from '../shared/catalog.js';
import type { ExtensionBridge } from '../shared/extensions.js';
import type { AppInfo, IpcResult } from '../shared/ipc.js';
import type { LaunchBridge } from '../shared/launch.js';
import type { ProviderBridge } from '../shared/provider.js';
import type { StudioBridge } from '../shared/studio.js';

declare global {
  interface Window {
    mona: CatalogBridge &
      StudioBridge &
      AgentBridge &
      ProviderBridge &
      ExtensionBridge &
      LaunchBridge &
      AttentionBridge &
      BriefingBridge & {
        getAppInfo(): Promise<IpcResult<AppInfo>>;
      };
  }
}

export {};
