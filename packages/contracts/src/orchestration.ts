import { z } from 'zod';
import { CostEvidence } from './events.js';

/**
 * Renderer-facing native orchestration vocabulary. These are Mona's projections
 * of engine-owned records, not a second execution ledger: every value comes from
 * a runtime response or an observed event, and a missing value stays missing.
 */

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');
const TimestampOrNull = Timestamp.nullable();
const ShortText = z.string().max(2_000);

export const AgentRunUsage = z
  .object({
    status: z.enum(['reported', 'unknown']),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    costMicros: z.number().int().nonnegative().nullable(),
    note: z.string().max(500).nullable(),
  })
  .strict();
export type AgentRunUsage = z.infer<typeof AgentRunUsage>;

export const AgentRunArtifact = z
  .object({
    kind: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    target: z.string().max(500),
    description: z.string().max(500),
  })
  .strict();
export type AgentRunArtifact = z.infer<typeof AgentRunArtifact>;

export const AgentRunEvent = z
  .object({
    seq: z.number().int().nonnegative(),
    status: z.string().min(1).max(80),
    at: Timestamp,
    message: z.string().max(500).nullable(),
  })
  .strict();
export type AgentRunEvent = z.infer<typeof AgentRunEvent>;

export const AgentRun = z
  .object({
    id: z.string().min(1),
    ownerThreadId: z.string().min(1),
    originTurnId: z.string().min(1).nullable(),
    parentRunId: z.string().min(1).nullable(),
    name: z.string().min(1).max(200),
    role: z.string().min(1).max(80),
    agentType: z.string().min(1).max(80),
    model: z.string().min(1).max(200),
    provider: z.string().min(1).max(80),
    workspace: z.string().min(1).max(1_000),
    status: z.string().min(1).max(80),
    depth: z.number().int().nonnegative(),
    objective: ShortText,
    createdAt: TimestampOrNull,
    updatedAt: TimestampOrNull,
    startedAt: TimestampOrNull,
    completedAt: TimestampOrNull,
    usage: AgentRunUsage,
    /** True when the engine reports this child's spend inside the parent thread total. */
    spendIncludedInParent: z.boolean(),
    verificationStatus: z.string().max(80).nullable(),
    verificationSummary: z.string().max(500).nullable(),
    artifacts: z.array(AgentRunArtifact),
    events: z.array(AgentRunEvent),
  })
  .strict();
export type AgentRun = z.infer<typeof AgentRun>;

export const NativeGoal = z
  .object({
    threadId: z.string().min(1),
    goalId: z.string().min(1),
    objective: z.string().max(4_000),
    status: z.string().min(1).max(80),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    continuationCount: z.number().int().nonnegative(),
    repeatedGapCount: z.number().int().nonnegative(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export type NativeGoal = z.infer<typeof NativeGoal>;

export const NativeTask = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1).max(80),
    threadId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    objective: z.string().max(2_000).nullable(),
    createdAt: TimestampOrNull,
    updatedAt: TimestampOrNull,
  })
  .strict();
export type NativeTask = z.infer<typeof NativeTask>;

export const FleetTask = z
  .object({
    taskId: z.string().min(1),
    status: z.string().min(1).max(80),
    leasedTo: z.string().min(1).nullable(),
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export type FleetTask = z.infer<typeof FleetTask>;

export const FleetWorker = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    hostKind: z.string().min(1).max(80),
    maxConcurrentTasks: z.number().int().nonnegative(),
  })
  .strict();
export type FleetWorker = z.infer<typeof FleetWorker>;

export const FleetRunCounts = z
  .object({
    runs: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    restarted: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    transportFailed: z.number().int().nonnegative(),
    taskFailed: z.number().int().nonnegative(),
    verifierFailed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  })
  .strict();
export type FleetRunCounts = z.infer<typeof FleetRunCounts>;

export const FleetRun = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    projectId: z.string().min(1).max(80).nullable(),
    lifecycleStatus: z.string().min(1).max(80),
    target: z.string().min(1).max(80),
    workflowId: z.string().min(1).max(200),
    workflowKind: z.string().min(1).max(80),
    roles: z.array(z.string().min(1).max(80)),
    taskCount: z.number().int().nonnegative(),
    workerCount: z.number().int().nonnegative(),
    maxWorkers: z.number().int().nonnegative(),
    labels: z.record(z.string(), z.string()),
    createdAt: TimestampOrNull,
    updatedAt: TimestampOrNull,
    completedAt: TimestampOrNull,
    tasks: z.array(FleetTask),
    workers: z.array(FleetWorker),
    counts: FleetRunCounts,
  })
  .strict();
export type FleetRun = z.infer<typeof FleetRun>;

export const FleetStartReceipt = z
  .object({
    action: z.string().min(1).max(80),
    execution: z.string().min(1).max(80),
    runId: z.string().min(1),
    target: z.string().max(80),
    leased: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    workerIds: z.array(z.string().min(1).max(200)),
  })
  .strict();
export type FleetStartReceipt = z.infer<typeof FleetStartReceipt>;

export const NativeControlReceipt = z
  .object({
    action: z.string().min(1).max(80),
    id: z.string().min(1).max(300),
    acknowledged: z.boolean(),
    detail: z.string().max(500),
  })
  .strict();
export type NativeControlReceipt = z.infer<typeof NativeControlReceipt>;

export const FleetGovernor = z
  .object({
    launchSlots: z.number().int().nonnegative(),
    maxLaunchSlots: z.number().int().nonnegative(),
    paused: z.boolean(),
    recentRateLimits: z.number().int().nonnegative(),
  })
  .strict();
export type FleetGovernor = z.infer<typeof FleetGovernor>;

export const OrchestrationSnapshot = z
  .object({
    capturedAt: Timestamp,
    threadId: z.string().min(1).nullable(),
    goals: z.array(NativeGoal),
    tasks: z.array(NativeTask),
    agentRuns: z.array(AgentRun),
    fleetRuns: z.array(FleetRun),
    governor: FleetGovernor,
    caveats: z.array(z.string().max(500)),
  })
  .strict();
export type OrchestrationSnapshot = z.infer<typeof OrchestrationSnapshot>;

export const OWNERSHIP_KINDS = ['none', 'mona_queue', 'native_goal', 'native_fleet', 'native_agent'] as const;
export const OwnershipKind = z.enum(OWNERSHIP_KINDS);
export type OwnershipKind = z.infer<typeof OwnershipKind>;

export const OwnershipView = z
  .object({
    owner: OwnershipKind,
    runId: z.string().min(1).nullable(),
    detail: z.string().max(500),
    since: TimestampOrNull,
  })
  .strict();
export type OwnershipView = z.infer<typeof OwnershipView>;

export const AgentNodeKind = z.enum(['thread', 'goal', 'agent', 'fleet_run', 'fleet_task', 'worker']);
export type AgentNodeKind = z.infer<typeof AgentNodeKind>;

export const AgentNode = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    kind: AgentNodeKind,
    label: z.string().min(1).max(300),
    role: z.string().max(80).nullable(),
    status: z.string().min(1).max(80),
    workspace: z.string().max(1_000).nullable(),
    branch: z.string().max(300).nullable(),
    taskId: z.string().max(200).nullable(),
    turnId: z.string().max(200).nullable(),
    lastEvent: z.string().max(500).nullable(),
    tools: z.array(z.string().max(200)),
    tests: z.array(z.string().max(200)),
    spend: CostEvidence,
    spendIncludedInParent: z.boolean(),
  })
  .strict();
export type AgentNode = z.infer<typeof AgentNode>;

export const ObservatorySpend = z
  .object({
    threadCost: CostEvidence,
    childrenKnownMicros: z.number().int().nonnegative().nullable(),
    aggregate: CostEvidence,
    doubleCountAvoided: z.boolean(),
    note: z.string().max(500),
  })
  .strict();
export type ObservatorySpend = z.infer<typeof ObservatorySpend>;

export const ObservatoryView = z
  .object({
    projectId: z.string().min(1).nullable(),
    threadId: z.string().min(1).nullable(),
    connected: z.boolean(),
    capturedAt: Timestamp,
    ownership: OwnershipView,
    spend: ObservatorySpend,
    nodes: z.array(AgentNode),
    goals: z.array(NativeGoal),
    tasks: z.array(NativeTask),
    fleetRuns: z.array(FleetRun),
    agentRuns: z.array(AgentRun),
    artifacts: z.array(AgentRunArtifact),
    caveats: z.array(z.string().max(500)),
    diagnostics: z.array(z.string().max(500)),
  })
  .strict();
export type ObservatoryView = z.infer<typeof ObservatoryView>;

/** The one execution-owner rule from spec 10.3, expressed as data. */
export function ownershipConflict(ownership: OwnershipView, next: OwnershipKind): string | null {
  if (ownership.owner === 'none' || ownership.owner === next) return null;
  return `${ownership.owner} already owns execution for this project${ownership.runId ? ` (${ownership.runId})` : ''}.`;
}
