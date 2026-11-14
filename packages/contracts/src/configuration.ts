import { z } from 'zod';

/**
 * Configuration and route vocabulary. Every field is something the running
 * engine reported or a value Mona saved locally; requested and effective values
 * are separate fields so they can never be conflated in the UI.
 */

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');

export const CredentialState = z.enum(['configured', 'missing', 'login_required', 'local', 'unknown']);
export type CredentialState = z.infer<typeof CredentialState>;

export const EngineConfigSnapshot = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    modelAvailable: z.boolean(),
    baseUrl: z.string().max(500).nullable(),
    reasoningEffort: z.string().max(80).nullable(),
    defaultMode: z.enum(['agent', 'plan', 'operate', 'unknown']),
    approvalMode: z.string().max(80).nullable(),
    allowShell: z.boolean(),
    subagentsEnabled: z.boolean(),
    capturedAt: Timestamp,
  })
  .strict();
export type EngineConfigSnapshot = z.infer<typeof EngineConfigSnapshot>;

export const ProviderEntry = z
  .object({
    id: z.string().min(1).max(200),
    modelProviderId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    defaultModel: z.string().max(200),
    hasModelCatalog: z.boolean(),
    credentialState: CredentialState,
    credentialSource: z.string().max(120),
    credentialWritable: z.boolean(),
  })
  .strict();
export type ProviderEntry = z.infer<typeof ProviderEntry>;

export const ModelEntry = z
  .object({
    id: z.string().min(1).max(300),
    imageInput: z.enum(['supported', 'unsupported', 'unknown']),
    outputTokenLimit: z.enum(['supported', 'unsupported', 'unknown']),
    reasoningEffort: z.enum(['supported', 'unsupported', 'unknown']),
    reasoningLevels: z.array(z.string().max(80)),
    reasoningSource: z.string().max(120).nullable(),
    contextTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    pricingStatus: z.string().max(120).nullable(),
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ReasoningControl = z
  .object({
    supported: z.boolean(),
    levels: z.array(z.string().max(80)),
    source: z.string().max(120).nullable(),
    note: z.string().max(400),
  })
  .strict();
export type ReasoningControl = z.infer<typeof ReasoningControl>;

export const RouteRequested = z
  .object({
    provider: z.string().min(1).max(200).nullable(),
    model: z.string().min(1).max(300).nullable(),
    source: z.enum(['engine_config', 'saved_default', 'unknown']),
  })
  .strict();
export type RouteRequested = z.infer<typeof RouteRequested>;

export const RouteEffective = z
  .object({
    threadId: z.string().min(1).nullable(),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    mode: z.enum(['agent', 'plan']).nullable(),
    permissionPosture: z.enum(['full_access', 'workspace_write', 'ask', 'read_only', 'unknown']),
    observedAt: Timestamp,
  })
  .strict();
export type RouteEffective = z.infer<typeof RouteEffective>;

export const SavedRouteDefault = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    revision: z.string().min(1).max(120),
    updatedAt: Timestamp,
    source: z.literal('mona_settings'),
  })
  .strict();
export type SavedRouteDefault = z.infer<typeof SavedRouteDefault>;

export const PermissionOption = z
  .object({
    value: z.enum(['ask', 'auto-review', 'full-access']),
    label: z.string().min(1).max(80),
    description: z.string().max(300),
  })
  .strict();
export type PermissionOption = z.infer<typeof PermissionOption>;

export const DiagnosticFinding = z
  .object({
    id: z.string().min(1).max(120),
    severity: z.enum(['info', 'warning', 'error']),
    title: z.string().min(1).max(200),
    detail: z.string().max(2_000),
  })
  .strict();
export type DiagnosticFinding = z.infer<typeof DiagnosticFinding>;

export const DIAGNOSTIC_STATUSES = [
  'healthy',
  'missing_credential',
  'invalid_endpoint',
  'unreachable',
  'unknown',
] as const;
export const DiagnosticStatus = z.enum(DIAGNOSTIC_STATUSES);
export type DiagnosticStatus = z.infer<typeof DiagnosticStatus>;

export const ConnectionDiagnostics = z
  .object({
    status: DiagnosticStatus,
    checkedAt: Timestamp,
    /** False: Mona never performs a paid provider probe from this view. */
    probed: z.literal(false),
    credentialState: CredentialState,
    endpoint: z.string().max(500).nullable(),
    findings: z.array(DiagnosticFinding),
    redactedText: z.string().max(20_000),
  })
  .strict();
export type ConnectionDiagnostics = z.infer<typeof ConnectionDiagnostics>;

export const ProviderWorkbenchView = z
  .object({
    connected: z.boolean(),
    capturedAt: Timestamp,
    providers: z.array(ProviderEntry),
    selectedProviderId: z.string().min(1).max(200).nullable(),
    models: z.array(ModelEntry),
    requested: RouteRequested,
    effective: RouteEffective,
    savedDefault: SavedRouteDefault.nullable(),
    reasoning: ReasoningControl,
    permissions: z.array(PermissionOption),
    maxWorkers: z.number().int().min(1).max(8),
    configRevision: z.string().min(1).max(128),
    diagnostics: ConnectionDiagnostics,
    caveats: z.array(z.string().max(500)),
  })
  .strict();
export type ProviderWorkbenchView = z.infer<typeof ProviderWorkbenchView>;

export const SettingsChangeReceipt = z
  .object({
    scope: z.literal('new_threads'),
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(300),
    configPath: z.string().min(1).max(1_000),
    backupPath: z.string().max(1_000).nullable(),
    previousHash: z.string().max(128),
    newHash: z.string().max(128),
    expectedRevision: z.string().min(1).max(128),
    verified: z.boolean(),
    appliedAt: Timestamp,
    activeThreadUnchanged: z.literal(true),
  })
  .strict();
export type SettingsChangeReceipt = z.infer<typeof SettingsChangeReceipt>;

export const ConfigurationChangeReceipt = z
  .object({
    scope: z.literal('new_threads'),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    configPath: z.string().min(1).max(1_000),
    backupPath: z.string().max(1_000).nullable(),
    previousHash: z.string().max(128),
    newHash: z.string().max(128),
    expectedRevision: z.string().min(1).max(128),
    verified: z.boolean(),
    appliedAt: Timestamp,
    activeThreadUnchanged: z.literal(true),
  })
  .strict();
export type ConfigurationChangeReceipt = z.infer<typeof ConfigurationChangeReceipt>;

/** The permission choices the engine reports for new sessions. */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  {
    value: 'ask',
    label: 'Ask',
    description: 'Ask before tools that can make consequential changes.',
  },
  {
    value: 'auto-review',
    label: 'Auto-Review',
    description: 'Review tool risk automatically and ask when a decision needs you.',
  },
  {
    value: 'full-access',
    label: 'Full Access',
    description: 'Run tools without approval prompts; workspace rules still apply.',
  },
];

/** Explanation used whenever the selected model exposes no reasoning levels. */
export const NO_ROUTE_REASONING =
  'This route reports no supported reasoning levels, so Mona offers no reasoning control. It sends none.';
