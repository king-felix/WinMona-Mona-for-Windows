import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import type { IpcResult } from '../shared/catalog.js';
import { MEMORY_CHANNELS } from '../shared/memory.js';
import type { IpcHandle } from './ipc.js';
import type { MemoryService } from './memory-service.js';

const ProjectRequest = z.object({ projectId: z.string().min(1).max(80) }).strict();

const SearchRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    query: z.string().min(1).max(200),
    mode: z.enum(['history', 'files']),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const VariableInput = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
    description: z.string().max(500),
    required: z.boolean(),
    defaultValue: z.string().max(2_000).nullable(),
  })
  .strict();

const AcceptanceInput = z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(500) }).strict();

const PromptSaveRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    id: z.string().min(1).max(80).optional(),
    label: z.string().min(1).max(120),
    description: z.string().max(1_000).optional(),
    template: z.string().min(1).max(20_000),
    variables: z.array(VariableInput).max(24).optional(),
    acceptance: z.array(AcceptanceInput).max(50).optional(),
  })
  .strict();

const PromptRemoveRequest = z
  .object({ projectId: z.string().min(1).max(80), promptId: z.string().min(1).max(80) })
  .strict();

const PromptPreviewRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    promptId: z.string().min(1).max(80),
    values: z.record(z.string().max(40), z.string().max(2_000)),
  })
  .strict()
  .refine((value) => Object.keys(value.values).length <= 24, 'Too many prompt values.');

const PortableExportRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    kind: z.enum(['handoff', 'resume', 'settings', 'diagnostics']),
    includeFiles: z.array(z.string().min(1).max(240)).max(200).optional(),
  })
  .strict();

const PortableImportRequest = z
  .object({
    kind: z.enum(['handoff', 'resume', 'settings']),
    replaceExisting: z.boolean().optional(),
  })
  .strict();

const DiagnosticsRequest = z.object({ verifyArtifacts: z.boolean().optional() }).strict();

type Handler = (payload: unknown, service: MemoryService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

/**
 * Registers the memory surface. Each channel validates the sender, then the
 * payload, then delegates. The renderer never supplies a file path: dialogs are
 * owned by the main process.
 */
export function registerMemoryIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => MemoryService | null;
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
          error: errorResult('internal', 'Local project memory is unavailable. See Settings → Diagnostics.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The memory action failed.', true) };
      }
    });
  };

  register(MEMORY_CHANNELS.search, SearchRequest, (payload, service) =>
    service.search(payload as { projectId: string; query: string; mode: 'history' | 'files'; limit?: number }),
  );
  register(MEMORY_CHANNELS.reindex, ProjectRequest, (payload, service) =>
    service.reindex((payload as { projectId: string }).projectId),
  );
  register(MEMORY_CHANNELS.promptSave, PromptSaveRequest, (payload, service) =>
    service.promptSave(payload as Parameters<MemoryService['promptSave']>[0]),
  );
  register(MEMORY_CHANNELS.promptRemove, PromptRemoveRequest, (payload, service) =>
    service.promptRemove(payload as { projectId: string; promptId: string }),
  );
  register(MEMORY_CHANNELS.promptPreview, PromptPreviewRequest, (payload, service) =>
    service.promptPreview(payload as { projectId: string; promptId: string; values: Record<string, string> }),
  );
  register(MEMORY_CHANNELS.promptImport, ProjectRequest, (payload, service) =>
    service.promptImport((payload as { projectId: string }).projectId),
  );
  register(MEMORY_CHANNELS.promptExport, ProjectRequest, (payload, service) =>
    service.promptExport((payload as { projectId: string }).projectId),
  );
  register(MEMORY_CHANNELS.portableExport, PortableExportRequest, (payload, service) =>
    service.portableExport(
      payload as {
        projectId: string;
        kind: 'handoff' | 'resume' | 'settings' | 'diagnostics';
        includeFiles?: string[];
      },
    ),
  );
  register(MEMORY_CHANNELS.portableImport, PortableImportRequest, (payload, service) =>
    service.portableImport(payload as { kind: 'handoff' | 'resume' | 'settings'; replaceExisting?: boolean }),
  );
  register(MEMORY_CHANNELS.diagnosticsPreview, DiagnosticsRequest, (payload, service) =>
    service.diagnosticsPreview(payload as { verifyArtifacts?: boolean }),
  );

  return channels;
}
