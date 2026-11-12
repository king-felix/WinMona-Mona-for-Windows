import type { DatabaseSync } from 'node:sqlite';

/**
 * Local state failures are typed so callers never have to parse messages, and so
 * a UI can offer a real next step instead of a generic error.
 */
export type StateErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'stale_revision'
  | 'maintenance'
  | 'disk_full'
  | 'migration_failed'
  | 'migration_mismatch'
  | 'corrupt_state'
  | 'unsafe_location'
  | 'alias_conflict'
  | 'relocation_required'
  | 'digest_mismatch'
  | 'dependency_cycle'
  | 'not_eligible'
  | 'criteria_unsatisfied'
  | 'evidence_mismatch'
  | 'oversize'
  | 'internal';

export class StateError extends Error {
  constructor(
    readonly code: StateErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'StateError';
  }
}

export function stateError(code: StateErrorCode, message: string, detail?: string): StateError {
  return new StateError(code, message, detail);
}

export type StateResult<T> = { ok: true; value: T } | { ok: false; error: StateError };

/**
 * A single write path: every mutation goes through one transaction boundary that
 * also respects the maintenance barrier. Workers, ingestion and the UI share it,
 * so a restore cannot interleave with a write.
 */
export type Transaction = {
  db: DatabaseSync;
  now: () => string;
  /** Incremented per committed logical change, used for exported revisions. */
  revision: () => number;
  bumpRevision: () => number;
};

export type WriteOptions = {
  /** Project whose revision must match before the write is accepted. */
  projectId?: string;
  /** Refuse the write when the stored project revision is not this value. */
  expectedRevision?: number;
  /** Label recorded in diagnostics when a write is refused or fails. */
  label?: string;
};
