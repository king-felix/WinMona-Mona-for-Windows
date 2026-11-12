import { z } from 'zod';

/**
 * Extension vocabulary. Every field here was observed on the pinned runtime
 * (0.10.2, ff466b2ed0bf) or is a value Mona derives locally from that report.
 * Sections carry their own status so "none configured" can never be confused
 * with "the runtime did not answer".
 */

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');
const BoundedText = (max: number) => z.string().max(max);
const ShortName = z.string().min(1).max(200);
const PathText = z.string().max(2_000);

export const EXTENSION_ORIGINS = ['global', 'project', 'plugin', 'builtin', 'unknown'] as const;
export const ExtensionOrigin = z.enum(EXTENSION_ORIGINS);
export type ExtensionOrigin = z.infer<typeof ExtensionOrigin>;

export const SectionStatus = z.enum(['ok', 'unavailable']);
export type SectionStatus = z.infer<typeof SectionStatus>;

export const McpTransport = z.enum(['stdio', 'http', 'sse', 'unknown']);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpServerEntry = z
  .object({
    name: ShortName,
    origin: z.enum(['global', 'project', 'unknown']),
    writable: z.boolean(),
    authRequired: z.boolean(),
    enabled: z.boolean(),
    required: z.boolean(),
    command: BoundedText(1_000).nullable(),
    argumentCount: z.number().int().nonnegative(),
    url: BoundedText(1_000).nullable(),
    transport: McpTransport,
    connected: z.boolean(),
    credentialConfigured: z.boolean(),
    enabledTools: z.array(ShortName).max(500),
    disabledTools: z.array(ShortName).max(500),
    envKeys: z.array(ShortName).max(100),
    scopes: z.array(BoundedText(200)).max(50),
    detailAvailable: z.boolean(),
    detailNote: BoundedText(500).nullable(),
  })
  .strict();
export type McpServerEntry = z.infer<typeof McpServerEntry>;

export const McpSection = z
  .object({
    status: SectionStatus,
    note: BoundedText(2_000).nullable(),
    revision: BoundedText(200).nullable(),
    servers: z.array(McpServerEntry).max(200),
  })
  .strict();
export type McpSection = z.infer<typeof McpSection>;

export const SkillEntry = z
  .object({
    name: ShortName,
    description: BoundedText(2_000),
    path: PathText,
    source: z.enum(['native', 'plugin', 'project', 'unknown']),
    pluginId: BoundedText(300).nullable(),
    pluginGeneration: BoundedText(120).nullable(),
    pluginContentHash: BoundedText(128).nullable(),
    enabled: z.boolean(),
    bundled: z.boolean(),
    invocation: z.enum(['model+user', 'explicit-only', 'unknown']),
    aliases: z.array(ShortName).max(50),
    bundledTier: BoundedText(80).nullable(),
  })
  .strict();
export type SkillEntry = z.infer<typeof SkillEntry>;

export const SkillSection = z
  .object({
    status: SectionStatus,
    note: BoundedText(2_000).nullable(),
    directories: z.array(PathText).max(20),
    warnings: z.array(BoundedText(1_000)).max(200),
    skills: z.array(SkillEntry).max(1_000),
  })
  .strict();
export type SkillSection = z.infer<typeof SkillSection>;

export const PluginInventory = z
  .object({
    skills: z.number().int().nonnegative(),
    mcpServers: z.number().int().nonnegative(),
    stdioMcpServers: z.number().int().nonnegative(),
    remoteMcpServers: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
    lsp: z.number().int().nonnegative(),
    native: z.number().int().nonnegative(),
    filesystemRoots: z.array(BoundedText(1_000)).max(100),
    networkHosts: z.array(BoundedText(500)).max(100),
    lifecycleMutation: z.boolean(),
  })
  .strict();
export type PluginInventory = z.infer<typeof PluginInventory>;

export const PluginEntry = z
  .object({
    id: ShortName,
    name: ShortName,
    displayName: BoundedText(200),
    author: BoundedText(200),
    homepage: BoundedText(1_000).nullable(),
    version: BoundedText(80),
    description: BoundedText(2_000),
    scope: z.enum(['builtin', 'global', 'project', 'unknown']),
    origin: BoundedText(120),
    path: PathText.nullable(),
    state: BoundedText(80),
    enabled: z.boolean(),
    trustStatus: BoundedText(80),
    active: z.boolean(),
    compatibility: BoundedText(80),
    platforms: z.array(BoundedText(40)).max(20),
    inventory: PluginInventory,
    contentHash: BoundedText(128).nullable(),
    capabilityHash: BoundedText(128).nullable(),
    stateGeneration: z.number().int().nonnegative(),
    diagnostics: z.array(BoundedText(1_000)).max(100),
  })
  .strict();
export type PluginEntry = z.infer<typeof PluginEntry>;

export const PluginSection = z
  .object({
    status: SectionStatus,
    note: BoundedText(2_000).nullable(),
    workspace: PathText.nullable(),
    plugins: z.array(PluginEntry).max(200),
    registryDiagnostics: z.array(BoundedText(1_000)).max(100),
    validationClean: z.boolean(),
  })
  .strict();
export type PluginSection = z.infer<typeof PluginSection>;

export const HookEntry = z
  .object({
    name: BoundedText(200),
    event: BoundedText(80),
    command: BoundedText(1_000),
    background: z.boolean(),
    timeoutSecs: z.number().int().nonnegative().nullable(),
    source: z.enum(['global', 'project', 'plugin', 'unknown']),
  })
  .strict();
export type HookEntry = z.infer<typeof HookEntry>;

export const HookSection = z
  .object({
    status: SectionStatus,
    note: BoundedText(2_000).nullable(),
    workspace: PathText.nullable(),
    enabled: z.boolean(),
    hooks: z.array(HookEntry).max(500),
    problems: z.array(BoundedText(1_000)).max(200),
  })
  .strict();
export type HookSection = z.infer<typeof HookSection>;

export const InstructionSource = z
  .object({
    kind: BoundedText(40),
    status: BoundedText(40),
    scopeDir: PathText,
    path: PathText,
    relativePath: BoundedText(300).nullable(),
    exists: z.boolean(),
    bytes: z.number().int().nonnegative().nullable(),
    warning: BoundedText(1_000).nullable(),
  })
  .strict();
export type InstructionSource = z.infer<typeof InstructionSource>;

export const InstructionSection = z
  .object({
    status: SectionStatus,
    note: BoundedText(2_000).nullable(),
    workspace: PathText.nullable(),
    sources: z.array(InstructionSource).max(200),
    foreignImports: z.array(PathText).max(100),
    generatedFallback: z.boolean(),
    aggregateBudgetBytes: z.number().int().nonnegative(),
    warnings: z.array(BoundedText(1_000)).max(100),
  })
  .strict();
export type InstructionSection = z.infer<typeof InstructionSection>;

export const ExtensionCounts = z
  .object({
    mcpServers: z.number().int().nonnegative(),
    mcpEnabled: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    plugins: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
    instructionsLoaded: z.number().int().nonnegative(),
  })
  .strict();
export type ExtensionCounts = z.infer<typeof ExtensionCounts>;

export const ExtensionScopeNote = z
  .object({
    id: z.enum(['global', 'project', 'builtin']),
    label: BoundedText(80),
    detail: BoundedText(600),
  })
  .strict();
export type ExtensionScopeNote = z.infer<typeof ExtensionScopeNote>;

export const ExtensionsView = z
  .object({
    connected: z.boolean(),
    capturedAt: Timestamp,
    workspace: PathText.nullable(),
    engineState: BoundedText(40),
    mcp: McpSection,
    skills: SkillSection,
    plugins: PluginSection,
    hooks: HookSection,
    instructions: InstructionSection,
    counts: ExtensionCounts,
    scopes: z.array(ExtensionScopeNote).max(10),
    caveats: z.array(BoundedText(600)).max(50),
  })
  .strict();
export type ExtensionsView = z.infer<typeof ExtensionsView>;

export const MCP_TOOL_NAME_MAX = 500;

export const McpToolName = z
  .object({
    server: ShortName,
    name: ShortName,
    prefixedName: ShortName,
  })
  .strict();
export type McpToolName = z.infer<typeof McpToolName>;

export const McpHealthView = z
  .object({
    server: ShortName,
    connected: z.boolean(),
    authRequired: z.boolean(),
    error: BoundedText(2_000).nullable(),
    tools: z.array(McpToolName).max(MCP_TOOL_NAME_MAX),
    checkedAt: Timestamp,
    revision: BoundedText(200).nullable(),
  })
  .strict();
export type McpHealthView = z.infer<typeof McpHealthView>;

export const EXTENSION_ACTIONS = ['mcp.enable', 'mcp.disable', 'mcp.recheck'] as const;
export const ExtensionAction = z.enum(EXTENSION_ACTIONS);
export type ExtensionAction = z.infer<typeof ExtensionAction>;

export const ExtensionActionReceipt = z
  .object({
    action: ExtensionAction,
    target: ShortName,
    origin: z.enum(['global', 'project', 'unknown']),
    enabled: z.boolean().nullable(),
    connected: z.boolean().nullable(),
    verified: z.boolean(),
    previousRevision: BoundedText(200),
    revision: BoundedText(200).nullable(),
    detail: BoundedText(2_000),
    appliedAt: Timestamp,
  })
  .strict();
export type ExtensionActionReceipt = z.infer<typeof ExtensionActionReceipt>;

/**
 * Scope language shown in the UI. It states the engine's own authority: Mona
 * never enables project-supplied executable content on its own.
 */
export const EXTENSION_SCOPE_NOTES: readonly ExtensionScopeNote[] = [
  {
    id: 'global',
    label: 'Global',
    detail:
      'Applies to every project and new session on this machine. Global MCP servers live in the engine’s own mcp.json.',
  },
  {
    id: 'project',
    label: 'Project',
    detail:
      'Applies to this workspace only. The engine loads project instructions, hooks and servers only after its own review or trust step; Mona does not approve them for you.',
  },
  {
    id: 'builtin',
    label: 'Bundled',
    detail:
      'Ships with the pinned engine or a reviewed plugin snapshot. Mona reports the engine’s state and never edits the reviewed bytes.',
  },
];
