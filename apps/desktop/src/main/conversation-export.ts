import type { StudioProfile, TimelineItem } from '../shared/studio.js';

/**
 * Conversation export. This renders exactly what Mona recorded: the stored
 * timeline items, their real timestamps, statuses and truncation flags. It does
 * not call a model, does not summarize, and does not re-order anything.
 */

const KIND_HEADING: Record<TimelineItem['kind'], string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  status: 'Status',
  outcome: 'Outcome',
  approval: 'Approval',
  error: 'Problem',
};

/** Bodies that are machine output go inside a fence the body cannot close. */
const FENCED_KINDS = new Set<TimelineItem['kind']>(['tool', 'status', 'outcome', 'error']);

/** Longest backtick run in the body, so the fence always outruns the content. */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export type ConversationExportInput = {
  projectLabel: string;
  workspace: string;
  sessionId: string;
  thread: StudioProfile | null;
  items: readonly TimelineItem[];
  exportedAt: string;
  appVersion: string;
  /** The window Mona reads per session; recorded so the export is not mistaken for everything. */
  itemBound: number;
};

export function renderConversationMarkdown(input: ConversationExportInput): string {
  const truncated = input.items.filter((item) => item.truncated).length;
  const lines: string[] = [];
  lines.push(`# Mona conversation — ${input.projectLabel}`);
  lines.push('');
  lines.push(`- Project: ${input.projectLabel}`);
  lines.push(`- Workspace: ${input.workspace}`);
  lines.push(`- Session: ${input.sessionId}`);
  lines.push(
    input.thread
      ? `- Thread: ${input.thread.threadId} · ${input.thread.provider} · ${input.thread.model} · ${input.thread.mode} · ${input.thread.permissionPosture}`
      : '- Thread: no runtime thread is bound to this session',
  );
  lines.push(`- Exported: ${input.exportedAt} by Mona ${input.appVersion}`);
  lines.push(
    `- Items: ${input.items.length} recorded (the newest ${input.itemBound} per session are read; ${truncated} item(s) were cut by Mona's per-item size bound)`,
  );
  lines.push('');
  lines.push(
    'This file is the recorded timeline, in order. Nothing was regenerated, summarized or re-priced while exporting.',
  );
  lines.push('');

  if (input.items.length === 0) {
    lines.push('No events were recorded for this session.');
    lines.push('');
    return lines.join('\n');
  }

  for (const item of input.items) {
    const heading = [`## ${KIND_HEADING[item.kind]}`, `seq ${item.seq}`, item.at].join(' · ');
    lines.push(heading);
    const meta: string[] = [];
    if (item.status) meta.push(`status: ${item.status}`);
    if (item.turnId) meta.push(`turn: ${item.turnId}`);
    if (item.truncated) meta.push('truncated by Mona at the item size bound');
    if (meta.length > 0) {
      lines.push('');
      lines.push(`_${meta.join(' · ')}_`);
    }
    lines.push('');
    if (FENCED_KINDS.has(item.kind)) {
      const fence = fenceFor(item.body);
      lines.push(fence);
      lines.push(item.body);
      lines.push(fence);
    } else {
      lines.push(item.body);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** A Windows-safe default file name; never derived from a path separator. */
export function conversationFileName(projectLabel: string, sessionId: string, at: Date): string {
  const stem =
    projectLabel
      .replace(/[^A-Za-z0-9._ -]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48) || 'project';
  const date = at.toISOString().slice(0, 10);
  return `${stem}-${sessionId.slice(0, 8)}-${date}.md`;
}
