// Copy the generated brand icons into the desktop build so the main process can
// load window and tray images from disk. The bytes come from
// assets/brand/generated, which tools/assets/build-icons.mjs produces from the
// preserved source artwork; nothing is drawn here.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const source = path.join(repoRoot, 'assets', 'brand', 'generated');
const targetDir = path.join(here, '..', 'dist', 'resources', 'icons');

const files = ['mona.ico', 'mona-16.png', 'mona-32.png', 'mona-128.png', 'manifest.json'];

try {
  await readFile(path.join(source, 'mona.ico'));
} catch {
  console.error(
    `brand icons are absent at ${path.relative(repoRoot, source)}; run \`npm run assets:icons\` before building.`,
  );
  process.exit(1);
}

await mkdir(targetDir, { recursive: true });
for (const file of files) {
  await copyFile(path.join(source, file), path.join(targetDir, file));
}
console.log(`copied ${files.length} brand icons -> ${path.relative(repoRoot, targetDir)}`);
