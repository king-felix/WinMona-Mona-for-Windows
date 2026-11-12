import { describe, expect, it } from 'vitest';
import {
  analyzeTemplate,
  buildPromptPack,
  digestOfPromptPack,
  parsePromptPack,
  renderPrompt,
  revisePrompt,
  type ShelfPrompt,
} from './prompts.js';

function basePrompt(overrides: Partial<ShelfPrompt> = {}): ShelfPrompt {
  return {
    id: 'pfv_1',
    label: 'Review the failing test',
    description: 'Ask for a focused correction without sending anything.',
    template: 'Review {{file}} for the failure in {{suite}}.',
    variables: [
      { name: 'file', description: 'Path to review', required: true, defaultValue: null },
      { name: 'suite', description: 'Test suite', required: true, defaultValue: 'unit' },
      { name: 'tone', description: 'Unused', required: false, defaultValue: null },
    ],
    acceptance: [
      { id: 'acc_1', text: 'The failing assertion is explained' },
      { id: 'acc_2', text: 'A targeted fix is proposed' },
    ],
    version: 1,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    history: [],
    ...overrides,
  };
}

describe('prompt rendering and preview', () => {
  it('renders variables, applies defaults, and appends the acceptance checklist', () => {
    const prompt = basePrompt();
    const preview = renderPrompt(prompt, { file: 'src/app.test.ts' });
    expect(preview.text.trimEnd()).toBe(
      [
        'Review src/app.test.ts for the failure in unit.',
        '',
        '## Acceptance criteria',
        '- [ ] The failing assertion is explained',
        '- [ ] A targeted fix is proposed',
      ].join('\n'),
    );
    expect(preview.missing).toEqual([]);
    expect(preview.ready).toBe(true);
    expect(preview.acceptance).toHaveLength(2);
    expect(preview.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.characters).toBe(preview.text.length);
    expect(preview.notes.join(' ')).toContain('Nothing is sent until Submit');
  });

  it('keeps missing placeholders visible and reports them', () => {
    const prompt = basePrompt({ variables: [] });
    const preview = renderPrompt(prompt, {});
    expect(preview.missing).toEqual(['file', 'suite']);
    expect(preview.undeclared).toEqual(['file', 'suite']);
    expect(preview.ready).toBe(false);
    expect(preview.text).toContain('{{file}}');
  });

  it('does not duplicate an acceptance section that the template already has', () => {
    const prompt = basePrompt({
      template: 'Review {{file}}.\n\n## Acceptance criteria\n- [ ] Already written down',
    });
    const preview = renderPrompt(prompt, { file: 'a.ts' });
    const occurrences = preview.text.match(/## Acceptance criteria/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(preview.notes.join(' ')).toContain('not appended twice');
  });

  it('reports malformed placeholders instead of pretending the preview is ready', () => {
    expect(analyzeTemplate('Do {{good}} and {{bad name}} and {{unclosed').malformed.length).toBeGreaterThan(0);
    const preview = renderPrompt(basePrompt({ template: 'Review {{bad name}}', variables: [] }), {});
    expect(preview.ready).toBe(false);
    expect(preview.malformed.length).toBeGreaterThan(0);
  });

  it('reports unused variables and unknown supplied values', () => {
    const preview = renderPrompt(basePrompt(), { file: 'a.ts', suite: 'unit', extra: 'ignored' });
    expect(preview.unused).toEqual(['tone']);
    expect(preview.unknownValues).toEqual(['extra']);
  });
});

describe('prompt versioning', () => {
  it('bumps the version and keeps a bounded history on a real change', () => {
    const original = basePrompt();
    const revised = revisePrompt(original, { template: 'Review {{file}} carefully.' }, '2026-11-12T11:00:00.000Z');
    expect(revised.changed).toBe(true);
    expect(revised.prompt.version).toBe(2);
    expect(revised.prompt.history).toHaveLength(1);
    expect(revised.prompt.history[0]).toMatchObject({ version: 1, template: original.template });
    expect(revised.prompt.updatedAt).toBe('2026-11-12T11:00:00.000Z');
    expect(revised.prompt.createdAt).toBe(original.createdAt);

    let rolling = revised.prompt;
    for (let index = 0; index < 12; index += 1) {
      rolling = revisePrompt(
        rolling,
        { description: `Revision ${index}` },
        `2026-11-12T12:00:0${index % 10}.000Z`,
      ).prompt;
    }
    expect(rolling.version).toBe(14);
    expect(rolling.history).toHaveLength(10);
    expect(rolling.history[0]?.version).toBe(13);
  });

  it('does not claim a version for an unchanged prompt', () => {
    const original = basePrompt();
    const unchanged = revisePrompt(
      original,
      { label: original.label, template: original.template },
      '2026-11-12T11:00:00.000Z',
    );
    expect(unchanged.changed).toBe(false);
    expect(unchanged.prompt).toBe(original);
  });
});

describe('prompt packs are inert and digest-checked', () => {
  it('round-trips a pack and verifies its digest', () => {
    const pack = buildPromptPack([basePrompt()], '2026-11-12T12:00:00.000Z');
    expect(pack.kind).toBe('mona.prompt-pack');
    expect(pack.prompts[0]).not.toHaveProperty('id');
    const parsed = parsePromptPack(JSON.parse(JSON.stringify(pack)));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.label).toBe('Review the failing test');
    expect(parsed.entries[0]?.version).toBe(1);
  });

  it('rejects a tampered pack and a pack-shaped stranger', () => {
    const pack = buildPromptPack([basePrompt()], '2026-11-12T12:00:00.000Z');
    const tampered = { ...pack, prompts: [{ ...pack.prompts[0], template: 'Do something else entirely.' }] };
    expect(() => parsePromptPack(tampered)).toThrowError(/digest/i);
    expect(() => parsePromptPack({ kind: 'something-else' })).toThrowError(/not a Mona prompt pack/i);
  });

  it('is deterministic for the same content', () => {
    const first = buildPromptPack([basePrompt()], '2026-11-12T12:00:00.000Z');
    const second = buildPromptPack([basePrompt()], '2026-11-12T12:00:00.000Z');
    expect(second.digest).toBe(first.digest);
    const { digest, ...body } = first;
    expect(digestOfPromptPack(body)).toBe(digest);
  });

  it('does not reject or execute prompt text that looks like a command', () => {
    const pack = buildPromptPack(
      [
        basePrompt({
          template: 'Run {{cmd}} and then delete everything.',
          variables: [{ name: 'cmd', description: '', required: true, defaultValue: null }],
        }),
      ],
      '2026-11-12T12:00:00.000Z',
    );
    const parsed = parsePromptPack(pack);
    expect(parsed.entries[0]?.template).toContain('delete everything');
    // Parsing returns text. Nothing else happened: no store, engine or process
    // is involved in this module at all.
    expect(parsed.entries).toHaveLength(1);
  });
});
