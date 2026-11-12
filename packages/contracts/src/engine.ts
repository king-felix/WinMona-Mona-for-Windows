import { z } from 'zod';
import { ThreadId } from './ids.js';

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');

/** Loopback-only runtime binding; Mona never connects to a remote runtime by default. */
export const LoopbackBaseUrl = z
  .string()
  .refine((value) => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value), 'runtime base URL must be loopback HTTP');

export const EngineIdentity = z
  .object({
    product: z.literal('Codewhale'),
    version: z.string().min(1),
    commit: z.string().min(7),
    runtimeApiVersion: z.string().min(1),
    baseUrl: LoopbackBaseUrl,
    pid: z.number().int().positive(),
    workspace: z.string().min(1),
    startedAt: Timestamp,
  })
  .strict();
export type EngineIdentity = z.infer<typeof EngineIdentity>;

/**
 * Capability flags observed through GET /v1/runtime/info. `false` means the
 * pinned build did not advertise the capability; it is never rendered as if it
 * were supported.
 */
export const EngineCapabilities = z
  .object({
    threads: z.boolean(),
    turns: z.boolean(),
    threadCreateIdempotency: z.boolean(),
    turnOperationIdempotency: z.boolean(),
    turnOperationLookup: z.boolean(),
    eventReplay: z.boolean(),
    eventStreamResume: z.boolean(),
    turnInterrupt: z.boolean(),
    turnSteer: z.boolean(),
    fleetEventStream: z.boolean(),
    memory: z.boolean(),
    mcpServerManagement: z.boolean(),
    skillLifecycle: z.boolean(),
    pluginManagement: z.boolean(),
    agentMail: z.boolean(),
    terminalStream: z.boolean(),
    terminalInput: z.boolean(),
    terminalResize: z.boolean(),
    terminalKill: z.boolean(),
  })
  .strict();
export type EngineCapabilities = z.infer<typeof EngineCapabilities>;

export const PermissionPosture = z.enum(['full_access', 'workspace_write', 'read_only', 'unknown']);
export type PermissionPosture = z.infer<typeof PermissionPosture>;

export const EngineMode = z.enum(['agent', 'plan']);
export type EngineMode = z.infer<typeof EngineMode>;

/**
 * The effective profile a thread actually runs with. Requested settings from a
 * UI form are a different type; this one is only built from an observed thread
 * record and is what Mona displays.
 */
export const EffectiveProfile = z
  .object({
    threadId: ThreadId,
    workspace: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    mode: EngineMode,
    permissionPosture: PermissionPosture,
    allowShell: z.boolean(),
    trustMode: z.boolean(),
    autoApprove: z.boolean(),
    observedAt: Timestamp,
  })
  .strict();
export type EffectiveProfile = z.infer<typeof EffectiveProfile>;

/** A capability either works on the pinned build, or carries a typed reason it cannot. */
export const CapabilityState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('supported') }).strict(),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('unverified'), reason: z.string().min(1) }).strict(),
]);
export type CapabilityState = z.infer<typeof CapabilityState>;
