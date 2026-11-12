import { describe, expect, it } from 'vitest';
import { LAUNCH_PROFILE, coerceLaunchCommand, parseLaunchCommand, stripLauncherArgs } from './cli.js';

const CWD = 'C:\\Work';

describe('launcher command line', () => {
  it('accepts the documented Explorer contract', () => {
    const command = parseLaunchCommand(
      ['project', 'open', '--path', 'C:\\Work\\Alpha', '--profile', LAUNCH_PROFILE],
      CWD,
      'win32',
    );
    expect(command).toEqual({
      kind: 'launch',
      usage: 'project-open',
      paths: ['C:\\Work\\Alpha'],
      profile: LAUNCH_PROFILE,
    });
  });

  it('accepts the --name=value form and keeps a path with spaces as one value', () => {
    const command = parseLaunchCommand(
      ['project', 'open', '--path=C:\\Work\\Mona Alpha', '--profile=ds-full-access'],
      CWD,
      'win32',
    );
    expect(command.kind).toBe('launch');
    if (command.kind !== 'launch') return;
    expect(command.paths).toEqual(['C:\\Work\\Mona Alpha']);
    expect(command.profile).toBe(LAUNCH_PROFILE);
  });

  it('keeps apostrophes, ampersands, parentheses and Unicode inert inside one path', () => {
    const folder = 'C:\\Work\\R&D (beta) — Victor\'s "notes" & more';
    const command = parseLaunchCommand(['project', 'open', '--path', folder], CWD, 'win32');
    expect(command.kind).toBe('launch');
    if (command.kind !== 'launch') return;
    expect(command.paths).toEqual([folder]);
    // A path is one argv element; nothing here is split on shell metacharacters.
    expect(command.paths).toHaveLength(1);
  });

  it('normalizes trailing separators and deduplicates case-insensitively on Windows', () => {
    const command = parseLaunchCommand(
      ['project', 'open', '--path', 'C:\\Work\\Alpha\\', '--path', 'c:\\work\\alpha'],
      CWD,
      'win32',
    );
    expect(command.kind).toBe('launch');
    if (command.kind !== 'launch') return;
    expect(command.paths).toEqual(['C:\\Work\\Alpha']);
  });

  it('keeps two different launch paths in the order the shell passed them', () => {
    const command = parseLaunchCommand(
      ['project', 'open', '--path', 'C:\\Work\\Beta', '--path', 'C:\\Work\\Alpha'],
      CWD,
      'win32',
    );
    expect(command.kind).toBe('launch');
    if (command.kind !== 'launch') return;
    expect(command.paths).toEqual(['C:\\Work\\Beta', 'C:\\Work\\Alpha']);
  });

  it('rejects a missing path instead of opening the owner’s own directory', () => {
    expect(parseLaunchCommand(['project', 'open'], CWD, 'win32')).toEqual({
      kind: 'invalid',
      problem: 'missing_path',
      detail: 'No folder was selected for Mona to open (--path <folder> is required).',
    });
    expect(parseLaunchCommand(['project', 'open', '--profile', LAUNCH_PROFILE], CWD, 'win32')).toMatchObject({
      kind: 'invalid',
      problem: 'missing_path',
    });
  });

  it('rejects a flag without a value rather than swallowing the next option', () => {
    expect(parseLaunchCommand(['project', 'open', '--path'], CWD, 'win32')).toMatchObject({
      kind: 'invalid',
      problem: 'missing_value',
    });
    expect(parseLaunchCommand(['project', 'open', '--path', '--profile', LAUNCH_PROFILE], CWD, 'win32')).toMatchObject({
      kind: 'invalid',
      problem: 'missing_value',
    });
  });

  it('rejects unknown options, unknown actions and stray positionals', () => {
    expect(
      parseLaunchCommand(['project', 'open', '--path', 'C:\\A', '--shell', 'calc.exe'], CWD, 'win32'),
    ).toMatchObject({ kind: 'invalid', problem: 'unknown_option' });
    expect(parseLaunchCommand(['project', 'delete', '--path', 'C:\\A'], CWD, 'win32')).toMatchObject({
      kind: 'invalid',
      problem: 'unknown_command',
    });
    expect(parseLaunchCommand(['project'], CWD, 'win32')).toMatchObject({
      kind: 'invalid',
      problem: 'missing_subcommand',
    });
    expect(parseLaunchCommand(['project', 'open', '--path', 'C:\\A', 'extra'], CWD, 'win32')).toMatchObject({
      kind: 'invalid',
      problem: 'unexpected_argument',
    });
  });

  it('refuses a profile Mona does not own instead of changing the saved route', () => {
    expect(
      parseLaunchCommand(['project', 'open', '--path', 'C:\\A', '--profile', 'other-account'], CWD, 'win32'),
    ).toMatchObject({ kind: 'invalid', problem: 'unsupported_profile' });
  });

  it('treats an ordinary app start and Electron switches as no launch request', () => {
    expect(parseLaunchCommand([], CWD, 'win32')).toEqual({ kind: 'app' });
    expect(parseLaunchCommand(['--smoke-test'], CWD, 'win32')).toEqual({ kind: 'app' });
    expect(parseLaunchCommand(['--catalog-test', '--trace-warnings'], CWD, 'win32')).toEqual({ kind: 'app' });
  });

  it('still accepts a bare path for the existing probe and lifecycle surfaces', () => {
    expect(parseLaunchCommand(['C:\\Work\\Alpha'], CWD, 'win32')).toEqual({
      kind: 'launch',
      usage: 'path',
      paths: ['C:\\Work\\Alpha'],
      profile: null,
    });
    expect(parseLaunchCommand(['--flag', 'C:\\Work\\Alpha'], CWD, 'win32')).toEqual({ kind: 'app' });
  });

  it('resolves relative selections against the working directory', () => {
    const command = parseLaunchCommand(['project', 'open', '--path', '..\\Sibling'], CWD, 'win32');
    expect(command.kind).toBe('launch');
    if (command.kind !== 'launch') return;
    expect(command.paths).toEqual(['C:\\Sibling']);
  });
});

describe('launcher argv normalization', () => {
  it('strips the executable and the app directory in an unpackaged run', () => {
    const argv = [
      'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      'C:\\repo\\apps\\desktop',
      'project',
      'open',
      '--path',
      'C:\\Work\\Alpha',
      '--profile',
      'ds-full-access',
    ];
    expect(
      stripLauncherArgs(argv, { isPackaged: false, appPath: 'C:\\repo\\apps\\desktop', platform: 'win32' }),
    ).toEqual(['project', 'open', '--path', 'C:\\Work\\Alpha', '--profile', 'ds-full-access']);
    // The second-instance argv has the same shape.
    expect(
      stripLauncherArgs(argv, { isPackaged: false, appPath: 'c:\\REPO\\apps\\desktop', platform: 'win32' }).slice(0, 2),
    ).toEqual(['project', 'open']);
  });

  it('strips only the executable in a packaged run', () => {
    const argv = ['C:\\Program Files\\Mona\\Mona.exe', 'project', 'open', '--path', 'C:\\Work\\Alpha'];
    expect(stripLauncherArgs(argv, { isPackaged: true, platform: 'win32' })).toEqual([
      'project',
      'open',
      '--path',
      'C:\\Work\\Alpha',
    ]);
  });

  it('strips the packaged app directory Electron puts before the arguments', () => {
    // Observed shape for the installed app and for its second-instance argv.
    const appPath = 'C:\\Users\\v\\AppData\\Local\\Programs\\Mona\\resources\\app';
    const argv = [
      'C:\\Users\\v\\AppData\\Local\\Programs\\Mona\\Mona.exe',
      appPath,
      'project',
      'open',
      '--path',
      "C:\\Work\\a & b (café) — 'q'",
      '--profile',
      'ds-full-access',
    ];
    expect(stripLauncherArgs(argv, { isPackaged: true, appPath, platform: 'win32' })).toEqual([
      'project',
      'open',
      '--path',
      "C:\\Work\\a & b (café) — 'q'",
      '--profile',
      'ds-full-access',
    ]);
  });

  it('keeps a folder that merely resembles the app directory', () => {
    const appPath = 'C:\\Programs\\Mona\\resources\\app';
    const argv = ['Mona.exe', 'C:\\Programs\\Mona\\resources\\application', 'project', 'open'];
    expect(stripLauncherArgs(argv, { isPackaged: true, appPath, platform: 'win32' })).toEqual([
      'C:\\Programs\\Mona\\resources\\application',
      'project',
      'open',
    ]);
  });

  it('treats electron . as the app argument, not as a folder to open', () => {
    expect(
      stripLauncherArgs(['electron.exe', '.', 'C:\\Work\\Alpha'], { isPackaged: false, platform: 'win32' }),
    ).toEqual(['C:\\Work\\Alpha']);
  });
});

describe('launcher data across the single-instance boundary', () => {
  it('round-trips a parsed command as structured data', () => {
    const command = parseLaunchCommand(['project', 'open', '--path', 'C:\\Work\\R&D'], CWD, 'win32');
    expect(command.kind).toBe('launch');
    expect(coerceLaunchCommand(JSON.parse(JSON.stringify(command)))).toEqual(command);
  });

  it('refuses data that is not a launcher command', () => {
    expect(coerceLaunchCommand(null)).toBeNull();
    expect(coerceLaunchCommand('project open')).toBeNull();
    expect(coerceLaunchCommand({ kind: 'launch', usage: 'project-open', paths: [], profile: null })).toBeNull();
    expect(coerceLaunchCommand({ kind: 'launch', usage: 'project-open', paths: ['', 3], profile: null })).toBeNull();
    expect(
      coerceLaunchCommand({
        kind: 'launch',
        usage: 'project-open',
        paths: ['C:\\A'],
        profile: 'not a profile!',
      }),
    ).toBeNull();
    expect(coerceLaunchCommand({ kind: 'invalid', problem: 'made_up', detail: 'x' })).toBeNull();
    expect(coerceLaunchCommand({ kind: 'app' })).toEqual({ kind: 'app' });
  });
});
