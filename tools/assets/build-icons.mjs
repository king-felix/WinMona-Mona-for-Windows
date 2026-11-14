/**
 * Deterministic icon pipeline for the Mona brand artwork.
 *
 * Input : assets/brand/MidnightMona.png (the preserved source, never modified)
 * Output: assets/brand/generated/** (committed derivatives, byte-stable)
 *
 * Why a hand-rolled pipeline: the repository deliberately carries no image
 * dependency, and every published artifact must be reproducible from a recorded
 * source hash. This module decodes and re-encodes PNG itself, so the only
 * inputs are the source bytes and this file.
 *
 * Determinism rules:
 *   - no timestamps, no ancillary chunks, no random data in any output;
 *   - fixed deflate level and fixed PNG filter type;
 *   - resampling is a coverage-weighted box filter in premultiplied alpha,
 *     which is the correct way to downscale an anti-aliased RGBA mark.
 *
 * Run: node tools/assets/build-icons.mjs [--check]
 *   --check  regenerate into memory and fail if any committed file differs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const SOURCE = path.join(repoRoot, 'assets', 'brand', 'MidnightMona.png');
export const OUT_DIR = path.join(repoRoot, 'assets', 'brand', 'generated');
/**
 * The renderer imports its mark as a module asset, so the copy has to live
 * inside the Vite root. It is a verified copy of generated/mona-128.png rather
 * than a second hand-managed original.
 */
export const RENDERER_MARK = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'assets', 'mona-mark.png');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Alpha above this counts as artwork when measuring the content box. */
const ALPHA_FLOOR = 8;
/** Fraction of the cropped edge kept as breathing room before resampling. */
const PADDING_RATIO = 0.02;

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit RGB or RGBA non-interlaced PNG into RGBA bytes. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}; expected 8`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`unsupported colour type ${colorType}; expected 6 (RGBA) or 2 (RGB)`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      rgba[target] = current[x * channels];
      rgba[target + 1] = current[x * channels + 1];
      rgba[target + 2] = current[x * channels + 2];
      rgba[target + 3] = channels === 4 ? current[x * channels + 3] : 255;
    }
    previous = current;
  }
  return { width, height, data: rgba };
}

/** Bounding box of pixels whose alpha exceeds the floor. */
export function contentBounds({ width, height, data }) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA_FLOOR) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('source artwork is fully transparent');
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Crop to a centred square around the artwork box, keeping a small margin, and
 * pad with transparent pixels where the square leaves the original canvas.
 */
export function cropSquare(image, paddingRatio = PADDING_RATIO) {
  const bounds = contentBounds(image);
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  const side = Math.round(Math.max(bounds.width, bounds.height) * (1 + paddingRatio * 2));
  const left = Math.round(centreX - side / 2);
  const top = Math.round(centreY - side / 2);
  const data = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    const sourceY = top + y;
    if (sourceY < 0 || sourceY >= image.height) continue;
    for (let x = 0; x < side; x += 1) {
      const sourceX = left + x;
      if (sourceX < 0 || sourceX >= image.width) continue;
      const from = (sourceY * image.width + sourceX) * 4;
      const to = (y * side + x) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = image.data[from + 3];
    }
  }
  return { width: side, height: side, data };
}

/**
 * Coverage-weighted box resampling in premultiplied alpha.
 *
 * Averaging straight RGBA lets fully transparent pixels pull colour into the
 * edges of the mark, which shows up as a grey fringe at 16-32 px. Averaging
 * premultiplied values and dividing back out avoids that.
 */
export function resample(image, targetWidth, targetHeight = targetWidth) {
  const { width: sw, height: sh, data } = image;
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = sw / targetWidth;
  const scaleY = sh / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = y0 + scaleY;
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = x0 + scaleX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const overlapY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (overlapY <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const overlapX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (overlapX <= 0) continue;
          const w = overlapX * overlapY;
          const at = (sy * sw + sx) * 4;
          const alpha = data[at + 3] / 255;
          r += data[at] * alpha * w;
          g += data[at + 1] * alpha * w;
          b += data[at + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const target = (ty * targetWidth + tx) * 4;
      if (weight === 0 || a === 0) continue;
      output[target] = Math.round(r / a);
      output[target + 1] = Math.round(g / a);
      output[target + 2] = Math.round(b / a);
      output[target + 3] = Math.round((a / weight) * 255);
    }
  }
  return { width: targetWidth, height: targetHeight, data: output };
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) : crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** CRC-32 fallback for Node builds whose zlib has no crc32 helper. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode RGBA bytes as a PNG with no ancillary chunks and filter type 0. */
export function encodePng(image) {
  const { width, height, data } = image;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Build a multi-size ICO whose entries are PNG streams.
 *
 * Windows Vista and later, and Chromium's ICO decoder (used by Electron for
 * nativeImage), both accept PNG-compressed entries. Keeping one encoding means
 * the small sizes are byte-identical to the standalone PNGs.
 *
 * The ICO container is little-endian throughout. That is not a detail to guess
 * at: the first version of this function wrote big-endian fields, which Windows
 * reads as type 256 with 1792 directory entries, so the packaged executable and
 * the shell could not load the mark at all. `tests/assets` now reads the
 * directory the way Windows does, and `tools/assets/embed-exe-icon.mjs` rejects
 * an ICO whose container is not LE.
 */
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(entries.length * 16);
  let payloadOffset = 6 + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(payloadOffset, at + 12);
    payloadOffset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

/** Sizes written as standalone PNGs, and the sizes packed into mona.ico. */
export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Windows package image sizes, matching what AppxManifest.xml declares. */
export const PACKAGE_IMAGES = [
  { file: 'StoreLogo.png', size: 50 },
  { file: 'Square44x44Logo.png', size: 44 },
  { file: 'Square150x150Logo.png', size: 150 },
];

/** Produce every derivative in memory. Pure function of the source bytes. */
export function buildIcons(sourceBuffer) {
  const decoded = decodePng(sourceBuffer);
  const square = cropSquare(decoded);
  const files = new Map();
  for (const size of PNG_SIZES) {
    files.set(`mona-${size}.png`, encodePng(resample(square, size)));
  }
  for (const { file, size } of PACKAGE_IMAGES) {
    files.set(file, encodePng(resample(square, size)));
  }
  const icoEntries = ICO_SIZES.map((size) => ({
    size,
    png: files.get(`mona-${size}.png`),
  }));
  files.set('mona.ico', encodeIco(icoEntries));
  const manifest = {
    pipeline: 'tools/assets/build-icons.mjs',
    pipeline_version: 2,
    source: {
      path: 'assets/brand/MidnightMona.png',
      sha256: sha256(sourceBuffer),
      width: decoded.width,
      height: decoded.height,
    },
    crop: {
      width: square.width,
      height: square.height,
      padding_ratio: PADDING_RATIO,
      alpha_floor: ALPHA_FLOOR,
    },
    files: [...files.entries()]
      .map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha256(bytes) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return { files, manifest };
}

export function writeIcons({ files, manifest }, outDir = OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, bytes] of files) {
    const target = path.join(outDir, name);
    writeFileSync(target, bytes);
    written.push(name);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(outDir, 'manifest.json'), manifestBytes);
  written.push('manifest.json');
  mkdirSync(path.dirname(RENDERER_MARK), { recursive: true });
  writeFileSync(RENDERER_MARK, files.get('mona-128.png'));
  written.push(path.relative(repoRoot, RENDERER_MARK));
  return written;
}

/** Compare freshly built bytes with what is committed. */
export function checkIcons(sourceBuffer, outDir = OUT_DIR) {
  const { files, manifest } = buildIcons(sourceBuffer);
  const expected = new Map(files);
  expected.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  const problems = [];
  for (const [name, bytes] of expected) {
    const target = path.join(outDir, name);
    if (!existsSync(target)) {
      problems.push(`missing generated icon: ${name}`);
      continue;
    }
    if (!readFileSync(target).equals(bytes)) problems.push(`stale generated icon: ${name}`);
  }
  for (const name of readdirSync(outDir)) {
    if (!expected.has(name)) problems.push(`unexpected file in generated icons: ${name}`);
  }
  const rendererMark = files.get('mona-128.png');
  if (!existsSync(RENDERER_MARK)) problems.push(`missing renderer mark: ${RENDERER_MARK}`);
  else if (!readFileSync(RENDERER_MARK).equals(rendererMark)) {
    problems.push(`stale renderer mark: ${path.relative(repoRoot, RENDERER_MARK)}`);
  }
  return problems;
}

function main() {
  if (!existsSync(SOURCE)) {
    process.stderr.write(
      `assets:icons needs the source artwork at ${path.relative(repoRoot, SOURCE)}; it is absent, so no icon was invented.\n`,
    );
    process.exit(1);
  }
  const sourceBuffer = readFileSync(SOURCE);
  if (process.argv.includes('--check')) {
    const problems = checkIcons(sourceBuffer);
    if (problems.length) {
      process.stderr.write(`${problems.join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write(`icons verified up to date (${SOURCE} ${sha256(sourceBuffer).slice(0, 12)})\n`);
    return;
  }
  const built = buildIcons(sourceBuffer);
  const written = writeIcons(built);
  process.stdout.write(
    `generated ${written.length} files in ${path.relative(repoRoot, OUT_DIR)} from source ${sha256(sourceBuffer).slice(
      0,
      12,
    )} (crop ${built.manifest.crop.width}px)\n`,
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
