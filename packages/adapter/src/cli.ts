/**
 * Mona's launcher command line. The contract is the one in spec section 14:
 *
 *   Mona.exe project open --path <selected-folder> --profile ds-full-access
 *
 * Arguments arrive from the OS shell as separate argv elements. A selected path
 * is data: this parser never joins arguments into a command string and never
 * touches the filesystem. Validation of the folder itself belongs to the
 * desktop launcher, which can report honest failures.
 */
import path from 'node:path';

export const LAUNCH_PROFILE = 'ds-full-access';

export type LaunchArgumentProblem =
  | 'missing_subcommand'
  | 'unknown_command'
  | 'missing_path'
  | 'missing_value'
  | 'unknown_option'
  | 'unexpected_argument'
  | 'unsupported_profile';

export type LaunchCommand =
  | {
      kind: 'launch';
      /** `project-open` is the documented contract; `path` is a bare-path fallback. */
      usage: 'project-open' | 'path';
      paths: string[];
      profile: string | null;
    }
  | { kind: 'app' }
  | { kind: 'invalid'; problem: LaunchArgumentProblem; detail: string };

function pathApi(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isSwitch(value: string): boolean {
  return value.startsWith('-');
}

/** Keep the spelling the shell passed; compare case-insensitively on Windows. */
function pathKey(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function dedupe(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of paths) {
    const key = pathKey(entry, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function resolvePath(value: string, cwd: string, platform: NodeJS.Platform): string {
  return pathApi(platform).resolve(cwd, value);
}

/** Short, safe rendering of an unexpected token in a diagnosis. */
function describeToken(value: string, limit = 80): string {
  const printable = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? '?' : character;
    })
    .join('');
  return printable.length > limit ? `${printable.slice(0, limit)}…` : printable;
}

function invalid(problem: LaunchArgumentProblem, detail: string): LaunchCommand {
  return { kind: 'invalid', problem, detail };
}

function parseProjectOpen(args: readonly string[], cwd: string, platform: NodeJS.Platform): LaunchCommand {
  const action = args[1];
  if (action === undefined) {
    return invalid('missing_subcommand', 'The project command needs an action: project open --path <folder>.');
  }
  if (action !== 'open') {
    return invalid(
      'unknown_command',
      `Unsupported project action "${describeToken(action)}"; Mona supports "project open".`,
    );
  }

  const paths: string[] = [];
  let profile: string | null = null;

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--path' || arg.startsWith('--path=')) {
      const inline = arg.startsWith('--path=') ? arg.slice('--path='.length) : undefined;
      const value = inline ?? args[index + 1];
      if (value === undefined || value === '' || (inline === undefined && isSwitch(value))) {
        return invalid('missing_value', '--path needs the selected folder after it.');
      }
      if (inline === undefined) index += 1;
      paths.push(resolvePath(value, cwd, platform));
      continue;
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const inline = arg.startsWith('--profile=') ? arg.slice('--profile='.length) : undefined;
      const value = inline ?? args[index + 1];
      if (value === undefined || value === '' || (inline === undefined && isSwitch(value))) {
        return invalid('missing_value', '--profile needs a profile name after it.');
      }
      if (inline === undefined) index += 1;
      profile = value;
      continue;
    }
    if (arg.startsWith('-')) {
      return invalid('unknown_option', `Unsupported option "${describeToken(arg)}" for project open.`);
    }
    return invalid(
      'unexpected_argument',
      `Unexpected argument "${describeToken(arg)}" for project open; pass folders with --path.`,
    );
  }

  if (paths.length === 0) {
    return invalid('missing_path', 'No folder was selected for Mona to open (--path <folder> is required).');
  }
  if (profile !== null && profile !== LAUNCH_PROFILE) {
    return invalid(
      'unsupported_profile',
      `Unsupported profile "${describeToken(profile)}". Mona opens projects with ${LAUNCH_PROFILE}.`,
    );
  }
  return { kind: 'launch', usage: 'project-open', paths: dedupe(paths, platform), profile };
}

function parseBarePaths(args: readonly string[], cwd: string, platform: NodeJS.Platform): LaunchCommand {
  const paths: string[] = [];
  for (const arg of args) {
    if (isSwitch(arg)) continue;
    paths.push(resolvePath(arg, cwd, platform));
  }
  if (paths.length === 0) return { kind: 'app' };
  return { kind: 'launch', usage: 'path', paths: dedupe(paths, platform), profile: null };
}

const PROBLEMS: readonly LaunchArgumentProblem[] = [
  'missing_subcommand',
  'unknown_command',
  'missing_path',
  'missing_value',
  'unknown_option',
  'unexpected_argument',
  'unsupported_profile',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a command that crossed a process boundary (Electron's single-instance
 * channel re-serializes Windows argv, so the launcher sends the parsed command as
 * data instead). Anything unrecognized returns null and the caller falls back to
 * parsing argv.
 */
export function coerceLaunchCommand(value: unknown): LaunchCommand | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'app') return { kind: 'app' };
  if (value.kind === 'invalid') {
    const problem = value.problem;
    if (typeof problem !== 'string' || !PROBLEMS.includes(problem as LaunchArgumentProblem)) return null;
    if (typeof value.detail !== 'string') return null;
    return { kind: 'invalid', problem: problem as LaunchArgumentProblem, detail: value.detail.slice(0, 500) };
  }
  if (value.kind !== 'launch') return null;
  if (value.usage !== 'project-open' && value.usage !== 'path') return null;
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 64) return null;
  const paths: string[] = [];
  for (const entry of value.paths) {
    if (typeof entry !== 'string' || !entry || entry.length > 32_767) return null;
    paths.push(entry);
  }
  if (value.profile !== null && (typeof value.profile !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.profile))) {
    return null;
  }
  return { kind: 'launch', usage: value.usage, paths, profile: value.profile };
}

/**
 * Parse the user-facing arguments (after the executable and, in development,
 * Electron's app path have been removed). An ordinary app start is `app`;
 * `--smoke-test` and other Electron switches are not launcher input.
 */
export function parseLaunchCommand(
  argv: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): LaunchCommand {
  if (argv.length === 0) return { kind: 'app' };
  const first = argv[0] as string;
  if (first === 'project') return parseProjectOpen(argv, cwd, platform);
  if (isSwitch(first)) return { kind: 'app' };
  return parseBarePaths(argv, cwd, platform);
}

/**
 * Remove the leading executable argument and the app directory Electron inserts
 * after it. That directory appears for development runs and also for a packaged
 * app whose payload lives in `resources/app`, where Chromium reports
 * `[Mona.exe, <...>resources\app, ...userArgs]` — including on the
 * second-instance argv. A user's own path argument can never equal Mona's app
 * directory, so matching it is unambiguous.
 */
export function stripLauncherArgs(
  argv: readonly string[],
  options: { isPackaged: boolean; appPath?: string | null; platform?: NodeJS.Platform },
): string[] {
  const platform = options.platform ?? process.platform;
  const rest = argv.slice(1);
  if (rest.length === 0) return rest;
  const first = rest[0] as string;
  if (first === '.' || first === '..') {
    rest.shift();
    return rest;
  }
  const appPath = options.appPath;
  if (
    appPath &&
    pathKey(pathApi(platform).resolve(first), platform) === pathKey(pathApi(platform).resolve(appPath), platform)
  ) {
    rest.shift();
  }
  return rest;
}
