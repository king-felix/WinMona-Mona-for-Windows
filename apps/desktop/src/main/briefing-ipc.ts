import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import type { BriefingService } from '@mona/project-state';
import { BRIEFING_CHANNELS, type BriefingView } from '../shared/briefing.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';
import type { UiStateStore } from './ui-state.js';

const GetRequest = z.object({ projectId: z.string().min(1).max(80), markSeen: z.boolean().optional() }).strict();

/**
 * One read-only projection. Computing the brief never submits work, opens a
 * runtime, or calls a model; the only write is the local last-seen timestamp
 * when the caller explicitly asks for it.
 */
export function registerBriefingIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => BriefingService | null;
  ui: () => UiStateStore | null;
}): string[] {
  const channels: string[] = [];
  deps.handle(BRIEFING_CHANNELS.get, async (event, payload): Promise<IpcResult<BriefingView>> => {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
    }
    const parsed = GetRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'briefing-get received an invalid request.') };
    }
    const service = deps.service();
    const ui = deps.ui();
    if (!service || !ui) {
      return { ok: false, error: errorResult('internal', 'Local project state is unavailable.', true) };
    }
    try {
      const since = ui.lastSeen(parsed.data.projectId);
      const [resume, digest] = await Promise.all([
        service.resumeBrief(parsed.data.projectId),
        service.sinceYouLeft(parsed.data.projectId, since),
      ]);
      if (parsed.data.markSeen) ui.markSeen(parsed.data.projectId);
      return { ok: true, data: { resume, since: digest } };
    } catch (error) {
      const message = String((error as Error).message ?? error);
      const code = message.includes('does not exist') ? 'not_found' : 'internal';
      return { ok: false, error: errorResult(code, message.slice(0, 300), code === 'internal') };
    }
  });
  channels.push(BRIEFING_CHANNELS.get);
  return channels;
}
