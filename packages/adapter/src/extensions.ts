import { z } from 'zod';
import {
  EXTENSION_SCOPE_NOTES,
  ExtensionsView,
  McpHealthView,
  type ExtensionActionReceipt,
  type ExtensionCounts,
  type HookSection,
  type InstructionSection,
  type McpSection,
  type McpServerEntry,
  type PluginSection,
  type SkillSection,
} from '@mona/contracts';
import { fail, ok, redact, type Result } from './errors.js';
import type { RuntimeTransport } from './http.js';

/**
 * Read-only projection of the pinned runtime's extension surfaces plus the two
 * revision-guarded MCP actions the runtime exposes. Snapshot never connects a
 * server and never asks for the full tool catalog, so opening a settings page
 * cannot spawn processes or pull every server description into the app.
 */

const WireMcpList = z
  .object({
    revision: z.string().min(1).optional(),
    servers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            origin: z.string().optional(),
            writable: z.boolean().optional(),
            auth_required: z.boolean().optional(),
            enabled: z.boolean().optional(),
            required: z.boolean().optional(),
            command: z.string().nullable().optional(),
            url: z.string().nullable().optional(),
            connected: z.boolean().optional(),
            enabled_tools: z.array(z.string()).optional(),
            disabled_tools: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireMcpDetail = z
  .object({
    name: z.string().min(1),
    credential_configured: z.boolean().optional(),
    origin: z.string().optional(),
    writable: z.boolean().optional(),
    auth_required: z.boolean().optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).optional(),
    env_keys: z.array(z.string()).optional(),
    url: z.string().nullable().optional(),
    transport: z.string().nullable().optional(),
    enabled_tools: z.array(z.string()).optional(),
    disabled_tools: z.array(z.string()).optional(),
    scopes: z.array(z.string()).optional(),
    connected: z.boolean().optional(),
  })
  .passthrough();

const WireMcpReconnect = z
  .object({
    name: z.string().min(1),
    action: z.string().optional(),
    ok: z.boolean().optional(),
    connection: z
      .object({
        server: z.string().optional(),
        connected: z.boolean().optional(),
        auth_required: z.boolean().optional(),
        error: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const WireMcpTools = z
  .object({
    tools: z
      .array(
        z
          .object({
            server: z.string().min(1),
            name: z.string().min(1),
            prefixed_name: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    connections: z
      .array(
        z
          .object({
            server: z.string().min(1),
            connected: z.boolean().optional(),
            auth_required: z.boolean().optional(),
            error: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireSkills = z
  .object({
    directory: z.string().optional(),
    directories: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    skills: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            path: z.string().optional(),
            source: z.string().optional(),
            plugin_id: z.string().nullable().optional(),
            plugin_generation: z.string().nullable().optional(),
            plugin_content_hash: z.string().nullable().optional(),
            enabled: z.boolean().optional(),
            is_bundled: z.boolean().optional(),
            invocation: z.string().optional(),
            aliases: z.array(z.string()).optional(),
            bundled_tier: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WirePlugin = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    display_name: z.string().optional(),
    author: z.string().optional(),
    homepage: z.string().nullable().optional(),
    platforms: z.array(z.string()).optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    scope: z.string().optional(),
    origin: z.string().optional(),
    path: z.string().nullable().optional(),
    state: z.string().optional(),
    enabled: z.boolean().optional(),
    trust_status: z.string().optional(),
    active: z.boolean().optional(),
    compatibility: z.string().optional(),
    inventory: z
      .object({
        skills: z.number().optional(),
        mcp_servers: z.number().optional(),
        stdio_mcp_servers: z.number().optional(),
        remote_mcp_servers: z.number().optional(),
        commands: z.number().optional(),
        agents: z.number().optional(),
        hooks: z.number().optional(),
        lsp: z.number().optional(),
        native: z.number().optional(),
        filesystem_roots: z.array(z.string()).optional(),
        network_hosts: z.array(z.string()).optional(),
        lifecycle_mutation: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    content_hash: z.string().nullable().optional(),
    capability_hash: z.string().nullable().optional(),
    state_generation: z.number().optional(),
    diagnostics: z.array(z.unknown()).optional(),
  })
  .passthrough();

const WirePlugins = z
  .object({
    workspace: z.string().optional(),
    plugins: z.array(WirePlugin).optional(),
    registry_diagnostics: z.array(z.unknown()).optional(),
    validation_clean: z.boolean().optional(),
  })
  .passthrough();

const WireHooks = z
  .object({
    workspace: z.string().optional(),
    enabled: z.boolean().optional(),
    hooks: z
      .array(
        z
          .object({
            name: z.string().optional(),
            event: z.string().optional(),
            command: z.string().optional(),
            background: z.boolean().optional(),
            timeout_secs: z.number().nullable().optional(),
            source: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    problems: z.array(z.unknown()).optional(),
  })
  .passthrough();

const WireInstructions = z
  .object({
    workspace: z.string().optional(),
    sources: z
      .array(
        z
          .object({
            kind: z.string().optional(),
            status: z.string().optional(),
            scope_dir: z.string().optional(),
            path: z.string().optional(),
            relative_path: z.string().nullable().optional(),
            exists: z.boolean().optional(),
            bytes: z.number().nullable().optional(),
            warning: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    foreign_imports: z.array(z.string()).optional(),
    generated_fallback: z.boolean().optional(),
    aggregate_budget_bytes: z.number().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

const MAX_DETAIL_SERVERS = 60;

export class EngineExtensions {
  private readonly transport: RuntimeTransport;
  private readonly now: () => Date;

  constructor(transport: RuntimeTransport, now: () => Date = () => new Date()) {
    this.transport = transport;
    this.now = now;
  }

  async snapshot(workspace: string | null = null): Promise<Result<ExtensionsView>> {
    const [mcp, skills, plugins, hooks, instructions] = await Promise.all([
      this.readMcp(),
      this.readSkills(),
      this.readPlugins(),
      this.readHooks(),
      this.readInstructions(),
    ]);
    const caveats: string[] = [];
    for (const section of [mcp, skills, plugins, hooks, instructions]) {
      if (section.status === 'unavailable' && section.note) caveats.push(section.note);
    }
    const counts: ExtensionCounts = {
      mcpServers: mcp.servers.length,
      mcpEnabled: mcp.servers.filter((server) => server.enabled).length,
      skills: skills.skills.length,
      plugins: plugins.plugins.length,
      hooks: hooks.hooks.length,
      instructionsLoaded: instructions.sources.filter((source) => source.exists).length,
    };
    return ok(
      ExtensionsView.parse({
        connected: true,
        capturedAt: this.now().toISOString(),
        workspace: workspace ?? plugins.workspace ?? hooks.workspace ?? instructions.workspace ?? null,
        engineState: 'connected',
        mcp,
        skills,
        plugins,
        hooks,
        instructions,
        counts,
        scopes: [...EXTENSION_SCOPE_NOTES],
        caveats,
      }),
    );
  }

  /** Explicit user action: ask the runtime to connect one server and list its tools. */
  async checkMcpHealth(input: { name: string; expectedRevision: string }): Promise<Result<McpHealthView>> {
    const connected = await this.transport.json(
      'POST',
      `/v1/apps/mcp/servers/${encodeURIComponent(input.name)}/reconnect`,
      {},
      { headers: { 'If-Match': input.expectedRevision } },
    );
    if (!connected.ok) return connected;
    const wire = WireMcpReconnect.safeParse(connected.value.json);
    if (!wire.success) return fail('schema_drift', 'MCP health response did not match the runtime contract');
    const tools = await this.readToolNames();
    const collection = tools.ok ? tools.value.tools.filter((tool) => tool.server === input.name) : [];
    const connectionError = wire.data.connection?.error ?? null;
    const toolNote = tools.ok ? null : `The tool list could not be read: ${tools.error.message}`;
    return ok(
      McpHealthView.parse({
        server: input.name,
        connected: wire.data.connection?.connected ?? false,
        authRequired: wire.data.connection?.auth_required ?? false,
        error: shorten(redactExtensionText([connectionError, toolNote].filter(Boolean).join(' ')), 2_000) || null,
        tools: collection.map((tool) => ({
          server: tool.server,
          name: tool.name,
          prefixedName: tool.prefixedName,
        })),
        checkedAt: this.now().toISOString(),
        revision: tools.ok ? tools.value.revision : null,
      }),
    );
  }

  /** Enable or disable one MCP server through the runtime's revision-guarded route. */
  async setMcpEnabled(input: {
    name: string;
    enabled: boolean;
    expectedRevision: string;
  }): Promise<Result<ExtensionActionReceipt>> {
    const before = await this.readMcp();
    if (before.status !== 'ok' || !before.revision) {
      return fail('engine_unavailable', 'The MCP configuration could not be read before saving.');
    }
    if (before.revision !== input.expectedRevision) {
      return fail('conflict', 'The MCP configuration changed since this view was read. Reload before saving.');
    }
    const server = before.servers.find((entry) => entry.name === input.name);
    if (!server) return fail('not_found', `MCP server ${input.name} is not configured.`);
    if (!server.writable) return fail('permission_denied', `MCP server ${input.name} is not writable from here.`);
    if (!input.enabled && server.required) {
      return fail('invalid_request', `${input.name} is marked required and cannot be disabled.`);
    }
    const action = input.enabled ? 'enable' : 'disable';
    const written = await this.transport.json(
      'POST',
      `/v1/apps/mcp/servers/${encodeURIComponent(input.name)}/${action}`,
      {},
      { headers: { 'If-Match': input.expectedRevision } },
    );
    if (!written.ok) {
      if (written.error.code === 'conflict') {
        return fail(
          'conflict',
          'The MCP configuration changed while this change was being saved. Reload before saving.',
          { detail: written.error.detail },
        );
      }
      return written;
    }
    const after = await this.readMcp();
    const observed = after.status === 'ok' ? after.servers.find((entry) => entry.name === input.name) : undefined;
    const verified = observed ? observed.enabled === input.enabled : false;
    return ok({
      action: input.enabled ? 'mcp.enable' : 'mcp.disable',
      target: input.name,
      origin: server.origin,
      enabled: observed?.enabled ?? null,
      connected: observed?.connected ?? null,
      verified,
      previousRevision: input.expectedRevision,
      revision: after.status === 'ok' ? after.revision : null,
      detail: verified
        ? `The engine confirms ${input.name} is ${input.enabled ? 'enabled' : 'disabled'}.`
        : `The engine accepted the request, but the read-back did not confirm ${input.name}. Inspect the MCP configuration.`,
      appliedAt: this.now().toISOString(),
    });
  }

  private async readMcp(): Promise<McpSection> {
    const response = await this.transport.json('GET', '/v1/apps/mcp/servers');
    if (!response.ok) return unavailableMcp(response.error.message);
    const wire = WireMcpList.safeParse(response.value.json);
    if (!wire.success) return unavailableMcp('MCP server list did not match the runtime contract.');
    const revision = wire.data.revision ?? null;
    const list = wire.data.servers ?? [];
    const details = await this.readDetails(list.slice(0, MAX_DETAIL_SERVERS));
    const servers: McpServerEntry[] = list.map((server, index) => {
      const detail = details[index] ?? null;
      return {
        name: server.name,
        origin: origin(server.origin),
        writable: server.writable ?? false,
        authRequired: server.auth_required ?? false,
        enabled: server.enabled ?? false,
        required: server.required ?? false,
        command: shorten(redactExtensionText(server.command ?? ''), 1_000) || null,
        argumentCount: detail?.args?.length ?? 0,
        url: shorten(redactExtensionText(server.url ?? ''), 1_000) || null,
        transport: transport(detail?.transport ?? null, server.url ?? null),
        connected: server.connected ?? detail?.connected ?? false,
        credentialConfigured: detail?.credential_configured ?? false,
        enabledTools: boundedNames(server.enabled_tools ?? detail?.enabled_tools ?? []),
        disabledTools: boundedNames(server.disabled_tools ?? detail?.disabled_tools ?? []),
        envKeys: boundedNames(detail?.env_keys ?? []),
        scopes: (detail?.scopes ?? []).map((scope) => shorten(redactExtensionText(scope), 200)),
        detailAvailable: detail !== null,
        detailNote: detail === null ? 'The engine did not return this server’s details.' : null,
      };
    });
    return {
      status: 'ok',
      note: null,
      revision,
      servers,
    };
  }

  private async readDetails(servers: Array<{ name: string }>): Promise<Array<z.infer<typeof WireMcpDetail> | null>> {
    const out: Array<z.infer<typeof WireMcpDetail> | null> = [];
    for (const server of servers) {
      const response = await this.transport.json('GET', `/v1/apps/mcp/servers/${encodeURIComponent(server.name)}`);
      if (!response.ok) {
        out.push(null);
        continue;
      }
      const wire = WireMcpDetail.safeParse(response.value.json);
      out.push(wire.success ? wire.data : null);
    }
    return out;
  }

  private async readToolNames(): Promise<
    Result<{ revision: string | null; tools: Array<{ server: string; name: string; prefixedName: string }> }>
  > {
    const response = await this.transport.json('GET', '/v1/apps/mcp/tools');
    if (!response.ok) return response;
    const wire = WireMcpTools.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'MCP tool list did not match the runtime contract.');
    const revision = await this.readMcpRevision();
    return ok({
      revision,
      tools: (wire.data.tools ?? []).map((tool) => ({
        server: tool.server,
        name: tool.name,
        prefixedName: tool.prefixed_name ?? tool.name,
      })),
    });
  }

  private async readMcpRevision(): Promise<string | null> {
    const response = await this.transport.json('GET', '/v1/apps/mcp/servers');
    if (!response.ok) return null;
    const wire = WireMcpList.safeParse(response.value.json);
    return wire.success ? (wire.data.revision ?? null) : null;
  }

  private async readSkills(): Promise<SkillSection> {
    const response = await this.transport.json('GET', '/v1/skills');
    if (!response.ok) return unavailableSkills(response.error.message);
    const wire = WireSkills.safeParse(response.value.json);
    if (!wire.success) return unavailableSkills('Skill list did not match the runtime contract.');
    return {
      status: 'ok',
      note: null,
      directories: (wire.data.directories ?? (wire.data.directory ? [wire.data.directory] : [])).slice(0, 20),
      warnings: (wire.data.warnings ?? []).map((warning) => shorten(redactExtensionText(warning), 1_000)).slice(0, 200),
      skills: (wire.data.skills ?? []).map((skill) => ({
        name: skill.name,
        description: shorten(skill.description ?? '', 2_000),
        path: skill.path ?? '',
        source:
          skill.source === 'native' || skill.source === 'plugin'
            ? skill.source
            : skill.path?.includes('.codewhale')
              ? 'project'
              : 'unknown',
        pluginId: skill.plugin_id ?? null,
        pluginGeneration: skill.plugin_generation ?? null,
        pluginContentHash: skill.plugin_content_hash ?? null,
        enabled: skill.enabled ?? true,
        bundled: skill.is_bundled ?? false,
        invocation:
          skill.invocation === 'model+user' || skill.invocation === 'explicit-only' ? skill.invocation : 'unknown',
        aliases: boundedNames(skill.aliases ?? []),
        bundledTier: skill.bundled_tier ?? null,
      })),
    };
  }

  private async readPlugins(): Promise<PluginSection> {
    const response = await this.transport.json('GET', '/v1/apps/plugins');
    if (!response.ok) return unavailablePlugins(response.error.message);
    const wire = WirePlugins.safeParse(response.value.json);
    if (!wire.success) return unavailablePlugins('Plugin list did not match the runtime contract.');
    return {
      status: 'ok',
      note: null,
      workspace: wire.data.workspace ?? null,
      registryDiagnostics: (wire.data.registry_diagnostics ?? []).map(textValue).slice(0, 100),
      validationClean: wire.data.validation_clean ?? false,
      plugins: (wire.data.plugins ?? []).map((plugin) => {
        const inventory = plugin.inventory ?? {};
        return {
          id: plugin.id,
          name: plugin.name,
          displayName: plugin.display_name ?? plugin.name,
          author: plugin.author ?? '',
          homepage: plugin.homepage ?? null,
          version: plugin.version ?? '',
          description: shorten(plugin.description ?? '', 2_000),
          scope:
            plugin.scope === 'builtin' || plugin.scope === 'global' || plugin.scope === 'project'
              ? plugin.scope
              : 'unknown',
          origin: plugin.origin ?? 'unknown',
          path: plugin.path ?? null,
          state: plugin.state ?? 'unknown',
          enabled: plugin.enabled ?? false,
          trustStatus: plugin.trust_status ?? 'unknown',
          active: plugin.active ?? false,
          compatibility: plugin.compatibility ?? 'unknown',
          platforms: boundedNames(plugin.platforms ?? []),
          inventory: {
            skills: count(inventory.skills),
            mcpServers: count(inventory.mcp_servers),
            stdioMcpServers: count(inventory.stdio_mcp_servers),
            remoteMcpServers: count(inventory.remote_mcp_servers),
            commands: count(inventory.commands),
            agents: count(inventory.agents),
            hooks: count(inventory.hooks),
            lsp: count(inventory.lsp),
            native: count(inventory.native),
            filesystemRoots: (inventory.filesystem_roots ?? []).slice(0, 100).map((value) => textValue(value)),
            networkHosts: (inventory.network_hosts ?? []).slice(0, 100).map((value) => textValue(value)),
            lifecycleMutation: inventory.lifecycle_mutation ?? false,
          },
          contentHash: plugin.content_hash ?? null,
          capabilityHash: plugin.capability_hash ?? null,
          stateGeneration: count(plugin.state_generation),
          diagnostics: (plugin.diagnostics ?? []).map(textValue).slice(0, 100),
        };
      }),
    };
  }

  private async readHooks(): Promise<HookSection> {
    const response = await this.transport.json('GET', '/v1/hooks');
    if (!response.ok) return unavailableHooks(response.error.message);
    const wire = WireHooks.safeParse(response.value.json);
    if (!wire.success) return unavailableHooks('Hook list did not match the runtime contract.');
    return {
      status: 'ok',
      note: null,
      workspace: wire.data.workspace ?? null,
      enabled: wire.data.enabled ?? false,
      hooks: (wire.data.hooks ?? []).map((hook) => ({
        name: shorten(hook.name ?? 'unnamed hook', 200),
        event: shorten(hook.event ?? 'unknown', 80),
        command: shorten(redactExtensionText(hook.command ?? ''), 1_000),
        background: hook.background ?? false,
        timeoutSecs: hook.timeout_secs ?? null,
        source:
          hook.source === 'global' || hook.source === 'project' || hook.source === 'plugin' ? hook.source : 'unknown',
      })),
      problems: (wire.data.problems ?? []).map(textValue).slice(0, 200),
    };
  }

  private async readInstructions(): Promise<InstructionSection> {
    const response = await this.transport.json('GET', '/v1/workspace/instructions');
    if (!response.ok) return unavailableInstructions(response.error.message);
    const wire = WireInstructions.safeParse(response.value.json);
    if (!wire.success) return unavailableInstructions('Instruction sources did not match the runtime contract.');
    return {
      status: 'ok',
      note: null,
      workspace: wire.data.workspace ?? null,
      sources: (wire.data.sources ?? []).map((source) => ({
        kind: source.kind ?? 'unknown',
        status: source.status ?? 'unknown',
        scopeDir: source.scope_dir ?? '',
        path: source.path ?? '',
        relativePath: source.relative_path ?? null,
        exists: source.exists ?? false,
        bytes: source.bytes ?? null,
        warning: source.warning ? shorten(redactExtensionText(source.warning), 1_000) : null,
      })),
      foreignImports: (wire.data.foreign_imports ?? []).slice(0, 100),
      generatedFallback: wire.data.generated_fallback ?? false,
      aggregateBudgetBytes: wire.data.aggregate_budget_bytes ?? 0,
      warnings: (wire.data.warnings ?? []).map((warning) => shorten(redactExtensionText(warning), 1_000)).slice(0, 100),
    };
  }
}

function unavailableMcp(note: string): McpSection {
  return { status: 'unavailable', note: shorten(redactExtensionText(note), 2_000), revision: null, servers: [] };
}

function unavailableSkills(note: string): SkillSection {
  return {
    status: 'unavailable',
    note: shorten(redactExtensionText(note), 2_000),
    directories: [],
    warnings: [],
    skills: [],
  };
}

function unavailablePlugins(note: string): PluginSection {
  return {
    status: 'unavailable',
    note: shorten(redactExtensionText(note), 2_000),
    workspace: null,
    plugins: [],
    registryDiagnostics: [],
    validationClean: false,
  };
}

function unavailableHooks(note: string): HookSection {
  return {
    status: 'unavailable',
    note: shorten(redactExtensionText(note), 2_000),
    workspace: null,
    enabled: false,
    hooks: [],
    problems: [],
  };
}

function unavailableInstructions(note: string): InstructionSection {
  return {
    status: 'unavailable',
    note: shorten(redactExtensionText(note), 2_000),
    workspace: null,
    sources: [],
    foreignImports: [],
    generatedFallback: false,
    aggregateBudgetBytes: 0,
    warnings: [],
  };
}

function origin(value: string | undefined): 'global' | 'project' | 'unknown' {
  return value === 'global' || value === 'project' ? value : 'unknown';
}

function transport(value: string | null, url: string | null): 'stdio' | 'http' | 'sse' | 'unknown' {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value;
  if (value === 'streamable-http' || value === 'streamable_http') return 'http';
  if (url) return 'http';
  return 'unknown';
}

function boundedNames(values: string[]): string[] {
  return values.slice(0, 500).map((value) => shorten(redactExtensionText(value), 200));
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function textValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return shorten(redactExtensionText(text ?? ''), 1_000);
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Redact credential-shaped values from extension configuration before it leaves the adapter. */
export function redactExtensionText(text: string): string {
  return redact(text)
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|bearer)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:token|api_key|key|secret|access_token|auth)=)[^&\s]+/gi, '$1[redacted]');
}
