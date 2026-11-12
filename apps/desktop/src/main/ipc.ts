import { errorResult } from '@mona/contracts';
import { APP_INFO_CHANNEL } from '../shared/channels.js';
import { AppInfoRequest, type AppInfo, type IpcResult } from '../shared/ipc.js';

export type IpcHandle = (
  channel: string,
  listener: (event: unknown, payload: unknown) => IpcResult<unknown> | Promise<IpcResult<unknown>>,
) => void;

export function createAppInfo(input: {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
}): AppInfo {
  return {
    schemaVersion: 1,
    name: 'Mona',
    version: input.version,
    electron: input.electron,
    chrome: input.chrome,
    node: input.node,
    platform: input.platform,
    arch: input.arch,
    engine: {
      status: 'not_connected',
      detail: 'No Codewhale runtime is owned yet. Connecting arrives with the adapter build.',
    },
  };
}

/** Registers the single narrow IPC surface and validates sender and payload. */
export function registerIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  getAppInfo: () => AppInfo;
}): void {
  deps.handle(APP_INFO_CHANNEL, (event, payload) => {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
    }
    const parsed = AppInfoRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'app-info accepts an empty object only.') };
    }
    try {
      return { ok: true, data: deps.getAppInfo() };
    } catch {
      return { ok: false, error: errorResult('internal', 'Could not read application information.', true) };
    }
  });
}
