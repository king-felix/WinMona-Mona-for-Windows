import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLASH_CATALOG, SLASH_CATALOG_PROVENANCE } from '../shared/slash-catalog.js';

/**
 * Coverage fixture for W04. The shipped catalog must reconcile, one row at a
 * time, with the registry the pinned engine actually served at GET /v1/commands
 * (recorded in docs/evidence/W04-commands-raw.json). No omission is silent and
 * no row is invented.
 */
const RAW_PATH = path.resolve(process.cwd(), 'docs', 'evidence', 'W04-commands-raw.json');

type RawCommand = {
  name: string;
  aliases?: string[];
  summary?: string;
  usage?: string;
  subcommands?: string[];
  hidden?: boolean;
  discovery?: string;
};
type RawCapture = {
  captured_at: string;
  engine: { version: string; commit: string | null };
  commands: RawCommand[];
};

const raw = JSON.parse(readFileSync(RAW_PATH, 'utf8')) as RawCapture;

describe('slash catalog coverage', () => {
  it('reconciles every registry row exactly once, by name', () => {
    const registry = raw.commands.map((command) => command.name).sort();
    const catalog = SLASH_CATALOG.map((entry) => entry.name).sort();
    expect(catalog).toEqual(registry);
    expect(new Set(catalog).size).toBe(catalog.length);
  });

  it('reconciles every alias the engine declares, and invents none', () => {
    const registryAliases = raw.commands
      .flatMap((command) => (command.aliases ?? []).map((alias) => `${command.name}/${alias}`))
      .sort();
    const catalogAliases = SLASH_CATALOG.flatMap((entry) =>
      entry.aliases.map((alias) => `${entry.name}/${alias}`),
    ).sort();
    expect(catalogAliases).toEqual(registryAliases);
  });

  it('keeps the engine summary, usage and subcommands for each row', () => {
    for (const command of raw.commands) {
      const entry = SLASH_CATALOG.find((candidate) => candidate.name === command.name);
      expect(entry, `missing ${command.name}`).toBeDefined();
      if (!entry) continue;
      expect(entry.summary).toBe(command.summary ?? '');
      expect(entry.usage).toBe(command.usage ?? `/${command.name}`);
      expect([...entry.subcommands]).toEqual(command.subcommands ?? []);
      expect(entry.hidden).toBe(command.hidden === true);
      expect(entry.discovery).toBe(command.discovery === 'primary' ? 'primary' : 'advanced');
    }
  });

  it('records provenance that matches the captured engine', () => {
    expect(SLASH_CATALOG_PROVENANCE.engineVersion).toBe(raw.engine.version);
    expect(SLASH_CATALOG_PROVENANCE.engineCommit).toBe(raw.engine.commit);
    expect(SLASH_CATALOG_PROVENANCE.capturedAt).toBe(raw.captured_at);
    expect(SLASH_CATALOG_PROVENANCE.registryCount).toBe(raw.commands.length);
  });

  it('gives every row a cost class, side-effect note and truthful route', () => {
    for (const entry of SLASH_CATALOG) {
      expect(['none', 'model', 'unknown']).toContain(entry.costClass);
      expect(['mona', 'tui-only', 'unsupported']).toContain(entry.route);
      expect(entry.sideEffects.length).toBeGreaterThan(10);
      expect(entry.routeNote.length).toBeGreaterThan(10);
      expect(entry.summary.length).toBeGreaterThan(0);
      // A row that can spend tokens must not claim "no provider request".
      if (entry.costClass === 'model') expect(entry.sideEffects.toLowerCase()).toContain('provider request');
    }
  });

  it('has no alias that collides with another command or alias', () => {
    const names = new Set(SLASH_CATALOG.map((entry) => entry.name));
    const seen = new Set<string>();
    for (const entry of SLASH_CATALOG) {
      for (const alias of entry.aliases) {
        expect(names.has(alias), `${alias} collides with a command name`).toBe(false);
        expect(seen.has(alias), `${alias} is claimed twice`).toBe(false);
        seen.add(alias);
      }
    }
  });

  it('marks the engine-hidden rows as hidden rather than dropping them', () => {
    const hiddenInRegistry = raw.commands.filter((command) => command.hidden === true).map((c) => c.name);
    const hiddenInCatalog = SLASH_CATALOG.filter((entry) => entry.hidden).map((entry) => entry.name);
    expect(hiddenInCatalog.sort()).toEqual(hiddenInRegistry.sort());
  });
});
