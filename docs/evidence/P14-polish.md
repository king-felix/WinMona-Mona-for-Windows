# P14 — Daily-use polish without inference overhead

**Prompt:** P14 · **Status:** completed · **Requirements:** MONA-017 (deterministic
digest, tray attention, quiet hours, no inference), MONA-029 (Resume Brief, Focus
Mode, evidence cards, keyboard flow) · **Environment:** win32-x64, Node
v26.13.1, Electron 45.3.0, schema v6.

P14 adds the surfaces a long session actually needs — what happened, what is
blocked, where work resumes, what a run cost, and how to stop it — using only
rows Mona already recorded. No summarizer, router, background model, or paid UI
feature was added, and idle Mona still makes zero provider requests.

## What is delivered

**Deterministic briefing (`packages/project-state/src/briefing.ts`).**
`BriefingService` composes `ResumeBrief` and `SinceYouLeft` from the existing
TaskService board, AttemptService handoff cards, CostLedger totals, ChangeService
test receipts and Git status. The brief names the current task and recorded
step, every unresolved task/problem blocker with the exact help needed, the last
test receipt, the changed-file count or an explicit unknown, and spend
confidence (`none`, `known`, `partial`, `unknown`). Task counts are counts — no
completion percentage is inferred — and unknown spend is never shown as zero.
`SinceYouLeft` groups task completions, blockers, test receipts, workspace
changes, spend and other transitions inside an exclusive time window. The window
is the project's stored `lastSeenAt`; the old value is read before the new visit
is recorded.

**Real shell surfaces.** Home now carries the Resume Brief and the "Since you
left" digest. Evidence paths are buttons: focusing one marks the matching card
(`aria-pressed`, visible focus ring) and does not open a new task. Studio keeps
its execution controls visible; the brief never replaces the interrupt path.

**Focus Mode and saved layout.** Focus Mode is a per-project layout stored in
machine-local UI state (`standard | focus`). It hides the inspector, project
search and recents while the topbar, navigation, composer, execution controls
and Interrupt now stay present. Density (`comfortable | compact`) is a persisted
preference applied as `data-density`.

**Identity, favorites and keyboard flow.** Project color and monogram are
curated locally from the project id and label, editable in the catalog
(`#RRGGBB` plus a 1–3 character monogram). Prompt favorites are per project,
bounded, deduplicated by text, and only fill the composer — using one sends
nothing. Shortcuts: `Ctrl+K` palette, `Alt+1…5` sections, `Ctrl+Shift+F` Focus
Mode, `Ctrl+Shift+N` new session, `Ctrl+Shift+/` or `?` the shortcut list,
`Ctrl+Enter` submit. Interrupt and quit are never single unmodified keys.

**Attention policy (`apps/desktop/src/main/attention.ts`).** A pure
`NotificationPlanner` decides delivery from recorded transitions. A completion
or blocker is planned once; a replay of the same turn key is `duplicate` across
reconnects. Quiet hours are evaluated in the configured zone at each event, so a
timezone change or DST boundary moves the window with the wall clock. Suppressed
events are remembered and are never delivered late. `local` follows the system
zone; an IANA zone can be set explicitly. Quiet hours silence delivery only —
they never pause a turn. Notification payloads are generic: no project name,
prompt text, file path or turn id reaches the lock screen.

**Tray and close-to-tray.** The app now creates a tray with a local drawn icon.
Its tooltip and menu reflect running, blocked, failed, completed and idle work;
the menu offers Show Mona, Interrupt now, and Quit and stop work. Closing the
window while an owned runtime is active hides Mona and keeps work alive; the
first close explains this once. The same explicit quit action is available in
Settings behind a confirmation dialog. A notification click focuses the right
project and evidence path, never a new task.

**No-inference boundary.** Briefing, digest, tray, notification and quiet-hours
paths call no adapter and open no thread. StudioService raises a local attention
event only after a recorded turn settles or a problem blocks; the main process
decides delivery. The live probe records `providerRequests: 0`, and the engine
remains `not_started` throughout.

## A real defect found and fixed while proving P14

Opening an existing database failed with `maintenance already in progress
(migrate)`. `openState()` held the migration's exclusive barrier while calling
`createBackup()`, which takes its own snapshot barrier — a nested lock on the
single maintenance barrier. Fresh profiles hid it because no backup was due.
P14's seeded probe exposed it. The backup now runs first under its own snapshot
barrier and migrations then run exclusively; `state.test.ts` opens a database
twice, asserts the pre-migration backup verifies and the existing project
survives. This was a real desktop launch bug outside the P14 surface and is
recorded here rather than folded into a silent fix.

## Acceptance evidence

- **Live probe:** `npm run polish` → 40 steps passed, 9 real-Electron
  screenshots, provider requests 0 (`docs/evidence/P14-polish.json`,
  `docs/evidence/P14-polish-log.txt`). It checks the brief against seeded task,
  test, spend and Git rows; Focus Mode hides the inspector while keeping
  Interrupt now; Alt+2 navigation; a pushed notification focus selects the right
  project/evidence and starts no task; quiet hours survive reload; both themes
  capture.
- **Screenshots:** `docs/evidence/shots-p14/` — Home, digest, Studio, Focus
  Mode and notification focus in Daybreak; Home, Studio, Focus Mode and the
  quiet-hours settings in Afterglow.
- **Unit tests:** `packages/project-state/src/briefing.test.ts` (projection,
  unknown-not-zero, exclusive window, determinism), `attention.test.ts`
  (timezone/DST, half-open window, dedupe across reconnect, suppression,
  payload privacy, tray state), `ui-state.test.ts` (v1 upgrade, layout,
  last-seen, favorites, validation), `App.test.tsx` (brief, focus, notification
  focus, favorites, density), `studio-service.test.ts` (attention raised once per
  settled turn/blocker), `state.test.ts` (existing-DB open regression).
- **Gates:** `docs/evidence/P14-tests.txt` (349 Vitest + 13 bootstrap + 12
  launch + 8 spike), `P14-build.txt`, `P14-checks.txt` (typecheck, lint,
  format, build check; state validate OK with 0 warnings).

## Honest limits

- Completion/blocker alerts originate from the live studio turn and problem
  surfaces. The queue itself is not wired to `StudioService` yet
  (P10-ISSUE-002), so a queue-only run that never opens a studio turn cannot
  raise an alert.
- The tray icon does not change pixels per state; state is carried in the
  tooltip and menu text, which stay accessible where Windows renders a 16 px
  icon. A color-coded icon set is not invented.
- Quiet hours suppress rather than queue. This is deliberate: a stale alert is
  worse than silence, and computation is unaffected.
- `lastSeenAt` advances when a project is opened or a notification is focused.
  A second digest in the same minute can therefore be empty; it reports silence
  rather than replaying old activity.
- The screenshots use a seeded fixture project in a temporary folder. The folder
  path visible in the captures is test data, not Victor's project.
- Project identity is catalog metadata; changing it never touches the folder.
  Derived colors are a fixed local palette, not a generated theme.
