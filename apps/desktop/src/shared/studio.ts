import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing studio vocabulary. This module stays free of zod and of the
 * engine's wire shapes: the renderer receives already-projected facts and never
 * a raw runtime payload it could be tempted to trust.
 */
export const STUDIO_CHANNELS = {
  get: 'mona:studio-get',
  submit: 'mona:studio-submit',
  interrupt: 'mona:studio-interrupt',
  pause: 'mona:studio-pause',
  resume: 'mona:studio-resume',
  references: 'mona:studio-pick-references',
  event: 'mona:studio-event',
} as const;

export type StudioMode = 'agent' | 'plan';

export type StudioProfile = {
  threadId: string;
  workspace: string;
  provider: string;
  model: string;
  mode: StudioMode;
  permissionPosture: 'full_access' | 'workspace_write' | 'read_only' | 'unknown';
  allowShell: boolean;
  trustMode: boolean;
  autoApprove: boolean;
  observedAt: string;
};

export type TimelineKind = 'user' | 'assistant' | 'tool' | 'status' | 'outcome' | 'approval' | 'error';

export type TimelineItem = {
  id: string;
  seq: number;
  turnId: string | null;
  kind: TimelineKind;
  title: string;
  body: string;
  status: string | null;
  truncated: boolean;
  at: string;
};

export type StudioPending =
  | {
      kind: 'approval';
      approvalId: string;
      toolName: string;
      description: string;
      at: string;
    }
  | {
      kind: 'input';
      approvalId: string;
      toolName: string;
      description: string;
      at: string;
    };

export type StudioRunState =
  'idle' | 'preparing' | 'running' | 'reconnecting' | 'awaiting_approval' | 'interrupting' | 'failed';

export type StudioRun = {
  state: StudioRunState;
  detail: string;
  turnId: string | null;
  submission: { submissionId: string; state: string; replayed: boolean } | null;
  startedAt: string | null;
};

export type StudioControl = {
  pauseRequested: boolean;
  queueState: string;
  lastOutcome: string | null;
  interrupt: { outcome: string; detail: string | null; at: string } | null;
};

export type StudioCapability = { status: 'supported' | 'unsupported'; reason: string | null };

export type StudioView = {
  projectId: string | null;
  sessionId: string | null;
  thread: StudioProfile | null;
  items: TimelineItem[];
  run: StudioRun;
  control: StudioControl;
  pending: StudioPending | null;
  diagnostics: string[];
  capabilities: {
    planMode: StudioCapability;
    approvalResponse: StudioCapability;
    attachments: StudioCapability;
  };
  warning: string | null;
};

export type StudioSubmission = {
  submissionId: string;
  threadId: string;
  turnId: string | null;
  state: string;
  replayed: boolean;
  reconciliation: { required: boolean; guidance?: string };
  /** The prompt exactly as sent, references included. */
  prompt: string;
  thread: StudioProfile;
  run: StudioRun;
};

/**
 * Incremental push from the main process. `delta` carries only the new text;
 * everything else is a complete item or complete state value.
 */
export type StudioEvent =
  | { type: 'item'; projectId: string; item: TimelineItem }
  | { type: 'delta'; projectId: string; itemId: string; text: string; seq: number }
  | {
      type: 'state';
      projectId: string;
      thread: StudioProfile | null;
      run: StudioRun;
      control: StudioControl;
      pending: StudioPending | null;
    }
  | { type: 'diagnostic'; projectId: string; line: string };

export type StudioReferencePick = { paths: string[] };

export type StudioBridge = {
  studioGet(input: { projectId: string; sessionId: string; mode?: StudioMode }): Promise<IpcResult<StudioView>>;
  studioSubmit(input: {
    projectId: string;
    sessionId: string;
    text: string;
    mode: StudioMode;
    references: string[];
  }): Promise<IpcResult<StudioSubmission>>;
  studioInterrupt(input: { projectId: string }): Promise<IpcResult<{ run: StudioRun; control: StudioControl }>>;
  studioPause(input: { projectId: string }): Promise<IpcResult<{ run: StudioRun; control: StudioControl }>>;
  studioResume(input: { projectId: string }): Promise<IpcResult<{ run: StudioRun; control: StudioControl }>>;
  studioPickReferences(input: { projectId: string }): Promise<IpcResult<StudioReferencePick>>;
  /** Subscribes to main-process studio pushes; returns an unsubscribe function. */
  onStudioEvent(handler: (event: StudioEvent) => void): () => void;
};
