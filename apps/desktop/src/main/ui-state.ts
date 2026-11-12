import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AttentionPatch, AttentionPreferences, Density } from '../shared/attention.js';
import type {
  DraftSession,
  ProjectLayout,
  ProjectUiState,
  ProjectView,
  PromptFavorite,
  UiStateView,
} from '../shared/catalog.js';
import { DEFAULT_ATTENTION_SETTINGS, validMinute, validTimeZone } from './attention.js';

/**
 * Independent UI state: the selected project, the last view and layout per
 * project, unsent drafts, prompt favorites, density, notification policy, and
 * the last time Victor saw a project's digest. It is machine-local JSON,
 * deliberately separate from the SQLite project database (drafts are not
 * project content) and separate from the renderer (a reload must not lose it).
 */
type StoredUiState = {
  schemaVersion: 2;
  currentProjectId: string | null;
  preferences: AttentionPreferences;
  projects: Record<string, ProjectUiState>;
};

const VIEWS: readonly ProjectView[] = ['home', 'studio', 'work', 'cost', 'settings'];
const LAYOUTS: readonly ProjectLayout[] = ['standard', 'focus'];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
const MAX_SESSIONS = 20;
const MAX_FAVORITES = 12;
const MAX_DRAFT_CHARS = 200_000;
const MAX_FAVORITE_CHARS = 20_000;
const MAX_FAVORITE_LABEL = 120;

export type UiStateStoreOptions = {
  file: string;
  now?: () => Date;
};

function defaultPreferences(): AttentionPreferences {
  return {
    ...DEFAULT_ATTENTION_SETTINGS,
    quietHours: { ...DEFAULT_ATTENTION_SETTINGS.quietHours },
    density: 'comfortable',
    firstCloseNotified: false,
  };
}

export class UiStateStore {
  private readonly file: string;
  private readonly now: () => Date;
  private state: StoredUiState;
  private warning: string | null = null;

  constructor(options: UiStateStoreOptions) {
    this.file = path.resolve(options.file);
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  view(): UiStateView {
    return {
      currentProjectId: this.state.currentProjectId,
      projects: cloneProjects(this.state.projects),
      preferences: {
        ...this.state.preferences,
        quietHours: { ...this.state.preferences.quietHours },
      },
      warning: this.warning,
    };
  }

  select(projectId: string | null): UiStateView {
    this.state.currentProjectId = projectId;
    if (projectId) {
      const entry = this.ensure(projectId);
      entry.lastOpenedAt = this.timestamp();
    }
    this.persist();
    return this.view();
  }

  setView(projectId: string, view: ProjectView): UiStateView {
    const entry = this.ensure(projectId);
    entry.view = view;
    entry.lastOpenedAt = this.timestamp();
    this.persist();
    return this.view();
  }

  /** The saved panel layout. Focus mode is a layout, not a transient toggle. */
  setLayout(projectId: string, layout: ProjectLayout): UiStateView {
    if (!LAYOUTS.includes(layout)) throw new Error('Unknown panel layout.');
    const entry = this.ensure(projectId);
    entry.layout = layout;
    entry.lastOpenedAt = this.timestamp();
    this.persist();
    return this.view();
  }

  saveDraft(projectId: string, sessionId: string, text: string): UiStateView {
    const entry = this.ensure(projectId);
    const bounded = text.slice(0, MAX_DRAFT_CHARS);
    const at = this.timestamp();
    const existing = entry.sessions.find((session) => session.sessionId === sessionId);
    if (existing) {
      existing.text = bounded;
      existing.updatedAt = at;
    } else {
      entry.sessions.push({ sessionId, updatedAt: at, text: bounded });
    }
    entry.currentSessionId = sessionId;
    entry.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (entry.sessions.length > MAX_SESSIONS) entry.sessions.length = MAX_SESSIONS;
    this.persist();
    return this.view();
  }

  newSession(projectId: string): UiStateView {
    const entry = this.ensure(projectId);
    const session: DraftSession = {
      sessionId: `ses_${randomUUID().replaceAll('-', '')}`,
      updatedAt: this.timestamp(),
      text: '',
    };
    entry.sessions.unshift(session);
    entry.currentSessionId = session.sessionId;
    if (entry.sessions.length > MAX_SESSIONS) entry.sessions.length = MAX_SESSIONS;
    this.persist();
    return this.view();
  }

  /** Prompt favorites are inserted into the composer; nothing is sent. */
  saveFavorite(projectId: string, input: { label: string; text: string }): UiStateView {
    const entry = this.ensure(projectId);
    const label = input.label.trim().slice(0, MAX_FAVORITE_LABEL);
    const text = input.text.slice(0, MAX_FAVORITE_CHARS);
    if (!label) throw new Error('A prompt favorite needs a label.');
    if (!text.trim()) throw new Error('A prompt favorite needs text.');
    const duplicate = entry.favorites.find((favorite) => favorite.text === text);
    if (duplicate) {
      duplicate.label = label;
      duplicate.createdAt = this.timestamp();
    } else {
      const favorite: PromptFavorite = {
        id: `pfv_${randomUUID().replaceAll('-', '')}`,
        label,
        text,
        createdAt: this.timestamp(),
      };
      entry.favorites.unshift(favorite);
      if (entry.favorites.length > MAX_FAVORITES) entry.favorites.length = MAX_FAVORITES;
    }
    this.persist();
    return this.view();
  }

  removeFavorite(projectId: string, favoriteId: string): UiStateView {
    const entry = this.ensure(projectId);
    entry.favorites = entry.favorites.filter((favorite) => favorite.id !== favoriteId);
    this.persist();
    return this.view();
  }

  updatePreferences(patch: AttentionPatch): AttentionPreferences {
    const next = { ...this.state.preferences, quietHours: { ...this.state.preferences.quietHours } };
    if (patch.notificationsEnabled !== undefined) next.notificationsEnabled = Boolean(patch.notificationsEnabled);
    if (patch.firstCloseNotified !== undefined) next.firstCloseNotified = Boolean(patch.firstCloseNotified);
    if (patch.density !== undefined) {
      if (!DENSITIES.includes(patch.density)) throw new Error('Unknown density.');
      next.density = patch.density;
    }
    if (patch.quietHours !== undefined) {
      const source = patch.quietHours;
      const quiet = {
        enabled: source.enabled === undefined ? next.quietHours.enabled : Boolean(source.enabled),
        startMinute: source.startMinute === undefined ? next.quietHours.startMinute : source.startMinute,
        endMinute: source.endMinute === undefined ? next.quietHours.endMinute : source.endMinute,
        timeZone: source.timeZone === undefined ? next.quietHours.timeZone : source.timeZone,
      };
      if (!validMinute(quiet.startMinute) || !validMinute(quiet.endMinute)) {
        throw new Error('Quiet hours need whole minutes between 00:00 and 23:59.');
      }
      if (!validTimeZone(quiet.timeZone)) throw new Error('That timezone is not recognized.');
      next.quietHours = quiet;
    }
    this.state.preferences = next;
    this.persist();
    return { ...next, quietHours: { ...next.quietHours } };
  }

  preferences(): AttentionPreferences {
    return { ...this.state.preferences, quietHours: { ...this.state.preferences.quietHours } };
  }

  /** Returns the previous "last seen" value and records this visit. */
  markSeen(projectId: string): string | null {
    const entry = this.ensure(projectId);
    const previous = entry.lastSeenAt;
    entry.lastSeenAt = this.timestamp();
    this.persist();
    return previous;
  }

  lastSeen(projectId: string): string | null {
    return this.ensure(projectId).lastSeenAt;
  }

  markFirstCloseNotified(): boolean {
    if (this.state.preferences.firstCloseNotified) return false;
    this.state.preferences = { ...this.state.preferences, firstCloseNotified: true };
    this.persist();
    return true;
  }

  forget(projectId: string): UiStateView {
    delete this.state.projects[projectId];
    if (this.state.currentProjectId === projectId) this.state.currentProjectId = null;
    this.persist();
    return this.view();
  }

  private ensure(projectId: string): ProjectUiState {
    const existing = this.state.projects[projectId];
    if (existing) return existing;
    const created: ProjectUiState = {
      view: 'studio',
      layout: 'standard',
      currentSessionId: `ses_${randomUUID().replaceAll('-', '')}`,
      sessions: [],
      favorites: [],
      lastOpenedAt: null,
      lastSeenAt: null,
    };
    this.state.projects[projectId] = created;
    return created;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.file);
  }

  private load(): StoredUiState {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return validate(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Keep the unreadable file for inspection; never overwrite evidence of
        // a corrupt draft store silently.
        try {
          renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* best effort */
        }
        this.warning = `UI state at ${this.file} could not be read and was set aside; drafts start empty.`;
      }
      return { schemaVersion: 2, currentProjectId: null, preferences: defaultPreferences(), projects: {} };
    }
  }
}

function validate(value: unknown): StoredUiState {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error('unsupported UI state');
  }
  const preferences = validatePreferences(value.preferences);
  const projects: Record<string, ProjectUiState> = {};
  if (isRecord(value.projects)) {
    for (const [id, entry] of Object.entries(value.projects)) {
      if (!isRecord(entry)) continue;
      const view = VIEWS.includes(entry.view as ProjectView) ? (entry.view as ProjectView) : 'studio';
      const layout = LAYOUTS.includes(entry.layout as ProjectLayout) ? (entry.layout as ProjectLayout) : 'standard';
      const sessions: DraftSession[] = [];
      if (Array.isArray(entry.sessions)) {
        for (const session of entry.sessions) {
          if (!isRecord(session) || typeof session.sessionId !== 'string') continue;
          sessions.push({
            sessionId: session.sessionId,
            updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date(0).toISOString(),
            text: typeof session.text === 'string' ? session.text.slice(0, MAX_DRAFT_CHARS) : '',
          });
          if (sessions.length >= MAX_SESSIONS) break;
        }
      }
      const favorites: PromptFavorite[] = [];
      if (Array.isArray(entry.favorites)) {
        for (const favorite of entry.favorites) {
          if (!isRecord(favorite) || typeof favorite.id !== 'string' || typeof favorite.text !== 'string') continue;
          favorites.push({
            id: favorite.id,
            label:
              typeof favorite.label === 'string' && favorite.label.trim()
                ? favorite.label.slice(0, MAX_FAVORITE_LABEL)
                : 'Saved prompt',
            text: favorite.text.slice(0, MAX_FAVORITE_CHARS),
            createdAt: typeof favorite.createdAt === 'string' ? favorite.createdAt : new Date(0).toISOString(),
          });
          if (favorites.length >= MAX_FAVORITES) break;
        }
      }
      const currentSessionId =
        typeof entry.currentSessionId === 'string' && entry.currentSessionId.trim()
          ? entry.currentSessionId
          : (sessions[0]?.sessionId ?? `ses_${randomUUID().replaceAll('-', '')}`);
      projects[id] = {
        view,
        layout,
        currentSessionId,
        sessions,
        favorites,
        lastOpenedAt: typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : null,
        lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : null,
      };
    }
  }
  return {
    schemaVersion: 2,
    currentProjectId: typeof value.currentProjectId === 'string' ? value.currentProjectId : null,
    preferences,
    projects,
  };
}

function validatePreferences(value: unknown): AttentionPreferences {
  const fallback = defaultPreferences();
  if (!isRecord(value)) return fallback;
  const quiet = isRecord(value.quietHours) ? value.quietHours : {};
  const startMinute = validMinute(quiet.startMinute) ? quiet.startMinute : fallback.quietHours.startMinute;
  const endMinute = validMinute(quiet.endMinute) ? quiet.endMinute : fallback.quietHours.endMinute;
  const timeZone =
    typeof quiet.timeZone === 'string' && validTimeZone(quiet.timeZone) ? quiet.timeZone : fallback.quietHours.timeZone;
  return {
    notificationsEnabled:
      typeof value.notificationsEnabled === 'boolean' ? value.notificationsEnabled : fallback.notificationsEnabled,
    quietHours: {
      enabled: typeof quiet.enabled === 'boolean' ? quiet.enabled : fallback.quietHours.enabled,
      startMinute,
      endMinute,
      timeZone,
    },
    density: DENSITIES.includes(value.density as Density) ? (value.density as Density) : fallback.density,
    firstCloseNotified:
      typeof value.firstCloseNotified === 'boolean' ? value.firstCloseNotified : fallback.firstCloseNotified,
  };
}

function cloneProjects(projects: Record<string, ProjectUiState>): Record<string, ProjectUiState> {
  const copy: Record<string, ProjectUiState> = {};
  for (const [id, entry] of Object.entries(projects)) {
    copy[id] = {
      ...entry,
      sessions: entry.sessions.map((session) => ({ ...session })),
      favorites: entry.favorites.map((favorite) => ({ ...favorite })),
    };
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
