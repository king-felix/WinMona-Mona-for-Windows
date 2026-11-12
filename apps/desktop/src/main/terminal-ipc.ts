import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { TERMINAL_CHANNELS, TERMINAL_LIMITS } from '../shared/terminal.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';
import type { TerminalService } from './terminal-service.js';

const ProjectId = z.string().min(1).max(80);
const SessionId = z.string().min(1).max(80);
const Size = {
  cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols),
  rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows),
};

const CreateRequest = z.object({ projectId: ProjectId, ...Size }).strict();
const InputRequest = z
  .object({
    projectId: ProjectId,
    sessionId: SessionId,
    data: z.string().max(TERMINAL_LIMITS.inputBytes),
  })
  .strict();
const ResizeRequest = z.object({ projectId: ProjectId, sessionId: SessionId, ...Size }).strict();
const SessionRequest = z.object({ projectId: ProjectId, sessionId: SessionId }).strict();
const CopyRequest = z
  .object({
    data: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict();

type Handler = (payload: unknown, service: TerminalService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export function registerTerminalIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => TerminalService | null;
  clipboard: (text: string) => void | Promise<void>;
}): string[] {
  const channels: string[] = [];
  const register = (channel: string, schema: z.ZodType, handler: Handler): void => {
    channels.push(channel);
    deps.handle(channel, (event, payload) => {
      if (!deps.isTrustedSender(event)) {
        return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: errorResult('invalid_request', `${channel} received an invalid request.`) };
      }
      const service = deps.service();
      if (!service) {
        return {
          ok: false,
          error: errorResult('internal', 'The terminal is available only inside the running app.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The terminal action failed.', true) };
      }
    });
  };
  register(TERMINAL_CHANNELS.create, CreateRequest, (payload, service) =>
    service.create(payload as { projectId: string; cols: number; rows: number }),
  );
  register(TERMINAL_CHANNELS.input, InputRequest, (payload, service) =>
    service.input(payload as { projectId: string; sessionId: string; data: string }),
  );
  register(TERMINAL_CHANNELS.resize, ResizeRequest, (payload, service) =>
    service.resize(payload as { projectId: string; sessionId: string; cols: number; rows: number }),
  );
  register(TERMINAL_CHANNELS.kill, SessionRequest, (payload, service) =>
    service.kill(payload as { projectId: string; sessionId: string }),
  );
  register(TERMINAL_CHANNELS.refresh, SessionRequest, (payload, service) =>
    service.refresh(payload as { projectId: string; sessionId: string }),
  );
  register(TERMINAL_CHANNELS.copy, CopyRequest, async (payload) => {
    const { data } = payload as { data: string };
    await deps.clipboard(data);
    return { ok: true, data: { copied: data.length } };
  });
  return channels;
}
