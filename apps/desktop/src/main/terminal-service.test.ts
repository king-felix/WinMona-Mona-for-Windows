import { describe, expect, it } from 'vitest';
import type { ProjectStore } from '@mona/project-state';
import type { TerminalHost } from './terminal-host.js';
import { TerminalService } from './terminal-service.js';

const PROJECT = { id: 'prj_1', label: 'Demo', canonicalPath: 'C:\\proj' };

function harness(options: { project?: boolean } = {}) {
  const calls: string[] = [];
  const store = {
    getProject: async (id: string) =>
      options.project === false || id !== PROJECT.id ? null : { ...PROJECT, createdAt: '', updatedAt: '' },
  } as unknown as ProjectStore;
  const host = {
    create: (input: { projectId: string; cwd: string; cols: number; rows: number }) => {
      calls.push(`create:${input.projectId}:${input.cwd}:${input.cols}x${input.rows}`);
      return { ok: true as const, data: { id: 'term_1' } };
    },
    input: (input: { sessionId: string; data: string }) => {
      calls.push(`input:${input.sessionId}`);
      return { ok: true as const, data: { accepted: input.data.length } };
    },
    resize: (input: { cols: number; rows: number }) => {
      calls.push(`resize:${input.cols}x${input.rows}`);
      return { ok: true as const, data: { cols: input.cols } };
    },
    kill: (input: { sessionId: string }) => {
      calls.push(`kill:${input.sessionId}`);
      return { ok: true as const, data: { id: input.sessionId } };
    },
    refresh: (input: { sessionId: string }) => {
      calls.push(`refresh:${input.sessionId}`);
      return { ok: true as const, data: { data: 'tail' } };
    },
    closeAll: () => calls.push('close-all'),
    availability: () => ({ available: true, detail: 'fixture' }),
  } as unknown as TerminalHost;
  return { service: new TerminalService({ store, host }), calls };
}

describe('terminal service', () => {
  it('resolves the project folder itself, never a renderer-supplied path', async () => {
    const { service, calls } = harness();
    const result = await service.create({ projectId: 'prj_1', cols: 100, rows: 30 });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['create:prj_1:C:\\proj:100x30']);
  });

  it('refuses every action for an unknown project', async () => {
    const { service, calls } = harness({ project: false });
    expect(await service.create({ projectId: 'prj_missing', cols: 100, rows: 30 })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await service.input({ projectId: 'prj_missing', sessionId: 'term_1', data: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(calls).toEqual([]);
  });

  it('forwards input, resize, kill and refresh once the project is known', async () => {
    const { service, calls } = harness();
    await service.input({ projectId: 'prj_1', sessionId: 'term_1', data: 'dir' });
    await service.resize({ projectId: 'prj_1', sessionId: 'term_1', cols: 120, rows: 40 });
    await service.kill({ projectId: 'prj_1', sessionId: 'term_1' });
    await service.refresh({ projectId: 'prj_1', sessionId: 'term_1' });
    expect(calls).toEqual(['input:term_1', 'resize:120x40', 'kill:term_1', 'refresh:term_1']);
  });

  it('closes every owned shell on shutdown', () => {
    const { service, calls } = harness();
    service.closeAll();
    expect(calls).toEqual(['close-all']);
  });
});
