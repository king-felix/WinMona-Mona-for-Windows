import { existsSync } from 'node:fs';
import { readGitBranch } from './identity.js';
import type { ProjectRow, ProjectStore, RuntimeBindingRow } from './store.js';

/**
 * A project as the catalog presents it: durable identity plus only the facts
 * that can be observed cheaply from the folder itself (existence and branch).
 * Listing never walks a drive; it inspects the registered paths.
 */
export type CatalogEntry = ProjectRow & {
  folderExists: boolean;
  branch: string | null;
  binding: RuntimeBindingRow | null;
  worktreeSiblingIds: string[];
};

export type CatalogListOptions = {
  includeArchived?: boolean;
  /** Case-insensitive substring search over label, path, branch and repo kind. */
  query?: string;
  limit?: number;
};

export type CatalogOptions = {
  /** Injected for tests and for platform-specific branch readers. */
  readBranch?: (canonicalPath: string) => string | null;
  folderExists?: (canonicalPath: string) => boolean;
};

const DEFAULT_LIMIT = 200;

/**
 * Read-only projection over the project store. Every mutation still goes through
 * the store's single write path, so catalog actions inherit its revision checks
 * and its guarantee that removing an entry never touches the folder.
 */
export class ProjectCatalog {
  private readonly readBranch: (canonicalPath: string) => string | null;
  private readonly folderExists: (canonicalPath: string) => boolean;

  constructor(
    private readonly store: ProjectStore,
    options: CatalogOptions = {},
  ) {
    this.readBranch = options.readBranch ?? readGitBranch;
    this.folderExists = options.folderExists ?? existsSync;
  }

  async list(options: CatalogListOptions = {}): Promise<CatalogEntry[]> {
    const rows = await this.store.listProjects({ includeArchived: options.includeArchived ?? false });
    const bindings = await this.store.listRuntimeBindings();
    const bindingByProject = new Map(bindings.map((binding) => [binding.projectId, binding]));
    const query = (options.query ?? '').trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), DEFAULT_LIMIT);

    const entries: CatalogEntry[] = [];
    for (const row of rows) {
      const entry = await this.describe(row, bindingByProject.get(row.id) ?? null);
      if (query && !matches(entry, query)) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries;
  }

  async get(id: string): Promise<CatalogEntry | null> {
    const row = await this.store.getProject(id);
    if (!row) return null;
    return await this.describe(row, await this.store.getRuntimeBinding(id));
  }

  async describe(row: ProjectRow, binding: RuntimeBindingRow | null = null): Promise<CatalogEntry> {
    const siblings = row.sharedRepoKey ? await this.store.listWorktreeSiblings(row.sharedRepoKey) : [];
    return {
      ...row,
      folderExists: this.folderExists(row.canonicalPath),
      branch: this.readBranch(row.canonicalPath),
      binding,
      worktreeSiblingIds: siblings.filter((sibling) => sibling.id !== row.id).map((sibling) => sibling.id),
    };
  }
}

function matches(entry: CatalogEntry, query: string): boolean {
  return (
    entry.label.toLowerCase().includes(query) ||
    entry.canonicalPath.toLowerCase().includes(query) ||
    (entry.branch ?? '').toLowerCase().includes(query) ||
    entry.repoKind.toLowerCase().includes(query)
  );
}
