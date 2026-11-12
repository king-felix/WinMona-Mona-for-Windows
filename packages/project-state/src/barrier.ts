import { stateError } from './errors.js';

type Waiter = () => void;

/**
 * One barrier shared by every writer (UI, ingestion, workers, task runner).
 * Reads and writes are refused entry while a maintenance operation (backup,
 * restore, migration) holds exclusivity; exclusivity waits for in-flight work to
 * drain. Nothing may bypass it: the store's only write path enters here.
 */
export class MaintenanceBarrier {
  private active = 0;
  private maintenance: string | null = null;
  private mode: 'exclusive' | 'snapshot' = 'exclusive';
  private readonly waiters: Waiter[] = [];

  isBusy(): boolean {
    return this.maintenance !== null;
  }

  activeCount(): number {
    return this.active;
  }

  maintenanceLabel(): string | null {
    return this.maintenance;
  }

  async enter(kind: 'read' | 'write'): Promise<() => void> {
    // A snapshot (backup) blocks writers but keeps reads available so the UI does
    // not freeze; an exclusive operation (migration, restore) blocks both.
    if (this.maintenance !== null && !(kind === 'read' && this.mode === 'snapshot')) {
      throw stateError(
        'maintenance',
        `state is locked for maintenance (${this.maintenance}); ${kind} refused`,
        'Retry after the maintenance operation finishes.',
      );
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active === 0) {
        for (const waiter of this.waiters.splice(0)) waiter();
      }
    };
  }

  /** Runs `fn` with every writer quiesced. No new writer may enter meanwhile. */
  async exclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    return await this.locked(label, 'exclusive', fn);
  }

  /** Runs `fn` with writers quiesced while reads continue (backup snapshot). */
  async snapshot<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    return await this.locked(label, 'snapshot', fn);
  }

  private async locked<T>(label: string, mode: 'exclusive' | 'snapshot', fn: () => Promise<T> | T): Promise<T> {
    if (this.maintenance !== null) {
      throw stateError('maintenance', `maintenance already in progress (${this.maintenance})`);
    }
    this.maintenance = label;
    this.mode = mode;
    try {
      if (this.active > 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      return await fn();
    } finally {
      this.maintenance = null;
      this.mode = 'exclusive';
    }
  }
}
