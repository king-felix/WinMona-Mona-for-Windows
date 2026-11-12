import { describe, expect, it } from 'vitest';
import type { EngineAdapter } from '@mona/adapter';
import { EXTENSION_SCOPE_NOTES, type ExtensionsView } from '@mona/contracts';
import type { ProjectStore } from '@mona/project-state';
import type { EngineSummary } from './engine-host.js';
import { ExtensionsService } from './extensions-service.js';

const PROJECT = {
  id: 'prj_1',
  label: 'Demo',
  canonicalPath: 'C:\\proj',
  createdAt: '2026-11-12T08:00:00Z',
  updatedAt: '2026-11-12T08:00:00Z',
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

function view(overrides: Partial<ExtensionsView> = {}): ExtensionsView {
  return {
    connected: true,
    capturedAt: '2026-11-12T10:00:00Z',
    workspace: 'C:\\proj',
    engineState: 'connected',
    mcp: {
      status: 'ok',
      note: null,
      revision: 'mcp-v1-aaaa',
      servers: [
        {
          name: 'fixture',
          origin: 'global',
          writable: true,
          authRequired: false,
          enabled: true,
          required: false,
          command: 'node',
          argumentCount: 1,
          url: null,
          transport: 'stdio',
          connected: false,
          credentialConfigured: false,
          enabledTools: [],
          disabledTools: [],
          envKeys: [],
          scopes: [],
          detailAvailable: true,
          detailNote: null,
        },
        {
          name: 'required',
          origin: 'project',
          writable: true,
          authRequired: false,
          enabled: true,
          required: true,
          command: 'node',
          argumentCount: 0,
          url: null,
          transport: 'stdio',
          connected: false,
          credentialConfigured: false,
          enabledTools: [],
          disabledTools: [],
          envKeys: [],
          scopes: [],
          detailAvailable: true,
          detailNote: null,
        },
      ],
    },
    skills: { status: 'ok', note: null, directories: [], warnings: [], skills: [] },
    plugins: {
      status: 'ok',
      note: null,
      workspace: 'C:\\proj',
      plugins: [],
      registryDiagnostics: [],
      validationClean: true,
    },
    hooks: { status: 'ok', note: null, workspace: 'C:\\proj', enabled: false, hooks: [], problems: [] },
    instructions: {
      status: 'ok',
      note: null,
      workspace: 'C:\\proj',
      sources: [],
      foreignImports: [],
      generatedFallback: true,
      aggregateBudgetBytes: 49_152,
      warnings: [],
    },
    counts: { mcpServers: 2, mcpEnabled: 2, skills: 0, plugins: 0, hooks: 0, instructionsLoaded: 0 },
    scopes: [...EXTENSION_SCOPE_NOTES],
    caveats: [],
    ...overrides,
  };
}

function harness(
  options: {
    snapshot?: ExtensionsView;
    adapter?: boolean;
    summary?: EngineSummary;
    project?: boolean;
    setResult?: { ok: true; value: unknown } | { ok: false; error: unknown };
    healthResult?: { ok: true; value: unknown } | { ok: false; error: unknown };
  } = {},
) {
  const store = {
    getProject: async (id: string) => (options.project === false || id !== PROJECT.id ? null : PROJECT),
  } as unknown as ProjectStore;
  const calls: string[] = [];
  const extensions = {
    snapshot: async () => ({ ok: true, value: options.snapshot ?? view() }),
    setMcpEnabled: async (input: { name: string; enabled: boolean; expectedRevision: string }) => {
      calls.push(`set:${input.name}:${input.enabled}:${input.expectedRevision}`);
      return options.setResult ?? { ok: true, value: { target: input.name } };
    },
    checkMcpHealth: async (input: { name: string; expectedRevision: string }) => {
      calls.push(`check:${input.name}:${input.expectedRevision}`);
      return options.healthResult ?? { ok: true, value: { server: input.name } };
    },
  };
  const adapter = { extensions: () => extensions } as unknown as EngineAdapter;
  const service = new ExtensionsService({
    store,
    engine: {
      summary: () => options.summary ?? summary(),
      adapter: () => (options.adapter === false ? null : adapter),
    },
    now: () => new Date('2026-11-12T10:00:00Z'),
  });
  return { service, calls };
}

describe('extensions service', () => {
  it('reports a disconnected view without inventing extension state', async () => {
    const { service } = harness({ adapter: false, summary: summary({ state: 'stopped', workspace: null }) });
    const result = await service.view({ projectId: 'prj_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(false);
    expect(result.data.mcp.status).toBe('unavailable');
    expect(result.data.mcp.servers).toEqual([]);
    expect(result.data.counts.mcpServers).toBe(0);
    expect(result.data.caveats[0]).toContain('not connected');
  });

  it('returns the runtime report and adds a workspace scope caveat', async () => {
    const { service } = harness({ summary: summary({ workspace: 'C:\\other' }) });
    const result = await service.view({ projectId: 'prj_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mcp.servers.map((server) => server.name)).toEqual(['fixture', 'required']);
    expect(result.data.caveats.some((caveat) => caveat.includes('not this project'))).toBe(true);
  });

  it('explains an empty MCP list without claiming project servers are broken', async () => {
    const empty = view({
      mcp: { status: 'ok', note: null, revision: 'mcp-v1-aaaa', servers: [] },
      counts: { mcpServers: 0, mcpEnabled: 0, skills: 0, plugins: 0, hooks: 0, instructionsLoaded: 0 },
    });
    const { service } = harness({ snapshot: empty });
    const result = await service.view({ projectId: 'prj_1' });
    if (!result.ok) throw new Error('view failed');
    expect(result.data.caveats.some((caveat) => caveat.includes('Project-scope'))).toBe(true);
  });

  it('refuses to disable a required server before calling the adapter', async () => {
    const { service, calls } = harness();
    const result = await service.setMcpEnabled({
      projectId: 'prj_1',
      name: 'required',
      enabled: false,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_request');
    expect(calls).toEqual([]);
  });

  it('forwards the revision guard and maps adapter failures', async () => {
    const { service, calls } = harness({
      setResult: {
        ok: false,
        error: {
          code: 'conflict',
          message: 'The MCP configuration changed since this view was read.',
          retryable: false,
        },
      },
    });
    const result = await service.setMcpEnabled({
      projectId: 'prj_1',
      name: 'fixture',
      enabled: false,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('conflict');
    expect(calls).toEqual(['set:fixture:false:mcp-v1-aaaa']);
  });

  it('checks health through the adapter with the current revision', async () => {
    const { service, calls } = harness({
      healthResult: {
        ok: true,
        value: {
          server: 'fixture',
          connected: true,
          authRequired: false,
          error: null,
          tools: [{ server: 'fixture', name: 'echo_text', prefixedName: 'mcp_fixture_echo_text' }],
          checkedAt: '2026-11-12T10:00:00Z',
          revision: 'mcp-v1-aaaa',
        },
      },
    });
    const result = await service.checkMcpHealth({
      projectId: 'prj_1',
      name: 'fixture',
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['check:fixture:mcp-v1-aaaa']);
  });

  it('refuses actions for an unknown project', async () => {
    const { service } = harness({ project: false });
    const result = await service.setMcpEnabled({
      projectId: 'prj_missing',
      name: 'fixture',
      enabled: true,
      expectedRevision: 'mcp-v1-aaaa',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });
});
