// Observe the packaged Explorer command through the shell, without clicking.
//
// Windows 11's modern context menu is built by the shell from the package's
// declared verbs. A human right-click is the only way to see its visual
// placement, but the shell's own verb table can be enumerated and invoked. This
// probe does exactly that: it lists the verbs the shell offers for a real folder
// with a Unicode name, invokes the Mona verb if present, and records the command
// line of the process the shell started.
//
// It does not register anything, change trust, or touch the user's own folders.
// The folder lives under the temporary directory and is removed afterwards. Only
// a Mona process whose command line names that temporary folder is stopped.
//
// Usage: node tools/spike/shell-verb.mjs [--out docs/evidence/W22-shell-verb.json]
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outIndex = process.argv.indexOf('--out');
const outPath = path.resolve(
  outIndex >= 0 ? process.argv[outIndex + 1] : path.join(repoRoot, 'docs', 'evidence', 'W22-shell-verb.json'),
);
const VERB = 'Start new DS project with Mona';

function powershell(script) {
  // A UTF-8 BOM script file is used instead of -Command: Windows PowerShell 5.1
  // reads -Command text with the console code page, which mangles a Unicode
  // folder name, and `DoIt()` also appears to need its COM caller alive long
  // enough to complete (the script keeps the process running after the call).
  const scriptFile = path.join(tmpdir(), `mona-ps-${randomUUID()}.ps1`);
  writeFileSync(scriptFile, `\ufeff${script}\n`, 'utf8');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    },
  );
  try {
    rmSync(scriptFile, { force: true });
  } catch {
    /* the temp file is not important */
  }
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function processSnapshot() {
  const result = powershell(
    'Get-CimInstance Win32_Process -Filter "Name=\'Mona.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  );
  if (!result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'mona-shell-verb-'));
const folderName = `Mona Shell Probe cafÃ© ä¸­æ–‡ ${randomUUID().slice(0, 8)}`;
const folder = path.join(root, folderName);
mkdirSync(folder, { recursive: true });
const before = new Set(processSnapshot().map((entry) => entry.ProcessId));

const enumerated = powershell(
  [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject Shell.Application',
    `$ns = $shell.Namespace('${root.replaceAll("'", "''")}')`,
    `$item = $ns.ParseName('${folderName.replaceAll("'", "''")}')`,
    'if (-not $item) { "[]"; exit 0 }',
    '$verbs = $item.Verbs()',
    '$names = @()',
    'for ($i = 0; $i -lt $verbs.Count; $i++) { $names += ($verbs.Item($i).Name -replace "^&", "") }',
    '$names | ConvertTo-Json -Compress',
  ].join('\n'),
);

let verbs = [];
try {
  verbs = JSON.parse(enumerated.stdout || '[]');
} catch {
  verbs = [];
}
const verbPresent = verbs.some((name) => String(name).includes(VERB));

let invocation = { attempted: false, ok: false, process: null, error: null };
if (verbPresent) {
  const invoke = powershell(
    [
      '$ErrorActionPreference = "Stop"',
      '$shell = New-Object -ComObject Shell.Application',
      `$ns = $shell.Namespace('${root.replaceAll("'", "''")}')`,
      `$item = $ns.ParseName('${folderName.replaceAll("'", "''")}')`,
      '$verbs = $item.Verbs()',
      '$target = $null',
      `for ($i = 0; $i -lt $verbs.Count; $i++) { if ($verbs.Item($i).Name -like '*${VERB}*') { $target = $verbs.Item($i) } }`,
      'if (-not $target) { "missing"; exit 2 }',
      '$target.DoIt()',
      'Start-Sleep -Seconds 3',
      '"invoked"',
    ].join('\n'),
  );
  invocation.attempted = invoke.status === 0;
  invocation.status = invoke.status;
  invocation.stdout = invoke.stdout;
  invocation.stderr = invoke.stderr;
  if (!invocation.attempted) invocation.error = invoke.stderr || invoke.stdout;
  const deadline = Date.now() + 30_000;
  while (invocation.attempted && Date.now() < deadline) {
    const fresh = processSnapshot().filter((entry) => !before.has(entry.ProcessId));
    const started = fresh.filter(
      (entry) => typeof entry.CommandLine === 'string' && entry.CommandLine.includes('project open'),
    );
    if (started.length > 0) {
      invocation.ok = true;
      invocation.process = {
        pid: started[0].ProcessId,
        commandLine: started[0].CommandLine,
      };
      break;
    }
    if (fresh.length > 0) invocation.sawNewProcess = true;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { windowsHide: true });
  }
  if (!invocation.ok && invocation.error === null) {
    invocation.error = `no Mona process with the probe folder appeared within 30 s (new processes seen: ${invocation.sawNewProcess === true})`;
  }
}

if (invocation.ok && invocation.process) {
  // Only the process this probe started, and its own children.
  spawnSync('taskkill.exe', ['/PID', String(invocation.process.pid), '/T', '/F'], { windowsHide: true });
}

const executable = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Mona', 'Mona.exe');
const report = {
  capturedUtc: new Date().toISOString(),
  executable,
  executableExists: existsSync(executable),
  folderName,
  verbs,
  verbPresent,
  invocation,
  modernMenuVisualPlacement: 'not observed: requires a human right-click',
  trustContext: 'the installed package must be registered under its declared trust state; see W22-menu-trust.md',
  sha256OfExecutable: existsSync(executable)
    ? createHash('sha256').update(readFileSync(executable)).digest('hex')
    : null,
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // Explorer may still hold a handle on the just-invoked folder; the OS clears
  // the temporary directory later and the probe has already recorded its report.
}

process.stdout.write(`${JSON.stringify({ verbPresent, invoked: invocation.ok, out: outPath }, null, 2)}\n`);
if (!verbPresent) process.exit(1);
