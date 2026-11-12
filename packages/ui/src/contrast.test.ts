import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens, requirementsFor, type TokenMap } from './contrast.js';

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
const tokens = readTokens(css);

function value(tokensForTheme: TokenMap, name: string): string {
  const found = tokensForTheme[name];
  if (!found) throw new Error(`token --${name} is not defined in the measured stylesheet`);
  return found;
}

describe('measured contrast', () => {
  it('parses the shipped token file rather than a copied table', () => {
    expect(Object.keys(tokens.base).length).toBeGreaterThan(20);
    expect(tokens.base['ink']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokens.afterglow['canvas']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokens.base['canvas']).not.toBe(tokens.afterglow['canvas']);
  });

  for (const theme of ['daybreak', 'afterglow'] as const) {
    it(`${theme} meets WCAG AA for every declared pair`, () => {
      const themeTokens = theme === 'daybreak' ? tokens.base : { ...tokens.base, ...tokens.afterglow };
      const failures = requirementsFor(theme)
        .map((requirement) => ({
          name: requirement.name,
          ratio: contrastRatio(value(themeTokens, requirement.foreground), value(themeTokens, requirement.background)),
          minimum: requirement.minimum,
        }))
        .filter((entry) => entry.ratio < entry.minimum)
        .map((entry) => `${entry.name}: ${entry.ratio.toFixed(2)} < ${entry.minimum}`);
      expect(failures).toEqual([]);
    });
  }

  it('keeps body text at AAA on the primary surface in both themes', () => {
    expect(contrastRatio(tokens.base['ink'] as string, tokens.base['surface'] as string)).toBeGreaterThanOrEqual(7);
    expect(
      contrastRatio(tokens.afterglow['ink'] as string, tokens.afterglow['surface'] as string),
    ).toBeGreaterThanOrEqual(7);
  });

  it('never uses the decorative accents as status text colours', () => {
    // Coral and sea glass are decoration; the status tokens are separate and
    // measured. This guards against a later palette edit conflating them.
    expect(tokens.base['accent-coral']).not.toBe(tokens.base['critical']);
    expect(tokens.base['accent-sea']).not.toBe(tokens.base['success']);
    const coralOnWhite = contrastRatio(tokens.base['accent-coral'] as string, '#ffffff');
    expect(coralOnWhite).toBeLessThan(4.5);
  });

  it('distinguishes both themes by more than hue alone', () => {
    expect(contrastRatio(tokens.base['canvas'] as string, tokens.afterglow['canvas'] as string)).toBeGreaterThan(10);
  });
});
