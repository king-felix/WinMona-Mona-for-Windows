import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import {
  CATALOG_CHANNELS,
  PROJECT_VIEWS,
  type IpcResult,
  type ProjectLayout,
  type ProjectView,
} from '../shared/catalog.js';
import type { CatalogService } from './catalog-service.js';
import type { IpcHandle } from './ipc.js';

const VIEWS: [ProjectView, ...ProjectView[]] = [...PROJECT_VIEWS];

const Empty = z.object({}).strict();
const ListRequest = z
  .object({
    includeArchived: z.boolean().optional(),
    query: z.string().max(200).optional(),
  })
  .strict();
const OpenRequest = z.object({ path: z.string().min(1).max(32_768) }).strict();
const PickFolderRequest = z.object({ purpose: z.enum(['open', 'create-parent']) }).strict();
const CreateRequest = z.object({ parent: z.string().min(1).max(32_768), name: z.string().min(1).max(120) }).strict();
const UpdateRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    expectedRevision: z.number().int().min(1),
    patch: z
      .object({
        label: z.string().max(120).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional(),
        monogram: z.string().max(3).nullable().optional(),
      })
      .strict(),
  })
  .strict();
const ProjectRequest = z.object({ projectId: z.string().min(1).max(80) }).strict();
const RelocateRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    expectedRevision: z.number().int().min(1),
    path: z.string().min(1).max(32_768),
  })
  .strict();
const SelectRequest = z.object({ projectId: z.string().min(1).max(80).nullable() }).strict();
const SetViewRequest = z.object({ projectId: z.string().min(1).max(80), view: z.enum(VIEWS) }).strict();
const SetLayoutRequest = z
  .object({ projectId: z.string().min(1).max(80), layout: z.enum(['standard', 'focus']) })
  .strict();
const FavoriteRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    text: z.string().min(1).max(20_000),
  })
  .strict();
const RemoveFavoriteRequest = z
  .object({ projectId: z.string().min(1).max(80), favoriteId: z.string().min(1).max(80) })
  .strict();
const SaveDraftRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    text: z.string().max(200_000),
  })
  .strict();

type Handler = (payload: unknown, service: CatalogService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

/**
 * Registers the catalog surface. Every channel validates the sender, then the
 * payload, then delegates to the service; the renderer never receives a raw
 * exception, a stack trace, or an arbitrary filesystem capability.
 */
export function registerCatalogIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: CatalogService | null;
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
        return {
          ok: false,
          error: errorResult('invalid_request', `${channel} received an invalid request.`),
        };
      }
      const service = deps.service;
      if (!service) {
        return {
          ok: false,
          error: errorResult('internal', 'Local project state is unavailable. See Settings → Diagnostics.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The catalog action failed.', true) };
      }
    });
  };

  register(CATALOG_CHANNELS.list, ListRequest, (payload, service) =>
    service.list(payload as { includeArchived?: boolean; query?: string }),
  );
  register(CATALOG_CHANNELS.open, OpenRequest, (payload, service) => service.open((payload as { path: string }).path));
  register(CATALOG_CHANNELS.pickFolder, PickFolderRequest, (payload, service) =>
    service.pickFolder((payload as { purpose: 'open' | 'create-parent' }).purpose),
  );
  register(CATALOG_CHANNELS.create, CreateRequest, (payload, service) => {
    const input = payload as { parent: string; name: string };
    return service.create(input.parent, input.name);
  });
  register(CATALOG_CHANNELS.update, UpdateRequest, (payload, service) => {
    const input = payload as {
      projectId: string;
      expectedRevision: number;
      patch: {
        label?: string;
        pinned?: boolean;
        archived?: boolean;
        color?: string | null;
        monogram?: string | null;
      };
    };
    return service.update(input.projectId, input.expectedRevision, input.patch);
  });
  register(CATALOG_CHANNELS.remove, ProjectRequest, (payload, service) =>
    service.remove((payload as { projectId: string }).projectId),
  );
  register(CATALOG_CHANNELS.relocate, RelocateRequest, (payload, service) => {
    const input = payload as { projectId: string; expectedRevision: number; path: string };
    return service.relocate(input.projectId, input.expectedRevision, input.path);
  });
  register(CATALOG_CHANNELS.reveal, ProjectRequest, (payload, service) =>
    service.reveal((payload as { projectId: string }).projectId),
  );
  register(CATALOG_CHANNELS.select, SelectRequest, (payload, service) =>
    service.select((payload as { projectId: string | null }).projectId),
  );
  register(CATALOG_CHANNELS.engineState, Empty, (_payload, service) => service.engineState());
  register(CATALOG_CHANNELS.engineStart, ProjectRequest, (payload, service) =>
    service.startEngine((payload as { projectId: string }).projectId),
  );
  register(CATALOG_CHANNELS.engineStop, Empty, (_payload, service) => service.stopEngine());
  register(CATALOG_CHANNELS.spend, ProjectRequest, (payload, service) =>
    service.spend((payload as { projectId: string }).projectId),
  );
  register(CATALOG_CHANNELS.uiGet, Empty, (_payload, service) => service.uiState());
  register(CATALOG_CHANNELS.uiSetView, SetViewRequest, (payload, service) => {
    const input = payload as { projectId: string; view: ProjectView };
    return service.setView(input.projectId, input.view);
  });
  register(CATALOG_CHANNELS.uiSaveDraft, SaveDraftRequest, (payload, service) => {
    const input = payload as { projectId: string; sessionId: string; text: string };
    return service.saveDraft(input.projectId, input.sessionId, input.text);
  });
  register(CATALOG_CHANNELS.uiNewSession, ProjectRequest, (payload, service) =>
    service.newSession((payload as { projectId: string }).projectId),
  );
  register(CATALOG_CHANNELS.uiSetLayout, SetLayoutRequest, (payload, service) => {
    const input = payload as { projectId: string; layout: ProjectLayout };
    return service.setLayout(input.projectId, input.layout);
  });
  register(CATALOG_CHANNELS.uiSaveFavorite, FavoriteRequest, (payload, service) => {
    const input = payload as { projectId: string; label: string; text: string };
    return service.saveFavorite(input.projectId, input.label, input.text);
  });
  register(CATALOG_CHANNELS.uiRemoveFavorite, RemoveFavoriteRequest, (payload, service) => {
    const input = payload as { projectId: string; favoriteId: string };
    return service.removeFavorite(input.projectId, input.favoriteId);
  });

  return channels;
}
