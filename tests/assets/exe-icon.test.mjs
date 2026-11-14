// The packaged executable must carry the approved artwork, not Electron's.
// These tests use the real Electron runtime as the fixture: it is the exact
// binary the installer renames to Mona.exe, so a passing test means the
// resource rewrite works on the bytes that actually ship.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ICO,
  parseIco,
  parsePeHeaders,
  readExeIcons,
  readResourceTree,
  verifyEmbeddedIcons,
} from '../../tools/assets/embed-exe-icon.mjs';
import { embedIcon } from '../../tools/assets/embed-exe-icon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const electronExe = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const ico = readFileSync(DEFAULT_ICO);
const available = existsSync(electronExe);

describe('executable icon embedding', () => {
  it('reads the generated ICO the way Windows reads it', () => {
    const entries = parseIco(ico);
    assert.equal(ico.readUInt16LE(0), 0, 'reserved');
    assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
    assert.equal(ico.readUInt16LE(4), entries.length, 'little-endian entry count');
    assert.deepEqual(
      entries.map((entry) => entry.width),
      [16, 24, 32, 48, 64, 128, 256],
    );
    assert.equal(entries.at(-1).offset + entries.at(-1).bytes, ico.length);
  });

  it('refuses an ICO whose container is not a valid icon file', () => {
    assert.throws(() => parseIco(Buffer.alloc(0)), /truncated/);
    const wrong = Buffer.from(ico);
    wrong.writeUInt16LE(2, 2);
    assert.throws(() => parseIco(wrong), /type is not 1/);
  });

  it('refuses a file that is not an executable', () => {
    assert.throws(
      () => parsePeHeaders(Buffer.from('MZ but nothing else')),
      /not an MZ executable|PE header|missing PE/,
    );
  });

  (available ? it : it.skip)('replaces Electron icon resources and preserves everything else', () => {
    const before = readFileSync(electronExe);
    const beforeTree = readResourceTree(before).tree;
    const result = embedIcon(before, ico);

    const verification = verifyEmbeddedIcons(result.buffer, ico);
    assert.deepEqual(verification.problems, []);
    assert.ok(
      result.buffer.length > before.length,
      'the resource section moves to the end of the file rather than overwriting the runtime',
    );

    const afterTree = readResourceTree(result.buffer).tree;
    for (const type of [1, 12, 16, 24]) {
      const beforeType = beforeTree.entries.get(type);
      const afterType = afterTree.entries.get(type);
      assert.ok(beforeType && afterType, `resource type ${type} survives`);
      assert.deepEqual([...afterType.entries.keys()], [...beforeType.entries.keys()], `type ${type} names`);
      for (const [name, node] of beforeType.entries) {
        const languageNode = [...node.entries.values()][0];
        const afterLanguageNode = [...afterType.entries.get(name).entries.values()][0];
        assert.ok(languageNode.bytes.equals(afterLanguageNode.bytes), `resource ${type}/${name} bytes are unchanged`);
      }
    }

    const pe = parsePeHeaders(result.buffer);
    assert.equal(pe.resourceDirectory.rva, result.resourceRva, 'resource RVA is stable');
    assert.equal(pe.resourceDirectory.size, result.resourceBytes);
    assert.equal(pe.relocationDirectory.rva, result.relocationRva, 'relocation directory follows the grown section');
    assert.equal(result.sizeOfImage % pe.sectionAlignment, 0, 'SizeOfImage stays section-aligned');
    const rsrc = pe.sections.find((section) => section.name === '.rsrc');
    const reloc = pe.sections.find((section) => section.name === '.reloc');
    assert.ok(rsrc.virtualAddress + rsrc.virtualSize <= reloc.virtualAddress, '.rsrc and .reloc do not overlap');
  });

  (available ? it : it.skip)('is byte-stable and idempotent on the same image', () => {
    const before = readFileSync(electronExe);
    const first = embedIcon(before, ico);
    const second = embedIcon(first.buffer, ico);
    assert.ok(second.buffer.equals(first.buffer), 'embedding twice produces identical bytes');
  });

  (available ? it : it.skip)('reports an unpatched runtime as not carrying the approved artwork', () => {
    const result = verifyEmbeddedIcons(readFileSync(electronExe), ico);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /group has 4 images/.test(problem)));
  });
});
