/**
 * Slash-command vocabulary shared by the main and renderer processes.
 *
 * The catalog itself is generated from the pinned engine's own registry (see
 * `tools/build/slash-catalog.mjs`); this module holds only types and the
 * deterministic parsing/filtering rules. It makes no engine call and no model
 * call, and it never invents a command, description or route.
 */
export type SlashCostClass = 'none' | 'model' | 'unknown';

/**
 * How Mona can support a row:
 * - `mona`       a typed Mona operation exists for it
 * - `tui-only`   the engine implements it in its terminal UI only
 * - `unsupported` this platform/build does not provide it
 */
export type SlashRoute = 'mona' | 'tui-only' | 'unsupported';

export type SlashCommandRow = {
  /** Canonical name without the leading slash. */
  name: string;
  aliases: readonly string[];
  summary: string;
  usage: string;
  subcommands: readonly string[];
  takesArguments: boolean;
  /** The engine refuses the command without an argument. */
  requiresArgument: boolean;
  discovery: 'primary' | 'advanced';
  hidden: boolean;
  costClass: SlashCostClass;
  sideEffects: string;
  route: SlashRoute;
  routeNote: string;
};

export type CommandTokenContext = {
  /** What the person has typed after the slash. */
  query: string;
  /** Index of the slash that starts the token. */
  from: number;
  /** Exclusive end of the token; accepting a candidate replaces `from..to`. */
  to: number;
};

const COMMAND_CHARACTER = /[A-Za-z0-9_-]/;

/**
 * True only in a command position: the caret is inside the first token of a
 * line that begins with `/` at column 0. A drive path, a UNC path, a quoted
 * example, an indented code line and an escaped `\/` are all ordinary text.
 */
export function commandContext(text: string, caret: number): CommandTokenContext | null {
  if (caret < 0 || caret > text.length) return null;
  const lineStart = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  if (text[lineStart] !== '/') return null;
  const lineEnd = text.indexOf('\n', caret);
  const stop = lineEnd === -1 ? text.length : lineEnd;
  // The caret must still be in the first token: no whitespace between the slash
  // and the caret, so `/new ` (argument position) closes the list.
  for (let index = lineStart; index < caret; index += 1) {
    const character = text[index] ?? '';
    if (character === ' ' || character === '\t') return null;
    if (!COMMAND_CHARACTER.test(character) && character !== '/') return null;
  }
  let tokenEnd = stop;
  for (let index = lineStart + 1; index < stop; index += 1) {
    const character = text[index] ?? '';
    if (character === ' ' || character === '\t' || character === '\n') {
      tokenEnd = index;
      break;
    }
  }
  const query = text.slice(lineStart + 1, tokenEnd);
  // Any character outside a command name means a path or code (`/usr/bin/env`),
  // not a command.
  if (!/^[A-Za-z0-9_-]*$/.test(query)) return null;
  return { query, from: lineStart, to: tokenEnd };
}

export type CommandMatch = { row: SlashCommandRow; via: 'name' | 'alias' };

/** Exact match on a command name or alias, case-insensitively. */
export function matchCommand(rows: readonly SlashCommandRow[], token: string): CommandMatch | null {
  const wanted = token.trim().toLowerCase();
  if (!wanted) return null;
  for (const row of rows) {
    if (row.name.toLowerCase() === wanted) return { row, via: 'name' };
  }
  for (const row of rows) {
    if (row.aliases.some((alias) => alias.toLowerCase() === wanted)) return { row, via: 'alias' };
  }
  return null;
}

/**
 * Local prefix/substring filter. Empty query shows primary commands first.
 * Hidden rows only appear when their name or alias is actually typed.
 */
export function filterCommands(rows: readonly SlashCommandRow[], query: string, limit = 8): SlashCommandRow[] {
  const wanted = query.trim().toLowerCase();
  const scored: Array<{ row: SlashCommandRow; score: number }> = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    const aliases = row.aliases.map((alias) => alias.toLowerCase());
    let score: number | null = null;
    if (!wanted) {
      if (row.hidden) continue;
      score = row.discovery === 'primary' ? 0 : 1;
    } else if (name.startsWith(wanted)) {
      score = 0;
    } else if (aliases.some((alias) => alias.startsWith(wanted))) {
      score = 1;
    } else if (name.includes(wanted)) {
      score = 3;
    } else if (aliases.some((alias) => alias.includes(wanted))) {
      score = 4;
    } else if (row.summary.toLowerCase().includes(wanted)) {
      score = 6;
    }
    if (score !== null) scored.push({ row, score });
  }
  scored.sort((left, right) => left.score - right.score || left.row.name.localeCompare(right.row.name));
  return scored.slice(0, Math.max(1, limit)).map((entry) => entry.row);
}

export type CommandIntent =
  | { kind: 'literal'; /** Set when a leading `\/` escape was removed. */ unescaped: string | null }
  | { kind: 'ambiguous'; token: string; candidates: string[] }
  | {
      kind: 'command';
      row: SlashCommandRow;
      via: 'name' | 'alias';
      argument: string;
      /** The engine requires an argument and none was typed. */
      argumentMissing: boolean;
    };

/**
 * Decide what the composer is holding. Only the first line is considered, and
 * only when it begins with `/` at column 0. Everything else — prose, pasted
 * code, paths, quoted examples — is literal text.
 */
export function interpretCommandInput(text: string, rows: readonly SlashCommandRow[]): CommandIntent {
  if (text.startsWith('\\/')) {
    // An escaped slash is a deliberate literal spelling; the backslash is not
    // part of what the person wants to discuss.
    return { kind: 'literal', unescaped: text.slice(1) };
  }
  if (!text.startsWith('/')) return { kind: 'literal', unescaped: null };
  const lineEnd = text.indexOf('\n');
  const line = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(line.trimEnd());
  if (!match) return { kind: 'literal', unescaped: null };
  const token = match[1] ?? '';
  if (!token || token.includes('/')) return { kind: 'literal', unescaped: null };
  const argument = match[2] ?? '';
  const exact = matchCommand(rows, token);
  if (exact) {
    return {
      kind: 'command',
      row: exact.row,
      via: exact.via,
      argument,
      argumentMissing: exact.row.requiresArgument && argument.trim() === '',
    };
  }
  const prefix = token.toLowerCase();
  const candidates = rows
    .filter(
      (row) =>
        row.name.toLowerCase().startsWith(prefix) ||
        row.aliases.some((alias) => alias.toLowerCase().startsWith(prefix)),
    )
    .map((row) => row.name)
    .sort()
    .slice(0, 8);
  if (candidates.length > 0) return { kind: 'ambiguous', token, candidates };
  return { kind: 'literal', unescaped: null };
}

/** The text to insert when a candidate is accepted. */
export function acceptedCommand(row: SlashCommandRow): string {
  return `/${row.name}${row.takesArguments ? ' ' : ''}`;
}

/**
 * Truthful one-line description of what Mona can do with a row. Used by the
 * autocomplete list and by the composer's explanation when it refuses to send.
 */
export function routeSentence(row: SlashCommandRow): string {
  if (row.route === 'mona') return `Mona can run this command here. ${row.routeNote}`;
  if (row.route === 'unsupported') return `This build does not support this command. ${row.routeNote}`;
  return row.routeNote;
}
