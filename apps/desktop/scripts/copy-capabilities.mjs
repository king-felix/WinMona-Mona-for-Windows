// Copy the versioned capability ledger into the desktop build. The app reads it
// as a static inventory at runtime; it is not generated from live provider calls.
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const source = path.join(repoRoot, 'docs', 'codewhale-capabilities.json');
const targetDir = path.join(here, '..', 'dist', 'resources');
await mkdir(targetDir, { recursive: true });
await copyFile(source, path.join(targetDir, 'capabilities.json'));
console.log(`copied capability ledger -> ${path.join(targetDir, 'capabilities.json')}`);
