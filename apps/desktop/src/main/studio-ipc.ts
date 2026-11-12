import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import type { IpcResult } from '../shared/catalog.js';
import { STUDIO_CHANNELS } from '../shared/studio.js';
import type { StudioService } from './studio-service.js';
import type { IpcHandle } from './ipc.js';

const ProjectOnly = z.object({ projectId: z.string().min(1).max(80) }).strict();
const StudioRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    mode: z.enum(['agent', 'plan']).optional(),
  })
  .strict();
const SubmitRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    text: z.string().min(1).max(100_000),
    mode: z.enum(['agent', 'plan']),
    references: z.array(z.string().min(1).max(512)).max(50),
  })
  .strict();

type Handler = (payload: unknown, service: StudioService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

/**
 * The studio surface. Like the catalog surface, every channel validates the
 * sender, then the payload, then delegates; a renderer never receives a raw
 * engine payload or an arbitrary runtime capability.
 */
export function registerStudioIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => StudioService | null;
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
          error: errorResult('internal', 'Local project state is unavailable. See Settings → Diagnostics.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The studio action failed.', true) };
      }
    });
  };

  register(STUDIO_CHANNELS.get, StudioRequest, (payload, service) => {
    const input = payload as { projectId: string; sessionId: string; mode?: 'agent' | 'plan' };
    return service.view(input.projectId, input.sessionId, input.mode);
  });
  register(STUDIO_CHANNELS.submit, SubmitRequest, (payload, service) => {
    const input = payload as {
      projectId: string;
      sessionId: string;
      text: string;
      mode: 'agent' | 'plan';
      references: string[];
    };
    return service.submit(input);
  });
  register(STUDIO_CHANNELS.interrupt, ProjectOnly, (payload, service) =>
    service.interrupt((payload as { projectId: string }).projectId),
  );
  register(STUDIO_CHANNELS.pause, ProjectOnly, (payload, service) =>
    service.pause((payload as { projectId: string }).projectId),
  );
  register(STUDIO_CHANNELS.resume, ProjectOnly, (payload, service) =>
    service.resume((payload as { projectId: string }).projectId),
  );
  register(STUDIO_CHANNELS.references, ProjectOnly, (payload, service) =>
    service.references((payload as { projectId: string }).projectId),
  );
  register(STUDIO_CHANNELS.export, StudioRequest, (payload, service) => {
    const input = payload as { projectId: string; sessionId: string; mode?: 'agent' | 'plan' };
    return service.exportConversation(input);
  });

  return channels;
}
