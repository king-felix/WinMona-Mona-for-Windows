import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stateError } from './errors.js';

/**
 * Prompt shelf documents and portable prompt packs.
 *
 * Everything here is inert: parsing, rendering and previewing a prompt never
 * contacts the engine, never submits a turn and never executes the text. The
 * preview is the exact string the composer would receive, including the
 * acceptance checklist, with a digest so a stored preview and a sent prompt can
 * be compared without trusting a summary.
 */

export const PROMPT_LIMITS = {
  label: 120,
  description: 1_000,
  template: 20_000,
  variables: 24,
  acceptance: 50,
  history: 10,
  packPrompts: 200,
} as const;

const VariableName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;

export const PromptVariable = z
  .object({
    name: z.string().regex(VariableName),
    description: z.string().max(500).default(''),
    required: z.boolean().default(true),
    defaultValue: z.string().max(2_000).nullable().default(null),
  })
  .strict();
export type PromptVariable = z.infer<typeof PromptVariable>;

export const PromptAcceptance = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(500),
  })
  .strict();
export type PromptAcceptance = z.infer<typeof PromptAcceptance>;

export const PromptVersionSnapshot = z
  .object({
    version: z.number().int().min(1),
    template: z.string().max(PROMPT_LIMITS.template),
    variables: z.array(PromptVariable).max(PROMPT_LIMITS.variables),
    acceptance: z.array(PromptAcceptance).max(PROMPT_LIMITS.acceptance),
    replacedAt: z.string().min(1),
  })
  .strict();
export type PromptVersionSnapshot = z.infer<typeof PromptVersionSnapshot>;

export const ShelfPrompt = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(PROMPT_LIMITS.label),
    description: z.string().max(PROMPT_LIMITS.description).default(''),
    template: z.string().min(1).max(PROMPT_LIMITS.template),
    variables: z.array(PromptVariable).max(PROMPT_LIMITS.variables).default([]),
    acceptance: z.array(PromptAcceptance).max(PROMPT_LIMITS.acceptance).default([]),
    version: z.number().int().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    history: z.array(PromptVersionSnapshot).max(PROMPT_LIMITS.history).default([]),
  })
  .strict();
export type ShelfPrompt = z.infer<typeof ShelfPrompt>;

export const PromptPackEntry = z
  .object({
    label: z.string().min(1).max(PROMPT_LIMITS.label),
    description: z.string().max(PROMPT_LIMITS.description).default(''),
    template: z.string().min(1).max(PROMPT_LIMITS.template),
    variables: z.array(PromptVariable).max(PROMPT_LIMITS.variables).default([]),
    acceptance: z.array(PromptAcceptance).max(PROMPT_LIMITS.acceptance).default([]),
    version: z.number().int().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    history: z.array(PromptVersionSnapshot).max(PROMPT_LIMITS.history).default([]),
  })
  .strict();
export type PromptPackEntry = z.infer<typeof PromptPackEntry>;

export const PromptPack = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('mona.prompt-pack'),
    exported_at: z.string().min(1),
    prompts: z.array(PromptPackEntry).max(PROMPT_LIMITS.packPrompts),
    /** sha256 over the canonical JSON of everything except this field. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PromptPack = z.infer<typeof PromptPack>;

function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sort(record[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

export type TemplateAnalysis = {
  /** Variables used in the template, in first-appearance order. */
  used: string[];
  /** Placeholders that are not a valid variable name. */
  malformed: string[];
};

export function analyzeTemplate(template: string): TemplateAnalysis {
  const used: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !used.includes(name)) used.push(name);
  }
  const malformed: string[] = [];
  const open = /\{\{([^}]*)\}\}/g;
  for (const match of template.matchAll(open)) {
    const body = (match[1] ?? '').trim();
    if (!VariableName.test(body)) malformed.push(`{{${body}}}`);
  }
  const dangling = template.replace(PLACEHOLDER, '');
  if (/\{\{/.test(dangling) || /\}\}/.test(dangling)) {
    for (const match of dangling.matchAll(/\{\{[^}]*$|\{\{/g)) malformed.push(match[0] ?? '{{');
    if (/\}\}/.test(dangling)) malformed.push('}}');
  }
  return { used, malformed: [...new Set(malformed)].slice(0, 20) };
}

export type PromptRender = {
  /** The exact text, including any appended acceptance checklist. */
  text: string;
  sha256: string;
  characters: number;
  /** Required variables with no supplied value and no default. */
  missing: string[];
  /** Used placeholders with no declared variable and no supplied value. */
  undeclared: string[];
  /** Declared variables the template does not use. */
  unused: string[];
  /** Supplied values whose variable is not used by the template. */
  unknownValues: string[];
  malformed: string[];
  usedVariables: string[];
  acceptance: PromptAcceptance[];
  /** True only when the text is complete enough to insert into the composer. */
  ready: boolean;
  notes: string[];
};

/**
 * Render one prompt with variable values and append the acceptance checklist.
 * Missing values remain visible as `{{name}}` so a preview cannot look finished
 * when it is not.
 */
export function renderPrompt(
  prompt: Pick<ShelfPrompt, 'template' | 'variables' | 'acceptance'>,
  values: Record<string, string | undefined> = {},
): PromptRender {
  const analysis = analyzeTemplate(prompt.template);
  const declared = new Map(prompt.variables.map((variable) => [variable.name, variable]));
  const missing: string[] = [];
  const supplied = new Map<string, string>();
  const undeclared: string[] = [];

  for (const name of analysis.used) {
    const provided = values[name];
    const variable = declared.get(name);
    const value = typeof provided === 'string' && provided.trim().length > 0 ? provided : null;
    if (value !== null) {
      supplied.set(name, value);
      continue;
    }
    if (variable?.defaultValue !== null && variable?.defaultValue !== undefined && variable.defaultValue.length > 0) {
      supplied.set(name, variable.defaultValue);
      continue;
    }
    if (variable === undefined) undeclared.push(name);
    if (variable === undefined || variable.required) missing.push(name);
    if (!supplied.has(name)) supplied.set(name, `{{${name}}}`);
  }

  const rendered = prompt.template.replace(PLACEHOLDER, (whole, name: string) => supplied.get(name) ?? whole);
  const acceptance = prompt.acceptance ?? [];
  const includesChecklist = /##\s*acceptance criteria/i.test(prompt.template);
  const checklist =
    acceptance.length > 0 && !includesChecklist
      ? `\n\n## Acceptance criteria\n${acceptance.map((criterion) => `- [ ] ${criterion.text}`).join('\n')}\n`
      : '';
  const text = `${rendered.trimEnd()}${checklist}`;
  const used = new Set(analysis.used);
  const notes = [
    'This is the exact text inserted into the composer. Nothing is sent until Submit.',
    'No project document, engine history or hidden context is appended by the shelf.',
  ];
  if (includesChecklist && acceptance.length > 0) {
    notes.push('The template already contains an acceptance section, so the checklist was not appended twice.');
  }
  if (analysis.malformed.length > 0) {
    notes.push('The template has a malformed placeholder; fix it before use.');
  }

  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    characters: text.length,
    missing,
    undeclared,
    unused: [...declared.keys()].filter((name) => !used.has(name)),
    unknownValues: Object.keys(values).filter((name) => !used.has(name)),
    malformed: analysis.malformed,
    usedVariables: analysis.used,
    acceptance,
    ready: missing.length === 0 && analysis.malformed.length === 0 && text.length <= PROMPT_LIMITS.template + 4_000,
    notes,
  };
}

export type PromptPatch = {
  label?: string;
  description?: string;
  template?: string;
  variables?: PromptVariable[];
  acceptance?: PromptAcceptance[];
};

/**
 * Version a shelf prompt. A content change appends a bounded snapshot of the
 * previous version; nothing rewrites history, and a no-op patch does not claim
 * a new version.
 */
export function revisePrompt(
  prompt: ShelfPrompt,
  patch: PromptPatch,
  now: string,
): { prompt: ShelfPrompt; changed: boolean } {
  const next = {
    ...prompt,
    label: patch.label === undefined ? prompt.label : boundedText(patch.label, PROMPT_LIMITS.label, 'label'),
    description:
      patch.description === undefined
        ? prompt.description
        : boundedText(patch.description, PROMPT_LIMITS.description, 'description', true),
    template:
      patch.template === undefined ? prompt.template : boundedText(patch.template, PROMPT_LIMITS.template, 'template'),
    variables: patch.variables ?? prompt.variables,
    acceptance: patch.acceptance ?? prompt.acceptance,
  };
  const contentChanged =
    next.label !== prompt.label ||
    next.description !== prompt.description ||
    next.template !== prompt.template ||
    JSON.stringify(next.variables) !== JSON.stringify(prompt.variables) ||
    JSON.stringify(next.acceptance) !== JSON.stringify(prompt.acceptance);
  if (!contentChanged) return { prompt, changed: false };
  const history: PromptVersionSnapshot[] = [
    {
      version: prompt.version,
      template: prompt.template,
      variables: prompt.variables,
      acceptance: prompt.acceptance,
      replacedAt: now,
    },
    ...prompt.history,
  ].slice(0, PROMPT_LIMITS.history);
  return {
    prompt: {
      ...next,
      id: prompt.id,
      version: prompt.version + 1,
      createdAt: prompt.createdAt,
      updatedAt: now,
      history,
    },
    changed: true,
  };
}

function boundedText(value: string, max: number, name: string, allowEmpty = false): string {
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw stateError('invalid_request', `A prompt needs a ${name}.`);
  if (value.length > max) {
    throw stateError('oversize', `The prompt ${name} is ${value.length} characters; the bound is ${max}.`);
  }
  return value;
}

export function digestOfPromptPack(document: Omit<PromptPack, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

export function buildPromptPack(prompts: readonly ShelfPrompt[], exportedAt = new Date().toISOString()): PromptPack {
  if (prompts.length > PROMPT_LIMITS.packPrompts) {
    throw stateError('oversize', `A prompt pack may hold at most ${PROMPT_LIMITS.packPrompts} prompts.`);
  }
  const body = {
    schema_version: 1 as const,
    kind: 'mona.prompt-pack' as const,
    exported_at: exportedAt,
    prompts: prompts.map((prompt): PromptPackEntry => ({
      label: prompt.label,
      description: prompt.description,
      template: prompt.template,
      variables: prompt.variables,
      acceptance: prompt.acceptance,
      version: prompt.version,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
      history: prompt.history,
    })),
  };
  return { ...body, digest: digestOfPromptPack(body) };
}

/**
 * Validate a prompt pack without applying it. The caller decides whether to
 * save the prompts; nothing here touches the shelf, the store or the engine.
 */
export function parsePromptPack(raw: unknown): { pack: PromptPack; entries: PromptPackEntry[] } {
  const parsed = PromptPack.safeParse(raw);
  if (!parsed.success) {
    throw stateError(
      'invalid_request',
      'The file is not a Mona prompt pack.',
      parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  const { digest, ...body } = parsed.data;
  if (digestOfPromptPack(body) !== digest) {
    throw stateError('digest_mismatch', 'The prompt pack digest does not match its contents.');
  }
  return { pack: parsed.data, entries: parsed.data.prompts };
}
