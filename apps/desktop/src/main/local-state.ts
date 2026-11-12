import path from 'node:path';
import {
  ArtifactStore,
  SqliteSubmissionJournal,
  openState,
  type MigrationReport,
  type ProjectStore,
} from '@mona/project-state';

export type LocalState = {
  store: ProjectStore;
  journal: SqliteSubmissionJournal;
  artifacts: ArtifactStore;
  schemaVersion: number;
  migrations: MigrationReport;
  backupRoot: string;
  artifactRoot: string;
  close: () => void;
};

/**
 * The desktop's local state lives under the app's private data directory, never
 * in a project folder and never on a network share. Opening it applies
 * migrations under the maintenance barrier and keeps a verified pre-migration
 * backup when the database already existed.
 */
export async function openLocalState(directory: string): Promise<LocalState> {
  const opened = await openState({ directory: path.resolve(directory) });
  return {
    store: opened.store,
    journal: new SqliteSubmissionJournal(opened.store),
    artifacts: new ArtifactStore({ root: opened.artifactRoot }),
    schemaVersion: opened.schemaVersion,
    migrations: opened.migrations,
    backupRoot: opened.backupRoot,
    artifactRoot: opened.artifactRoot,
    close: () => opened.store.close(),
  };
}
