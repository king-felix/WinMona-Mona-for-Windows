import type { CatalogBridge } from '../shared/catalog.js';
import type { AppInfo, IpcResult } from '../shared/ipc.js';
import type { StudioBridge } from '../shared/studio.js';

declare global {
  interface Window {
    mona: CatalogBridge &
      StudioBridge & {
        getAppInfo(): Promise<IpcResult<AppInfo>>;
      };
  }
}

export {};
