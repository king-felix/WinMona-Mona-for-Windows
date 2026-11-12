# Mona build handoff

**Current prompt:** P15 — Surface native agents, goals, fleets, and workflows
**Current status:** P00–P14 completed. State revision 45. Next eligible: P15, P16.

`last_verified_commit` stays null because a state file cannot contain the hash of
the commit that contains it. Verify with `node tools/build/cli.mjs validate`
(expect OK, r45, 0 warnings) before trusting this file.

## P14 result — daily-use polish with zero inference

- **Deterministic brief (`packages/project-state/src/briefing.ts`).**
  `BriefingService` projects `ResumeBrief` and `SinceYouLeft` from the task
  board, attempt handoff cards, cost totals, test receipts and Git status. It
  names the current task/step, blockers and exact help needed, last test, changed
  files or an explicit unknown, and spend confidence. No completion percentage,
  no model call, no fabricated zero.
- **Real shell:** Resume Brief and "Since you left" on Home; evidence paths are
  focusable buttons; prompt favorites fill the composer without sending; project
  color/monogram identities are curated locally and editable.
- **Focus Mode** is a saved per-project layout that hides inspector/search/recents
  while keeping the execution strip, Interrupt now, Stop and Quit reachable.
  Density is persisted separately.
- **Attention:** pure `NotificationPlanner` deduplicates a completion/blocker
  across reconnects, evaluates quiet hours in the configured zone at event time
  (`local` follows travel/DST), suppresses rather than queues, and keeps project
  names, prompts and paths out of lock-screen content.
- **Tray:** real Electron tray with a local icon; tooltip/menu reflect running,
  blocked, failed, completed, idle; menu offers Show Mona, Interrupt now, Quit and
  stop work. First close explains that the window hides while work continues.
- **Notification click** focuses the right project and evidence path; it never
  creates or starts a task.
- **P05-area defect found and fixed:** opening an existing database nested the
  pre-migration backup inside the migration's exclusive barrier and failed with
  `maintenance already in progress (migrate)`. The backup now runs first under its
  own snapshot barrier, migrations then run exclusively, and
  `state.test.ts` opens an existing database twice and verifies the backup.

## Next exact action (P15)

Read P15 in `Mona_PROMPTS.md` and its linked capability sections. P15 owns
MONA-018 (native agents/goals/fleets/workflows surfaced honestly) and MONA-019.
Reuse the pinned runtime's documented surfaces and version 0.10.2 (ff466b2ed0bf);
do not invent a parallel orchestrator. P10-ISSUE-003 leaves native execution as
an owner record only; P15 must either connect a real native dispatcher or keep
the limitation explicit.

## Relevant files and spec sections

- `packages/project-state/src/briefing.ts` (+ `.test.ts`), `costs.ts`
  (`totalsSince`), `tasks.ts` (`gaps`), `index.ts` (open-state barrier fix),
  `state.test.ts`
- `apps/desktop/src/main/{attention,attention-ipc,briefing-ipc,polish-probe}.ts`,
  `tray-icon.ts`, `ui-state.ts` (schema v2), `studio-service.ts` (attention hook),
  `main.ts` (tray, notifications, IPS modules, `--polish-test`)
- `apps/desktop/src/renderer/{App.tsx,BriefingPanel.tsx,StudioPanel.tsx,styles.css}`
- `apps/desktop/scripts/polish.mjs` — seeded live probe; `npm run polish`
- Spec 4.3, 5, 8.4, 8.5, 9.1, 12; O3/O5.

## Open problem IDs and no-progress counts

No open blocker. `attempts.jsonl` still holds only the closed P02 rows.

Carried forward, relevant to P15/P16:
- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — one owned runtime per machine session; a launch for a
  different workspace opens the project with a caveat instead of stopping the
  runtime (live-verified by P09).
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-002** — tray affordance now exists; P23 still owns packaging.
- **P05-ISSUE-001** — maintenance barrier is in-process (D-0032). The nested
  barrier bug is fixed (D-0076); the single-process boundary is unchanged.
- **P06-ISSUE-002** — no human screen-reader pass yet; P22 owns it.
- **P07-ISSUE-001** — probe scripts still default to fixed historical paths when
  prompt-scoped `MONA_*` output variables are absent.
- **P08-ISSUE-001** — `packages/contracts` models four engine event names; the
  studio projects the rest by name in the desktop service; revisit at P16/P18.
- **P08-ISSUE-002** — approval waits are surfaced and interruptible; Mona still
  has no qualified approval-response route.
- **P08-ISSUE-003** — the engine writes its own `.codewhale/state/*` into a
  workspace during a turn; evidence for P22 documentation.
- **P09-ISSUE-001** — the classic registration names the development Electron
  binary and repository path until P21/P23 install a packaged executable.
- **P09-ISSUE-002** — Explorer's own placement ("Show more options") and a human
  click are not programmatically verifiable.
- **P10-ISSUE-001** — the task engine has no renderer work-board surface yet.
- **P10-ISSUE-002** — `runOnce` is not wired to `StudioService`; a queue-only run
  therefore cannot raise a P14 completion alert yet.
- **P10-ISSUE-003** — native-workflow execution is recorded as an owner; a real
  native dispatcher is P15.
- **P11-ISSUE-001** — engine-internal attempt loops remain cooperative (D-0064).
- **P12-ISSUE-001** — the cost lens has no renderer surface; the cost screen still
  shows the P07 aggregate.
- **P12-ISSUE-002** — budgets gate only Mona's outer dispatch.
- **P12-ISSUE-003** — `StudioService` does not attribute turn usage to a task id
  yet; the ledger supports it.
- **P13-ISSUE-001** — no renderer surface for the change list, diff viewer or
  test cards.
- **P13-ISSUE-002** — attributed changes need a persisted per-task tool-touch set.
- **P13-ISSUE-003** — restore covers HEAD only.
- **P14-ISSUE-001** — tray state is carried in tooltip/menu text, not a
  color-coded icon set.
- **P14-ISSUE-002** — quiet hours suppress rather than queue; a suppressed alert
  is not delivered later.
- **P14-ISSUE-003** — a queue-only run cannot raise an attention event until
  P10-ISSUE-002 is wired.
- **P14-ISSUE-004** — `lastSeenAt` advances on project activation, so a second
  digest in the same minute can be legitimately empty.

## Blocked dependencies

None.

## Last relevant validation

- `npm test` → 349 Vitest (34 files) + 13 bootstrap + 12 launch + 8 spike
  (`docs/evidence/P14-tests.txt`).
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  313.47 kB (gzip 92.93 kB) (`docs/evidence/P14-build.txt`).
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:build -w @mona/desktop` (35 named preload channels), and
  `node tools/build/cli.mjs validate` → pass (`docs/evidence/P14-checks.txt`).
- `npm run polish` → 40 live steps, 9 real-Electron screenshots in Daybreak and
  Afterglow, provider requests 0 (`docs/evidence/P14-polish.json`,
  `P14-polish-log.txt`, `shots-p14/`).
- Spend: zero. Every P14 check ran locally without a provider request.

## Human input needed

None to continue P15. One standing human acceptance item for P21/P22: right-click
a folder and a folder background in Explorer and choose **Start new DS project
with Mona** (possibly under **Show more options**). The registration currently
points at the development build; remove it with
`npm run launch:menu -- unregister` or replace it at install time.

Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and
`catalog-probe.ts` in P07 and one test string in P14; Prettier does not repair
that. `check-build.mjs` fails on mojibake in the renderer bundle. The remaining
`Â·`/`â€™` sequences in `DECISIONS.md` and older handoff text are quoted examples
of that incident, not corrupted text.
