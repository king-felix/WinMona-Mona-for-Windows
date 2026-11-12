import { describe, expect, it } from 'vitest';
import type { RuntimeTransport, TransportOptions, TransportResponse } from './http.js';
import type { Result } from './errors.js';
import { EngineExtensions, redactExtensionText } from './extensions.js';

type Handler = (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  options: TransportOptions | undefined,
) => Result<TransportResponse>;

class FakeTransport implements RuntimeTransport {
  readonly calls: Array<{ method: string; path: string; options: TransportOptions | undefined }> = [];
  constructor(private readonly handler: Handler) {}

  async json(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<Result<TransportResponse>> {
    this.calls.push({ method, path, options });
    return this.handler(method, path, body, options);
  }

  async stream(): Promise<Result<AsyncIterable<Uint8Array>>> {
    return { ok: false, error: { code: 'transport_failed', message: 'unused', retryable: false } };
  }
}

function success(json: unknown): Result<TransportResponse> {
  return { ok: true, value: { status: 200, json, bytes: 0 } };
}

function failure(code: 'not_found' | 'conflict', message: string): Result<TransportResponse> {
  return { ok: false, error: { code, message, retryable: false } };
}

const mcpList = {
  revision: 'mcp-v1-aaaa',
  servers: [
    {
      name: 'fixture',
      origin: 'global',
      writable: true,
      auth_required: false,
      enabled: true,
      required: false,
      command: 'node',
      url: null,
      connected: false,
      enabled_tools: [],
      disabled_tools: [],
    },
    {
      name: 'remote',
      origin: 'project',
      writable: true,
      auth_required: true,
      enabled: false,
      required: true,
      command: null,
      url: 'https://example.test/mcp?token=super-secret-value',
      connected: false,
      enabled_tools: ['search'],
      disabled_tools: [],
    },
  ],
};

const mcpDetail = {
  name: 'fixture',
  credential_configured: true,
  origin: 'global',
  writable: true,
  auth_required: false,
  enabled: true,
  required: false,
  command: 'node',
  args: ['server.mjs', '--api-key=sk-live-secret-value'],
  env_keys: ['FIXTURE_TOKEN'],
  url: null,
  transport: 'stdio',
  enabled_tools: [],
  disabled_tools: [],
  scopes: ['tools'],
  connected: false,
};

const mcpTools = {
  tools: [
    { server: 'fixture', name: 'echo_text', prefixed_name: 'mcp_fixture_echo_text' },
    { server: 'other', name: 'ignored', prefixed_name: 'mcp_other_ignored' },
  ],
  connections: [{ server: 'fixture', connected: true, auth_required: false }],
};

const skillsWire = {
  directory: 'C:\\home\\skills',
  directories: ['C:\\home\\skills', 'C:\\project\\.codewhale\\skills'],
  warnings: ['Skill `a` is shadowed by `b`.'],
  skills: [
    {
      name: 'debug',
      description: 'Find the root cause.',
      path: 'C:\\home\\skills\\debug\\SKILL.md',
      source: 'native',
      plugin_id: null,
      plugin_generation: null,
      plugin_content_hash: null,
      enabled: true,
      is_bundled: true,
      invocation: 'model+user',
      aliases: ['diagnose'],
      bundled_tier: 'core',
    },
  ],
};

const pluginsWire = {
  workspace: 'C:\\project',
  validation_clean: true,
  registry_diagnostics: [],
  plugins: [
    {
      id: 'builtin/abc/computer-use',
      name: 'computer-use',
      display_name: 'Computer Use',
      icon: 'data:image/png;base64,' + 'A'.repeat(4_000),
      author: 'Codewhale',
      homepage: 'https://codewhale.net/computer-use',
      platforms: ['macos'],
      version: '0.12.1',
      description: 'Control apps.',
      scope: 'builtin',
      origin: 'codewhale-builtin',
      path: 'C:\\home\\builtin-plugins\\computer-use',
      state: 'disabled',
      enabled: false,
      trust_status: 'not-reviewed',
      active: false,
      compatibility: 'full',
      inventory: {
        skills: 1,
        mcp_servers: 1,
        stdio_mcp_servers: 1,
        remote_mcp_servers: 0,
        commands: 1,
        agents: 0,
        hooks: 0,
        lsp: 0,
        native: 0,
        filesystem_roots: [],
        network_hosts: [],
        lifecycle_mutation: false,
      },
      content_hash: 'hash',
      capability_hash: 'cap',
      state_generation: 0,
      diagnostics: [],
    },
  ],
};

const hooksWire = {
  workspace: 'C:\\project',
  enabled: true,
  hooks: [
    {
      name: 'format',
      event: 'tool_call_after',
      command: 'deploy --token=super-secret-value',
      background: true,
      timeout_secs: 30,
      source: 'global',
    },
  ],
  problems: [{ message: 'Project hooks are not approved.' }],
};

const instructionsWire = {
  workspace: 'C:\\project',
  sources: [
    {
      kind: 'project',
      status: 'loaded',
      scope_dir: 'C:\\project',
      path: 'C:\\project\\AGENTS.md',
      relative_path: 'AGENTS.md',
      exists: true,
      bytes: 245,
      warning: null,
    },
    {
      kind: 'global',
      status: 'missing',
      scope_dir: 'C:\\Users\\victor',
      path: 'C:\\Users\\victor\\.codewhale\\AGENTS.md',
      relative_path: null,
      exists: false,
      bytes: null,
      warning: null,
    },
  ],
  foreign_imports: [],
  generated_fallback: false,
  aggregate_budget_bytes: 49_152,
  warnings: [],
};

function fullSnapshotHandler(
  options: { tools?: boolean; hookProblem?: unknown; missingDetail?: boolean } = {},
): Handler {
  return (method, path) => {
    if (method === 'GET' && path === '/v1/apps/mcp/servers') return success(mcpList);
    if (method === 'GET' && path === '/v1/apps/mcp/servers/fixture') {
      return options.missingDetail ? failure('not_found', 'not found') : success(mcpDetail);
    }
    if (method === 'GET' && path === '/v1/apps/mcp/servers/remote') {
      return success({
        ...mcpDetail,
        name: 'remote',
        transport: 'http',
        command: null,
        args: [],
        url: mcpList.servers[1].url,
      });
    }
    if (method === 'GET' && path === '/v1/apps/mcp/tools') return success(mcpTools);
    if (method === 'GET' && path === '/v1/skills') return success(skillsWire);
    if (method === 'GET' && path === '/v1/apps/plugins') return success(pluginsWire);
    if (method === 'GET' && path === '/v1/hooks') {
      return success({
        ...hooksWire,
        problems: options.hookProblem === undefined ? hooksWire.problems : [options.hookProblem],
      });
    }
    if (method === 'GET' && path === '/v1/workspace/instructions') return success(instructionsWire);
    return failure('not_found', `unexpected ${method} ${path}`);
  };
}

describe('engine extension projection', () => {
  it('maps every section without connecting servers or requesting tool descriptions', async () => {
    const transport = new FakeTransport(fullSnapshotHandler());
    const extensions = new EngineExtensions(transport, () => new Date('2026-11-12T10:00:00Z'));
    const result = await extensions.snapshot('C:\\project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts).toEqual({
      mcpServers: 2,
      mcpEnabled: 1,
      skills: 1,
      plugins: 1,
      hooks: 1,
      instructionsLoaded: 1,
    });
    expect(result.value.mcp.revision).toBe('mcp-v1-aaaa');
    expect(result.value.mcp.servers[0]).toMatchObject({
      name: 'fixture',
      origin: 'global',
      transport: 'stdio',
      argumentCount: 2,
      envKeys: ['FIXTURE_TOKEN'],
      detailAvailable: true,
    });
    expect(result.value.mcp.servers[1]).toMatchObject({
      name: 'remote',
      origin: 'project',
      required: true,
      authRequired: true,
      transport: 'http',
    });
    expect(result.value.mcp.servers[1].url).not.toContain('super-secret-value');
    expect(Object.keys(result.value.plugins.plugins[0])).not.toContain('icon');
    expect(result.value.plugins.plugins[0].inventory.mcpServers).toBe(1);
    expect(result.value.hooks.hooks[0].command).not.toContain('super-secret-value');
    expect(result.value.hooks.problems[0]).toContain('not approved');
    expect(result.value.instructions.sources[0]).toMatchObject({ kind: 'project', status: 'loaded', bytes: 245 });
    expect(result.value.scopes.map((scope) => scope.id)).toEqual(['global', 'project', 'builtin']);
    expect(transport.calls.some((call) => call.path === '/v1/apps/mcp/tools')).toBe(false);
    expect(transport.calls.some((call) => call.options?.headers)).toBe(false);
  });

  it('keeps a section unavailable instead of pretending it is empty', async () => {
    const transport = new FakeTransport((method, path) => {
      if (path === '/v1/skills') return failure('not_found', 'runtime route or item was not found');
      return fullSnapshotHandler()(method, path, undefined, undefined);
    });
    const result = await new EngineExtensions(transport).snapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.status).toBe('unavailable');
    expect(result.value.skills.note).toContain('not found');
    expect(result.value.mcp.status).toBe('ok');
    expect(result.value.caveats.some((caveat) => caveat.includes('not found'))).toBe(true);
  });

  it('reports a missing server detail without dropping the list row', async () => {
    const transport = new FakeTransport(fullSnapshotHandler({ missingDetail: true }));
    const result = await new EngineExtensions(transport).snapshot();
    if (!result.ok) throw new Error('snapshot failed');
    expect(result.value.mcp.servers[0].detailAvailable).toBe(false);
    expect(result.value.mcp.servers[0].detailNote).toContain('did not return');
    expect(result.value.mcp.servers[0].command).toBe('node');
  });

  it('checks health with the revision guard and returns tool names only', async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === 'POST' && path === '/v1/apps/mcp/servers/fixture/reconnect') {
        return success({
          name: 'fixture',
          action: 'reconnected',
          ok: true,
          connection: { server: 'fixture', connected: true },
        });
      }
      return fullSnapshotHandler()(method, path, undefined, undefined);
    });
    const result = await new EngineExtensions(transport).checkMcpHealth({
      name: 'fixture',
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.connected).toBe(true);
    expect(result.value.tools).toEqual([
      { server: 'fixture', name: 'echo_text', prefixedName: 'mcp_fixture_echo_text' },
    ]);
    expect(result.value.revision).toBe('mcp-v1-aaaa');
    const post = transport.calls.find((call) => call.method === 'POST');
    expect(post?.options?.headers).toEqual({ 'If-Match': 'mcp-v1-aaaa' });
  });

  it('returns an actionable redacted error when a server cannot start', async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === 'POST' && path === '/v1/apps/mcp/servers/missing/reconnect') {
        return success({
          name: 'missing',
          action: 'reconnect_failed',
          ok: false,
          connection: {
            server: 'missing',
            connected: false,
            error: 'MCP stdio spawn failed cmd="C:\\nope.exe" env_keys=["TOKEN"] token=super-secret-value',
          },
        });
      }
      return fullSnapshotHandler()(method, path, undefined, undefined);
    });
    const result = await new EngineExtensions(transport).checkMcpHealth({
      name: 'missing',
      expectedRevision: 'mcp-v1-aaaa',
    });
    if (!result.ok) throw new Error('health failed');
    expect(result.value.connected).toBe(false);
    expect(result.value.error).toContain('spawn failed');
    expect(result.value.error).not.toContain('super-secret-value');
  });

  it('refuses a stale view before writing and leaves the server untouched', async () => {
    const transport = new FakeTransport(fullSnapshotHandler());
    const result = await new EngineExtensions(transport).setMcpEnabled({
      name: 'fixture',
      enabled: false,
      expectedRevision: 'mcp-v1-stale',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('conflict');
    expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses to disable a required server', async () => {
    const transport = new FakeTransport(fullSnapshotHandler());
    const result = await new EngineExtensions(transport).setMcpEnabled({
      name: 'remote',
      enabled: false,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_request');
    expect(transport.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('verifies enable/disable by reading the server back', async () => {
    let enabled = true;
    let revision = 'mcp-v1-aaaa';
    const transport = new FakeTransport((method, path) => {
      if (method === 'GET' && path === '/v1/apps/mcp/servers') {
        return success({
          ...mcpList,
          revision,
          servers: mcpList.servers.map((server) => (server.name === 'fixture' ? { ...server, enabled } : server)),
        });
      }
      if (method === 'GET' && path === '/v1/apps/mcp/servers/fixture') return success(mcpDetail);
      if (method === 'GET' && path === '/v1/apps/mcp/servers/remote') {
        return success({
          ...mcpDetail,
          name: 'remote',
          transport: 'http',
          command: null,
          args: [],
          url: mcpList.servers[1].url,
        });
      }
      if (method === 'GET' && path === '/v1/skills') return success(skillsWire);
      if (method === 'GET' && path === '/v1/apps/plugins') return success(pluginsWire);
      if (method === 'GET' && path === '/v1/hooks') return success(hooksWire);
      if (method === 'GET' && path === '/v1/workspace/instructions') return success(instructionsWire);
      if (method === 'POST' && path === '/v1/apps/mcp/servers/fixture/disable') {
        enabled = false;
        revision = 'mcp-v1-bbbb';
        return success({ name: 'fixture', action: 'disabled', ok: true });
      }
      return failure('not_found', `unexpected ${method} ${path}`);
    });
    const result = await new EngineExtensions(transport).setMcpEnabled({
      name: 'fixture',
      enabled: false,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verified).toBe(true);
    expect(result.value.enabled).toBe(false);
    expect(result.value.revision).toBe('mcp-v1-bbbb');
    const post = transport.calls.find((call) => call.method === 'POST');
    expect(post?.options?.headers).toEqual({ 'If-Match': 'mcp-v1-aaaa' });
  });

  it('maps a runtime stale-revision refusal to a reload instruction', async () => {
    const transport = new FakeTransport((method, path) => {
      if (method === 'POST' && path === '/v1/apps/mcp/servers/fixture/disable') {
        return failure('conflict', 'runtime refused a stale revision; reload before saving');
      }
      return fullSnapshotHandler()(method, path, undefined, undefined);
    });
    const result = await new EngineExtensions(transport).setMcpEnabled({
      name: 'fixture',
      enabled: false,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('conflict');
    expect(result.error.message).toContain('Reload');
  });
});

describe('extension redaction', () => {
  it('removes credential-shaped values from commands, errors and URLs', () => {
    const text = redactExtensionText(
      'deploy --token=super-secret FIXTURE_TOKEN=abc123 Authorization: Bearer abcdefghijklmnop https://x.test/mcp?api_key=zzz',
    );
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('zzz');
    expect(text).toContain('[redacted]');
  });
});
