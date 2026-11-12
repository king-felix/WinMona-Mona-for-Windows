import { describe, expect, it } from 'vitest';
import type { RuntimeTransport, TransportOptions, TransportResponse } from './http.js';
import type { Result } from './errors.js';
import { EngineConfiguration } from './configuration.js';

class FakeTransport implements RuntimeTransport {
  readonly calls: string[] = [];
  constructor(private readonly routes: Record<string, unknown>) {}

  async json(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    _body?: unknown,
    _options?: TransportOptions,
  ): Promise<Result<TransportResponse>> {
    this.calls.push(`${method} ${path}`);
    const json = this.routes[`${method} ${path}`];
    if (json === undefined) return { ok: false, error: { code: 'not_found', message: 'not found', retryable: false } };
    return { ok: true, value: { status: 200, json, bytes: 0 } };
  }

  async stream(): Promise<Result<AsyncIterable<Uint8Array>>> {
    return { ok: false, error: { code: 'transport_failed', message: 'unused', retryable: false } };
  }
}

const configWire = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  model_available: true,
  base_url: 'https://api.deepseek.com/beta',
  reasoning_effort: 'auto',
  default_mode: 'agent',
  approval_mode: 'suggest',
  allow_shell: false,
  subagents_enabled: true,
};

const providersWire = {
  current: 'deepseek',
  providers: [
    {
      id: 'deepseek',
      model_provider_id: 'deepseek',
      display_name: 'DeepSeek',
      default_model: 'deepseek-flash',
      has_model_catalog: true,
      credentialState: 'configured',
      credentialSource: 'secret_store',
      credentialWritable: true,
    },
    {
      id: 'openai',
      model_provider_id: 'openai',
      display_name: 'OpenAI-compatible',
      default_model: 'gpt-5.6',
      has_model_catalog: false,
      credentialState: 'missing',
      credentialSource: 'secret_store',
      credentialWritable: true,
    },
  ],
};

const modelsWire = {
  provider: 'deepseek',
  models: [
    {
      id: 'deepseek-flash',
      image_input: 'supported',
      output_token_limit: 'supported',
      reasoning_effort: 'unknown',
      reasoning_effort_levels: [],
      reasoning_effort_source: null,
      facts: { effective_limits: { context_tokens: 1_000_000, output_tokens: 384_000 } },
    },
    {
      id: 'deepseek-reasoner',
      image_input: 'unsupported',
      output_token_limit: 'supported',
      reasoning_effort: 'supported',
      reasoning_effort_levels: ['low', 'medium', 'high'],
      reasoning_effort_source: 'catalog',
      facts: {},
    },
  ],
};

describe('engine configuration projection', () => {
  it('keeps requested and effective route values as reported', async () => {
    const transport = new FakeTransport({
      'GET /v1/config': configWire,
      'GET /v1/providers': providersWire,
      'GET /v1/providers/deepseek/models': modelsWire,
    });
    const configuration = new EngineConfiguration(transport, () => new Date('2026-11-12T09:00:00Z'));
    const config = await configuration.readConfig();
    const providers = await configuration.listProviders();
    const models = await configuration.listModels('deepseek');
    expect(config.ok && config.value.model).toBe('deepseek-flash');
    expect(config.ok && config.value.baseUrl).toBe('https://api.deepseek.com/beta');
    expect(providers.ok && providers.value.current).toBe('deepseek');
    expect(providers.ok && providers.value.providers[1]?.credentialState).toBe('missing');
    expect(models.ok && models.value.models[0]?.reasoningEffort).toBe('unknown');
    expect(models.ok && models.value.models[1]?.reasoningLevels).toEqual(['low', 'medium', 'high']);
  });

  it('maps only supported or unsupported capability values, never a guessed yes', async () => {
    const transport = new FakeTransport({
      'GET /v1/providers/deepseek/models': {
        provider: 'deepseek',
        models: [{ id: 'mystery', reasoning_effort: 'sometimes', image_input: 'maybe' }],
      },
    });
    const configuration = new EngineConfiguration(transport);
    const models = await configuration.listModels('deepseek');
    expect(models.ok).toBe(true);
    if (models.ok) {
      expect(models.value.models[0]?.reasoningEffort).toBe('unknown');
      expect(models.value.models[0]?.imageInput).toBe('unknown');
    }
  });

  it('reads the engine settings schema for permission options', async () => {
    const transport = new FakeTransport({
      'GET /v1/settings/schema': {
        settings: [
          {
            key: 'permission_posture',
            kind: 'enum',
            value: 'full-access',
            editable: true,
            options: [
              { value: 'ask', label: 'Ask', description: 'Ask first.' },
              { value: 'full-access', label: 'Full Access', description: 'No prompts.' },
            ],
          },
        ],
      },
    });
    const configuration = new EngineConfiguration(transport);
    const schema = await configuration.readSettingsSchema();
    expect(schema.ok).toBe(true);
    if (schema.ok) {
      const entry = schema.value.entries[0];
      expect(entry?.key).toBe('permission_posture');
      expect(entry?.value).toBe('full-access');
      expect(entry?.options.map((option) => option.value)).toEqual(['ask', 'full-access']);
    }
  });
});
