import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineAdapter } from '@mona/adapter';
import type { ProjectStore, StudioThreadRow } from '@mona/project-state';
import type { CliResult } from './engine-config.js';
import type { ConfigCliPort } from './provider-workbench.js';
import { ProviderWorkbenchService, redactSecrets } from './provider-workbench.js';
import type { EngineSummary } from './engine-host.js';

const PROJECT = {
  id: 'prj_1',
  label: 'Demo',
  canonicalPath: 'C:\\proj',
  createdAt: '2026-11-12T08:00:00Z',
  updatedAt: '2026-11-12T08:00:00Z',
};

type FakeOptions = {
  config?: Record<string, unknown>;
  providers?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
  saved?: { version: number; values: unknown } | null;
  threadProfile?: Record<string, unknown> | null;
  engine?: EngineSummary;
  endpoint?: string;
};

function summary(overrides: Partial<EngineSummary> = {}): EngineSummary {
  return {
    state: 'connected',
    detail: 'ready',
    workspace: 'C:\\proj',
    pid: 1,
    endpoint: 'http://127.0.0.1:1234',
    compatibility: 'qualified',
    descriptors: [],
    ...overrides,
  };
}

async function harness(options: FakeOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mona-p16-'));
  const configPath = path.join(root, 'config.toml');
  const settingsPath = path.join(root, 'settings.toml');
  await writeFile(configPath, 'provider = "deepseek"\nmodel = "deepseek-flash"\n', 'utf8');
  await writeFile(settingsPath, 'permission_posture = "full-access"\n', 'utf8');
  const calls: string[] = [];
  const values = new Map<string, string>([
    ['provider', 'deepseek'],
    ['model', 'deepseek-flash'],
    ['permission_posture', 'full-access'],
    ['default_mode', 'agent'],
  ]);
  const cli: ConfigCliPort = {
    path: async (): Promise<CliResult<string>> => ({ ok: true, value: configPath }),
    get: async (key: string): Promise<CliResult<string | null>> => ({
      ok: true,
      value: values.get(key) ?? null,
    }),
    set: async (key: string, value: string): Promise<CliResult<string>> => {
      calls.push(`set:${key}=${value}`);
      values.set(key, value);
      const file = key === 'provider' || key === 'model' ? configPath : settingsPath;
      const current = await readFile(file, 'utf8').catch(() => '');
      const lines = current
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(`${key} =`))
        .filter((line) => line.length > 0);
      lines.push(`${key} = ${JSON.stringify(value)}`);
      await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
      return { ok: true, value: `set ${key}` };
    },
    doctorJson: async (): Promise<CliResult<unknown>> => ({
      ok: true,
      value: {
        route: {
          base_url: { redacted: options.endpoint ?? 'https://api.deepseek.com/beta' },
          route_error: null,
          auth: { source: 'secret_store_unprobed', availability: 'not_probed' },
        },
        api_connectivity: { checked: false, status: 'not_probed' },
      },
    }),
  };

  let saved = options.saved ?? null;
  const threadRow: StudioThreadRow | null = options.threadProfile
    ? ({
        id: 'thr_11111111111111111111111111111111',
        projectId: 'prj_1',
        engineThreadId: 'thr_11111111111111111111111111111111',
        workspace: 'C:\\proj',
        sessionId: 'ses_1',
        mode: 'agent',
        profileJson: JSON.stringify(options.threadProfile),
        lastSeq: 10,
        createdAt: '2026-11-12T08:00:00Z',
        updatedAt: '2026-11-12T08:00:00Z',
      } as unknown as StudioThreadRow)
    : null;
  const store = {
    getProject: async (id: string) => (id === PROJECT.id ? PROJECT : null),
    latestSettingVersion: async (scope: string) =>
      scope === 'engine.route' ? saved : scope === 'engine.permission' ? saved : scope === 'engine.mode' ? saved : null,
    saveSettingVersion: async (scope: string, version: number, values: unknown) => {
      calls.push(`save:${scope}:${version}:${JSON.stringify(values)}`);
      if (scope === 'engine.route') saved = { version, values };
    },
    studioThreadForSession: async () => threadRow,
  } as unknown as ProjectStore;

  const configWire = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    ...(options.config ?? {}),
  };
  const adapter = {
    configuration: () => ({
      readConfig: async () => ({
        ok: true as const,
        value: {
          provider: String(configWire.provider),
          model: String(configWire.model),
          modelAvailable: true,
          baseUrl: options.endpoint ?? 'https://api.deepseek.com/beta',
          reasoningEffort: 'auto',
          defaultMode: 'agent' as const,
          approvalMode: 'suggest',
          allowShell: false,
          subagentsEnabled: true,
          capturedAt: '2026-11-12T09:00:00Z',
        },
      }),
      listProviders: async () => ({
        ok: true as const,
        value: {
          current: 'deepseek',
          providers: options.providers ?? [
            {
              id: 'deepseek',
              modelProviderId: 'deepseek',
              displayName: 'DeepSeek',
              defaultModel: 'deepseek-flash',
              hasModelCatalog: true,
              credentialState: 'configured',
              credentialSource: 'secret_store',
              credentialWritable: true,
            },
            {
              id: 'openai',
              modelProviderId: 'openai',
              displayName: 'OpenAI-compatible',
              defaultModel: 'gpt-5.6',
              hasModelCatalog: false,
              credentialState: 'missing',
              credentialSource: 'secret_store',
              credentialWritable: true,
            },
          ],
        },
      }),
      listModels: async () => ({
        ok: true as const,
        value: {
          provider: 'deepseek',
          models: options.models ?? [
            {
              id: 'deepseek-chat',
              imageInput: 'unsupported',
              outputTokenLimit: 'supported',
              reasoningEffort: 'unsupported',
              reasoningLevels: [],
              reasoningSource: 'catalog',
              contextTokens: 1_000_000,
              outputTokens: 384_000,
              pricingStatus: null,
            },
            {
              id: 'deepseek-flash',
              imageInput: 'supported',
              outputTokenLimit: 'supported',
              reasoningEffort: 'unknown',
              reasoningLevels: [],
              reasoningSource: null,
              contextTokens: 1_000_000,
              outputTokens: 384_000,
              pricingStatus: null,
            },
          ],
        },
      }),
      readSettingsSchema: async () => ({
        ok: true as const,
        value: {
          entries: [
            {
              key: 'permission_posture',
              kind: 'enum',
              value: 'full-access',
              options: [
                { value: 'ask', label: 'Ask', description: 'Ask first.' },
                { value: 'auto-review', label: 'Auto-review', description: 'Review.' },
                { value: 'full-access', label: 'Full Access', description: 'No prompts.' },
              ],
              editable: true,
            },
          ],
        },
      }),
    }),
  } as unknown as EngineAdapter;

  const service = new ProviderWorkbenchService({
    store,
    engine: {
      summary: () => options.engine ?? summary(),
      adapter: () => adapter,
    },
    config: cli,
    backupRoot: path.join(root, 'backups'),
    now: () => new Date('2026-11-12T09:00:00Z'),
  });
  return { service, calls, root, configPath, settingsPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('provider workbench', () => {
  it('shows requested and effective routes separately and offers no reasoning control for Flash', async () => {
    const h = await harness({
      saved: {
        version: 1,
        values: { provider: 'deepseek', model: 'deepseek-chat', revision: 'old', updatedAt: '2026-11-12T08:00:00Z' },
      },
      threadProfile: {
        threadId: 'thr_11111111111111111111111111111111',
        workspace: 'C:\\proj',
        provider: 'deepseek',
        model: 'deepseek-flash',
        mode: 'agent',
        permissionPosture: 'full_access',
        allowShell: true,
        trustMode: true,
        autoApprove: true,
        observedAt: '2026-11-12T08:00:00Z',
      },
    });
    try {
      const result = await h.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.requested).toMatchObject({
        provider: 'deepseek',
        model: 'deepseek-chat',
        source: 'saved_default',
      });
      expect(result.data.effective).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' });
      const flash = result.data.models.find((model) => model.id === 'deepseek-flash');
      expect(flash?.reasoningEffort).toBe('unknown');
      expect(result.data.reasoning.supported).toBe(false);
      expect(result.data.reasoning.levels).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it('distinguishes a missing credential from an invalid endpoint', async () => {
    const missing = await harness({
      saved: {
        version: 1,
        values: { provider: 'openai', model: 'gpt-5.6', revision: 'r', updatedAt: '2026-11-12T08:00:00Z' },
      },
    });
    try {
      const result = await missing.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.diagnostics.status).toBe('missing_credential');
        expect(result.data.diagnostics.findings.map((finding) => finding.id)).toContain('missing-credential');
      }
    } finally {
      await missing.cleanup();
    }
    const invalid = await harness({ endpoint: 'not a url' });
    try {
      const result = await invalid.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.diagnostics.status).toBe('invalid_endpoint');
        expect(result.data.diagnostics.findings.map((finding) => finding.id)).toContain('invalid-endpoint');
      }
    } finally {
      await invalid.cleanup();
    }
  });

  it('applies a new-thread default with a backup, verification and an untouched active thread', async () => {
    const h = await harness({
      threadProfile: {
        threadId: 'thr_11111111111111111111111111111111',
        workspace: 'C:\\proj',
        provider: 'deepseek',
        model: 'deepseek-flash',
        mode: 'agent',
        permissionPosture: 'full_access',
        allowShell: true,
        trustMode: true,
        autoApprove: true,
        observedAt: '2026-11-12T08:00:00Z',
      },
    });
    try {
      const view = await h.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      const applied = await h.service.applyRoute({
        projectId: 'prj_1',
        sessionId: 'ses_1',
        provider: 'deepseek',
        model: 'deepseek-chat',
        expectedRevision: view.data.configRevision,
      });
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.data.verified).toBe(true);
        expect(applied.data.activeThreadUnchanged).toBe(true);
        expect(applied.data.backupPath).toBeTruthy();
      }
      expect(h.calls).toContain('set:provider=deepseek');
      expect(h.calls).toContain('set:model=deepseek-chat');
      const stored = await readFile(h.configPath, 'utf8');
      expect(stored).toContain('model = "deepseek-chat"');
    } finally {
      await h.cleanup();
    }
  });

  it('applies permission and mode defaults to the engine settings file', async () => {
    const h = await harness({});
    try {
      const view = await h.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      const permission = await h.service.applyPermission({
        projectId: 'prj_1',
        sessionId: 'ses_1',
        posture: 'ask',
        expectedRevision: view.data.configRevision,
      });
      expect(permission.ok).toBe(true);
      if (permission.ok) {
        expect(permission.data.key).toBe('permission_posture');
        expect(permission.data.value).toBe('ask');
        expect(permission.data.verified).toBe(true);
      }
      const refreshed = await h.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;
      const mode = await h.service.applyMode({
        projectId: 'prj_1',
        sessionId: 'ses_1',
        mode: 'plan',
        expectedRevision: refreshed.data.configRevision,
      });
      expect(mode.ok).toBe(true);
      const settings = await readFile(h.settingsPath, 'utf8');
      expect(settings).toContain('permission_posture = "ask"');
      expect(settings).toContain('default_mode = "plan"');
    } finally {
      await h.cleanup();
    }
  });

  it('refuses a stale revision without writing', async () => {
    const h = await harness({});
    try {
      const result = await h.service.applyRoute({
        projectId: 'prj_1',
        sessionId: 'ses_1',
        provider: 'deepseek',
        model: 'deepseek-chat',
        expectedRevision: 'sha256:stale',
      });
      expect(result.ok).toBe(false);
      expect(h.calls.filter((call) => call.startsWith('set:'))).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it('refuses a provider with no usable credential before writing', async () => {
    const h = await harness({});
    try {
      const view = await h.service.view({ projectId: 'prj_1', sessionId: 'ses_1' });
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      const result = await h.service.applyRoute({
        projectId: 'prj_1',
        sessionId: 'ses_1',
        provider: 'openai',
        model: 'gpt-5.6',
        expectedRevision: view.data.configRevision,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('authentication_failed');
      expect(h.calls.filter((call) => call.startsWith('set:'))).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it('redacts credential-shaped values from diagnostics text', () => {
    const text = [
      'api_key = "sk-1234567890abcdef"',
      'DEEPSEEK_API_KEY=super-secret-value',
      'Authorization: Bearer abcdefghijklmnop',
      'token: "tok_live_abcdefghijkl"',
    ].join('\n');
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('sk-1234567890abcdef');
    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).toContain('[redacted]');
  });
});
