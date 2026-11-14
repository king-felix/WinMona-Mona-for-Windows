import type { AttentionBridge } from '../shared/attention.js';
import type { AppearanceBridge } from '../shared/appearance.js';
import type { AgentBridge } from '../shared/agents.js';
import type { BriefingBridge } from '../shared/briefing.js';
import type { CatalogBridge } from '../shared/catalog.js';
import type { ChangesBridge } from '../shared/changes.js';
import type { CommandBridge } from '../shared/commands.js';
import type { CostBridge } from '../shared/cost.js';
import type { CapabilityBridge } from '../shared/capabilities.js';
import type { ExtensionBridge } from '../shared/extensions.js';
import type { AppInfo, IpcResult } from '../shared/ipc.js';
import type { LaunchBridge } from '../shared/launch.js';
import type { MemoryBridge } from '../shared/memory.js';
import type { ProviderBridge } from '../shared/provider.js';
import type { StudioBridge } from '../shared/studio.js';
import type { TaskBridge } from '../shared/tasks.js';
import type { TerminalBridge } from '../shared/terminal.js';

declare global {
  interface Window {
    mona: CatalogBridge &
      StudioBridge &
      CommandBridge &
      AgentBridge &
      ProviderBridge &
      ExtensionBridge &
      CapabilityBridge &
      TerminalBridge &
      LaunchBridge &
      AttentionBridge &
      AppearanceBridge &
      BriefingBridge &
      MemoryBridge &
      ChangesBridge &
      CostBridge &
      TaskBridge & {
        getAppInfo(): Promise<IpcResult<AppInfo>>;
      };
  }
}

export {};
