import type { AppInfo, IpcResult } from '../shared/ipc.js';

declare global {
  interface Window {
    mona: {
      getAppInfo(): Promise<IpcResult<AppInfo>>;
    };
  }
}

export {};
