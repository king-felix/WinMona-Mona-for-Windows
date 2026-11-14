/**
 * Brand image resolution for the main process.
 *
 * The images are generated from the preserved source artwork by
 * `tools/assets/build-icons.mjs` and copied into `dist/resources/icons` by
 * `apps/desktop/scripts/copy-icons.mjs` during the desktop build.
 *
 * `null` means "no image was built". It deliberately does not fall back to a
 * drawn or different mark: a missing icon must stay visibly missing rather than
 * quietly substituting artwork nobody approved.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Directory that holds the built brand images, given the compiled main dir. */
export function brandIconDir(mainDir: string): string {
  return path.join(mainDir, '..', 'resources', 'icons');
}

/** Absolute path to one built brand image, or null when it is absent. */
export function brandIconPath(mainDir: string, name: string): string | null {
  const candidate = path.join(brandIconDir(mainDir), name);
  return existsSync(candidate) ? candidate : null;
}
