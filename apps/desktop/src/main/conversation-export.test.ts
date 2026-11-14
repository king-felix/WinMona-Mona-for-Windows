import { describe, expect, it } from 'vitest';
import { conversationFileName, fenceFor, renderConversationMarkdown } from './conversation-export.js';
import type { StudioProfile, TimelineItem } from '../shared/studio.js';

const thread: StudioProfile = {
  threadId: 'thr_00000000000000000000000000000001',
  workspace: 'C:\\work\\alpha',
  provider: 'deepseek',
  model: 'deepseek-flash',
  mode: 'agent',
  permissionPosture: 'full_access',
  allowShell: true,
  trustMode: true,
  autoApprove: true,
  observedAt: '2026-11-12T18:00:00.000Z',
};

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: 'item_1',
    seq: 1,
    turnId: 'turn_1',
    kind: 'assistant',
    title: 'Assistant',
    body: 'MONA_OK',
    status: 'completed',
    truncated: false,
    at: '2026-11-12T18:00:01.000Z',
    ...overrides,
  };
}

const base = {
  projectLabel: 'Alpha',
  workspace: 'C:\\work\\alpha',
  sessionId: 'ses_12345678',
  thread,
  exportedAt: '2026-11-12T18:05:00.000Z',
  appVersion: '0.1.0',
  totalStored: 2,
};

describe('conversation export', () => {
  it('keeps the recorded content and the real thread facts', () => {
    const text = renderConversationMarkdown({
      ...base,
      items: [
        item({ id: 'u', seq: 1, kind: 'user', body: 'Say MONA_OK', status: null }),
        item({ id: 'a', seq: 2, kind: 'assistant', body: 'MONA_OK' }),
      ],
    });
    expect(text).toContain('# Mona conversation — Alpha');
    expect(text).toContain('Say MONA_OK');
    expect(text).toContain('deepseek-flash');
    expect(text).toContain('full_access');
    expect(text).toContain('Mona 0.1.0');
    expect(text).toContain('Items: 2 recorded');
    expect(text).toContain('## User · seq 1');
    expect(text).toContain('## Assistant · seq 2 · 2026-11-12T18:00:01.000Z');
    expect(text).not.toContain('```');
  });

  it('labels a truncated item instead of pretending it is complete', () => {
    const text = renderConversationMarkdown({
      ...base,
      items: [item({ truncated: true, body: 'partial' })],
    });
    expect(text).toContain('truncated by Mona at the item size bound');
    expect(text).toContain('1 item(s) were cut');
  });

  it('fences machine output with a fence the body cannot close', () => {
    const body = 'before\n```\nstill inside\n```';
    expect(fenceFor(body)).toBe('````');
    const text = renderConversationMarkdown({
      ...base,
      items: [item({ kind: 'tool', body })],
    });
    expect(text).toContain('````\nbefore\n```\nstill inside\n```\n````');
  });

  it('says plainly that an empty session has no events', () => {
    const text = renderConversationMarkdown({ ...base, items: [] });
    expect(text).toContain('No events were recorded for this session.');
  });

  it('names the file without path separators or Windows-reserved characters', () => {
    const name = conversationFileName('a/b\\c:d*e?f"g<h>i|j', 'ses_12345678', new Date('2026-11-12T00:00:00Z'));
    expect(name).toBe('a-b-c-d-e-f-g-h-i-j-ses_1234-2026-11-12.md');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(conversationFileName('...', 'ses_abcdefgh', new Date('2026-11-12T00:00:00Z'))).toBe(
      'project-ses_abcd-2026-11-12.md',
    );
  });
});
