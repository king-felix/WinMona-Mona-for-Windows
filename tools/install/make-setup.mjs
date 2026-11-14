// Build the single installable file a recipient uses.
//
// The staged payload (build/install-stage) is zipped and appended to the setup
// stub, followed by a trailer the stub validates. The result is one
// `Mona-Setup-<version>-x64.exe` that installs per user with no Node, compiler
// or source checkout, by running the product's own installer through
// Mona.exe with ELECTRON_RUN_AS_NODE=1.
//
// Nothing here is signed, and nothing here is described as trusted: the setup
// file still needs a signing decision, which is a separate release gate.
//
// Usage: node tools/install/make-setup.mjs [--no-build] [--json <path>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactPaths, readJson, resolveLayout, sha256File } from './installer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const TRAILER_MAGIC = 'MONASETUP-v1\0\0\0\0';
const TRAILER_SIZE = 32;

const zig =
  process.env.MONA_ZIG ?? path.join(repoRoot, 'node_modules', '.cache', 'mona-build-tools', 'zig-0.17.1', 'zig.exe');
const stubSource = path.join(repoRoot, 'native', 'setup', 'setup-stub.c');
const stubExe = path.join(repoRoot, 'native', 'setup', 'dist', 'MonaSetupStub.exe');
const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return { status: result.status ?? -1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function buildStub() {
  if (!existsSync(zig)) {
    throw new Error(`Zig is not present at ${zig}. Run tools/install/fetch-tools.mjs or set MONA_ZIG.`);
  }
  mkdirSync(path.dirname(stubExe), { recursive: true });
  const compiled = run(zig, [
    'cc',
    '-target',
    'x86_64-windows-gnu',
    '-O2',
    '-Wall',
    '-Wextra',
    '-municode',
    '-DUNICODE',
    '-D_UNICODE',
    '-o',
    stubExe,
    stubSource,
    '-lshlwapi',
  ]);
  if (compiled.status !== 0) {
    throw new Error(`zig cc failed for the setup stub:\n${compiled.stdout}\n${compiled.stderr}`);
  }
  return stubExe;
}

function main() {
  const argv = process.argv.slice(2);
  const jsonIndex = argv.indexOf('--json');
  const jsonOut = jsonIndex >= 0 ? path.resolve(argv[jsonIndex + 1]) : null;
  const layout = resolveLayout();
  const stage = layout.stage;
  if (!existsSync(path.join(stage, 'Mona.exe'))) {
    throw new Error(`The staged payload is missing (${stage}). Run: node tools/install/cli.mjs stage`);
  }
  if (!existsSync(path.join(stage, 'installer', 'cli.mjs'))) {
    throw new Error('The staged payload has no installer/cli.mjs; re-run staging.');
  }
  if (!argv.includes('--no-build')) buildStub();
  if (!existsSync(stubExe)) throw new Error('The setup stub is missing. Run without --no-build.');

  const artifacts = artifactPaths(layout);
  mkdirSync(artifacts.directory, { recursive: true });
  const work = path.join(repoRoot, 'build', 'setup-work');
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(work, { recursive: true });
  const payloadZip = path.join(work, 'payload.zip');

  // bsdtar writes a ZIP from the staged directory; the archive keeps relative
  // paths, so the stub extracts a self-contained tree.
  const zipped = run(tarExe, ['-a', '-c', '-f', payloadZip, '-C', stage, '.']);
  if (zipped.status !== 0) throw new Error(`Could not archive the payload: ${zipped.stderr}`);
  const zipBytes = statSync(payloadZip).size;

  const output = path.join(artifacts.directory, `Mona-Setup-${layout.version}-x64.exe`);
  rmSync(output, { force: true });
  writeFileSync(output, readFileSync(stubExe));
  const stubBytes = statSync(output).size;
  appendFileSync(output, readFileSync(payloadZip));

  const trailer = Buffer.alloc(TRAILER_SIZE);
  trailer.write(TRAILER_MAGIC, 0, 'latin1');
  trailer.writeBigUInt64LE(BigInt(stubBytes), 16);
  trailer.writeBigUInt64LE(BigInt(zipBytes), 24);
  appendFileSync(output, trailer);

  // Verify the file the way the stub will read it, before reporting success.
  const produced = readFileSync(output);
  const tail = produced.subarray(produced.length - TRAILER_SIZE);
  const offset = Number(tail.readBigUInt64LE(16));
  const length = Number(tail.readBigUInt64LE(24));
  const problems = [];
  if (tail.subarray(0, 16).toString('latin1') !== TRAILER_MAGIC) problems.push('trailer magic is wrong');
  if (offset !== stubBytes) problems.push(`payload offset ${offset} != stub size ${stubBytes}`);
  if (length !== zipBytes) problems.push(`payload length ${length} != archive size ${zipBytes}`);
  if (offset + length + TRAILER_SIZE !== produced.length) problems.push('payload does not end at the trailer');
  const embedded = produced.subarray(offset, offset + Math.min(4, length)).toString('latin1');
  if (embedded !== 'PK\u0003\u0004') problems.push('payload does not start with a ZIP local header');

  const receipt = {
    capturedUtc: new Date().toISOString(),
    version: layout.version,
    file: output,
    bytes: produced.length,
    sha256: createHash('sha256').update(produced).digest('hex'),
    stub: {
      path: path.relative(repoRoot, stubExe).replaceAll('\\', '/'),
      bytes: stubBytes,
      sha256: sha256File(stubExe),
    },
    payload: { bytes: zipBytes, sha256: createHash('sha256').update(readFileSync(payloadZip)).digest('hex') },
    installer: {
      entry: 'Mona.exe with ELECTRON_RUN_AS_NODE=1 running installer/cli.mjs install',
      stage: path.relative(repoRoot, stage).replaceAll('\\', '/'),
    },
    archive: { tool: 'tar.exe (bsdtar/libarchive)', format: 'zip' },
    signature: {
      status: 'unsigned',
      note: 'A signing decision is a separate release gate; this file is not signed and not claimed as trusted.',
    },
    problems,
  };
  const receiptPath = path.join(artifacts.directory, `Mona-Setup-${layout.version}-x64.receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  if (jsonOut) {
    mkdirSync(path.dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(
    `${JSON.stringify({ ok: problems.length === 0, file: output, bytes: receipt.bytes, sha256: receipt.sha256, receipt: receiptPath, problems }, null, 2)}\n`,
  );
  if (problems.length) process.exit(1);
}

main();
