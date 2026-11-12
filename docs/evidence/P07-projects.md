# P07 — The project catalog and the real desktop shell

**Prompt:** P07 · **Status:** completed · **Requirements:** MONA-005 (catalog
lifecycle), MONA-006 (accessible shell), MONA-029 (keyboard-first navigation) ·
**Environment:** win32-x64, Electron 45.3.0 (Chromium 156.0.8078.96), Node
v24.22.2, Codewhale 0.10.2 (ff466b2ed0bf)

The placeholder view router is gone. Mona now opens on a real catalog backed by
SQLite, shows the engine's actual connection state, and can be driven entirely
from the keyboard. Nothing in this prompt submits a turn: starting a runtime
costs nothing and sends no task.

## What exists

- **Rail:** project search (label, path, branch), recents ordered by real
  `lastOpenedAt`, five sections, and a permanent "Idle Mona makes no request"
  footer.
- **Context bar:** project label, branch (read from `.git/HEAD`, worktrees
  included), engine connection, effective route model, permission profile and
  recorded spend, plus the command palette entry point.
- **Home:** open folder, create project, and per-project actions — open, reveal,
  pin, rename, archive/restore, locate (after a move), remove. Search and
  "show archived" are real filters over the store.
- **Studio:** the project's draft composer (per project *and* per session),
  engine connection with the engine's own words, an explicit execution-disabled
  explanation, and permission/model/spend facts.
- **Work / Cost / Settings:** honest scoped states. Work states plainly that
  prompt dependencies arrive with P10; cost shows only recorded usage and never
  turns unknown into `$0.00`; settings shows the pinned route, the saved profile,
  local-state schema and the theme.
- **Inspector:** one panel — path, repository kind and sibling worktrees,
  persisted runtime binding, engine state, draft sessions, "no delegated work".
- **Bottom drawer:** closed by default, toggled from the status bar, Escape
  closes it, and it holds diagnostics only.
- **Command palette:** Ctrl+K, labelled combobox with a real filter, Arrow/Home/
  End, Enter to run, Escape to close, focus restored to the opener.

## Catalog behaviour that is enforced, not narrated

- **Aliases deduplicate.** A junction to a registered folder resolves to the same
  project (`status: existing`), verified live.
- **Moves need a decision.** Opening a folder that carries Mona's marker (or the
  same filesystem identity at a new path while the old path is gone) returns
  `relocation_required`; only `relocateProject` rebinds. Live run: the folder was
  registered, renamed on disk, then rebound — one project entry throughout.
- **Removal never deletes.** `removeProject` deletes the catalog row and reports
  whether the folder still exists; the live probe re-checks the files and the
  unit test asserts the folder and its marker survive.
- **Archiving is reversible** and archived projects stay searchable when
  "show archived" is on.
- **Nested repositories stay distinct** (`packages/inner` inside an outer repo is
  its own entry with its own branch); linked worktrees share a repository key but
  remain separate projects and are labelled as siblings.
- **No drive scanning.** A project's branch and existence are read from its
  registered path only.

## Draft and state isolation

UI state (selected project, last view per project, unsent drafts per
project/session) is machine-local JSON written atomically next to the SQLite
database. It is deliberately not in the project database: a draft is not project
content, and a project export must not carry someone's half-written text.

Live evidence: drafts for two projects were saved, the window was reloaded, and
both came back under their own project, with the per-project view restored.
Switching projects while a runtime is live showed the second project's own draft,
its own "No recorded spend", and an explicit "Runtime serves another project"
notice; starting a second runtime was refused by the engine host with the
workspace it already serves.

## Engine, permission and offline truth

- The engine badge is the supervisor state, not a constant. Live: `Engine
  connected` with the real endpoint and pid in the connection panel, then
  `Engine stopped` with the stop receipt's own wording (`stopped_forced`).
- Stopping is asynchronous. The probe waits for the observed `stopped` state
  instead of asserting instantly — the earlier version of the probe failed on the
  honest intermediate `stopping` state, which is exactly the kind of thing that
  must not be papered over.
- Missing local state, a missing folder, and an engine attached to another
  workspace each disable execution with a specific explanation; the catalog,
  drafts and settings stay usable.
- Execution is disabled in this build by design — submission arrives with P08 —
  and the button says so instead of pretending.

## Harness containment (closes P06-ISSUE-001)

`?harness=1` no longer renders fixtures in a normal window. The main process
exposes `harnessEnabled` only for a dev-server session or `MONA_ALLOW_HARNESS=1`,
and the renderer refuses the route otherwise. The screenshot runner sets that
flag explicitly. `npm run smoke` now fails if the harness renders, if the empty
catalog state is missing, or if the palette entry point is absent.

## Accessibility

The live probe drives `Ctrl+K`, types a command, presses Enter, and records the
heading that appears: `Projects`, `Probe repo renamed`, `Work board`,
`Recorded spend`, `Route and permission` — five screens, no mouse. A real Tab
traversal reaches 18 focus stops starting at the palette button, the search field
and the section buttons. Both themes were captured from the live shell
(`docs/evidence/shots-p07/`).

## Two defects this prompt found and fixed

1. **Double-encoded UTF-8.** A PowerShell `Get-Content`/`Set-Content` round-trip
   re-encoded `App.tsx` and `catalog-probe.ts`, so `·`, `…`, `’` and `→` shipped
   as `Â·`, `â€¦`. Caught by reading the captured screenshot, repaired by a
   Node-based byte-safe pass, and prevented mechanically: `check-build.mjs` now
   fails on mojibake sequences in the renderer bundle. Source edits from here on
   use byte-safe tools only.
2. **Composer below the fold.** At 1280×800 the draft composer sat under the
   connection block. The composer now comes first; the connection and its
   explanation follow.

## Evidence

- `docs/evidence/P07-catalog.json` + `P07-catalog-log.txt` — 21 end-to-end steps
  in a real Electron window (catalog lifecycle, aliases, relocation, removal,
  drafts, reload persistence, keyboard-only navigation, live engine start,
  mid-run project switching, stop, offline listing).
- `docs/evidence/shots-p07/` — six screenshots of the live shell (Daybreak home,
  studio, cost, palette; Afterglow home, studio).
- `docs/evidence/P07-shell.json` — production smoke: CSP, refused navigation and
  popup, 18 named bridge methods, no harness, 333 MB footprint.
- `docs/evidence/P07-tests.txt` — 180 Vitest (20 files) + 13 bootstrap + 8 spike.
- `docs/evidence/P07-checks.txt`, `P07-build.txt` — lint, format, typecheck,
  build, static bundle checks. (esbuild's progress line reaches stderr; the
  `NativeCommandError` line in the build capture is PowerShell reporting that,
  not a failure.)

## Verification not yet performed

- No human screen-reader pass (P22 owns it; MONA-006 stays at "automated
  keyboard and focus checks recorded").
- Terminal and test panes in the drawer are placeholders until P08/P23; they are
  labelled as such, not shown as working.
- Only this machine and this Windows build were tested.

## Open issue

**P07-ISSUE-001** — earlier build records (`DECISIONS.md`, `HANDOFF.md`) contain
double-encoded punctuation from the same PowerShell pattern. `HANDOFF.md` was
rewritten cleanly in this prompt; the historical decision rows still carry
mojibake and should be repaired in a single mechanical pass (content unchanged).
Recorded rather than silently rewritten mid-prompt.
