import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  errorResult,
  NO_ROUTE_REASONING,
  PERMISSION_OPTIONS,
  type ConfigurationChangeReceipt,
  type ConnectionDiagnostics,
  type CredentialState,
  type DiagnosticFinding,
  type EngineConfigSnapshot,
  type ModelEntry,
  type PermissionOption,
  type ProviderEntry,
  type ProviderWorkbenchView,
  type ReasoningControl,
  type RouteEffective,
  type RouteRequested,
  type SavedRouteDefault,
  type SettingsChangeReceipt,
} from '@mona/contracts';
import type { EngineAdapter } from '@mona/adapter';
import type { ProjectStore } from '@mona/project-state';
import type { EngineSummary } from './engine-host.js';
import type { CliResult } from './engine-config.js';

export type WorkbenchEnginePort = {
  summary(): EngineSummary;
  adapter(): EngineAdapter | null;
};

export type ConfigCliPort = {
  path(): Promise<CliResult<string>>;
  get(key: string): Promise<CliResult<string | null>>;
  set(key: string, value: string): Promise<CliResult<string>>;
  doctorJson(): Promise<CliResult<unknown>>;
};

export type ProviderWorkbenchDeps = {
  store: ProjectStore;
  engine: WorkbenchEnginePort;
  config: ConfigCliPort;
  backupRoot: string;
  now?: () => Date;
};

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
type ServiceResult<T> = Success<T> | Failure;

const ROUTE_SCOPE = 'engine.route';
const PERMISSION_SCOPE = 'engine.permission';
const MODE_SCOPE = 'engine.mode';

/**
 * Reads providers, models and effective settings without contacting a provider.
 * Writes go through the engine's config CLI, with a hashed backup and a
 * revision check; they affect new threads only and never mutate an active
 * engine thread.
 */
export class ProviderWorkbenchService {
  private readonly store: ProjectStore;
  private readonly engine: WorkbenchEnginePort;
  private readonly config: ConfigCliPort;
  private readonly backupRoot: string;
  private readonly now: () => Date;

  constructor(deps: ProviderWorkbenchDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.config = deps.config;
    this.backupRoot = deps.backupRoot;
    this.now = deps.now ?? (() => new Date());
  }

  async view(input: {
    projectId: string;
    sessionId: string;
    providerId?: string;
  }): Promise<ServiceResult<ProviderWorkbenchView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const capturedAt = this.now().toISOString();
    const adapter = this.engine.adapter();
    const live = adapter?.configuration() ?? null;
    const caveats: string[] = [];

    const configSnapshot = live ? await live.readConfig() : null;
    const catalog = live ? await live.listProviders() : null;
    const state = await this.readState();
    const saved = await this.readSavedDefault();
    const requested = this.requestedRoute(saved, configSnapshot);
    const effective = await this.effectiveRoute(input.projectId, input.sessionId, configSnapshot);
    const selectedProvider = input.providerId ?? requested.provider ?? effective.provider;
    const models = live && selectedProvider ? await live.listModels(selectedProvider) : null;
    if (!live) {
      caveats.push(
        'The engine is not connected, so live provider and model catalogs are unavailable. The saved default and the offline doctor report are shown.',
      );
    }
    if (!saved) {
      caveats.push('No route has been saved from this window. The engine’s configured route is shown as requested.');
    }
    if (requested.provider && effective.threadId && requested.provider !== effective.provider) {
      caveats.push(
        `The requested provider (${requested.provider}) differs from the active thread (${effective.provider}). A saved default applies to new threads.`,
      );
    }
    const modelList = models?.ok ? models.value.models : [];
    const selectedModel =
      (selectedProvider === requested.provider ? modelList.find((model) => model.id === requested.model) : null) ??
      (selectedProvider === effective.provider ? modelList.find((model) => model.id === effective.model) : null) ??
      modelList[0] ??
      null;
    const reasoning = reasoningControl(selectedModel);
    const diagnostics = await this.diagnostics({
      configSnapshot: configSnapshot?.ok ? configSnapshot.value : null,
      provider: providerFor(catalog?.ok ? catalog.value.providers : [], selectedProvider ?? effective.provider),
      capturedAt,
    });
    const permissions = await this.permissionOptions(live);
    if (!state.ok) caveats.push(`The engine configuration revision could not be read: ${state.error.message}`);

    return {
      ok: true,
      data: {
        connected: live !== null,
        capturedAt,
        providers: catalog?.ok ? catalog.value.providers : [],
        selectedProviderId: selectedProvider,
        models: modelList,
        requested,
        effective,
        savedDefault: saved,
        reasoning,
        permissions,
        maxWorkers: 1,
        configRevision: state.ok ? state.value.revision : 'unavailable',
        diagnostics,
        caveats,
      },
    };
  }

  async applyRoute(input: {
    projectId: string;
    sessionId: string;
    provider: string;
    model: string;
    expectedRevision: string;
  }): Promise<ServiceResult<ConfigurationChangeReceipt>> {
    const beforeThread = await this.activeThreadSnapshot(input.projectId, input.sessionId);
    const state = await this.readState();
    if (!state.ok) return state;
    if (state.value.revision !== input.expectedRevision) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          'The engine configuration changed since this view was read. Refresh the workbench before applying a default.',
        ),
      };
    }
    const adapter = this.engine.adapter();
    if (!adapter) {
      return { ok: false, error: errorResult('engine_unavailable', 'Connect the engine before changing the route.') };
    }
    const configuration = adapter.configuration();
    const catalog = await configuration.listProviders();
    if (!catalog.ok) {
      return { ok: false, error: errorResult(catalog.error.code, catalog.error.message, catalog.error.retryable) };
    }
    const provider = catalog.value.providers.find((entry) => entry.id === input.provider);
    if (!provider) {
      return {
        ok: false,
        error: errorResult('invalid_request', `Provider ${input.provider} is not offered by this engine.`),
      };
    }
    if (provider.credentialState === 'missing' || provider.credentialState === 'login_required') {
      return {
        ok: false,
        error: errorResult(
          'authentication_failed',
          `${provider.displayName} has no usable credential (${provider.credentialState}). Add it through the engine, then retry. Nothing was written.`,
        ),
      };
    }
    const models = await configuration.listModels(input.provider);
    if (!models.ok) {
      return { ok: false, error: errorResult(models.error.code, models.error.message, models.error.retryable) };
    }
    if (!models.value.models.some((entry) => entry.id === input.model)) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          `${input.model} is not in ${provider.displayName}’s catalog. Nothing was written.`,
        ),
      };
    }

    const backup = await this.backup(state.value);
    if (!backup.ok) return { ok: false, error: errorResult('internal', backup.detail) };
    const setProvider = await this.config.set('provider', input.provider);
    if (!setProvider.ok) {
      return {
        ok: false,
        error: errorResult('invalid_request', `The engine refused the provider: ${setProvider.detail}`),
      };
    }
    const setModel = await this.config.set('model', input.model);
    if (!setModel.ok) {
      return { ok: false, error: errorResult('invalid_request', `The engine refused the model: ${setModel.detail}`) };
    }
    const providerRead = await this.config.get('provider');
    const modelRead = await this.config.get('model');
    const verified =
      providerRead.ok && modelRead.ok && providerRead.value === input.provider && modelRead.value === input.model;
    if (!verified) {
      return {
        ok: false,
        error: errorResult(
          'schema_drift',
          'The engine did not confirm the saved route. The file was backed up; inspect it before retrying.',
        ),
      };
    }
    const after = await this.readState();
    if (!after.ok) return after;
    const afterThread = await this.activeThreadSnapshot(input.projectId, input.sessionId);
    if (afterThread !== beforeThread) {
      return {
        ok: false,
        error: errorResult(
          'internal',
          'The active thread changed while the default was written. Inspect it before continuing.',
        ),
      };
    }
    await this.saveSetting(ROUTE_SCOPE, {
      provider: input.provider,
      model: input.model,
      revision: after.value.revision,
      updatedAt: this.now().toISOString(),
    });
    return {
      ok: true,
      data: {
        scope: 'new_threads',
        provider: input.provider,
        model: input.model,
        configPath: after.value.configPath,
        backupPath: backup.value,
        previousHash: state.value.configHash,
        newHash: after.value.configHash,
        expectedRevision: input.expectedRevision,
        verified,
        appliedAt: this.now().toISOString(),
        activeThreadUnchanged: true,
      },
    };
  }

  async applyPermission(input: {
    projectId: string;
    sessionId: string;
    posture: 'ask' | 'auto-review' | 'full-access';
    expectedRevision: string;
  }): Promise<ServiceResult<SettingsChangeReceipt>> {
    return await this.applySetting(input, {
      key: 'permission_posture',
      value: input.posture,
      scope: PERMISSION_SCOPE,
      allowed: ['ask', 'auto-review', 'full-access'],
    });
  }

  async applyMode(input: {
    projectId: string;
    sessionId: string;
    mode: 'agent' | 'plan';
    expectedRevision: string;
  }): Promise<ServiceResult<SettingsChangeReceipt>> {
    return await this.applySetting(input, {
      key: 'default_mode',
      value: input.mode,
      scope: MODE_SCOPE,
      allowed: ['agent', 'plan'],
    });
  }

  private async applySetting(
    input: { projectId: string; sessionId: string; expectedRevision: string },
    change: { key: string; value: string; scope: string; allowed: string[] },
  ): Promise<ServiceResult<SettingsChangeReceipt>> {
    if (!change.allowed.includes(change.value)) {
      return {
        ok: false,
        error: errorResult('invalid_request', `${change.value} is not a supported ${change.key} value.`),
      };
    }
    const beforeThread = await this.activeThreadSnapshot(input.projectId, input.sessionId);
    const state = await this.readState();
    if (!state.ok) return state;
    if (state.value.revision !== input.expectedRevision) {
      return {
        ok: false,
        error: errorResult(
          'invalid_request',
          'The engine configuration changed since this view was read. Refresh the workbench before applying a default.',
        ),
      };
    }
    const backup = await this.backup(state.value);
    if (!backup.ok) return { ok: false, error: errorResult('internal', backup.detail) };
    const written = await this.config.set(change.key, change.value);
    if (!written.ok) {
      return {
        ok: false,
        error: errorResult('invalid_request', `The engine refused ${change.key}: ${written.detail}`),
      };
    }
    const read = await this.config.get(change.key);
    const verified = read.ok && read.value === change.value;
    if (!verified) {
      return {
        ok: false,
        error: errorResult('schema_drift', `The engine did not confirm ${change.key}. The files were backed up.`),
      };
    }
    const after = await this.readState();
    if (!after.ok) return after;
    const afterThread = await this.activeThreadSnapshot(input.projectId, input.sessionId);
    if (afterThread !== beforeThread) {
      return {
        ok: false,
        error: errorResult(
          'internal',
          'The active thread changed while the setting was written. Inspect it before continuing.',
        ),
      };
    }
    await this.saveSetting(change.scope, {
      key: change.key,
      value: change.value,
      revision: after.value.revision,
      updatedAt: this.now().toISOString(),
    });
    return {
      ok: true,
      data: {
        scope: 'new_threads',
        key: change.key,
        value: change.value,
        configPath: after.value.settingsPath,
        backupPath: backup.value,
        previousHash: state.value.settingsHash,
        newHash: after.value.settingsHash,
        expectedRevision: input.expectedRevision,
        verified,
        appliedAt: this.now().toISOString(),
        activeThreadUnchanged: true,
      },
    };
  }

  private requestedRoute(
    saved: SavedRouteDefault | null,
    config: { ok: true; value: EngineConfigSnapshot } | { ok: false } | null,
  ): RouteRequested {
    if (saved) return { provider: saved.provider, model: saved.model, source: 'saved_default' };
    if (config?.ok) return { provider: config.value.provider, model: config.value.model, source: 'engine_config' };
    return { provider: null, model: null, source: 'unknown' };
  }

  private async effectiveRoute(
    projectId: string,
    sessionId: string,
    config: { ok: true; value: EngineConfigSnapshot } | { ok: false } | null,
  ): Promise<RouteEffective> {
    const row = await this.store.studioThreadForSession(projectId, sessionId);
    if (row?.profileJson) {
      try {
        const profile = JSON.parse(row.profileJson) as Record<string, unknown>;
        const provider = typeof profile.provider === 'string' ? profile.provider : null;
        const model = typeof profile.model === 'string' ? profile.model : null;
        const mode = profile.mode === 'plan' || profile.mode === 'agent' ? profile.mode : null;
        const posture =
          profile.permissionPosture === 'full_access' ||
          profile.permissionPosture === 'workspace_write' ||
          profile.permissionPosture === 'read_only'
            ? profile.permissionPosture
            : 'unknown';
        if (provider && model) {
          return {
            threadId: typeof profile.threadId === 'string' ? profile.threadId : null,
            provider,
            model,
            mode,
            permissionPosture: posture,
            observedAt: typeof profile.observedAt === 'string' ? profile.observedAt : this.now().toISOString(),
          };
        }
      } catch {
        // Fall through to the configured route; the saved thread profile is unreadable.
      }
    }
    const fallback = config?.ok ? config.value : null;
    return {
      threadId: null,
      provider: fallback?.provider ?? 'unknown',
      model: fallback?.model ?? 'unknown',
      mode: fallback?.defaultMode === 'plan' ? 'plan' : fallback?.defaultMode === 'agent' ? 'agent' : null,
      permissionPosture: 'unknown',
      observedAt: this.now().toISOString(),
    };
  }

  private async permissionOptions(
    live: { readSettingsSchema(): Promise<{ ok: boolean; value?: unknown }> } | null,
  ): Promise<PermissionOption[]> {
    if (!live) return [...PERMISSION_OPTIONS];
    const schema = await live.readSettingsSchema();
    if (!schema.ok || !schema.value) return [...PERMISSION_OPTIONS];
    const entries =
      (schema.value as { entries?: Array<{ key: string; options: Array<{ value: string }> }> }).entries ?? [];
    const entry = entries.find((candidate) => candidate.key === 'permission_posture');
    if (!entry || entry.options.length === 0) return [...PERMISSION_OPTIONS];
    const offered = new Set(entry.options.map((option) => option.value));
    const filtered = PERMISSION_OPTIONS.filter((option) => offered.has(option.value));
    return filtered.length > 0 ? filtered : [...PERMISSION_OPTIONS];
  }

  private async diagnostics(input: {
    configSnapshot: EngineConfigSnapshot | null;
    provider: ProviderEntry | null;
    capturedAt: string;
  }): Promise<ConnectionDiagnostics> {
    const findings: DiagnosticFinding[] = [];
    const doctor = await this.config.doctorJson();
    let doctorRecord: Record<string, unknown> | null = null;
    if (doctor.ok && isRecord(doctor.value)) doctorRecord = doctor.value;
    const route = isRecord(doctorRecord?.route) ? (doctorRecord.route as Record<string, unknown>) : null;
    const endpoint =
      input.configSnapshot?.baseUrl ??
      (typeof route?.base_url === 'object' &&
      route.base_url !== null &&
      typeof (route.base_url as Record<string, unknown>).redacted === 'string'
        ? ((route.base_url as Record<string, unknown>).redacted as string)
        : null);
    const credentialState: CredentialState = input.provider?.credentialState ?? 'unknown';
    if (credentialState === 'missing' || credentialState === 'login_required') {
      findings.push({
        id: 'missing-credential',
        severity: 'error',
        title: credentialState === 'login_required' ? 'Sign-in required' : 'Credential missing',
        detail: `${input.provider?.displayName ?? 'The selected provider'} reports ${credentialState}. Add the credential through the engine; Mona never stores it.`,
      });
    }
    if (!endpoint) {
      findings.push({
        id: 'missing-endpoint',
        severity: 'error',
        title: 'Endpoint missing',
        detail: 'The engine did not report a base URL for this route.',
      });
    } else if (!isHttpUrl(endpoint)) {
      findings.push({
        id: 'invalid-endpoint',
        severity: 'error',
        title: 'Endpoint is not a valid HTTP(S) URL',
        detail: `Reported endpoint: ${endpoint}`,
      });
    }
    const routeError = typeof route?.route_error === 'string' ? route.route_error : null;
    if (routeError) {
      findings.push({
        id: 'route-error',
        severity: 'error',
        title: 'The engine reports a route error',
        detail: routeError,
      });
    }
    const connectivity = isRecord(doctorRecord?.api_connectivity)
      ? (doctorRecord.api_connectivity as Record<string, unknown>)
      : null;
    if (connectivity?.checked !== true) {
      findings.push({
        id: 'not-probed',
        severity: 'info',
        title: 'No live provider probe was run',
        detail: 'This view is offline by design. Use the engine’s own probe only when you choose to spend a request.',
      });
    }
    const status = findings.some((finding) => finding.id === 'missing-credential')
      ? 'missing_credential'
      : findings.some((finding) => finding.id === 'missing-endpoint' || finding.id === 'invalid-endpoint')
        ? 'invalid_endpoint'
        : findings.some((finding) => finding.id === 'route-error')
          ? 'unreachable'
          : 'healthy';
    const lines = [
      `checked_at: ${input.capturedAt}`,
      `provider: ${input.provider?.id ?? 'unknown'}`,
      `credential_state: ${credentialState}`,
      `endpoint: ${endpoint ?? 'unknown'}`,
      `status: ${status}`,
      ...findings.map((finding) => `${finding.severity}: ${finding.title} — ${finding.detail}`),
      doctor.ok ? 'doctor: offline JSON read' : `doctor: ${doctor.detail}`,
    ];
    return {
      status,
      checkedAt: input.capturedAt,
      probed: false,
      credentialState,
      endpoint,
      findings,
      redactedText: redactSecrets(lines.join('\n')),
    };
  }

  private async readSavedDefault(): Promise<SavedRouteDefault | null> {
    const latest = await this.store.latestSettingVersion(ROUTE_SCOPE);
    if (!latest || !isRecord(latest.values)) return null;
    const value = latest.values as Record<string, unknown>;
    if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
    return {
      provider: value.provider,
      model: value.model,
      revision: typeof value.revision === 'string' ? value.revision : `v${latest.version}`,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : this.now().toISOString(),
      source: 'mona_settings',
    };
  }

  private async saveSetting(scope: string, values: unknown): Promise<void> {
    const latest = await this.store.latestSettingVersion(scope);
    await this.store.saveSettingVersion(scope, (latest?.version ?? 0) + 1, values);
  }

  private async activeThreadSnapshot(projectId: string, sessionId: string): Promise<string> {
    const row = await this.store.studioThreadForSession(projectId, sessionId);
    return row ? `${row.id}|${row.profileJson ?? ''}|${row.lastSeq}` : 'none';
  }

  private async readState(): Promise<
    | {
        ok: true;
        value: {
          configPath: string;
          settingsPath: string;
          configHash: string;
          settingsHash: string;
          revision: string;
          configBytes: Buffer | null;
          settingsBytes: Buffer | null;
        };
      }
    | { ok: false; error: ReturnType<typeof errorResult> }
  > {
    const resolved = await this.config.path();
    if (!resolved.ok) {
      return {
        ok: false,
        error: errorResult('engine_unavailable', `Engine config path unavailable: ${resolved.detail}`),
      };
    }
    const configPath = resolved.value.trim();
    const settingsPath = path.join(path.dirname(configPath), 'settings.toml');
    const configBytes = existsSync(configPath) ? await readFile(configPath) : null;
    const settingsBytes = existsSync(settingsPath) ? await readFile(settingsPath) : null;
    const configHash = hash(configBytes);
    const settingsHash = hash(settingsBytes);
    return {
      ok: true,
      value: {
        configPath,
        settingsPath,
        configHash,
        settingsHash,
        revision: `sha256:${hash(Buffer.from(`${configHash}:${settingsHash}`))}`,
        configBytes,
        settingsBytes,
      },
    };
  }

  private async backup(state: {
    configPath: string;
    settingsPath: string;
    configBytes: Buffer | null;
    settingsBytes: Buffer | null;
  }): Promise<{ ok: true; value: string | null } | { ok: false; detail: string }> {
    if (!state.configBytes && !state.settingsBytes) return { ok: true, value: null };
    try {
      await mkdir(this.backupRoot, { recursive: true });
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const base = path.join(this.backupRoot, `engine-config-${stamp}`);
      if (state.configBytes) await copyFile(state.configPath, `${base}-config.toml`);
      if (state.settingsBytes) await copyFile(state.settingsPath, `${base}-settings.toml`);
      return { ok: true, value: base };
    } catch (error) {
      return { ok: false, detail: `Could not write a configuration backup: ${String(error).slice(0, 300)}` };
    }
  }
}

function reasoningControl(model: ModelEntry | null): ReasoningControl {
  if (!model) {
    return {
      supported: false,
      levels: [],
      source: null,
      note: 'No model catalog entry is available, so Mona offers no reasoning control.',
    };
  }
  if (model.reasoningEffort !== 'supported' || model.reasoningLevels.length === 0) {
    return {
      supported: false,
      levels: [],
      source: model.reasoningSource,
      note:
        model.reasoningEffort === 'unknown'
          ? `${model.id} reports reasoning support as unknown. Mona offers no reasoning control and sends none.`
          : NO_ROUTE_REASONING,
    };
  }
  return {
    supported: true,
    levels: model.reasoningLevels,
    source: model.reasoningSource,
    note: `The route reports ${model.reasoningLevels.length} reasoning level(s).`,
  };
}

function providerFor(providers: ProviderEntry[], id: string | null): ProviderEntry | null {
  if (!id) return null;
  return providers.find((provider) => provider.id === id) ?? null;
}

function hash(bytes: Buffer | null): string {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : 'absent';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove credential-shaped values from diagnostics before they leave main. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(sk|api|key)[-_][A-Za-z0-9]{12,}\b/gi, '[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(DEEPSEEK_API_KEY|OPENAI_API_KEY|CODEWHALE_RUNTIME_TOKEN)=([^\s]+)/g, '$1=[redacted]');
}
