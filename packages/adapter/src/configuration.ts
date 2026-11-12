import { z } from 'zod';
import { EngineConfigSnapshot, ModelEntry, ProviderEntry, type CredentialState } from '@mona/contracts';
import { fail, ok, type Result } from './errors.js';
import type { RuntimeTransport } from './http.js';

/**
 * Read-only projection of the engine's configuration surface. It never writes:
 * changing a saved default goes through the engine's own config CLI in the
 * desktop service, with a backup and revision check.
 */

const WireConfig = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    model_available: z.boolean().optional(),
    base_url: z.string().nullable().optional(),
    reasoning_effort: z.string().nullable().optional(),
    default_mode: z.string().optional(),
    approval_mode: z.string().nullable().optional(),
    allow_shell: z.boolean().optional(),
    subagents_enabled: z.boolean().optional(),
  })
  .passthrough();

const WireProviders = z
  .object({
    current: z.string().optional(),
    current_provider_id: z.string().optional(),
    providers: z
      .array(
        z
          .object({
            id: z.string().min(1),
            model_provider_id: z.string().optional(),
            display_name: z.string().optional(),
            default_model: z.string().optional(),
            has_model_catalog: z.boolean().optional(),
            credentialState: z.string().optional(),
            credentialSource: z.string().optional(),
            credentialWritable: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireModels = z
  .object({
    provider: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            image_input: z.string().optional(),
            output_token_limit: z.string().optional(),
            reasoning_effort: z.string().optional(),
            reasoning_effort_levels: z.array(z.string()).optional(),
            reasoning_effort_source: z.string().nullable().optional(),
            facts: z
              .object({
                effective_limits: z
                  .object({
                    context_tokens: z.number().int().nonnegative().optional(),
                    output_tokens: z.number().int().nonnegative().optional(),
                  })
                  .passthrough()
                  .optional(),
                pricing_status: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireSettings = z
  .object({
    settings: z
      .array(
        z
          .object({
            key: z.string(),
            kind: z.string().optional(),
            value: z.unknown().optional(),
            options: z.array(z.unknown()).optional(),
            editable: z.boolean().optional(),
            visible: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type ProviderCatalog = {
  current: string | null;
  providers: ProviderEntry[];
};

export type ModelCatalog = {
  provider: string;
  models: ModelEntry[];
};

export type SettingsEntry = {
  key: string;
  kind: string | null;
  value: string | null;
  options: Array<{ value: string; label: string | null; description: string | null }>;
  editable: boolean;
};

export type SettingsSchema = {
  entries: SettingsEntry[];
};

export class EngineConfiguration {
  private readonly transport: RuntimeTransport;
  private readonly now: () => Date;

  constructor(transport: RuntimeTransport, now: () => Date = () => new Date()) {
    this.transport = transport;
    this.now = now;
  }

  async readConfig(): Promise<Result<EngineConfigSnapshot>> {
    const response = await this.transport.json('GET', '/v1/config');
    if (!response.ok) return response;
    const wire = WireConfig.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'config response did not match the runtime contract');
    const mode = wire.data.default_mode;
    return ok(
      EngineConfigSnapshot.parse({
        provider: wire.data.provider ?? 'unknown',
        model: wire.data.model ?? 'unknown',
        modelAvailable: wire.data.model_available ?? false,
        baseUrl: wire.data.base_url ?? null,
        reasoningEffort: wire.data.reasoning_effort ?? null,
        defaultMode: mode === 'agent' || mode === 'plan' || mode === 'operate' ? mode : 'unknown',
        approvalMode: wire.data.approval_mode ?? null,
        allowShell: wire.data.allow_shell ?? false,
        subagentsEnabled: wire.data.subagents_enabled ?? false,
        capturedAt: this.now().toISOString(),
      }),
    );
  }

  async listProviders(): Promise<Result<ProviderCatalog>> {
    const response = await this.transport.json('GET', '/v1/providers');
    if (!response.ok) return response;
    const wire = WireProviders.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'provider catalog did not match the runtime contract');
    return ok({
      current: wire.data.current ?? wire.data.current_provider_id ?? null,
      providers: (wire.data.providers ?? []).map((provider) =>
        ProviderEntry.parse({
          id: provider.id,
          modelProviderId: provider.model_provider_id ?? provider.id,
          displayName: provider.display_name ?? provider.id,
          defaultModel: provider.default_model ?? '',
          hasModelCatalog: provider.has_model_catalog ?? false,
          credentialState: credentialState(provider.credentialState),
          credentialSource: provider.credentialSource ?? 'unknown',
          credentialWritable: provider.credentialWritable ?? false,
        }),
      ),
    });
  }

  async listModels(providerId: string): Promise<Result<ModelCatalog>> {
    const response = await this.transport.json('GET', `/v1/providers/${encodeURIComponent(providerId)}/models`);
    if (!response.ok) return response;
    const wire = WireModels.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'model catalog did not match the runtime contract');
    return ok({
      provider: wire.data.provider ?? providerId,
      models: (wire.data.models ?? []).map((model) =>
        ModelEntry.parse({
          id: model.id,
          imageInput: support(model.image_input),
          outputTokenLimit: support(model.output_token_limit),
          reasoningEffort: support(model.reasoning_effort),
          reasoningLevels: model.reasoning_effort_levels ?? [],
          reasoningSource: model.reasoning_effort_source ?? null,
          contextTokens: model.facts?.effective_limits?.context_tokens ?? null,
          outputTokens: model.facts?.effective_limits?.output_tokens ?? null,
          pricingStatus: model.facts?.pricing_status ?? null,
        }),
      ),
    });
  }

  async readSettingsSchema(): Promise<Result<SettingsSchema>> {
    const response = await this.transport.json('GET', '/v1/settings/schema');
    if (!response.ok) return response;
    const wire = WireSettings.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'settings schema did not match the runtime contract');
    return ok({
      entries: (wire.data.settings ?? []).map((entry) => ({
        key: entry.key,
        kind: entry.kind ?? null,
        value: entry.value === undefined || entry.value === null ? null : String(entry.value),
        options: (entry.options ?? []).map((option) => {
          const record = typeof option === 'object' && option !== null ? (option as Record<string, unknown>) : {};
          return {
            value: String(record.value ?? ''),
            label: typeof record.label === 'string' ? record.label : null,
            description: typeof record.description === 'string' ? record.description : null,
          };
        }),
        editable: entry.editable ?? false,
      })),
    });
  }
}

function credentialState(value: string | undefined): CredentialState {
  if (value === 'configured' || value === 'missing' || value === 'login_required' || value === 'local') return value;
  return 'unknown';
}

function support(value: string | undefined): 'supported' | 'unsupported' | 'unknown' {
  if (value === 'supported' || value === 'unsupported') return value;
  return 'unknown';
}
