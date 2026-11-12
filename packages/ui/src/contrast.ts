/**
 * WCAG 2.x relative luminance and contrast ratio. Used by the audit test so the
 * palette is measured, not assumed.
 */
export type Rgb = { r: number; g: number; b: number };

export function parseHex(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, '');
  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((char) => `${char}${char}`)
          .join('')
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) throw new Error(`not a hex colour: ${hex}`);
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: Rgb | string): number {
  const rgb = typeof color === 'string' ? parseHex(color) : color;
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export type TokenMap = Record<string, string>;

/**
 * Read the literal custom properties from a stylesheet, per theme, so the audit
 * measures the shipped file rather than a hand-copied table that can drift.
 */
export function readTokens(source: string): { base: TokenMap; afterglow: TokenMap; compact: TokenMap } {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const base: TokenMap = {};
  const afterglow: TokenMap = {};
  const compact: TokenMap = {};
  const blocks: Array<{ selector: string; body: string }> = [];
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(css)) !== null) {
    const selector = (match[1] ?? '').trim();
    blocks.push({ selector, body: match[2] ?? '' });
  }
  for (const block of blocks) {
    const target = block.selector.includes("data-theme='afterglow'")
      ? afterglow
      : block.selector.includes("data-density='compact'")
        ? compact
        : block.selector === ':root'
          ? base
          : null;
    if (!target) continue;
    const declaration = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
    let declarationMatch: RegExpExecArray | null;
    while ((declarationMatch = declaration.exec(block.body)) !== null) {
      const name = declarationMatch[1];
      const value = (declarationMatch[2] ?? '').trim();
      if (!name || !value.startsWith('#')) continue;
      target[name] = value;
    }
  }
  return { base, afterglow, compact };
}

export type ContrastRequirement = {
  name: string;
  foreground: string;
  background: string;
  minimum: number;
};

export const AA_TEXT = 4.5;
export const AA_LARGE = 3;
export const AA_NON_TEXT = 3;

/** The requirements the shipped palette must satisfy in each theme. */
export function requirementsFor(theme: 'daybreak' | 'afterglow'): ContrastRequirement[] {
  const canvas = 'canvas';
  const surface = 'surface';
  return [
    { name: 'body ink on canvas', foreground: 'ink', background: canvas, minimum: AA_TEXT },
    { name: 'body ink on surface', foreground: 'ink', background: surface, minimum: AA_TEXT },
    { name: 'muted text on surface', foreground: 'muted', background: surface, minimum: AA_TEXT },
    { name: 'muted text on canvas', foreground: 'muted', background: canvas, minimum: AA_TEXT },
    { name: 'primary button label', foreground: 'primary-ink', background: 'primary', minimum: AA_TEXT },
    { name: 'primary link text on surface', foreground: 'primary', background: surface, minimum: AA_TEXT },
    { name: 'success text on success-soft', foreground: 'success', background: 'success-soft', minimum: AA_TEXT },
    {
      name: 'attention text on attention-soft',
      foreground: 'attention',
      background: 'attention-soft',
      minimum: AA_TEXT,
    },
    { name: 'critical text on critical-soft', foreground: 'critical', background: 'critical-soft', minimum: AA_TEXT },
    { name: 'info text on info-soft', foreground: 'info', background: 'info-soft', minimum: AA_TEXT },
    { name: 'focus ring on canvas', foreground: 'focus', background: canvas, minimum: AA_NON_TEXT },
    { name: 'focus ring on surface', foreground: 'focus', background: surface, minimum: AA_NON_TEXT },
    { name: 'interactive border on surface', foreground: 'border-strong', background: surface, minimum: AA_NON_TEXT },
    { name: 'badge text on surface-sunken', foreground: 'ink', background: 'surface-sunken', minimum: AA_TEXT },
    { name: `${theme} theme applied`, foreground: 'ink', background: 'surface', minimum: AA_TEXT },
  ];
}
