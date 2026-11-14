/**
 * Seed docs/requirements-windows.json from the two Windows improvement
 * documents. The supplement is a separate ledger on purpose: the original
 * P00-P23 sequence is validated with its own id space (`Pnn`, `MONA-nnn`), and
 * loosening that schema to admit a second namespace would weaken the gate that
 * protects it.
 *
 * Everything here is derived from the documents, so the ledger cannot claim work
 * the documents do not describe. Re-running the seeder is safe: it rewrites the
 * file deterministically and preserves the recorded status of any prompt or
 * requirement that already exists, so progress is never reset by a re-seed.
 *
 * Run: node tools/build/seed-windows-ledger.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const PROJECT_DOC = 'Mona_Windows_Improvements_Project.md';
const PROMPTS_DOC = 'Mona_Windows_Improvements_PROMPTS.md';
const LEDGER = path.join(repoRoot, 'docs', 'requirements-windows.json');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function readDoc(name) {
  return readFileSync(path.join(repoRoot, name), 'utf8');
}

/** Rows of a pipe table whose first cell starts with the given prefix. */
function tableRows(text, prefixPattern) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!cells.length) continue;
    if (prefixPattern.test(cells[0])) rows.push(cells);
  }
  return rows;
}

/** W ids that actually gate this prompt: the part before the first semicolon. */
function prerequisitesFrom(cell) {
  const gating = cell.split(';')[0];
  const ids = [...gating.matchAll(/\bW\d{2}\b/g)].map((match) => match[0]);
  return [...new Set(ids)];
}

function specSectionsFrom(cell) {
  return [...new Set([...cell.matchAll(/\bS\d{2}\b/g)].map((match) => match[0]))];
}

function promptBlocks(text) {
  const blocks = new Map();
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    // ASCII-only on purpose: a PowerShell round-trip can silently rewrite a
    // literal em dash into mojibake, which then stops matching the document.
    const heading = /^### (W\d{2})\s+[\u2014\u2013-]\s+(.+)$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), body: [] };
      blocks.set(current.id, current);
      continue;
    }
    if (/^##\s/.test(line)) current = null;
    else if (current) current.body.push(line);
  }
  return blocks;
}

function field(body, label) {
  const text = body.join('\n');
  const match = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z][a-z]+:\\*\\*|\\n###|$)`).exec(
    text,
  );
  return match ? match[1].trim().replace(/\s+/g, ' ') : '';
}

export function buildLedger({ projectText, promptsText, previous }) {
  const promptRows = new Map(
    tableRows(promptsText, /^W\d{2}$/).map((cells) => [cells[0], cells]),
  );
  const blocks = promptBlocks(promptsText);
  const requirementRows = tableRows(projectText, /^WX-\d{2}$/);

  const previousPrompts = new Map((previous?.prompts ?? []).map((row) => [row.id, row]));
  const previousRequirements = new Map((previous?.requirements ?? []).map((row) => [row.id, row]));

  const prompts = [...blocks.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((block) => {
      const row = promptRows.get(block.id);
      if (!row) throw new Error(`${block.id} has a section but no dependency-map row`);
      const owner = previousPrompts.get(block.id);
      return {
        id: block.id,
        title: block.title,
        deliverable: row[1],
        prerequisites: prerequisitesFrom(row[2]),
        spec_sections: specSectionsFrom(row[3]),
        acceptance: field(block.body, 'Acceptance'),
        // W25 is a closure prompt and the document gives it no checkpoint; record
        // the absence as null rather than inventing one.
        checkpoint: field(block.body, 'Checkpoint') || null,
        requirements: owner?.requirements ?? [],
        status: owner?.status ?? 'pending',
        evidence: owner?.evidence ?? [],
        notes: owner?.notes ?? '',
      };
    });

  const requirements = requirementRows.map((cells) => {
    const id = cells[0];
    const owner = previousRequirements.get(id);
    return {
      id,
      title: cells[1],
      owning_prompts: [...new Set([...cells[2].matchAll(/\bW\d{2}\b/g)].map((match) => match[0]))],
      status: owner?.status ?? 'pending',
      criteria:
        owner?.criteria ??
        [
          {
            id: 'outcome',
            description: cells[1],
            status: 'pending',
            evidence: [],
          },
        ],
      verified_commit: owner?.verified_commit ?? null,
      tested_environment: owner?.tested_environment ?? null,
      open_issue_ids: owner?.open_issue_ids ?? [],
      // S10 requires the implementer to map supplement ids onto the original
      // ledger. Leaving this empty is the honest state until that mapping is
      // done; validation refuses a verified row with no mapping.
      original_requirements: owner?.original_requirements ?? [],
    };
  });

  const byRequirement = new Map(requirements.map((row) => [row.id, row]));
  void byRequirement;
  // Ownership is symmetric by construction: a prompt claims the requirements
  // whose S10 row names it, and nothing else.
  for (const prompt of prompts) {
    prompt.requirements = requirements
      .filter((row) => row.owning_prompts.includes(prompt.id))
      .map((row) => row.id);
  }
  for (const row of requirements) {
    for (const id of row.owning_prompts) {
      if (!prompts.some((candidate) => candidate.id === id)) {
        throw new Error(`${row.id} names unknown prompt ${id}`);
      }
    }
  }

  return {
    schema_version: 1,
    revision: (previous?.revision ?? 0) + 1,
    spec: {
      file: PROJECT_DOC,
      companion_file: PROMPTS_DOC,
      version: '1.0',
      sha256: sha256(Buffer.from(projectText, 'utf8')),
      companion_sha256: sha256(Buffer.from(promptsText, 'utf8')),
    },
    purpose:
      'Pending registry for the Windows improvement supplement (W00-W25, WX-01-WX-18). Separate from docs/requirements.json so the original P00-P23 id space keeps its own schema. Regenerate with `node tools/build/seed-windows-ledger.mjs`.',
    prompts,
    requirements,
  };
}

function main() {
  const projectText = readDoc(PROJECT_DOC);
  const promptsText = readDoc(PROMPTS_DOC);
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch {
    previous = null;
  }
  const ledger = buildLedger({ projectText, promptsText, previous });
  // Only advance the revision when something other than the revision changed, so
  // re-seeding an unchanged document does not churn the file.
  if (previous) {
    const comparable = (value) => {
      const clone = JSON.parse(JSON.stringify(value));
      delete clone.revision;
      return JSON.stringify(clone);
    };
    if (comparable(previous) === comparable(ledger)) {
      ledger.revision = previous.revision;
    }
  }
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `seeded ${ledger.prompts.length} prompts and ${ledger.requirements.length} requirements (revision ${ledger.revision}) -> docs/requirements-windows.json\n`,
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

