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
  export: 'mona:studio-export',
  respond: 'mona:studio-respond',
  history: 'mona:studio-history',
  search: 'mona:studio-search',
  event: 'mona:studio-event',
} as const;

export type StudioMode = 'agent' | 'plan';

export type StudioProfile = {
  threadId: string;
  workspace: string;
  provider: string;
  model: string;
  mode: StudioMode;
  permissionPosture: 'full_access' | 'workspace_write' | 'ask' | 'read_only' | 'unknown';
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

export type StudioQuestionOption = { label: string; description: string | null };

/** One clarification question as the runtime shaped it. */
export type StudioQuestion = {
  id: string;
  header: string | null;
  question: string | null;
  multiSelect: boolean;
  options: StudioQuestionOption[];
};

/**
 * A pending human request. `requestId` is the runtime's own identity and is the
 * only thing a reply may be addressed to; `decisions` is the reply schema that
 * was recorded when the request arrived, so the UI cannot offer an answer the
 * service would refuse.
 */
export type StudioPending =
  | {
      kind: 'approval';
      requestId: string;
      /** Kept for the earlier card shape; equal to `requestId`. */
      approvalId: string;
      toolName: string;
      description: string;
      intentSummary: string | null;
      decisions: Array<'allow' | 'deny'>;
      at: string;
    }
  | {
      kind: 'input';
      requestId: string;
      approvalId: string;
      toolName: string;
      description: string;
      questions: StudioQuestion[];
      freeText: boolean;
      at: string;
    };

/** The answer Mona sent, and the acknowledgement the runtime returned. */
export type StudioHumanAnswer = {
  requestId: string;
  status: 'answered';
  decision: 'allow' | 'deny' | null;
  answers: Array<{ id: string; label: string; value: string }>;
  acknowledged: boolean;
  detail: string;
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
  /** Set when a blocked problem refuses the next dispatch. */
  blockedProblem: { problemId: string; taskId: string | null; detail: string } | null;
};

/**
 * Usage for the session on screen, read from the recorded ledger. Nothing here is
 * estimated: unpriced records stay unknown, and the scope is the session, not the
 * project or the turn.
 */
export type StudioUsage = {
  scope: 'session';
  sessionId: string;
  records: number;
  knownMicros: number;
  unknownRecords: number;
  /** null means the runtime did not report that bucket; it is not zero. */
  tokens: {
    input: number | null;
    output: number | null;
    cacheHit: number | null;
    cacheMiss: number | null;
    reasoning: number | null;
  };
  /** True when the runtime reported reasoning tokens inside the output count. */
  reasoningIncludedInOutput: boolean;
  capturedAt: string;
};

export type StudioCapability = { status: 'supported' | 'unsupported'; reason: string | null };

/**
 * Paging facts for the loaded window. The renderer never has to guess whether
 * older stored rows exist: the store was asked.
 */
export type StudioHistoryWindow = {
  total: number;
  oldestSeq: number | null;
  newestSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
};

/** A cursor request over stored history. All values are bounded by the service. */
export type StudioHistoryQuery = {
  projectId: string;
  sessionId: string;
  mode?: StudioMode;
  /** Return rows strictly older than this sequence number. */
  beforeSeq?: number;
  /** Return a window centred on this sequence number. */
  aroundSeq?: number;
  limit?: number;
};

export type StudioHistoryPage = {
  items: TimelineItem[];
  window: StudioHistoryWindow;
};

export type StudioSearchResult = { query: string; items: TimelineItem[]; total: number };

export type StudioView = {
  projectId: string | null;
  sessionId: string | null;
  thread: StudioProfile | null;
  items: TimelineItem[];
  history: StudioHistoryWindow;
  run: StudioRun;
  control: StudioControl;
  pending: StudioPending | null;
  usage: StudioUsage | null;
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
  | { type: 'item'; projectId: string; threadId: string; item: TimelineItem }
  | { type: 'delta'; projectId: string; threadId: string; itemId: string; text: string; seq: number }
  | {
      type: 'state';
      projectId: string;
      threadId: string | null;
      thread: StudioProfile | null;
      run: StudioRun;
      control: StudioControl;
      pending: StudioPending | null;
    }
  | { type: 'diagnostic'; projectId: string; line: string };

export type StudioReferencePick = { paths: string[] };

/**
 * The outcome of exporting a conversation. `saved: false` means the user
 * cancelled the save dialog; nothing was written and no path is claimed.
 */
export type StudioExport = {
  saved: boolean;
  path: string | null;
  fileName: string;
  bytes: number;
  sha256: string | null;
  items: number;
  truncatedItems: number;
  note: string;
};

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
  studioExport(input: { projectId: string; sessionId: string; mode?: StudioMode }): Promise<IpcResult<StudioExport>>;
  /**
   * Answer the pending runtime request. `decision` answers an approval;
   * `answers` answers a clarification. Both address the runtime request id and
   * nothing else, so a stale card cannot decide a newer question.
   */
  studioRespond(input: {
    projectId: string;
    sessionId: string;
    mode?: StudioMode;
    requestId: string;
    decision?: 'allow' | 'deny';
    remember?: boolean;
    answers?: Array<{ id: string; label: string; value: string }>;
  }): Promise<IpcResult<StudioHumanAnswer>>;
  /** One cursor page of stored history. Reading history makes no model call. */
  studioHistory(input: StudioHistoryQuery): Promise<IpcResult<StudioHistoryPage>>;
  /** Case-insensitive search over the stored conversation for this thread. */
  studioSearchHistory(input: {
    projectId: string;
    sessionId: string;
    mode?: StudioMode;
    query: string;
  }): Promise<IpcResult<StudioSearchResult>>;
  /** Subscribes to main-process studio pushes; returns an unsubscribe function. */
  onStudioEvent(handler: (event: StudioEvent) => void): () => void;
};
