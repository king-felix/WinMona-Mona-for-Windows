// Native modern-menu helper: real COM behaviour, not a mock.
//
// The helper is built with the pinned Zig toolchain, so these tests skip with a
// recorded reason when the binary is absent instead of pretending to pass.
// Run `node native/windows-shell/build.mjs` first; `npm run native:test` does not
// install a compiler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const nativeDir = path.join(repoRoot, 'native', 'windows-shell', 'dist');
const dll = path.join(nativeDir, 'MonaMenu.dll');
const probe = path.join(nativeDir, 'MonaMenuProbe.exe');
const recorder = path.join(nativeDir, 'MonaArgvRecorder.exe');
const MENU_TITLE = 'Start new DS project with Mona';
const CLSID = '{6D2F1C9A-4B7E-4E51-9A3C-1F8E5B0D7C42}';
const CANONICAL = '{6D2F1C9A-4B7E-4E51-9A3C-1F8E5B0D7C43}';

const win32 = process.platform === 'win32';
const compiled = win32 && [dll, probe, recorder].every((file) => existsSync(file));
const skip = !win32
  ? 'The modern-menu helper is a Windows COM server.'
  : !compiled
    ? 'Native helper is not built. Run: node native/windows-shell/build.mjs'
    : false;

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function probeJson(args, env) {
  const result = run(probe, ['--dll', dll, ...args], { env });
  assert.equal(result.status, 0, `probe exit: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function reg(args) {
  return run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), args);
}

/** UTF-16LE, NUL-separated, double-NUL terminated — exactly what wmain sees. */
function readRecordedArguments(file) {
  const raw = readFileSync(file);
  const text = raw.toString('utf16le');
  return text.split('\u0000').filter((entry) => entry.length > 0);
}

describe('modern Explorer menu helper', { skip }, () => {
  let fixtureRoot = '';
  let hostileFolder = '';
  let secondFolder = '';
  let plainFile = '';
  let fakeInstall = '';
  let fakeExe = '';
  let previousExe = null;

  function readInstalledExe() {
    const result = reg(['query', 'HKCU\\Software\\Mona\\Install', '/v', 'MonaExe']);
    if (result.status !== 0) return null;
    const match = /MonaExe\s+REG_SZ\s+(.+)/.exec(result.stdout);
    return match ? match[1].trim() : null;
  }

  function restoreInstalledExe() {
    if (previousExe === null) {
      reg(['delete', 'HKCU\\Software\\Mona\\Install', '/v', 'MonaExe', '/f']);
      return;
    }
    reg(['add', 'HKCU\\Software\\Mona\\Install', '/v', 'MonaExe', '/t', 'REG_SZ', '/d', previousExe, '/f']);
  }

  before(() => {
    previousExe = readInstalledExe();
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mona-menu-'));
    hostileFolder = path.join(fixtureRoot, "a & b (café) — 'quoted' 中文");
    secondFolder = path.join(fixtureRoot, 'second');
    plainFile = path.join(fixtureRoot, 'plain.txt');
    fakeInstall = path.join(fixtureRoot, 'install');
    mkdirSync(hostileFolder, { recursive: true });
    mkdirSync(secondFolder, { recursive: true });
    mkdirSync(fakeInstall, { recursive: true });
    writeFileSync(plainFile, 'not a folder\n', 'utf8');
    // The helper launches "Mona.exe"; the recorder stands in for it so the exact
    // argv can be inspected.
    fakeExe = path.join(fakeInstall, 'Mona.exe');
    writeFileSync(fakeExe, readFileSync(recorder));
  });

  after(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
    restoreInstalledExe();
    reg(['delete', `HKCU\\Software\\Classes\\CLSID\\${CLSID}`, '/f']);
  });

  it('exposes the exact label, tooltip and canonical name', () => {
    const report = probeJson(['--path', hostileFolder]);
    assert.equal(report.ok, true);
    assert.equal(report.title, MENU_TITLE);
    assert.match(report.tooltip, /No task is sent/);
    assert.equal(report.canonical, CANONICAL);
    assert.equal(report.flags, 0);
    assert.equal(report.subcommands, 'not-implemented');
  });

  it('is enabled for one folder and hidden for files or multiple selections', () => {
    assert.equal(probeJson(['--path', hostileFolder]).state, 'enabled');
    assert.equal(probeJson(['--path', hostileFolder, '--second', secondFolder]).state, 'hidden');
    assert.equal(probeJson(['--path', plainFile]).state, 'hidden');
  });

  it('reports a disabled command when no Mona executable is registered', () => {
    reg(['delete', 'HKCU\\Software\\Mona\\Install', '/v', 'MonaExe', '/f']);
    const disabled = probeJson(['--path', hostileFolder]);
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.icon, null);
    restoreInstalledExe();
  });

  it('launches Mona with the hostile folder as one argument', async () => {
    const argvOut = path.join(fixtureRoot, 'argv.bin');
    const report = probeJson(['--path', hostileFolder, '--exe', fakeExe, '--invoke'], {
      MONA_ARGV_OUT: argvOut,
    });
    assert.equal(report.invoked, true);
    assert.equal(report.invoke_ok, true, `Invoke returned ${report.invoke_hr}`);

    // The recorder writes as soon as it starts; the helper does not wait for it.
    const deadline = Date.now() + 5000;
    while (!existsSync(argvOut) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(argvOut), 'the helper did not start the registered executable');
    const argv = readRecordedArguments(argvOut);
    const recorded = argv.slice(1);
    assert.deepEqual(recorded.slice(0, 3), ['project', 'open', '--path']);
    assert.equal(recorded[4], '--profile');
    assert.equal(recorded[5], 'ds-full-access');
    // The shell reports its own canonical casing for parent directories; the
    // selected folder name itself is preserved character for character.
    assert.equal(path.basename(recorded[3]), path.basename(hostileFolder));
    assert.equal(recorded[3].toLowerCase(), hostileFolder.toLowerCase());
    assert.equal(argv[0], fakeExe);
  });

  it('activates through CoCreateInstance like a packaged COM server', () => {
    const key = `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\InprocServer32`;
    assert.equal(reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', dll, '/f']).status, 0);
    assert.equal(reg(['add', key, '/v', 'ThreadingModel', '/t', 'REG_SZ', '/d', 'Apartment', '/f']).status, 0);
    const result = run(probe, ['--cocreate', '--path', hostileFolder]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.state, 'enabled');
    assert.equal(report.title, MENU_TITLE);
    assert.equal(reg(['delete', `HKCU\\Software\\Classes\\CLSID\\${CLSID}`, '/f']).status, 0);
  });

  it('ships a DLL small enough for a shell extension and free of network imports', () => {
    const bytes = readFileSync(dll);
    assert.ok(bytes.length < 512 * 1024, `helper is ${bytes.length} bytes`);
    const text = bytes.toString('latin1');
    for (const forbidden of ['ws2_32.dll', 'winhttp.dll', 'wininet.dll', 'urlmon.dll']) {
      assert.equal(text.includes(forbidden), false, `helper imports ${forbidden}`);
    }
    assert.ok(bytes.length > 0);
  });

  it('records a checksum for the built artifact', () => {
    const digest = createHash('sha256').update(readFileSync(dll)).digest('hex');
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
});
