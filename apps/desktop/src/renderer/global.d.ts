import type { CatalogBridge } from '../shared/catalog.js';
import type { AppInfo, IpcResult } from '../shared/ipc.js';

declare global {
  interface Window {
    mona: CatalogBridge & {
      getAppInfo(): Promise<IpcResult<AppInfo>>;
    };
  }
}

export {};
