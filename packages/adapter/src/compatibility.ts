import { z } from 'zod';
import { EngineCapabilities, EngineIdentity, type CapabilityState } from '@mona/contracts';
import { fail, ok, type Result } from './errors.js';

export const PINNED_ENGINE = {
  version: '0.10.2',
  commit: 'ff466b2ed0bf',
  runtimeApiVersion: '1.0',
} as const;

export const RuntimeInfoWire = z
  .object({
    service: z.literal('codewhale-runtime-api'),
    runtime_api_version: z.string().min(1),
    codewhale_version: z.string().min(1),
    codewhale_commit: z.string().min(7),
    bind_host: z.string().optional(),
    port: z.number().int().optional(),
    auth_required: z.boolean().optional(),
    capabilities: z.record(z.string(), z.boolean()),
  })
  .passthrough();
export type RuntimeInfoWire = z.infer<typeof RuntimeInfoWire>;

const CAPABILITY_MAP = {
  threads: 'threads',
  turns: 'turns',
  thread_create_idempotency: 'threadCreateIdempotency',
  turn_operation_idempotency: 'turnOperationIdempotency',
  turn_operation_lookup: 'turnOperationLookup',
  event_replay: 'eventReplay',
  event_stream_resume: 'eventStreamResume',
  turn_interrupt: 'turnInterrupt',
  turn_steer: 'turnSteer',
  fleet_event_stream: 'fleetEventStream',
  memory: 'memory',
  mcp_server_management: 'mcpServerManagement',
  skill_lifecycle: 'skillLifecycle',
  plugin_management: 'pluginManagement',
  agent_mail: 'agentMail',
  terminal_stream: 'terminalStream',
  terminal_input: 'terminalInput',
  terminal_resize: 'terminalResize',
  terminal_kill: 'terminalKill',
} as const;

export type CapabilityKey = keyof EngineCapabilities;

export const CompatibilityStatus = z.enum(['qualified', 'compatible_unqualified', 'unsupported']);
export type CompatibilityStatus = z.infer<typeof CompatibilityStatus>;

export type CompatibilityReport = {
  status: CompatibilityStatus;
  pinnedVersion: string;
  pinnedCommit: string;
  observedVersion: string;
  observedCommit: string;
  runtimeApiVersion: string;
  reasons: string[];
  capabilityGaps: CapabilityKey[];
};

export type EngineDiscovery = {
  identity: EngineIdentity;
  capabilities: EngineCapabilities;
  report: CompatibilityReport;
};

export type DiscoveryContext = {
  baseUrl: string;
  pid: number | null;
  workspace: string | null;
  startedAt: string;
};

/** Maps observed runtime info into Mona's identity, capabilities, and compatibility policy. */
export function assessCompatibility(raw: unknown, context: DiscoveryContext): Result<EngineDiscovery> {
  const parsed = RuntimeInfoWire.safeParse(raw);
  if (!parsed.success) {
    return fail('schema_drift', 'runtime info did not match the expected 1.0 contract', {
      detail: parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')
        .slice(0, 500),
    });
  }
  const info = parsed.data;
  const reasons: string[] = [];
  const capabilityGaps: CapabilityKey[] = [];
  const capabilities: Record<string, boolean> = {};
  for (const [wireKey, monaKey] of Object.entries(CAPABILITY_MAP) as Array<[string, CapabilityKey]>) {
    const value = info.capabilities[wireKey];
    if (value === undefined) {
      reasons.push(`capability flag ${wireKey} is missing; treated as unsupported`);
      capabilities[monaKey] = false;
      capabilityGaps.push(monaKey);
    } else {
      capabilities[monaKey] = value;
      if (!value) capabilityGaps.push(monaKey);
    }
  }
  const caps = EngineCapabilities.parse(capabilities);

  let status: CompatibilityStatus;
  if (info.codewhale_version === PINNED_ENGINE.version && info.codewhale_commit.startsWith(PINNED_ENGINE.commit)) {
    status = 'qualified';
  } else if (/^0\.10\.\d+$/.test(info.codewhale_version)) {
    status = 'compatible_unqualified';
    if (info.codewhale_version !== PINNED_ENGINE.version) {
      reasons.push(`version drift: pinned ${PINNED_ENGINE.version}, observed ${info.codewhale_version}`);
    }
    if (!info.codewhale_commit.startsWith(PINNED_ENGINE.commit)) {
      reasons.push(`commit drift: pinned ${PINNED_ENGINE.commit}, observed ${info.codewhale_commit.slice(0, 12)}`);
    }
  } else {
    status = 'unsupported';
    reasons.push(`unsupported engine version ${info.codewhale_version}; qualified ${PINNED_ENGINE.version}`);
  }
  if (info.runtime_api_version !== PINNED_ENGINE.runtimeApiVersion) {
    reasons.push(`runtime API ${info.runtime_api_version} differs from qualified ${PINNED_ENGINE.runtimeApiVersion}`);
    if (status === 'qualified') status = 'compatible_unqualified';
  }
  if (status === 'qualified' && reasons.length > 0) status = 'compatible_unqualified';

  const identity = EngineIdentity.parse({
    product: 'Codewhale',
    version: info.codewhale_version,
    commit: info.codewhale_commit,
    runtimeApiVersion: info.runtime_api_version,
    baseUrl: context.baseUrl,
    pid: context.pid,
    workspace: context.workspace,
    startedAt: context.startedAt,
  });

  return ok({
    identity,
    capabilities: caps,
    report: {
      status,
      pinnedVersion: PINNED_ENGINE.version,
      pinnedCommit: PINNED_ENGINE.commit,
      observedVersion: info.codewhale_version,
      observedCommit: info.codewhale_commit,
      runtimeApiVersion: info.runtime_api_version,
      reasons,
      capabilityGaps,
    },
  });
}

export function capabilityState(discovery: EngineDiscovery, key: CapabilityKey): CapabilityState {
  if (discovery.capabilities[key]) return { status: 'supported' };
  return {
    status: 'unsupported',
    reason: `runtime ${discovery.identity.version} does not advertise ${key}`,
  };
}

export function unsupportedCapability<T>(name: string, reason: string): Result<T> {
  return fail('capability_unsupported', `${name} is not supported on this runtime`, { detail: reason });
}
