// Build the modern-menu helper and its probe with the pinned portable toolchain.
//
// `zig cc` supplies a clang front end plus the mingw-w64 Windows headers, so no
// MSVC installation is needed. The toolchain lives under node_modules/.cache and
// is never committed. Outputs are x64 PE files with SHA-256 receipts so a
// packaged install can verify exactly what it ships.
//
// Usage: node native/windows-shell/build.mjs [--check]
//   --check  fail if the expected outputs are missing instead of rebuilding
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const buildDir = path.join(here, 'dist');
const cacheRoot = path.join(repoRoot, 'node_modules', '.cache', 'mona-build-tools');
const zigVersion = '0.17.1';
const defaultZig = path.join(cacheRoot, `zig-${zigVersion}`, 'zig.exe');

const OUTPUTS = {
  dll: path.join(buildDir, 'MonaMenu.dll'),
  probe: path.join(buildDir, 'MonaMenuProbe.exe'),
  recorder: path.join(buildDir, 'MonaArgvRecorder.exe'),
};

function zigExecutable() {
  const candidate = process.env.MONA_ZIG ?? defaultZig;
  if (!existsSync(candidate)) {
    throw new Error(
      `Zig ${zigVersion} is not present at ${candidate}. ` +
        'Set MONA_ZIG or run tools/install/fetch-tools.mjs, which pins and verifies the download.',
    );
  }
  return candidate;
}

export function compileZig(args) {
  const zig = zigExecutable();
  const result = spawnSync(zig, args, { cwd: here, encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`zig cc failed (${result.status}):\n${output}`);
  }
  return output;
}

/** Shared flags: x64 Windows PE, GNU ABI, no CRT dependency on a dev machine. */
const COMMON = [
  'cc',
  '-target',
  'x86_64-windows-gnu',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Wno-unused-parameter',
  '-DUNICODE',
  '-D_UNICODE',
  '-D_WIN32_WINNT=0x0A00',
];

const DLL_LIBS = ['-lole32', '-loleaut32', '-lshlwapi', '-ladvapi32', '-lshell32', '-luuid'];

export function build() {
  mkdirSync(buildDir, { recursive: true });
  compileZig([
    ...COMMON,
    '-shared',
    '-o',
    OUTPUTS.dll,
    path.join(here, 'mona-menu.c'),
    path.join(here, 'mona-menu.def'),
    ...DLL_LIBS,
  ]);
  compileZig([...COMMON, '-municode', '-o', OUTPUTS.probe, path.join(here, 'mona-menu-probe.c'), ...DLL_LIBS]);
  compileZig([...COMMON, '-municode', '-o', OUTPUTS.recorder, path.join(here, 'argv-recorder.c')]);
  return receipts();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function receipts() {
  return {
    zig: zigVersion,
    outputs: Object.entries(OUTPUTS).map(([name, file]) => ({
      name,
      path: path.relative(repoRoot, file).replace(/\\/g, '/'),
      bytes: existsSync(file) ? readFileSync(file).length : 0,
      sha256: existsSync(file) ? sha256(file) : null,
    })),
  };
}

export function check() {
  const missing = Object.values(OUTPUTS).filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Missing native build output: ${missing.join(', ')}`);
  }
  return receipts();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = process.argv.includes('--check') ? check() : build();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exit(1);
  }
}
