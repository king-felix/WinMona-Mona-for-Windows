// Fetch the pinned, portable build tools used for Mona's native helper and
// identity package. Nothing is installed system-wide and nothing is elevated.
//
// Pins are exact: a mismatched download is deleted and reported, never used.
//   zig 0.17.1 (x86_64-windows)  — C compiler + mingw-w64 headers for MonaMenu.dll
//   Windows SDK BuildTools       — MakeAppx.exe / SignTool.exe for the MSIX
//
// Usage: node tools/install/fetch-tools.mjs [--check]
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { get } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const cacheRoot = path.join(repoRoot, 'node_modules', '.cache', 'mona-build-tools');

export const PINS = [
  {
    name: 'zig-0.17.1',
    url: 'https://ziglang.org/download/0.17.1/zig-x86_64-windows-0.17.1.zip',
    sha256: 'b03f477a1943673e02aca0f570e8030dffd536ce1f45cbc4d3326ec31159562e',
    archive: 'zig-x86_64-windows-0.17.1.zip',
    extractDir: 'zig-0.17.1',
    extractedName: 'zig-x86_64-windows-0.17.1',
    marker: path.join('zig-0.17.1', 'zig.exe'),
  },
  {
    name: 'windows-sdk-buildtools-10.0.28000.2957',
    url: 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.28000.2957/microsoft.windows.sdk.buildtools.10.0.28000.2957.nupkg',
    sha256: 'b7163fc6f636172726d0985963e4f7f11c41afe1c7fdfe78f8051877360ed696',
    archive: 'microsoft.windows.sdk.buildtools.10.0.28000.2957.nupkg',
    extractDir: 'sdk-buildtools',
    extractedName: null,
    marker: path.join('sdk-buildtools', 'bin', '10.0.28000.0', 'x64', 'makeappx.exe'),
  },
];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function download(url, target, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        const next = response.headers.location;
        response.resume();
        if (!next) {
          reject(new Error(`Redirect without a location from ${url}`));
          return;
        }
        download(new URL(next, url).toString(), target, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const file = createWriteStream(target);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(target)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(tar, ['-xf', archive, '-C', destination], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not extract ${archive}: ${(result.stderr ?? '').trim()}`);
}

export async function fetchTools({ check = false } = {}) {
  const report = [];
  for (const pin of PINS) {
    const marker = path.join(cacheRoot, pin.marker);
    if (existsSync(marker)) {
      report.push({ name: pin.name, action: 'present', path: marker });
      continue;
    }
    if (check) {
      report.push({ name: pin.name, action: 'missing', path: marker });
      continue;
    }
    mkdirSync(cacheRoot, { recursive: true });
    const archive = path.join(cacheRoot, pin.archive);
    if (!existsSync(archive)) await download(pin.url, archive);
    const observed = sha256(archive);
    if (observed !== pin.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`${pin.name} checksum mismatch: expected ${pin.sha256}, observed ${observed}`);
    }
    const target = path.join(cacheRoot, pin.extractDir);
    rmSync(target, { recursive: true, force: true });
    extract(archive, cacheRoot);
    // Zig's archive has its own versioned top-level directory. Adopt it under the
    // stable name the build scripts expect; the nupkg already extracts flat.
    if (pin.extractedName) {
      const extracted = path.join(cacheRoot, pin.extractedName);
      if (existsSync(extracted)) renameSync(extracted, target);
    }
    if (!existsSync(marker)) {
      throw new Error(`${pin.name} did not produce ${marker} after extraction`);
    }
    report.push({ name: pin.name, action: 'fetched', sha256: observed, path: marker });
  }
  return { ok: report.every((entry) => entry.action !== 'missing'), cacheRoot, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchTools({ check: process.argv.includes('--check') })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 4;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
