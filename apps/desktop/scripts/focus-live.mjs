// W06 live probe: one bounded paid turn on the configured route, with Focus,
// native fullscreen, F11, minimize/restore and a drawer exercised while the
// engine's own delta frames are arriving. Records the delta count across every
// transition and asserts exactly one turn was recorded.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const out = process.env.MONA_FOCUS_LIVE_OUT ?? path.join(repoRoot, 'docs', 'evidence', 'W06-focus-live.json');
const logFile = process.env.MONA_FOCUS_LIVE_LOG ?? path.join(repoRoot, 'docs', 'evidence', 'W06-focus-live-log.txt');
const shotsDir = process.env.MONA_FOCUS_LIVE_SHOTS ?? path.join(repoRoot, 'docs', 'evidence', 'shots-w06-live');
const packagedExe = process.env.MONA_FOCUS_LIVE_EXE?.trim() || null;
await mkdir(path.dirname(out), { recursive: true });
await mkdir(shotsDir, { recursive: true });

let electronPath;
if (packagedExe) {
  electronPath = packagedExe;
} else {
  try {
    electronPath = (await import('electron')).default;
  } catch (error) {
    console.error('Electron runtime is not installed:', String(error));
    process.exit(3);
  }
}
if (!electronPath || !existsSync(electronPath)) {
  console.error('Executable is missing at', electronPath ?? '(unknown)');
  process.exit(3);
}

const root = await mkdtemp(path.join(tmpdir(), 'mona-w06-live-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'focus-live-project');
await mkdir(workspace, { recursive: true });
await writeFile(
  path.join(workspace, 'check.mjs'),
  [
    "import { readFileSync } from 'node:fs';",
    'const expected = {',
    "  'a.txt': 'ALPHA',",
    "  'b.txt': 'BETA',",
    "  'c.txt': 'GAMMA',",
    '};',
    'let failed = false;',
    'for (const [file, value] of Object.entries(expected)) {',
    '  try {',
    "    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').trim();",
    '    if (text !== value) {',
    '      console.error(`${file} has ${JSON.stringify(text)}, expected ${JSON.stringify(value)}`);',
    '      failed = true;',
    '    }',
    '  } catch (error) {',
    '    console.error(`${file} is missing:`, String(error));',
    '    failed = true;',
    '  }',
    '}',
    'if (failed) process.exit(1);',
    "console.log('MONA_FOCUS_LIVE_CHECK_PASS');",
    '',
  ].join('\n'),
  'utf8',
);
await writeFile(path.join(workspace, 'README.md'), '# Focus live fixture\n\nA small project.\n', 'utf8');

function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', workspace, ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}: ${stderr}`))));
  });
}
await git(['init', '--quiet']);
await git(['config', 'user.email', 'probe@example.invalid']);
await git(['config', 'user.name', 'Mona focus live probe']);
await git(['add', '.']);
await git(['commit', '--quiet', '-m', 'focus live probe baseline']);

const child = spawn(electronPath, packagedExe ? ['--focus-live-probe'] : ['.', '--focus-live-probe'], {
  cwd: packagedExe ? repoRoot : appDir,
  env: {
    ...process.env,
    MONA_FOCUS_LIVE_OUT: out,
    MONA_FOCUS_LIVE_SHOTS: shotsDir,
    MONA_FOCUS_LIVE_WORKSPACE: workspace,
    MONA_USER_DATA: profile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8');
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
  process.stderr.write(chunk);
});

const watchdog = setTimeout(() => {
  console.error('focus live probe exceeded its watchdog; terminating');
  child.kill('SIGKILL');
}, 600_000);

const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value)));
clearTimeout(watchdog);
await writeFile(logFile, `executable: ${electronPath}\nworkspace: ${workspace}\n\n${stdout}${stderr}`, 'utf8');
await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);

if (!existsSync(out)) {
  console.error('the probe wrote no report');
  process.exit(1);
}
const report = JSON.parse(await readFile(out, 'utf8'));
const failures = report.steps?.filter((step) => !step.ok).map((step) => step.name) ?? ['probe reported no steps'];
if (!report.ok) failures.unshift('probe reported ok=false');
if (!report.samples?.some((row) => row.runState === 'running' && (row.deltas > 0 || row.answerChars > 0))) {
  failures.push('no transition was sampled while the live turn had produced work');
}
if (code !== 0) failures.push(`the app exited with ${code}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `W06 live focus probe: ${report.steps.length} steps passed, ${report.shots?.length ?? 0} screenshots, deltas observed across transitions`,
);
