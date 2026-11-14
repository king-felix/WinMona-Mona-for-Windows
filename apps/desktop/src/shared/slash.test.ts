import { describe, expect, it } from 'vitest';
import {
  acceptedCommand,
  commandContext,
  filterCommands,
  interpretCommandInput,
  matchCommand,
  routeSentence,
  type SlashCommandRow,
} from './slash.js';

function row(overrides: Partial<SlashCommandRow> & { name: string }): SlashCommandRow {
  return {
    aliases: [],
    summary: `${overrides.name} summary`,
    usage: `/${overrides.name}`,
    subcommands: [],
    takesArguments: false,
    requiresArgument: false,
    discovery: 'primary',
    hidden: false,
    costClass: 'none',
    sideEffects: 'Reads local state.',
    route: 'tui-only',
    routeNote: 'The engine implements this in its terminal UI.',
    ...overrides,
  };
}

const rows: SlashCommandRow[] = [
  row({ name: 'model', aliases: ['moxing'], takesArguments: true, usage: '/model [name|refresh]' }),
  row({ name: 'models', aliases: ['moxingliebiao'] }),
  row({ name: 'compact', aliases: ['yasuo'], costClass: 'model', takesArguments: true }),
  row({ name: 'context', aliases: ['ctx'], discovery: 'advanced' }),
  row({
    name: 'review',
    aliases: ['shencha'],
    requiresArgument: true,
    takesArguments: true,
    usage: '/review <target>',
  }),
  row({ name: 'secret', hidden: true, discovery: 'advanced' }),
];

describe('command position', () => {
  it('opens in the first token of a line that starts with a slash', () => {
    expect(commandContext('/', 1)).toEqual({ query: '', from: 0, to: 1 });
    expect(commandContext('/mo', 3)).toEqual({ query: 'mo', from: 0, to: 3 });
    expect(commandContext('first line\n/com', 15)).toEqual({ query: 'com', from: 11, to: 15 });
  });

  it('stays open when the caret is in the middle of the token', () => {
    expect(commandContext('/model now', 4)).toEqual({ query: 'model', from: 0, to: 6 });
  });

  it('closes once the argument position is reached', () => {
    expect(commandContext('/model ', 7)).toBeNull();
    expect(commandContext('/model now', 9)).toBeNull();
  });

  it('treats prose, code, paths and quoted examples as ordinary text', () => {
    expect(commandContext('/usr/bin/env node', 6)).toBeNull();
    expect(commandContext('Run this later: /new', 20)).toBeNull();
    expect(commandContext('  /new', 6)).toBeNull();
    expect(commandContext('> /new', 6)).toBeNull();
    expect(commandContext('"/new"', 3)).toBeNull();
    expect(commandContext('\\/new', 5)).toBeNull();
    expect(commandContext('C:\\Users\\me', 6)).toBeNull();
    expect(commandContext('\\\\server\\share', 6)).toBeNull();
  });

  it('does not open on a later line that begins with a Windows path', () => {
    expect(commandContext('See C:\\work\nmore', 16)).toBeNull();
  });
});

describe('local filtering', () => {
  it('ranks names before aliases before descriptions and hides hidden rows by default', () => {
    expect(filterCommands(rows, 'mo').map((entry) => entry.name)).toEqual(['model', 'models']);
    expect(filterCommands(rows, 'moxing').map((entry) => entry.name)).toEqual(['model', 'models']);
    expect(filterCommands(rows, 'secret').map((entry) => entry.name)).toEqual(['secret']);
    expect(filterCommands(rows, '').map((entry) => entry.name)).not.toContain('secret');
  });

  it('matches on an alias and on descriptive text', () => {
    expect(filterCommands(rows, 'ctx').map((entry) => entry.name)).toEqual(['context']);
    expect(filterCommands(rows, 'compact').map((entry) => entry.name)).toEqual(['compact']);
    expect(filterCommands(rows, 'summary').length).toBeGreaterThan(0);
  });

  it('bounds the list', () => {
    expect(filterCommands(rows, '', 2)).toHaveLength(2);
  });
});

describe('command resolution', () => {
  it('resolves names and aliases, and refuses unknown tokens', () => {
    expect(matchCommand(rows, 'model')?.via).toBe('name');
    expect(matchCommand(rows, 'MOXING')?.row.name).toBe('model');
    expect(matchCommand(rows, 'nope')).toBeNull();
  });

  it('fills a name plus a trailing space only when it takes arguments', () => {
    expect(acceptedCommand(rows[0] as SlashCommandRow)).toBe('/model ');
    expect(acceptedCommand(rows[1] as SlashCommandRow)).toBe('/models');
  });
});

describe('composer intent', () => {
  it('recognizes an exact command and reports a missing required argument', () => {
    const intent = interpretCommandInput('/review', rows);
    expect(intent.kind).toBe('command');
    if (intent.kind !== 'command') return;
    expect(intent.row.name).toBe('review');
    expect(intent.argumentMissing).toBe(true);

    const withArgument = interpretCommandInput('/review src/app.ts', rows);
    expect(withArgument.kind).toBe('command');
    if (withArgument.kind === 'command') expect(withArgument.argument).toBe('src/app.ts');
  });

  it('recognizes an alias', () => {
    const intent = interpretCommandInput('/moxing deepseek-flash', rows);
    expect(intent.kind).toBe('command');
    if (intent.kind === 'command') expect(intent.via).toBe('alias');
  });

  it('reports an ambiguous prefix instead of guessing', () => {
    const intent = interpretCommandInput('/mod', rows);
    expect(intent).toEqual({ kind: 'ambiguous', token: 'mod', candidates: ['model', 'models'] });
  });

  it('leaves prose, unknown words, paths and code literal', () => {
    expect(interpretCommandInput('Please run the tests', rows)).toEqual({ kind: 'literal', unescaped: null });
    expect(interpretCommandInput('/unknown-thing', rows)).toEqual({ kind: 'literal', unescaped: null });
    expect(interpretCommandInput('/usr/bin/env node', rows)).toEqual({ kind: 'literal', unescaped: null });
    expect(interpretCommandInput('C:\\work\\mona', rows)).toEqual({ kind: 'literal', unescaped: null });
    expect(interpretCommandInput('const x = 1; // note', rows)).toEqual({ kind: 'literal', unescaped: null });
  });

  it('treats a leading backslash as an explicit escape', () => {
    expect(interpretCommandInput('\\/new', rows)).toEqual({ kind: 'literal', unescaped: '/new' });
  });

  it('only reads the first line as a command', () => {
    const intent = interpretCommandInput('/model\nwhat does this do?', rows);
    expect(intent.kind).toBe('command');
  });

  it('describes the route truthfully', () => {
    expect(routeSentence(row({ name: 'new', route: 'mona', routeNote: 'Mona can start a fresh thread.' }))).toContain(
      'Mona can run this command here',
    );
    expect(routeSentence(row({ name: 'x', route: 'tui-only' }))).toContain('terminal UI');
    expect(routeSentence(row({ name: 'y', route: 'unsupported', routeNote: 'Not on Windows.' }))).toContain(
      'does not support',
    );
  });
});
