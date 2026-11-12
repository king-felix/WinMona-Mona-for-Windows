import { errorResult } from '@mona/contracts';
import { APP_INFO_CHANNEL } from '../shared/channels.js';
import { AppInfoRequest, type AppInfo, type EngineStatus, type IpcResult } from '../shared/ipc.js';

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
  engine?: {
    status: EngineStatus;
    detail: string;
    descriptors?: string[];
    workspace?: string | null;
    pid?: number | null;
    endpoint?: string | null;
    compatibility?: 'qualified' | 'compatible_unqualified' | 'unsupported' | null;
  };
  localState?: { available: boolean; schemaVersion: number | null; detail: string };
  /** The saved profile read from local state; never a hard-coded badge. */
  permission?: { label: string; profile: string | null; detail: string };
  harnessEnabled?: boolean;
}): AppInfo {
  const engine = input.engine ?? {
    status: 'not_started' as const,
    detail: 'No Codewhale runtime is running. Mona starts one only for a project you open.',
  };
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
      status: engine.status,
      detail: engine.detail,
      descriptors: engine.descriptors ?? [],
      workspace: engine.workspace ?? null,
      pid: engine.pid ?? null,
      endpoint: engine.endpoint ?? null,
      compatibility: engine.compatibility ?? null,
    },
    localState: input.localState ?? {
      available: false,
      schemaVersion: null,
      detail: 'Local state is not open yet.',
    },
    route: {
      provider: 'deepseek',
      model: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com',
      source: 'pinned build route; not contacted to display this',
    },
    permission: input.permission ?? {
      label: 'Full Access',
      profile: 'DS',
      detail: 'Saved Codewhale profile; the engine applies it when a runtime starts.',
    },
    credentials: {
      state: 'unknown',
      detail: 'Codewhale manages credentials. Mona never reads them; the runtime reports authentication at start.',
    },
    harnessEnabled: input.harnessEnabled ?? false,
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
