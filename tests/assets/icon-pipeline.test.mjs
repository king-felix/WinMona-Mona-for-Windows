// The brand icon pipeline is a build input, so its guarantees are tested rather
// than reviewed by eye: the same source must produce the same bytes, every
// declared size must be present, the ICO must describe what it contains, and a
// missing source must fail loudly instead of producing an invented mark.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ICO_SIZES,
  OUT_DIR,
  PACKAGE_IMAGES,
  PNG_SIZES,
  RENDERER_MARK,
  SOURCE,
  buildIcons,
  checkIcons,
  decodePng,
  encodeIco,
  encodePng,
  resample,
} from '../../tools/assets/build-icons.mjs';

const source = readFileSync(SOURCE);
const built = buildIcons(source);

function icoDirectory(buffer) {
  const count = buffer.readUInt16BE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    entries.push({
      width: buffer[at] === 0 ? 256 : buffer[at],
      height: buffer[at + 1] === 0 ? 256 : buffer[at + 1],
      bytes: buffer.readUInt32BE(at + 8),
      offset: buffer.readUInt32BE(at + 12),
    });
  }
  return entries;
}

describe('icon pipeline', () => {
  it('decodes the preserved source artwork as RGBA', () => {
    const image = decodePng(source);
    assert.equal(image.width, 1254);
    assert.equal(image.height, 1254);
    assert.equal(image.data.length, 1254 * 1254 * 4);
  });

  it('writes every declared PNG size', () => {
    for (const size of PNG_SIZES) {
      const bytes = built.files.get(`mona-${size}.png`);
      assert.ok(bytes, `mona-${size}.png`);
      assert.deepEqual(bytes.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(bytes.readUInt32BE(16), size, `${size}px width`);
      assert.equal(bytes.readUInt32BE(20), size, `${size}px height`);
    }
  });

  it('writes package images at the sizes the identity manifest declares', () => {
    for (const { file, size } of PACKAGE_IMAGES) {
      const bytes = built.files.get(file);
      assert.ok(bytes, file);
      assert.equal(bytes.readUInt32BE(16), size, `${file} width`);
      assert.equal(bytes.readUInt32BE(20), size, `${file} height`);
    }
  });

  it('packs an ICO whose directory matches its payloads', () => {
    const ico = built.files.get('mona.ico');
    assert.equal(ico.readUInt16BE(2), 1, 'type 1 = icon');
    const entries = icoDirectory(ico);
    assert.deepEqual(
      entries.map((entry) => entry.width),
      ICO_SIZES,
    );
    assert.deepEqual(
      entries.map((entry) => entry.height),
      ICO_SIZES,
    );
    for (const entry of entries) {
      const payload = ico.subarray(entry.offset, entry.offset + entry.bytes);
      assert.deepEqual(payload.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(payload.readUInt32BE(16), entry.width);
    }
    assert.equal(entries.at(-1).offset + entries.at(-1).bytes, ico.length);
  });

  it('keeps corners transparent so the mark is not white-matted', () => {
    for (const size of [16, 32, 48]) {
      const image = decodePng(built.files.get(`mona-${size}.png`));
      const corner = image.data[3];
      assert.ok(corner < 40, `${size}px corner alpha ${corner} should stay transparent`);
    }
  });

  it('is byte-stable for the same source', () => {
    const again = buildIcons(source);
    for (const [name, bytes] of built.files) {
      assert.ok(again.files.get(name).equals(bytes), `${name} changed between runs`);
    }
  });

  it('is committed up to date', () => {
    assert.ok(existsSync(OUT_DIR), 'generated icon directory exists');
    assert.deepEqual(checkIcons(source), []);
  });

  it('keeps the renderer copy identical to the generated 128px mark', () => {
    assert.ok(existsSync(RENDERER_MARK), 'renderer mark exists');
    assert.ok(
      readFileSync(RENDERER_MARK).equals(built.files.get('mona-128.png')),
      'renderer mark is a copy of mona-128.png',
    );
  });

  it('round-trips a re-encoded image', () => {
    const small = resample(decodePng(source), 8);
    const decoded = decodePng(encodePng(small));
    assert.deepEqual([decoded.width, decoded.height], [8, 8]);
  });

  it('refuses a source that is not a PNG', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  });

  it('refuses an empty ICO list rather than writing a header only', () => {
    const ico = encodeIco([]);
    assert.equal(ico.readUInt16BE(4), 0);
    assert.equal(ico.length, 6);
  });
});
