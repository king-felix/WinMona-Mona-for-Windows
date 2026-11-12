import type { AttemptService } from './attempts.js';
import type { ChangeService } from './changes.js';
import type { CostLedger } from './costs.js';
import { stateError } from './errors.js';
import type { ProjectStore } from './store.js';
import type { TaskService, WorkTask } from './tasks.js';

/**
 * Resume Brief and "Since you left" are assembled from rows Mona already
 * recorded. No summarizer, router, or background model is involved: every line
 * below is a deterministic projection of task transitions, test receipts,
 * usage rows, timeline events or Git status.
 *
 * Counts are counts. The brief never turns them into a completion percentage,
 * and unknown spend is labeled unknown rather than zero.
 */

export type BriefTask = {
  id: string;
  title: string;
  status: WorkTask['status'];
  owner: WorkTask['executionOwner'];
  step: string | null;
  requirementIds: string[];
  dependencies: string[];
  evidencePaths: string[];
};

export type BriefBlocker = {
  kind: 'task' | 'problem';
  id: string;
  title: string;
  detail: string;
  helpNeeded: string | null;
  evidencePaths: string[];
};

export type BriefTest = {
  outcome: 'passed' | 'failed' | 'unknown';
  command: string;
  finishedAt: string | null;
  recordedAt: string;
  commit: string | null;
  outputPath: string | null;
  outputSha256: string | null;
};

export type BriefChanges = {
  count: number | null;
  added: number;
  modified: number;
  deleted: number;
  basis: 'git_status' | 'baseline' | 'none';
  truncated: boolean;
  detail: string;
};

export type BriefSpendConfidence = 'none' | 'known' | 'partial' | 'unknown';

export type BriefSpend = {
  knownMicros: number;
  unknownRecords: number;
  records: number;
  confidence: BriefSpendConfidence;
  label: string;
};

export type BriefNextStep = {
  taskId: string | null;
  text: string;
};

export type BriefProgress = {
  tasksTotal: number;
  completed: number;
  blocked: number;
  verifying: number;
  verifiedEvidence: number;
  note: string;
};

export type BriefEvidenceLink = {
  label: string;
  path: string;
  at: string | null;
};

export type ResumeBrief = {
  projectId: string;
  projectLabel: string;
  generatedAt: string;
  currentPrompt: BriefTask | null;
  blockers: BriefBlocker[];
  lastTest: BriefTest | null;
  changes: BriefChanges;
  spend: BriefSpend;
  nextStep: BriefNextStep;
  progress: BriefProgress;
  evidence: BriefEvidenceLink[];
  disclosure: string[];
};

export type DigestTone = 'info' | 'success' | 'attention' | 'critical' | 'neutral';

export type DigestItem = {
  at: string;
  summary: string;
  tone: DigestTone;
  taskId: string | null;
  evidencePath: string | null;
  /** Bounded identifiers help the UI group without parsing prose. */
  kind: string;
};

export type DigestGroup = {
  id: 'completed' | 'attention' | 'tests' | 'changes' | 'spend' | 'activity';
  label: string;
  items: DigestItem[];
};

export type SinceYouLeftCounts = {
  events: number;
  tasksCompleted: number;
  tasksBlocked: number;
  testsPassed: number;
  testsFailed: number;
  changedFiles: number | null;
  knownMicros: number;
  unknownRecords: number;
  timelineItems: number;
};

export type SinceYouLeft = {
  projectId: string;
  since: string | null;
  until: string;
  empty: boolean;
  groups: DigestGroup[];
  counts: SinceYouLeftCounts;
  note: string;
};

export type BriefingServiceOptions = {
  now?: () => Date;
  tasks?: TaskService;
  attempts?: AttemptService;
  costs?: CostLedger;
  changes?: ChangeService;
};

const MAX_DIGEST_ITEMS = 40;
const MAX_DIGEST_TEXT = 280;

/** Confidence comes from recorded origins only; a gap is never read as zero. */
export function spendConfidence(totals: { records: number; knownMicros: number; unknownRecords: number }): BriefSpend {
  const confidence: BriefSpendConfidence =
    totals.records === 0
      ? 'none'
      : totals.unknownRecords > 0
        ? totals.knownMicros > 0
          ? 'partial'
          : 'unknown'
        : 'known';
  const dollars = `$${(totals.knownMicros / 1_000_000).toFixed(4)}`;
  const label =
    confidence === 'none'
      ? 'No usage recorded'
      : confidence === 'known'
        ? dollars
        : confidence === 'partial'
          ? `${dollars} + ${totals.unknownRecords} unknown record(s)`
          : `${totals.unknownRecords} unknown record(s); no priced usage`;
  return {
    knownMicros: totals.knownMicros,
    unknownRecords: totals.unknownRecords,
    records: totals.records,
    confidence,
    label,
  };
}

/** `since` is exclusive; null means "everything recorded for this project". */
export function withinWindow(at: string | null, since: string | null): boolean {
  if (at === null) return false;
  if (since === null) return true;
  return at > since;
}

export class BriefingService {
  private readonly now: () => Date;

  constructor(
    private readonly store: ProjectStore,
    private readonly deps: BriefingServiceOptions = {},
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async resumeBrief(projectId: string): Promise<ResumeBrief> {
    const project = await this.store.getProject(projectId);
    if (!project) throw stateError('not_found', `project ${projectId} does not exist`);

    const tasks = await this.requireDeps().tasks.board(projectId);
    const all = tasks.tasks.map((entry) => entry.task);
    const active = all.find((task) => task.status === 'running' || task.status === 'verifying') ?? null;
    const interrupted = all.find((task) => task.status === 'interrupted') ?? null;
    const nextTask = tasks.next ? (all.find((task) => task.id === tasks.next) ?? null) : null;
    const current = active ?? interrupted ?? nextTask;

    const summary = await this.requireDeps().attempts.summary(projectId);
    const blockedCards = await Promise.all(
      summary.blockedProblemIds.map((id) => this.requireDeps().attempts.handoffCard(id)),
    );
    const blockers: BriefBlocker[] = [
      ...all
        .filter((task) => task.status === 'blocked')
        .map((task) => ({
          kind: 'task' as const,
          id: task.id,
          title: task.title,
          detail: task.blockedReason ?? 'Blocked with no reason recorded.',
          helpNeeded: null,
          evidencePaths: task.evidence.filter((entry) => !entry.stale).map((entry) => entry.path),
        })),
      ...blockedCards.map((card) => ({
        kind: 'problem' as const,
        id: card.problemId,
        title: card.title,
        detail: `${card.consecutiveNoProgress} consecutive no-progress attempt(s) of ${card.stopThreshold}.`,
        helpNeeded: card.helpNeeded,
        evidencePaths: card.evidencePaths,
      })),
    ];

    const receipts = await this.requireDeps().changes.testReceipts(projectId, 1);
    const receipt = receipts[0] ?? null;
    const changes = await this.changedFiles(projectId, project.canonicalPath);

    const spendTotals = await this.requireDeps().costs.totals(projectId);
    const spend = spendConfidence(spendTotals);

    const gaps = current ? await this.requireDeps().tasks.gaps(current.id) : [];
    const nextStep = this.nextStep(current, gaps, tasks.eligible);

    const completed = all.filter((task) => task.status === 'completed');
    const verifiedEvidence = completed.reduce(
      (total, task) => total + task.evidence.filter((entry) => !entry.stale).length,
      0,
    );

    const evidence = new Map<string, BriefEvidenceLink>();
    const add = (link: BriefEvidenceLink): void => {
      if (!link.path) return;
      if (!evidence.has(link.path)) evidence.set(link.path, link);
    };
    if (current) {
      for (const entry of current.evidence.filter((item) => !item.stale)) {
        add({ label: current.id, path: entry.path, at: entry.recordedAt });
      }
    }
    if (receipt?.outputPath) {
      add({ label: `test ${receipt.outcome}`, path: receipt.outputPath, at: receipt.finishedAt ?? receipt.createdAt });
    }
    for (const blocker of blockers) {
      for (const path of blocker.evidencePaths) add({ label: blocker.id, path, at: null });
    }

    return {
      projectId,
      projectLabel: project.label,
      generatedAt: this.timestamp(),
      currentPrompt: current ? toBriefTask(current) : null,
      blockers,
      lastTest: receipt
        ? {
            outcome: receipt.outcome,
            command: receipt.command,
            finishedAt: receipt.finishedAt,
            recordedAt: receipt.createdAt,
            commit: receipt.commit,
            outputPath: receipt.outputPath,
            outputSha256: receipt.outputSha256,
          }
        : null,
      changes,
      spend,
      nextStep,
      progress: {
        tasksTotal: all.length,
        completed: completed.length,
        blocked: all.filter((task) => task.status === 'blocked').length,
        verifying: all.filter((task) => task.status === 'verifying').length,
        verifiedEvidence,
        note: 'Counts of recorded task states and evidence. Mona does not infer a completion percentage.',
      },
      evidence: [...evidence.values()],
      disclosure: [
        'Generated locally from recorded rows; no model was called for this brief.',
        'A task count is not a completion percentage.',
        'Unknown spend stays unknown; it is never treated as zero.',
        'Changed files come from Git status or a recorded baseline, not from agent claims.',
      ],
    };
  }

  /**
   * Deterministic grouping of recorded activity. `since` is an ISO timestamp,
   * normally the last time Victor opened this project; null means all rows.
   */
  async sinceYouLeft(projectId: string, since: string | null): Promise<SinceYouLeft> {
    const project = await this.store.getProject(projectId);
    if (!project) throw stateError('not_found', `project ${projectId} does not exist`);

    const board = await this.requireDeps().tasks.board(projectId);
    const timeline = await this.store.read(
      (db) =>
        db
          .prepare(
            `SELECT id, turn_id, kind, title, status, created_at
             FROM timeline_items WHERE project_id = ? ORDER BY created_at ASC, id ASC LIMIT 500`,
          )
          .all(projectId) as Array<{
          id: string;
          turn_id: string | null;
          kind: string;
          title: string;
          status: string | null;
          created_at: string;
        }>,
    );
    const receipts = await this.requireDeps().changes.testReceipts(projectId, 100);
    const spendTotals = await this.requireDeps().costs.totalsSince(projectId, since);
    const changes = await this.changedFiles(projectId, project.canonicalPath);

    const completed: DigestItem[] = [];
    const attention: DigestItem[] = [];
    const tests: DigestItem[] = [];
    const activity: DigestItem[] = [];

    for (const entry of board.tasks) {
      const task = entry.task;
      if (task.status === 'completed' && withinWindow(task.completedAt, since)) {
        completed.push({
          at: task.completedAt as string,
          summary: `${task.id} completed: ${task.title}`,
          tone: 'success',
          taskId: task.id,
          evidencePath: task.evidence.find((item) => !item.stale)?.path ?? null,
          kind: 'task_completed',
        });
      }
      if (task.status === 'blocked' && withinWindow(task.updatedAt, since)) {
        attention.push({
          at: task.updatedAt,
          summary: `${task.id} is blocked: ${task.blockedReason ?? 'no reason recorded'}`,
          tone: 'critical',
          taskId: task.id,
          evidencePath: task.evidence.find((item) => !item.stale)?.path ?? null,
          kind: 'task_blocked',
        });
      }
      for (const transition of task.transitions) {
        if (!withinWindow(transition.at, since)) continue;
        if (transition.toStatus === 'completed' && transition.fromStatus !== 'completed') continue;
        if (transition.toStatus === 'blocked') continue;
        activity.push({
          at: transition.at,
          summary: `${task.id} ${transition.fromStatus ?? 'new'} → ${transition.toStatus}: ${transition.reason}`,
          tone: transition.toStatus === 'interrupted' ? 'attention' : 'neutral',
          taskId: task.id,
          evidencePath: null,
          kind: 'task_transition',
        });
      }
    }

    for (const receipt of receipts) {
      if (!withinWindow(receipt.createdAt, since)) continue;
      tests.push({
        at: receipt.finishedAt ?? receipt.createdAt,
        summary: `${receipt.outcome}: ${receipt.command}${receipt.outputPath ? ` (${receipt.outputPath})` : ''}`,
        tone: receipt.outcome === 'passed' ? 'success' : receipt.outcome === 'failed' ? 'critical' : 'attention',
        taskId: receipt.taskId,
        evidencePath: receipt.outputPath,
        kind: 'test_receipt',
      });
    }

    for (const item of timeline) {
      if (!withinWindow(item.created_at, since)) continue;
      const tone: DigestTone =
        item.kind === 'error'
          ? 'critical'
          : item.kind === 'approval'
            ? 'attention'
            : item.status === 'failed'
              ? 'critical'
              : item.kind === 'outcome' && item.status === 'completed'
                ? 'success'
                : 'neutral';
      if (
        item.kind === 'error' ||
        item.kind === 'approval' ||
        (item.kind === 'outcome' && item.status !== 'completed')
      ) {
        attention.push({
          at: item.created_at,
          summary: truncate(`${item.title}${item.status ? ` · ${item.status}` : ''}`),
          tone: tone === 'neutral' ? 'attention' : tone,
          taskId: null,
          evidencePath: null,
          kind: `timeline_${item.kind}`,
        });
      } else {
        activity.push({
          at: item.created_at,
          summary: truncate(`${item.kind}: ${item.title}`),
          tone,
          taskId: null,
          evidencePath: null,
          kind: `timeline_${item.kind}`,
        });
      }
    }

    // Newest first within each group, then a stable id so equal timestamps do
    // not reorder between runs.
    const sort = (items: DigestItem[]): DigestItem[] =>
      items
        .sort((left, right) => right.at.localeCompare(left.at) || left.summary.localeCompare(right.summary))
        .slice(0, MAX_DIGEST_ITEMS);

    const allGroups: DigestGroup[] = [
      { id: 'completed', label: 'Finished', items: sort(completed) },
      { id: 'attention', label: 'Needs attention', items: sort(attention) },
      { id: 'tests', label: 'Tests', items: sort(tests) },
      {
        id: 'changes',
        label: 'Workspace changes',
        items: [
          {
            at: this.timestamp(),
            summary: changes.count === null ? changes.detail : `${changes.count} changed path(s). ${changes.detail}`,
            tone: changes.count === null ? ('attention' as const) : ('neutral' as const),
            taskId: null,
            evidencePath: null,
            kind: 'changes',
          },
        ],
      },
      {
        id: 'spend',
        label: 'Spend',
        items: [
          {
            at: this.timestamp(),
            summary: `${spendConfidence(spendTotals).label} (${spendTotals.records} record(s) since ${
              since ?? 'the beginning'
            })`,
            tone: spendTotals.unknownRecords > 0 ? ('attention' as const) : ('neutral' as const),
            taskId: null,
            evidencePath: null,
            kind: 'spend',
          },
        ],
      },
      { id: 'activity', label: 'Activity', items: sort(activity) },
    ];
    const groups = allGroups.filter(
      (group) => group.id === 'changes' || group.id === 'spend' || group.items.length > 0,
    );

    const counts: SinceYouLeftCounts = {
      events: completed.length + attention.length + tests.length + activity.length,
      tasksCompleted: completed.length,
      tasksBlocked: attention.filter((item) => item.kind === 'task_blocked').length,
      testsPassed: tests.filter((item) => item.tone === 'success').length,
      testsFailed: tests.filter((item) => item.tone === 'critical').length,
      changedFiles: changes.count,
      knownMicros: spendTotals.knownMicros,
      unknownRecords: spendTotals.unknownRecords,
      timelineItems: timeline.filter((item) => withinWindow(item.created_at, since)).length,
    };

    return {
      projectId,
      since,
      until: this.timestamp(),
      empty: counts.events === 0 && changes.count === null && counts.timelineItems === 0,
      groups,
      counts,
      note: 'Grouped from recorded rows only. No summarizer or model request was made.',
    };
  }

  private nextStep(current: WorkTask | null, gaps: string[], eligible: string[]): BriefNextStep {
    if (!current) {
      return {
        taskId: null,
        text:
          eligible.length > 0
            ? `Claim the next eligible task (${eligible[0]}).`
            : 'No eligible task. Inspect blockers or record a bounded task.',
      };
    }
    if (current.status === 'blocked') {
      return {
        taskId: current.id,
        text: `Clear the blocker on ${current.id}: ${current.blockedReason ?? 'no reason recorded'}.`,
      };
    }
    if (current.status === 'verifying') {
      return {
        taskId: current.id,
        text:
          gaps.length === 0
            ? `${current.id} is verifying with no recorded gaps; review and complete it.`
            : `${current.id} is verifying. Remaining: ${gaps.join('; ')}.`,
      };
    }
    if (current.status === 'completed') {
      return { taskId: current.id, text: `${current.id} is completed and verified. Choose the next task.` };
    }
    const step =
      current.steps.find((entry) => entry.id === current.currentStep) ??
      current.steps.find((entry) => entry.status !== 'done');
    return {
      taskId: current.id,
      text: step
        ? `Resume ${current.id} at: ${step.title} (${step.status}).`
        : `Claim ${current.id} and run its prompt.`,
    };
  }

  private async changedFiles(projectId: string, workspace: string): Promise<BriefChanges> {
    const changes = this.deps.changes;
    if (!changes) {
      return {
        count: null,
        added: 0,
        modified: 0,
        deleted: 0,
        basis: 'none',
        truncated: false,
        detail: 'No change service is configured; the changed-file count is unknown, not zero.',
      };
    }
    const status = await changes.gitStatus(workspace);
    if (status.kind !== 'none') {
      const paths = new Set<string>();
      for (const entry of [...status.staged, ...status.unstaged]) paths.add(entry.path);
      for (const path of status.untracked) paths.add(path);
      for (const path of status.conflicts) paths.add(path);
      return {
        count: paths.size,
        added: status.staged.filter((entry) => entry.status === 'added').length,
        modified: [...status.staged, ...status.unstaged].filter((entry) => entry.status === 'modified').length,
        deleted: [...status.staged, ...status.unstaged].filter((entry) => entry.status === 'deleted').length,
        basis: 'git_status',
        truncated: status.unavailableReason !== null,
        detail:
          paths.size === 0
            ? 'Git reports a clean working tree.'
            : `${paths.size} path(s) differ from HEAD according to Git status.`,
      };
    }
    const baselines = await changes.baselines(projectId);
    const latest = baselines[0];
    if (!latest) {
      return {
        count: null,
        added: 0,
        modified: 0,
        deleted: 0,
        basis: 'none',
        truncated: false,
        detail: 'No Git repository and no captured baseline; the changed-file count is unknown, not zero.',
      };
    }
    const report = await changes.diff({ projectId, workspace, baselineId: latest.id });
    return {
      count: report.comparable ? report.changes.length : null,
      added: report.counts.added,
      modified: report.counts.modified,
      deleted: report.counts.deleted,
      basis: report.comparable ? 'baseline' : 'none',
      truncated: report.truncated,
      detail: report.comparable
        ? `${report.changes.length} path(s) differ from the baseline captured ${latest.capturedAt}.`
        : report.attributionNote,
    };
  }

  private requireDeps(): Required<Pick<BriefingServiceOptions, 'tasks' | 'attempts' | 'costs' | 'changes'>> {
    const missing = (['tasks', 'attempts', 'costs', 'changes'] as const).filter((key) => !this.deps[key]);
    if (missing.length > 0) {
      throw stateError('internal', `BriefingService is missing ${missing.join(', ')}`);
    }
    return this.deps as Required<Pick<BriefingServiceOptions, 'tasks' | 'attempts' | 'costs' | 'changes'>>;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function toBriefTask(task: WorkTask): BriefTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.executionOwner,
    step: task.steps.find((entry) => entry.id === task.currentStep)?.title ?? null,
    requirementIds: [...new Set(task.requirements.map((entry) => entry.requirementId))],
    dependencies: [...task.dependencies],
    evidencePaths: task.evidence.filter((entry) => !entry.stale).map((entry) => entry.path),
  };
}

function truncate(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > MAX_DIGEST_TEXT ? `${flat.slice(0, MAX_DIGEST_TEXT - 1)}…` : flat;
}
