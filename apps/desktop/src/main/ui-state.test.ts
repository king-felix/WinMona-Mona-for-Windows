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
    expect(written).toContain('"schemaVersion": 2');
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

  it('saves the panel layout and last-seen marker per project', async () => {
    const file = await tempFile('layout');
    const store = new UiStateStore({ file, now: () => new Date('2026-11-12T10:00:00.000Z') });
    store.select('prj_a');
    expect(store.view().projects['prj_a']?.layout).toBe('standard');
    expect(store.markSeen('prj_a')).toBeNull();
    store.setLayout('prj_a', 'focus');
    expect(store.view().projects['prj_a']?.layout).toBe('focus');

    const later = new UiStateStore({ file, now: () => new Date('2026-11-12T11:00:00.000Z') });
    expect(later.view().projects['prj_a']?.layout).toBe('focus');
    expect(later.lastSeen('prj_a')).toBe('2026-11-12T10:00:00.000Z');
    expect(later.markSeen('prj_a')).toBe('2026-11-12T10:00:00.000Z');
    expect(later.lastSeen('prj_a')).toBe('2026-11-12T11:00:00.000Z');
  });

  it('stores prompt favorites without duplicating identical text', async () => {
    const file = await tempFile('favorites');
    const store = new UiStateStore({ file });
    store.select('prj_a');
    expect(() => store.saveFavorite('prj_a', { label: '', text: 'x' })).toThrow();
    expect(() => store.saveFavorite('prj_a', { label: 'empty', text: '   ' })).toThrow();
    store.saveFavorite('prj_a', { label: 'Review', text: 'Review the failing test.' });
    store.saveFavorite('prj_a', { label: 'Review again', text: 'Review the failing test.' });
    const favorites = store.view().projects['prj_a']?.favorites ?? [];
    expect(favorites).toHaveLength(1);
    expect(favorites[0]?.label).toBe('Review again');
    store.removeFavorite('prj_a', favorites[0]?.id as string);
    expect(store.view().projects['prj_a']?.favorites).toHaveLength(0);
  });

  it('validates quiet hours, timezone and density', async () => {
    const file = await tempFile('preferences');
    const store = new UiStateStore({ file });
    expect(store.preferences().quietHours).toMatchObject({ enabled: false, timeZone: 'local' });
    const updated = store.updatePreferences({
      notificationsEnabled: false,
      density: 'compact',
      quietHours: { enabled: true, startMinute: 21 * 60 + 30, endMinute: 6 * 60, timeZone: 'Asia/Tokyo' },
    });
    expect(updated).toMatchObject({ notificationsEnabled: false, density: 'compact' });
    expect(updated.quietHours).toMatchObject({ enabled: true, startMinute: 1290, timeZone: 'Asia/Tokyo' });
    expect(() => store.updatePreferences({ quietHours: { startMinute: -1 } })).toThrow();
    expect(() => store.updatePreferences({ quietHours: { timeZone: 'Mars/Olympus_Mons' } })).toThrow();
    expect(store.markFirstCloseNotified()).toBe(true);
    expect(store.markFirstCloseNotified()).toBe(false);
  });

  it('upgrades a v1 file without losing drafts', async () => {
    const file = await tempFile('upgrade');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        currentProjectId: 'prj_a',
        projects: {
          prj_a: {
            view: 'work',
            currentSessionId: 'ses_old',
            sessions: [{ sessionId: 'ses_old', updatedAt: '2026-11-11T00:00:00.000Z', text: 'kept' }],
            lastOpenedAt: '2026-11-11T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    const store = new UiStateStore({ file });
    expect(store.view().projects['prj_a']?.sessions[0]?.text).toBe('kept');
    expect(store.view().projects['prj_a']?.layout).toBe('standard');
    expect(store.view().projects['prj_a']?.favorites).toEqual([]);
    expect(store.view().preferences.density).toBe('comfortable');
    store.select('prj_a');
    expect(await readFile(file, 'utf8')).toContain('"schemaVersion": 2');
  });

  it('upgrades legacy favorites into versioned shelf prompts', async () => {
    const file = await tempFile('legacy-prompts');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        currentProjectId: null,
        preferences: {},
        projects: {
          prj_a: {
            view: 'studio',
            currentSessionId: 'ses_1',
            sessions: [],
            favorites: [
              {
                id: 'pfv_legacy',
                label: 'Legacy prompt',
                text: 'Review {{file}} for the failure.',
                createdAt: '2026-11-11T00:00:00.000Z',
              },
            ],
            lastOpenedAt: null,
          },
        },
      }),
      'utf8',
    );
    const store = new UiStateStore({ file });
    const legacy = store.view().projects['prj_a']?.favorites[0];
    expect(legacy).toMatchObject({ id: 'pfv_legacy', template: 'Review {{file}} for the failure.', version: 1 });
    expect(legacy?.variables).toEqual([]);
    expect(legacy?.history).toEqual([]);

    store.savePrompt('prj_a', {
      id: 'pfv_legacy',
      label: 'Legacy prompt v2',
      template: 'Review {{file}} for the failure and propose a fix.',
      variables: [{ name: 'file', description: 'Path', required: true, defaultValue: null }],
      acceptance: [{ id: 'acc_1', text: 'The failure is explained' }],
    });
    const revised = store.view().projects['prj_a']?.favorites[0];
    expect(revised?.version).toBe(2);
    expect(revised?.history).toHaveLength(1);
    expect(revised?.history[0]?.template).toBe('Review {{file}} for the failure.');
    expect(revised?.text).toBe('Review {{file}} for the failure and propose a fix.');

    const imported = store.importPrompts('prj_a', [
      {
        label: 'Imported prompt',
        description: 'From a pack',
        template: 'Summarize {{topic}}',
        variables: [{ name: 'topic', description: '', required: true, defaultValue: null }],
        acceptance: [],
        version: 3,
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:00.000Z',
        history: [],
      },
    ]);
    expect(imported.imported).toBe(1);
    const shelf = store.view().projects['prj_a']?.favorites ?? [];
    expect(shelf).toHaveLength(2);
    expect(shelf[0]).toMatchObject({ label: 'Imported prompt', version: 3 });
    expect(shelf[0]?.id).not.toBe('pfv_legacy');

    expect(() => store.savePrompt('prj_a', { label: '', template: 'x' })).toThrow();
  });
});
