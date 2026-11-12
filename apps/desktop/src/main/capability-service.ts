import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CapabilityExplorerView,
  CapabilityLedger,
  errorResult,
  type CapabilityCoverage,
  type CapabilityLedgerRow,
  type CapabilityPaletteItem,
  type CapabilityRow,
  type CapabilityStatus,
  type CapabilityEngineIdentity,
  type IntegrationLabel,
  type LiveCapabilityFlag,
  type LogContent,
  type TerminalAvailability,
  type TerminalCheck,
} from '@mona/contracts';
import { toErrorResult, type EngineAdapter } from '@mona/adapter';
import type { EngineSummary } from './engine-host.js';

export type CapabilitiesEnginePort = {
  summary(): EngineSummary;
  adapter(): EngineAdapter | null;
};

export type CapabilityServiceDeps = {
  engine: CapabilitiesEnginePort;
  ledgerPath?: string;
  now?: () => Date;
};

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
type ServiceResult<T> = Success<T> | Failure;

const KNOWN_STATUSES: ReadonlySet<CapabilityStatus> = new Set([
  'qualified',
  'read-qualified',
  'discovered',
  'unavailable-by-choice',
  'unavailable-on-platform',
  'blocked',
  'unknown',
]);
const KNOWN_INTEGRATIONS: ReadonlySet<IntegrationLabel> = new Set([
  'Native view',
  'Advanced action',
  'Integrated terminal',
  'Unavailable',
  'Blocked integration gap',
]);

/**
 * The capability explorer joins the static ledger with the live engine. The
 * ledger is a repository document: it is read, validated and shown, never
 * treated as proof that a row currently works. Live flags and version drift are
 * reported separately so an upgraded engine cannot inherit a stale claim.
 */
export class CapabilityService {
  private readonly engine: CapabilitiesEnginePort;
  private readonly ledgerPath: string | undefined;
  private readonly now: () => Date;

  constructor(deps: CapabilityServiceDeps) {
    this.engine = deps.engine;
    this.ledgerPath = deps.ledgerPath;
    this.now = deps.now ?? (() => new Date());
  }

  async view(): Promise<ServiceResult<CapabilityExplorerView>> {
    const capturedAt = this.now().toISOString();
    const ledgerPath = await resolveLedgerPath(this.ledgerPath);
    if (!ledgerPath) {
      return {
        ok: false,
        error: errorResult(
          'not_found',
          'The capability ledger is missing. Rebuild the desktop app or set MONA_CAPABILITY_LEDGER.',
        ),
      };
    }
    const ledger = await this.readLedger(ledgerPath);
    if (!ledger.ok) return ledger;
    const caveats: string[] = [];
    const rows = ledger.value.rows.map((row) => mapRow(row, caveats));
    const summary = this.engine.summary();
    const adapter = this.engine.adapter();
    const identity = await this.identity({
      capturedAt,
      ledger,
      summary,
      adapter,
    });
    if (identity.drift === 'version' || identity.drift === 'commit') caveats.push(identity.driftDetail);
    const liveFlags = await this.liveFlags(adapter);
    const terminal = terminalAvailability(liveFlags, Boolean(adapter), capturedAt);
    if (terminal.status === 'unavailable') caveats.push(terminal.reason);
    const logs = adapter
      ? await adapter.diagnostics().listLogs()
      : {
          ok: true as const,
          value: { status: 'unavailable' as const, note: 'The engine is not connected.', sources: [] },
        };
    if (!logs.ok) {
      caveats.push(logs.error.message);
    } else if (logs.value.status === 'unavailable' && logs.value.note) {
      caveats.push(logs.value.note);
    }
    const coverage = computeCoverage(rows);
    if (coverage.discoveredOnly > 0) {
      caveats.push(
        `${coverage.discoveredOnly} row(s) are discovered-only: their help or route is recorded, but no tested entry point is claimed.`,
      );
    }
    const palette: CapabilityPaletteItem[] = rows.map((row) => ({
      id: `capability:${row.id}`,
      label: `${row.upstream.name || row.id} — ${row.status}`,
      hint: `${row.upstream.surface} · ${row.uiLocation}`,
      status: row.status,
      integration: row.integration,
    }));
    return {
      ok: true,
      data: CapabilityExplorerView.parse({
        connected: adapter !== null,
        capturedAt,
        ledgerPath,
        identity,
        coverage,
        rows,
        liveFlags,
        terminal,
        logs: logs.ok ? logs.value : { status: 'unavailable', note: logs.error.message, sources: [] },
        palette,
        caveats,
      }),
    };
  }

  async readLog(input: { name: string; offset?: number; limit?: number }): Promise<ServiceResult<LogContent>> {
    const adapter = this.engine.adapter();
    if (!adapter) {
      return { ok: false, error: errorResult('engine_unavailable', 'Connect the engine before reading its logs.') };
    }
    const result = await adapter.diagnostics().readLog(input);
    if (!result.ok) return { ok: false, error: toErrorResult(result.error) };
    return { ok: true, data: result.value };
  }

  async checkTerminal(): Promise<ServiceResult<TerminalCheck>> {
    const adapter = this.engine.adapter();
    if (!adapter) {
      return {
        ok: false,
        error: errorResult('engine_unavailable', 'Connect the engine before checking its terminal route.'),
      };
    }
    const result = await adapter.diagnostics().checkTerminal();
    if (!result.ok) return { ok: false, error: toErrorResult(result.error) };
    return { ok: true, data: result.value };
  }

  private async readLedger(
    ledgerPath: string,
  ): Promise<{ ok: true; value: CapabilityLedger } | { ok: false; error: ReturnType<typeof errorResult> }> {
    let text: string;
    try {
      text = await readFile(ledgerPath, 'utf8');
    } catch (error) {
      return {
        ok: false,
        error: errorResult('not_found', `The capability ledger could not be read: ${String(error).slice(0, 200)}`),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: errorResult('schema_drift', 'The capability ledger is not valid JSON.') };
    }
    const ledger = CapabilityLedger.safeParse(parsed);
    if (!ledger.success) {
      return {
        ok: false,
        error: errorResult('schema_drift', 'The capability ledger did not match the expected schema.'),
      };
    }
    return { ok: true, value: ledger.data };
  }

  private async identity(input: {
    capturedAt: string;
    ledger: { ok: true; value: CapabilityLedger };
    summary: EngineSummary;
    adapter: EngineAdapter | null;
  }): Promise<CapabilityEngineIdentity> {
    const ledgerVersion = input.ledger.value.engine?.version ?? null;
    const ledgerCommit = input.ledger.value.engine?.commit ?? null;
    const compatibility =
      input.summary.compatibility === 'qualified' ||
      input.summary.compatibility === 'compatible_unqualified' ||
      input.summary.compatibility === 'unsupported'
        ? input.summary.compatibility
        : input.summary.compatibility === null
          ? 'unknown'
          : 'unknown';
    if (!input.adapter) {
      return {
        connected: false,
        version: null,
        commit: null,
        apiVersion: null,
        bindHost: null,
        port: null,
        authRequired: null,
        pid: null,
        startedAt: null,
        uptimeSeconds: null,
        executable: null,
        ledgerVersion,
        ledgerCommit,
        compatibility,
        drift: 'unknown',
        driftDetail: 'The engine is not connected, so the ledger cannot be compared with a live version.',
        capturedAt: input.capturedAt,
      };
    }
    const diagnostics = input.adapter.diagnostics();
    const info = await diagnostics.runtimeInfo();
    const processInfo = await diagnostics.processInfo();
    const version = info.ok ? (info.value.version ?? null) : null;
    const commit = info.ok ? (info.value.commit ?? null) : null;
    const drift = driftFor(version, commit, ledgerVersion, ledgerCommit);
    return {
      connected: true,
      version,
      commit,
      apiVersion: info.ok ? info.value.apiVersion : null,
      bindHost: info.ok ? info.value.bindHost : null,
      port: info.ok ? info.value.port : null,
      authRequired: info.ok ? info.value.authRequired : null,
      pid: processInfo.ok ? processInfo.value.pid : null,
      startedAt: processInfo.ok ? processInfo.value.startedAt : null,
      uptimeSeconds: processInfo.ok ? processInfo.value.uptimeSeconds : null,
      executable: processInfo.ok ? processInfo.value.executable : null,
      ledgerVersion,
      ledgerCommit,
      compatibility,
      drift: drift.kind,
      driftDetail: drift.detail,
      capturedAt: input.capturedAt,
    };
  }

  private async liveFlags(adapter: EngineAdapter | null): Promise<LiveCapabilityFlag[]> {
    if (!adapter) return [];
    const info = await adapter.diagnostics().runtimeInfo();
    if (!info.ok) return [];
    return Object.entries(info.value.capabilities)
      .map(([name, value]) => ({ name, value: value === true }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

function mapRow(row: CapabilityLedgerRow, caveats: string[]): CapabilityRow {
  const status = (KNOWN_STATUSES.has(row.status as CapabilityStatus) ? row.status : 'unknown') as CapabilityStatus;
  const integration = (
    KNOWN_INTEGRATIONS.has(row.chosen_integration as IntegrationLabel)
      ? row.chosen_integration
      : 'Blocked integration gap'
  ) as IntegrationLabel;
  if (status === 'unknown') caveats.push(`${row.id} has an unrecognized ledger status and is shown as unknown.`);
  if (integration === 'Blocked integration gap' && row.chosen_integration && row.chosen_integration !== integration) {
    caveats.push(`${row.id} has an unrecognized integration label and is shown as a blocked gap.`);
  }
  return {
    id: row.id,
    upstream: {
      name: row.upstream.name ?? row.id,
      surface: row.upstream.surface ?? 'unknown',
      source: row.upstream.source ?? 'unknown',
      version: row.upstream.version ?? 'unknown',
    },
    platform: row.platform ?? 'unknown',
    kind: row.class ?? 'unknown',
    permissionImplications: row.permission_implications ?? 'not recorded',
    costImplications: row.cost_implications ?? 'unknown',
    requiredArguments: row.required_arguments ?? 'not recorded',
    integration,
    uiLocation: row.ui_location ?? 'not recorded',
    tests: (row.tests ?? []).slice(0, 100),
    status,
    gap: row.gap ?? null,
    evidence: {
      helpCapture: row.evidence?.help_capture ?? null,
      capturedAt: row.evidence?.captured_utc ?? null,
      contractReport: row.evidence?.contract_report ?? null,
    },
  };
}

function computeCoverage(rows: CapabilityRow[]): CapabilityCoverage {
  const count = (predicate: (row: CapabilityRow) => boolean): number => rows.filter(predicate).length;
  const qualified = count((row) => row.status === 'qualified');
  const readQualified = count((row) => row.status === 'read-qualified');
  const discovered = count((row) => row.status === 'discovered');
  const unavailable = count(
    (row) => row.status === 'unavailable-by-choice' || row.status === 'unavailable-on-platform',
  );
  const blocked = count((row) => row.status === 'blocked');
  const unknown = count((row) => row.status === 'unknown');
  const verifiedEntryPoints = qualified + readQualified;
  return {
    total: rows.length,
    qualified,
    readQualified,
    discovered,
    unavailable,
    blocked,
    unknown,
    nativeView: count((row) => row.integration === 'Native view'),
    advancedAction: count((row) => row.integration === 'Advanced action'),
    integratedTerminal: count((row) => row.integration === 'Integrated terminal'),
    unavailableSurface: count((row) => row.integration === 'Unavailable'),
    blockedGap: count((row) => row.integration === 'Blocked integration gap'),
    verifiedEntryPoints,
    discoveredOnly: discovered,
    completenessPercent: rows.length === 0 ? 0 : Math.round((verifiedEntryPoints / rows.length) * 100),
    note: 'Verified entry points are qualified plus read-qualified rows. Discovered rows have recorded help or routes but no tested entry point. Unavailable rows stay visible with their reason. This is catalog coverage, not a parity claim.',
  };
}

function driftFor(
  version: string | null,
  commit: string | null,
  ledgerVersion: string | null,
  ledgerCommit: string | null,
): { kind: 'none' | 'version' | 'commit' | 'unknown'; detail: string } {
  if (!version || !commit) {
    return {
      kind: 'unknown',
      detail: 'The running engine did not report both its version and commit, so drift cannot be judged.',
    };
  }
  if (!ledgerVersion || !ledgerCommit) {
    return { kind: 'unknown', detail: 'The capability ledger does not record a pinned version and commit.' };
  }
  if (version !== ledgerVersion) {
    return {
      kind: 'version',
      detail: `The running engine is ${version} (${commit.slice(0, 12)}); the ledger was captured on ${ledgerVersion} (${ledgerCommit.slice(0, 12)}). Unverified rows must not be relied on.`,
    };
  }
  if (commit !== ledgerCommit) {
    return {
      kind: 'commit',
      detail: `The running engine reports commit ${commit.slice(0, 12)}; the ledger was captured on ${ledgerCommit.slice(0, 12)} at the same version. Treat rows without live evidence as unverified.`,
    };
  }
  return { kind: 'none', detail: 'The running engine matches the ledger version and commit.' };
}

function terminalAvailability(
  flags: LiveCapabilityFlag[],
  connected: boolean,
  capturedAt: string,
): TerminalAvailability {
  const flag = (name: string): boolean | null => {
    const found = flags.find((entry) => entry.name === name);
    return found === undefined ? null : found.value;
  };
  const values = {
    stream: flag('terminal_stream'),
    input: flag('terminal_input'),
    resize: flag('terminal_resize'),
    kill: flag('terminal_kill'),
  };
  if (!connected) {
    return {
      supported: null,
      status: 'unknown',
      flags: values,
      route: '/v1/terminal/{name}',
      reason: 'The engine is not connected, so terminal capability flags could not be read.',
      checkedAt: null,
    };
  }
  const advertised = Object.values(values).filter((value) => value !== null);
  if (advertised.length === 0) {
    return {
      supported: null,
      status: 'unknown',
      flags: values,
      route: '/v1/terminal/{name}',
      reason: 'The engine did not report terminal capability flags on this build.',
      checkedAt: null,
    };
  }
  const supported = advertised.every((value) => value === true);
  return {
    supported,
    status: supported ? 'available' : 'unavailable',
    flags: values,
    route: '/v1/terminal/{name}',
    reason: supported
      ? 'The engine advertises terminal stream, input, resize and kill. Use the explicit route check before relying on a session.'
      : 'The engine reports terminal_stream, terminal_input, terminal_resize and terminal_kill as false. Its terminal route is not advertised on this build; Mona does not fake a PTY.',
    checkedAt: capturedAt,
  };
}

async function resolveLedgerPath(explicit: string | undefined): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.MONA_CAPABILITY_LEDGER,
    (process as typeof process & { resourcesPath?: string }).resourcesPath
      ? path.join((process as typeof process & { resourcesPath: string }).resourcesPath, 'capabilities.json')
      : undefined,
    path.join(here, '..', 'resources', 'capabilities.json'),
    path.join(here, '..', '..', '..', '..', 'docs', 'codewhale-capabilities.json'),
    path.join(process.cwd(), 'docs', 'codewhale-capabilities.json'),
    path.join(process.cwd(), '..', '..', 'docs', 'codewhale-capabilities.json'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
