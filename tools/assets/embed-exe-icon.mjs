/**
 * Embed the approved Mona icon into the staged Windows executable.
 *
 * Why this exists: `Mona.exe` is the Electron runtime renamed, so its embedded
 * icon group is still Electron's. Window, taskbar, tray, Start and package
 * surfaces already carry the approved mark, but Explorer, the taskbar's
 * "unpinned" view and Task Manager read the icon out of the PE resource
 * section. This module replaces `RT_GROUP_ICON`/`RT_ICON` there, from the same
 * `assets/brand/generated/mona.ico` the rest of the product uses.
 *
 * Why hand-rolled: the repository carries no image or PE-editing dependency, and
 * the result must be reproducible from a recorded source hash. The rewrite is a
 * pure function of (executable bytes, ICO bytes): no timestamps, no padding
 * randomness, no reordering beyond a deterministic sort.
 *
 * What it does NOT do: it does not touch any other resource (version info,
 * manifest, string tables) and it does not pretend a modified binary is signed.
 * Electron's distributed executable is unsigned, so no signature is invalidated
 * here; if a signed input is ever supplied, this tool clears the security
 * directory instead of leaving a stale, broken signature claim behind.
 *
 * Usage:
 *   node tools/assets/embed-exe-icon.mjs <exe> [--ico <path>]
 *   node tools/assets/embed-exe-icon.mjs <exe> --verify
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const DEFAULT_ICO = path.join(repoRoot, 'assets', 'brand', 'generated', 'mona.ico');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const ICO_LANG = 0x0409;
const DIRECTORY_FLAG = 0x80000000;

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

/* ------------------------------------------------------------------------- */
/* ICO                                                                        */
/* ------------------------------------------------------------------------- */

/** Parse an ICO file into ordered entries, keeping each payload verbatim. */
export function parseIco(buffer) {
  if (buffer.length < 6) throw new Error('ICO is truncated');
  if (buffer.readUInt16LE(0) !== 0) throw new Error('ICO reserved field is not 0');
  if (buffer.readUInt16LE(2) !== 1) throw new Error('ICO type is not 1 (icon)');
  const count = buffer.readUInt16LE(4);
  if (count === 0) throw new Error('ICO contains no images');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    if (at + 16 > buffer.length) throw new Error('ICO directory is truncated');
    const width = buffer[at] === 0 ? 256 : buffer[at];
    const height = buffer[at + 1] === 0 ? 256 : buffer[at + 1];
    const planes = buffer.readUInt16LE(at + 4);
    const bitDepth = buffer.readUInt16LE(at + 6);
    const bytes = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (offset + bytes > buffer.length) throw new Error(`ICO image ${index} runs past the file`);
    entries.push({
      width,
      height,
      planes,
      bitDepth,
      bytes,
      offset,
      payload: buffer.subarray(offset, offset + bytes),
    });
  }
  return entries;
}

/** The RT_GROUP_ICON payload: ICONDIR plus one 14-byte row per image. */
export function encodeIconGroup(entries, firstId = 1) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const rows = Buffer.alloc(entries.length * 14);
  entries.forEach((entry, index) => {
    const at = index * 14;
    rows[at] = entry.width >= 256 ? 0 : entry.width;
    rows[at + 1] = entry.height >= 256 ? 0 : entry.height;
    rows[at + 2] = 0;
    rows[at + 3] = 0;
    rows.writeUInt16LE(entry.planes, at + 4);
    rows.writeUInt16LE(entry.bitDepth, at + 6);
    rows.writeUInt32LE(entry.payload.length, at + 8);
    rows.writeUInt16LE(firstId + index, at + 12);
  });
  return Buffer.concat([header, rows]);
}

/* ------------------------------------------------------------------------- */
/* PE headers                                                                 */
/* ------------------------------------------------------------------------- */

/** Locate the pieces of a PE32/PE32+ image this module needs. */
export function parsePeHeaders(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) throw new Error('not an MZ executable');
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 0x18 > buffer.length) throw new Error('PE header lies outside the file');
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error('missing PE signature');
  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalOffset);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unsupported optional-header magic 0x${magic.toString(16)}`);
  const pe32Plus = magic === 0x20b;
  const dataDirectoryOffset = optionalOffset + (pe32Plus ? 112 : 96);
  const directoryCount = buffer.readUInt32LE(optionalOffset + (pe32Plus ? 108 : 92));
  if (directoryCount < 6) throw new Error('image has no base-relocation directory slot');
  const sectionAlignment = buffer.readUInt32LE(optionalOffset + 32);
  const fileAlignment = buffer.readUInt32LE(optionalOffset + 36);
  const sizeOfImageOffset = optionalOffset + 56;
  const sectionTableOffset = optionalOffset + optionalSize;
  if (sectionTableOffset + sectionCount * 40 > buffer.length) throw new Error('section table is truncated');
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const at = sectionTableOffset + index * 40;
    sections.push({
      index,
      name: buffer
        .subarray(at, at + 8)
        .toString('latin1')
        .replace(/\0+$/, ''),
      headerOffset: at,
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      rawSize: buffer.readUInt32LE(at + 16),
      rawPointer: buffer.readUInt32LE(at + 20),
    });
  }
  const directory = (index) => ({
    rva: buffer.readUInt32LE(dataDirectoryOffset + index * 8),
    size: buffer.readUInt32LE(dataDirectoryOffset + index * 8 + 4),
  });
  return {
    peOffset,
    machine,
    pe32Plus,
    optionalOffset,
    sectionAlignment,
    fileAlignment,
    sizeOfImageOffset,
    dataDirectoryOffset,
    sectionTableOffset,
    sections,
    resourceDirectory: directory(2),
    securityDirectory: directory(4),
    relocationDirectory: directory(5),
  };
}

function sectionForRva(pe, rva) {
  const section = pe.sections.find(
    (candidate) =>
      candidate.virtualAddress <= rva &&
      rva < candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize),
  );
  if (!section) throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  return section;
}

function rvaToOffset(pe, rva) {
  const section = sectionForRva(pe, rva);
  const delta = rva - section.virtualAddress;
  if (delta >= section.rawSize) throw new Error(`RVA 0x${rva.toString(16)} has no file backing`);
  return section.rawPointer + delta;
}

/* ------------------------------------------------------------------------- */
/* Resource tree                                                              */
/* ------------------------------------------------------------------------- */

function readUtf16Name(buffer, offset) {
  const length = buffer.readUInt16LE(offset);
  return buffer.subarray(offset + 2, offset + 2 + length * 2).toString('utf16le');
}

/**
 * Parse the resource directory into a generic tree.
 *
 * A node is either `{ kind: 'dir', entries: Map<key, node> }` or
 * `{ kind: 'data', codePage, bytes }`. Keys are numbers for ID entries and
 * strings for named entries.
 */
export function readResourceTree(buffer) {
  const pe = parsePeHeaders(buffer);
  const { rva } = pe.resourceDirectory;
  if (rva === 0) throw new Error('image has no resource directory');
  const base = rvaToOffset(pe, rva);
  const readNode = (relative, depth) => {
    if (depth > 4) throw new Error('resource tree is deeper than four levels');
    const at = base + relative;
    const namedCount = buffer.readUInt16LE(at + 12);
    const idCount = buffer.readUInt16LE(at + 14);
    const entries = new Map();
    for (let index = 0; index < namedCount + idCount; index += 1) {
      const entryAt = at + 16 + index * 8;
      const nameField = buffer.readUInt32LE(entryAt);
      const dataField = buffer.readUInt32LE(entryAt + 4);
      const key = nameField & DIRECTORY_FLAG ? readUtf16Name(buffer, base + (nameField & 0x7fffffff)) : nameField;
      if (dataField & DIRECTORY_FLAG) {
        entries.set(key, readNode(dataField & 0x7fffffff, depth + 1));
      } else {
        const dataAt = base + dataField;
        const dataRva = buffer.readUInt32LE(dataAt);
        const size = buffer.readUInt32LE(dataAt + 4);
        const offset = rvaToOffset(pe, dataRva);
        entries.set(key, {
          kind: 'data',
          codePage: buffer.readUInt32LE(dataAt + 8),
          bytes: buffer.subarray(offset, offset + size),
        });
      }
    }
    return { kind: 'dir', entries };
  };
  return { pe, tree: readNode(0, 0) };
}

function sortedKeys(node) {
  const keys = [...node.entries.keys()];
  return keys.sort((left, right) => {
    const leftNamed = typeof left === 'string';
    const rightNamed = typeof right === 'string';
    if (leftNamed !== rightNamed) return leftNamed ? -1 : 1;
    if (leftNamed) return String(left).localeCompare(String(right));
    return Number(left) - Number(right);
  });
}

/**
 * Serialize a resource tree into section content.
 *
 * Layout: every directory block, then the name strings, then the data entries,
 * then the blobs (4-byte aligned). Offsets are relative to the resource base,
 * so the caller must place this buffer at the resource directory RVA.
 */
export function encodeResourceTree(tree, resourceRva) {
  const blocks = [];
  const walk = (node) => {
    const block = { node, offset: 0, entries: [] };
    blocks.push(block);
    for (const key of sortedKeys(node)) {
      const child = node.entries.get(key);
      block.entries.push({ key, child });
      if (child.kind === 'dir') walk(child);
    }
    return block;
  };
  walk(tree);

  const names = new Map();
  const dataEntries = [];
  let cursor = 0;
  for (const block of blocks) {
    block.offset = cursor;
    cursor += 16 + block.entries.length * 8;
    for (const entry of block.entries) {
      if (typeof entry.key === 'string' && !names.has(entry.key)) names.set(entry.key, 0);
      if (entry.child.kind === 'data') dataEntries.push(entry);
    }
  }
  cursor = alignUp(cursor, 4);
  for (const name of names.keys()) {
    names.set(name, cursor);
    cursor += 2 + name.length * 2;
  }
  cursor = alignUp(cursor, 4);
  const entryOffsets = new Map();
  for (const entry of dataEntries) {
    entryOffsets.set(entry, cursor);
    cursor += 16;
  }
  cursor = alignUp(cursor, 4);
  const blobOffsets = new Map();
  for (const entry of dataEntries) {
    blobOffsets.set(entry, cursor);
    cursor += entry.child.bytes.length;
    cursor = alignUp(cursor, 4);
  }

  const output = Buffer.alloc(cursor);
  for (const block of blocks) {
    const at = block.offset;
    output.writeUInt32LE(0, at);
    output.writeUInt32LE(0, at + 4);
    output.writeUInt16LE(0, at + 8);
    output.writeUInt16LE(0, at + 10);
    const namedCount = block.entries.filter((entry) => typeof entry.key === 'string').length;
    output.writeUInt16LE(namedCount, at + 12);
    output.writeUInt16LE(block.entries.length - namedCount, at + 14);
    block.entries.forEach((entry, index) => {
      const entryAt = at + 16 + index * 8;
      if (typeof entry.key === 'string') output.writeUInt32LE((DIRECTORY_FLAG | names.get(entry.key)) >>> 0, entryAt);
      else output.writeUInt32LE(entry.key >>> 0, entryAt);
      if (entry.child.kind === 'dir') {
        const childBlock = blocks.find((candidate) => candidate.node === entry.child);
        output.writeUInt32LE((DIRECTORY_FLAG | childBlock.offset) >>> 0, entryAt + 4);
      } else {
        output.writeUInt32LE(entryOffsets.get(entry), entryAt + 4);
      }
    });
  }
  for (const [name, offset] of names) {
    output.writeUInt16LE(name.length, offset);
    output.write(name, offset + 2, 'utf16le');
  }
  for (const entry of dataEntries) {
    const at = entryOffsets.get(entry);
    output.writeUInt32LE(resourceRva + blobOffsets.get(entry), at);
    output.writeUInt32LE(entry.child.bytes.length, at + 4);
    output.writeUInt32LE(entry.child.codePage ?? 0, at + 8);
    output.writeUInt32LE(0, at + 12);
    entry.child.bytes.copy(output, blobOffsets.get(entry));
  }
  return output;
}

/* ------------------------------------------------------------------------- */
/* Icon replacement                                                           */
/* ------------------------------------------------------------------------- */

/** Read the icon group and icon images back out of an executable. */
export function readExeIcons(buffer) {
  const { tree } = readResourceTree(buffer);
  const iconType = tree.entries.get(RT_ICON);
  const groupType = tree.entries.get(RT_GROUP_ICON);
  if (!iconType || !groupType) return null;
  const images = new Map();
  for (const [name, nameNode] of iconType.entries) {
    if (nameNode.kind !== 'dir') continue;
    const languageNode = [...nameNode.entries.values()][0];
    if (languageNode?.kind === 'data') images.set(Number(name), languageNode.bytes);
  }
  const groupName = [...groupType.entries.values()][0];
  if (groupName?.kind !== 'dir') return null;
  const groupData = [...groupName.entries.values()][0];
  if (groupData?.kind !== 'data') return null;
  const count = groupData.bytes.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 14;
    entries.push({
      width: groupData.bytes[at] === 0 ? 256 : groupData.bytes[at],
      height: groupData.bytes[at + 1] === 0 ? 256 : groupData.bytes[at + 1],
      bitDepth: groupData.bytes.readUInt16LE(at + 6),
      bytes: groupData.bytes.readUInt32LE(at + 8),
      id: groupData.bytes.readUInt16LE(at + 12),
    });
  }
  return { entries, images };
}

function dataNode(bytes, codePage = 0) {
  return { kind: 'data', codePage, bytes };
}

/** Replace the icon resources in an executable image. Pure function. */
export function embedIcon(buffer, icoBuffer, { language = ICO_LANG } = {}) {
  const icons = parseIco(icoBuffer);
  const { pe, tree } = readResourceTree(buffer);
  const resourceSection = sectionForRva(pe, pe.resourceDirectory.rva);
  if (resourceSection.name !== '.rsrc')
    throw new Error(`resource directory lives in ${resourceSection.name}, not .rsrc`);

  // Re-running staging must not grow the file again; if the artwork is already
  // the approved one, the bytes are returned untouched.
  const existing = verifyEmbeddedIcons(buffer, icoBuffer);
  if (existing.ok) {
    return {
      buffer,
      alreadyEmbedded: true,
      resourceRva: pe.resourceDirectory.rva,
      resourceBytes: pe.resourceDirectory.size,
      previousRelocationRva: pe.relocationDirectory.rva,
      relocationRva: pe.relocationDirectory.rva,
      sizeOfImage: buffer.readUInt32LE(pe.sizeOfImageOffset),
      elapsedMs: 0,
      icons,
    };
  }

  const now = Date.now();
  if (pe.securityDirectory.rva !== 0) {
    throw new Error(
      'the input executable is signed; embedding an icon would invalidate that signature. Refusing rather than shipping a stale signature.',
    );
  }

  const iconNode = { kind: 'dir', entries: new Map() };
  icons.forEach((entry, index) => {
    iconNode.entries.set(index + 1, {
      kind: 'dir',
      entries: new Map([[language, dataNode(entry.payload)]]),
    });
  });
  const groupNode = {
    kind: 'dir',
    entries: new Map([[1, { kind: 'dir', entries: new Map([[language, dataNode(encodeIconGroup(icons))]]) }]]),
  };
  tree.entries.set(RT_ICON, iconNode);
  tree.entries.set(RT_GROUP_ICON, groupNode);

  const content = encodeResourceTree(tree, pe.resourceDirectory.rva);
  const sectionAlignment = pe.sectionAlignment;
  const fileAlignment = pe.fileAlignment;

  // Keep the resource RVA where it is and grow it into the space the following
  // sections occupy only by moving those sections. Electron's image has exactly
  // one section after .rsrc (base relocations), which nothing addresses except
  // the relocation data directory.
  const following = pe.sections.filter((section) => section.virtualAddress > resourceSection.virtualAddress);
  if (following.length !== 1 || following[0].name !== '.reloc') {
    throw new Error(
      `expected .rsrc followed only by .reloc, found ${following.map((s) => s.name).join(', ') || 'none'}`,
    );
  }
  const relocSection = following[0];
  const newRelocRva = alignUp(resourceSection.virtualAddress + content.length, sectionAlignment);
  const newSizeOfImage = alignUp(
    newRelocRva + Math.max(relocSection.virtualSize, relocSection.rawSize),
    sectionAlignment,
  );

  const rawOffset = alignUp(buffer.length, fileAlignment);
  const rawSize = alignUp(content.length, fileAlignment);
  const output = Buffer.alloc(rawOffset + rawSize);
  buffer.copy(output, 0);
  content.copy(output, rawOffset);

  // Section header: .rsrc keeps its RVA, gains new size and a new file backing.
  output.writeUInt32LE(content.length, resourceSection.headerOffset + 8);
  output.writeUInt32LE(rawSize, resourceSection.headerOffset + 16);
  output.writeUInt32LE(rawOffset, resourceSection.headerOffset + 20);

  // Section header: .reloc keeps its bytes, gains a new RVA past the grown .rsrc.
  output.writeUInt32LE(newRelocRva, relocSection.headerOffset + 12);

  output.writeUInt32LE(newSizeOfImage, pe.sizeOfImageOffset);
  const resourceDirectoryAt = pe.dataDirectoryOffset + 2 * 8;
  output.writeUInt32LE(pe.resourceDirectory.rva, resourceDirectoryAt);
  output.writeUInt32LE(content.length, resourceDirectoryAt + 4);
  const relocationDirectoryAt = pe.dataDirectoryOffset + 5 * 8;
  output.writeUInt32LE(newRelocRva, relocationDirectoryAt);

  return {
    buffer: output,
    resourceRva: pe.resourceDirectory.rva,
    resourceBytes: content.length,
    relocatedSection: '.reloc',
    previousRelocationRva: pe.relocationDirectory.rva,
    relocationRva: newRelocRva,
    sizeOfImage: newSizeOfImage,
    elapsedMs: Date.now() - now,
    icons,
  };
}

/**
 * Embed the icon into a file on disk and verify the result before returning.
 * Staging calls this so a distribution step cannot silently ship Electron's
 * artwork, and a failed embed fails the stage rather than the runtime.
 */
export function embedIconFile(exePath, icoPath = DEFAULT_ICO) {
  if (!existsSync(icoPath)) {
    throw new Error(`icon not found: ${icoPath}. Run \`npm run assets:icons\`; no icon is invented.`);
  }
  const ico = readFileSync(icoPath);
  const before = readFileSync(exePath);
  const result = embedIcon(before, ico);
  const verification = verifyEmbeddedIcons(result.buffer, ico);
  if (!verification.ok) {
    throw new Error(`embedded icon did not verify: ${verification.problems.join('; ')}`);
  }
  writeFileSync(exePath, result.buffer);
  return { ...result, verification };
}

/** True when every icon the ICO declares is present, byte for byte, in the image. */
export function verifyEmbeddedIcons(buffer, icoBuffer) {
  const expected = parseIco(icoBuffer);
  const actual = readExeIcons(buffer);
  if (!actual) return { ok: false, problems: ['image carries no icon group'] };
  const problems = [];
  if (actual.entries.length !== expected.length) {
    problems.push(`group has ${actual.entries.length} images, ICO has ${expected.length}`);
  }
  expected.forEach((entry, index) => {
    const row = actual.entries[index];
    if (!row) {
      problems.push(`group is missing image ${index}`);
      return;
    }
    if (row.width !== entry.width || row.height !== entry.height) {
      problems.push(`image ${index} is ${row.width}x${row.height}, expected ${entry.width}x${entry.height}`);
    }
    const payload = actual.images.get(row.id);
    if (!payload) problems.push(`image ${index} references missing RT_ICON ${row.id}`);
    else if (!payload.equals(entry.payload)) problems.push(`image ${index} bytes differ from the ICO payload`);
  });
  for (const [id, bytes] of actual.images) {
    if (!actual.entries.some((row) => row.id === id)) problems.push(`RT_ICON ${id} is orphaned`);
    if (bytes.length === 0) problems.push(`RT_ICON ${id} is empty`);
  }
  return { ok: problems.length === 0, problems, entries: actual.entries };
}

function main() {
  const args = process.argv.slice(2);
  const exe = args.find((arg) => !arg.startsWith('--'));
  const icoFlag = args.indexOf('--ico');
  const icoPath = icoFlag >= 0 ? args[icoFlag + 1] : DEFAULT_ICO;
  if (!exe) {
    process.stderr.write('usage: node tools/assets/embed-exe-icon.mjs <exe> [--ico <path>] [--verify]\n');
    process.exit(2);
  }
  const target = path.resolve(exe);
  if (!existsSync(target)) throw new Error(`executable not found: ${target}`);
  if (!existsSync(icoPath)) {
    throw new Error(`icon not found: ${icoPath}. Run \`npm run assets:icons\`; no icon is invented.`);
  }
  const ico = readFileSync(icoPath);
  const verifyOnly = args.includes('--verify');

  if (verifyOnly) {
    const result = verifyEmbeddedIcons(readFileSync(target), ico);
    process.stdout.write(`${JSON.stringify({ exe: target, ico: icoPath, ...result }, null, 2)}\n`);
    if (!result.ok) process.exit(1);
    return;
  }

  const result = embedIconFile(target, icoPath);
  const verification = result.verification;
  if (result.alreadyEmbedded) {
    process.stdout.write(
      `${path.basename(target)}: already carries the approved artwork (${verification.entries.length} images)\n`,
    );
    return;
  }
  process.stdout.write(
    `${path.basename(target)}: embedded ${result.icons.length} icon images (${result.resourceBytes} resource bytes, .reloc 0x${result.previousRelocationRva.toString(16)} -> 0x${result.relocationRva.toString(16)})\n`,
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
