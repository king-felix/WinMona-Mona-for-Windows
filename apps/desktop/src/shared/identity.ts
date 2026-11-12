export type IdentityProject = {
  id: string;
  label: string;
  color: string | null;
  monogram: string | null;
};

export const PROJECT_COLORS = [
  '#1F5F8B',
  '#7A3E8C',
  '#8C3B3B',
  '#2F6B4F',
  '#8A5A1F',
  '#33507A',
  '#6B3F5E',
  '#3F5F2F',
] as const;

/**
 * Project identity is curated locally: a stable color from the project id and
 * a monogram from its label. Victor can override either value in the catalog;
 * the derived pair is never written unless he saves it.
 */
export function projectIdentity(project: IdentityProject): { color: string; monogram: string } {
  const derived = PROJECT_COLORS[stableIndex(project.id, PROJECT_COLORS.length)] ?? PROJECT_COLORS[0];
  return {
    color: project.color ?? derived,
    monogram: project.monogram ?? monogramFor(project.label),
  };
}

export function monogramFor(label: string): string {
  const words = label
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'M';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
}

function stableIndex(value: string, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % length;
}
