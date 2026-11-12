import { z } from 'zod';

/**
 * Capability explorer vocabulary. Rows come from the repository's capability
 * ledger, which is a static, versioned inventory; live identity and capability
 * flags come from the running engine. The two are kept separate so a stale
 * ledger can never be presented as live support.
 */

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');
const BoundedText = (max: number) => z.string().max(max);

export const CAPABILITY_STATUSES = [
  'qualified',
  'read-qualified',
  'discovered',
  'unavailable-by-choice',
  'unavailable-on-platform',
  'blocked',
  'unknown',
] as const;
export const CapabilityStatus = z.enum(CAPABILITY_STATUSES);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const INTEGRATION_LABELS = [
  'Native view',
  'Advanced action',
  'Integrated terminal',
  'Unavailable',
  'Blocked integration gap',
] as const;
export const IntegrationLabel = z.enum(INTEGRATION_LABELS);
export type IntegrationLabel = z.infer<typeof IntegrationLabel>;

export const CapabilityUpstream = z
  .object({
    name: BoundedText(200),
    surface: BoundedText(80),
    source: BoundedText(500),
    version: BoundedText(120),
  })
  .strict();
export type CapabilityUpstream = z.infer<typeof CapabilityUpstream>;

export const CapabilityEvidenceRef = z
  .object({
    helpCapture: BoundedText(500).nullable(),
    capturedAt: BoundedText(80).nullable(),
    contractReport: BoundedText(500).nullable(),
  })
  .strict();
export type CapabilityEvidenceRef = z.infer<typeof CapabilityEvidenceRef>;

export const CapabilityRow = z
  .object({
    id: z.string().min(1).max(40),
    upstream: CapabilityUpstream,
    platform: BoundedText(80),
    kind: BoundedText(80),
    permissionImplications: BoundedText(1_000),
    costImplications: BoundedText(200),
    requiredArguments: BoundedText(500),
    integration: IntegrationLabel,
    uiLocation: BoundedText(300),
    tests: z.array(BoundedText(500)).max(100),
    status: CapabilityStatus,
    gap: BoundedText(2_000).nullable(),
    evidence: CapabilityEvidenceRef,
  })
  .strict();
export type CapabilityRow = z.infer<typeof CapabilityRow>;

export const CapabilityCoverage = z
  .object({
    total: z.number().int().nonnegative(),
    qualified: z.number().int().nonnegative(),
    readQualified: z.number().int().nonnegative(),
    discovered: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    nativeView: z.number().int().nonnegative(),
    advancedAction: z.number().int().nonnegative(),
    integratedTerminal: z.number().int().nonnegative(),
    unavailableSurface: z.number().int().nonnegative(),
    blockedGap: z.number().int().nonnegative(),
    verifiedEntryPoints: z.number().int().nonnegative(),
    discoveredOnly: z.number().int().nonnegative(),
    completenessPercent: z.number().int().min(0).max(100),
    note: BoundedText(500),
  })
  .strict();
export type CapabilityCoverage = z.infer<typeof CapabilityCoverage>;

export const CapabilityEngineIdentity = z
  .object({
    connected: z.boolean(),
    version: BoundedText(80).nullable(),
    commit: BoundedText(80).nullable(),
    apiVersion: BoundedText(40).nullable(),
    bindHost: BoundedText(120).nullable(),
    port: z.number().int().nonnegative().nullable(),
    authRequired: z.boolean().nullable(),
    pid: z.number().int().positive().nullable(),
    startedAt: BoundedText(80).nullable(),
    uptimeSeconds: z.number().nonnegative().nullable(),
    executable: BoundedText(1_000).nullable(),
    ledgerVersion: BoundedText(80).nullable(),
    ledgerCommit: BoundedText(80).nullable(),
    compatibility: z.enum(['qualified', 'compatible_unqualified', 'unsupported', 'unknown']),
    drift: z.enum(['none', 'version', 'commit', 'unknown']),
    driftDetail: BoundedText(600),
    capturedAt: Timestamp,
  })
  .strict();
export type CapabilityEngineIdentity = z.infer<typeof CapabilityEngineIdentity>;

export const LiveCapabilityFlag = z
  .object({
    name: BoundedText(120),
    value: z.boolean(),
  })
  .strict();
export type LiveCapabilityFlag = z.infer<typeof LiveCapabilityFlag>;

export const TerminalFlags = z
  .object({
    stream: z.boolean().nullable(),
    input: z.boolean().nullable(),
    resize: z.boolean().nullable(),
    kill: z.boolean().nullable(),
  })
  .strict();
export type TerminalFlags = z.infer<typeof TerminalFlags>;

export const TerminalAvailability = z
  .object({
    supported: z.boolean().nullable(),
    status: z.enum(['available', 'unavailable', 'unknown']),
    flags: TerminalFlags,
    route: BoundedText(300),
    reason: BoundedText(1_000),
    checkedAt: Timestamp.nullable(),
  })
  .strict();
export type TerminalAvailability = z.infer<typeof TerminalAvailability>;

export const TerminalCheck = z
  .object({
    supported: z.boolean(),
    status: z.enum(['available', 'unavailable', 'unknown']),
    statusCode: z.number().int().min(100).max(599).nullable(),
    message: BoundedText(2_000),
    checkedAt: Timestamp,
  })
  .strict();
export type TerminalCheck = z.infer<typeof TerminalCheck>;

export const LogFile = z
  .object({
    name: BoundedText(300),
    size: z.number().int().nonnegative(),
    modifiedAt: BoundedText(80).nullable(),
  })
  .strict();
export type LogFile = z.infer<typeof LogFile>;

export const LogSource = z
  .object({
    dir: BoundedText(2_000),
    files: z.array(LogFile).max(500),
  })
  .strict();
export type LogSource = z.infer<typeof LogSource>;

export const LogCatalog = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    note: BoundedText(1_000).nullable(),
    sources: z.array(LogSource).max(20),
  })
  .strict();
export type LogCatalog = z.infer<typeof LogCatalog>;

export const LogContent = z
  .object({
    name: BoundedText(300),
    size: z.number().int().nonnegative(),
    modifiedAt: BoundedText(80).nullable(),
    offset: z.number().int().nonnegative(),
    requestedLimit: z.number().int().positive(),
    bytes: z.number().int().nonnegative(),
    content: BoundedText(70_000),
    truncated: z.boolean(),
    redacted: z.boolean(),
    readAt: Timestamp,
  })
  .strict();
export type LogContent = z.infer<typeof LogContent>;

export const CapabilityPaletteItem = z
  .object({
    id: z.string().min(1).max(80),
    label: BoundedText(240),
    hint: BoundedText(300),
    status: CapabilityStatus,
    integration: IntegrationLabel,
  })
  .strict();
export type CapabilityPaletteItem = z.infer<typeof CapabilityPaletteItem>;

export const CapabilityExplorerView = z
  .object({
    connected: z.boolean(),
    capturedAt: Timestamp,
    ledgerPath: BoundedText(2_000).nullable(),
    identity: CapabilityEngineIdentity,
    coverage: CapabilityCoverage,
    rows: z.array(CapabilityRow).max(2_000),
    liveFlags: z.array(LiveCapabilityFlag).max(200),
    terminal: TerminalAvailability,
    logs: LogCatalog,
    palette: z.array(CapabilityPaletteItem).max(2_000),
    caveats: z.array(BoundedText(600)).max(50),
  })
  .strict();
export type CapabilityExplorerView = z.infer<typeof CapabilityExplorerView>;

/** The ledger shape Mona reads. Unknown top-level keys are preserved, not interpreted. */
export const CapabilityLedgerRow = z
  .object({
    id: z.string().min(1),
    upstream: z.object({
      name: z.string().optional(),
      surface: z.string().optional(),
      source: z.string().optional(),
      version: z.string().optional(),
    }),
    platform: z.string().optional(),
    class: z.string().optional(),
    permission_implications: z.string().optional(),
    cost_implications: z.string().optional(),
    required_arguments: z.string().optional(),
    chosen_integration: z.string().optional(),
    ui_location: z.string().optional(),
    tests: z.array(z.string()).optional(),
    status: z.string().optional(),
    gap: z.string().nullable().optional(),
    evidence: z
      .object({
        help_capture: z.string().nullable().optional(),
        captured_utc: z.string().nullable().optional(),
        contract_report: z.string().nullable().optional(),
      })
      .optional(),
  })
  .passthrough();
export type CapabilityLedgerRow = z.infer<typeof CapabilityLedgerRow>;

export const CapabilityLedger = z
  .object({
    schema_version: z.number().optional(),
    captured_utc: z.string().optional(),
    engine: z
      .object({
        version: z.string().optional(),
        commit: z.string().optional(),
        platform: z.string().optional(),
      })
      .passthrough()
      .optional(),
    coverage_notes: z.record(z.string(), z.unknown()).optional(),
    inventory_scope: z.string().optional(),
    rows: z.array(CapabilityLedgerRow),
  })
  .passthrough();
export type CapabilityLedger = z.infer<typeof CapabilityLedger>;
