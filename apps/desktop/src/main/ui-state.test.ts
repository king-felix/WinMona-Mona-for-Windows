import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UiStateStore } from './ui-state.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempFile(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `mona-p07-ui-${label}-`));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return path.join(dir, 'ui-state.json');
}

describe('UI state store', () => {
  it('keeps drafts per project and never mixes sessions', async () => {
    const file = await tempFile('drafts');
    const store = new UiStateStore({ file });
    const first = store.view().projects['prj_a']?.currentSessionId;
    const alpha = store.select('prj_a');
    const alphaSession = alpha.projects['prj_a']?.currentSessionId;
    const beta = store.select('prj_b');
    const betaSession = beta.projects['prj_b']?.currentSessionId;
    expect(alphaSession).toBeDefined();
    expect(betaSession).toBeDefined();
    expect(first).toBeUndefined();

    store.saveDraft('prj_a', alphaSession as string, 'draft a');
    store.saveDraft('prj_b', betaSession as string, 'draft b');
    const view = store.view();
    expect(view.projects['prj_a']?.sessions.find((s) => s.sessionId === alphaSession)?.text).toBe('draft a');
    expect(view.projects['prj_b']?.sessions.find((s) => s.sessionId === betaSession)?.text).toBe('draft b');
    expect(view.projects['prj_a']?.view).toBe('studio');
    expect(view.projects['prj_b']?.view).toBe('studio');
  });

  it('persists across instances and forgets only the removed project', async () => {
    const file = await tempFile('persist');
    const first = new UiStateStore({ file });
    first.select('prj_a');
    const session = first.view().projects['prj_a']?.currentSessionId as string;
    first.saveDraft('prj_a', session, 'unsent');
    first.setView('prj_a', 'cost');
    first.select('prj_b');

    const second = new UiStateStore({ file });
    expect(second.view().currentProjectId).toBe('prj_b');
    expect(second.view().projects['prj_a']?.view).toBe('cost');
    expect(second.view().projects['prj_a']?.sessions[0]?.text).toBe('unsent');

    second.forget('prj_a');
    expect(second.view().projects['prj_a']).toBeUndefined();
    expect(second.view().projects['prj_b']).toBeDefined();
    const reloaded = new UiStateStore({ file });
    expect(reloaded.view().projects['prj_a']).toBeUndefined();
  });

  it('sets aside an unreadable file instead of overwriting it silently', async () => {
    const file = await tempFile('corrupt');
    await writeFile(file, '{ this is not json', 'utf8');
    const store = new UiStateStore({ file });
    const view = store.view();
    expect(view.projects).toEqual({});
    expect(view.warning).toContain('could not be read');
    const files = await readdir(path.dirname(file));
    expect(files.some((name) => name.includes('corrupt-'))).toBe(true);
    store.select('prj_a');
    const written = await readFile(file, 'utf8');
    expect(written).toContain('"schemaVersion": 1');
  });

  it('bounds draft text and session count', async () => {
    const file = await tempFile('bounds');
    const store = new UiStateStore({ file });
    store.select('prj_a');
    const session = store.view().projects['prj_a']?.currentSessionId as string;
    store.saveDraft('prj_a', session, 'x'.repeat(250_000));
    expect((store.view().projects['prj_a']?.sessions[0]?.text ?? '').length).toBe(200_000);

    for (let index = 0; index < 30; index += 1) store.newSession('prj_a');
    expect((store.view().projects['prj_a']?.sessions.length ?? 0) <= 20).toBe(true);
  });
});
