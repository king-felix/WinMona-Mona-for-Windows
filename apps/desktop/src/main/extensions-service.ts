import {
  EXTENSION_SCOPE_NOTES,
  errorResult,
  type ExtensionActionReceipt,
  type ExtensionsView,
  type ExtensionCounts,
  type HookSection,
  type InstructionSection,
  type McpHealthView,
  type McpSection,
  type PluginSection,
  type SkillSection,
} from '@mona/contracts';
import { toErrorResult, type EngineAdapter } from '@mona/adapter';
import type { ProjectStore } from '@mona/project-state';
import type { EngineSummary } from './engine-host.js';

export type ExtensionsEnginePort = {
  summary(): EngineSummary;
  adapter(): EngineAdapter | null;
};

export type ExtensionsServiceDeps = {
  store: ProjectStore;
  engine: ExtensionsEnginePort;
  now?: () => Date;
};

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
type ServiceResult<T> = Success<T> | Failure;

/**
 * Project-facing extension inventory. It reads the runtime's own reports, never
 * parses extension files itself, and never connects a server to render the
 * page. The two write actions are revision-guarded by the runtime; Mona does not
 * approve hooks, plugins, skills or project servers on the user's behalf.
 */
export class ExtensionsService {
  private readonly store: ProjectStore;
  private readonly engine: ExtensionsEnginePort;
  private readonly now: () => Date;

  constructor(deps: ExtensionsServiceDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.now = deps.now ?? (() => new Date());
  }

  async view(input: { projectId: string }): Promise<ServiceResult<ExtensionsView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const summary = this.engine.summary();
    const adapter = this.engine.adapter();
    const capturedAt = this.now().toISOString();
    if (!adapter) {
      return {
        ok: true,
        data: disconnectedView({
          capturedAt,
          engineState: summary.state,
          workspace: summary.workspace,
          note: 'The engine is not connected, so MCP servers, skills, plugins, hooks and project instructions cannot be read.',
        }),
      };
    }
    const result = await adapter.extensions().snapshot(summary.workspace ?? project.canonicalPath);
    if (!result.ok) {
      return { ok: false, error: toErrorResult(result.error) };
    }
    const caveats = [...result.value.caveats];
    if (summary.workspace && !sameWorkspace(summary.workspace, project.canonicalPath)) {
      caveats.push(
        `The running engine reports the workspace ${summary.workspace}, which is not this project (${project.canonicalPath}). This inventory belongs to the engine’s workspace.`,
      );
    }
    if (result.value.mcp.status === 'ok' && result.value.mcp.servers.length === 0) {
      caveats.push(
        'No MCP servers are configured. Project-scope servers appear only after the engine’s own review or trust step.',
      );
    }
    return {
      ok: true,
      data: { ...result.value, caveats },
    };
  }

  async setMcpEnabled(input: {
    projectId: string;
    name: string;
    enabled: boolean;
    expectedRevision: string;
  }): Promise<ServiceResult<ExtensionActionReceipt>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const adapter = this.engine.adapter();
    if (!adapter) {
      return { ok: false, error: errorResult('engine_unavailable', 'Connect the engine before changing MCP servers.') };
    }
    if (!input.enabled) {
      const snapshot = await adapter.extensions().snapshot(this.engine.summary().workspace ?? project.canonicalPath);
      if (snapshot.ok) {
        const server = snapshot.value.mcp.servers.find((entry) => entry.name === input.name);
        if (server?.required) {
          return {
            ok: false,
            error: errorResult('invalid_request', `${input.name} is marked required and cannot be disabled.`),
          };
        }
      }
    }
    const result = await adapter.extensions().setMcpEnabled({
      name: input.name,
      enabled: input.enabled,
      expectedRevision: input.expectedRevision,
    });
    if (!result.ok) return { ok: false, error: toErrorResult(result.error) };
    return { ok: true, data: result.value };
  }

  async checkMcpHealth(input: {
    projectId: string;
    name: string;
    expectedRevision: string;
  }): Promise<ServiceResult<McpHealthView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const adapter = this.engine.adapter();
    if (!adapter) {
      return { ok: false, error: errorResult('engine_unavailable', 'Connect the engine before checking MCP health.') };
    }
    const result = await adapter.extensions().checkMcpHealth({
      name: input.name,
      expectedRevision: input.expectedRevision,
    });
    if (!result.ok) return { ok: false, error: toErrorResult(result.error) };
    return { ok: true, data: result.value };
  }
}

function sameWorkspace(left: string, right: string): boolean {
  return normalizeWorkspace(left).toLowerCase() === normalizeWorkspace(right).toLowerCase();
}

function normalizeWorkspace(value: string): string {
  return value.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
}

function unavailableSections(note: string): {
  mcp: McpSection;
  skills: SkillSection;
  plugins: PluginSection;
  hooks: HookSection;
  instructions: InstructionSection;
} {
  return {
    mcp: { status: 'unavailable', note, revision: null, servers: [] },
    skills: { status: 'unavailable', note, directories: [], warnings: [], skills: [] },
    plugins: {
      status: 'unavailable',
      note,
      workspace: null,
      plugins: [],
      registryDiagnostics: [],
      validationClean: false,
    },
    hooks: { status: 'unavailable', note, workspace: null, enabled: false, hooks: [], problems: [] },
    instructions: {
      status: 'unavailable',
      note,
      workspace: null,
      sources: [],
      foreignImports: [],
      generatedFallback: false,
      aggregateBudgetBytes: 0,
      warnings: [],
    },
  };
}

function disconnectedView(input: {
  capturedAt: string;
  engineState: string;
  workspace: string | null;
  note: string;
}): ExtensionsView {
  const counts: ExtensionCounts = {
    mcpServers: 0,
    mcpEnabled: 0,
    skills: 0,
    plugins: 0,
    hooks: 0,
    instructionsLoaded: 0,
  };
  const sections = unavailableSections(input.note);
  return {
    connected: false,
    capturedAt: input.capturedAt,
    workspace: input.workspace,
    engineState: input.engineState,
    ...sections,
    counts,
    scopes: [...EXTENSION_SCOPE_NOTES],
    caveats: [input.note],
  };
}
