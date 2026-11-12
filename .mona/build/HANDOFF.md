# Mona build handoff

**Current prompt:** P09 — Make the first right-click launch work
**Current status:** P00–P08 completed. State revision 27. Next eligible: P09.

**Last verified commit / dirty work:** the P08 work is commit `pending` at the
time this file was written; the checkpoint and journal rows recorded after it
carry the real hash. `last_verified_commit` stays null because a state file
cannot contain the hash of the commit that contains it. Verify with
`node tools/build/cli.mjs validate` (OK, r27, 0 warnings) before trusting this
file.

## P08 result — a live studio over the real engine

Victor can submit work, watch the runtime's own events, and understand the
result without leaving Mona. Nothing in this prompt invents content.

- **StudioService** (`apps/desktop/src/main/studio-service.ts`) binds one engine
  thread per Mona session and mode, submits through the P03 adapter, projects the
  SSE stream into typed items, drives the P04 `WorkQueue`, records turns and
  usage, and keeps raw lifecycle lines in a bounded diagnostics ring.
- **Persistence** — migration v2 adds `threads.session_id/mode/profile_json` and
  `timeline_items` with a unique `(thread_id, seq)` index. A replayed engine
  sequence is a no-op. Items are capped at 64 KB and labeled truncated.
- **IPC** — seven named channels (`studio-get/submit/interrupt/pause/resume/
  pick-references` plus the `studio-event` push). Every channel validates the
  sender frame and a strict payload; the preload exposes named methods and one
  unsubscribe-returning event subscription. 25 named bridge methods in total.
- **Renderer** (`StudioPanel.tsx`) — a persistent control strip (run state,
  Plan/Work, observed permission, spend, Pause after task, Interrupt now,
  Connect/Stop), a scrollable timeline above the composer, an optimistic pending
  prompt, a pending approval/input card, composer file references, and a separate
  diagnostics disclosure. The composer is a draft until Submit; Ctrl+Enter sends.
- **Safe Markdown** (`packages/ui/src/markdown.tsx`) — escaped text nodes only,
  no raw HTML, no anchors. Tests assert both.
- **Permission** — the saved DS Full Access profile is seeded once in
  `settings_versions` and shown as saved; the studio shows the posture the engine
  actually reported for the bound thread (`full_access`, allowShell/trustMode/
  autoApprove true in the live run).
- **Approval waits** — `approval.required`, unrecognized `approval.*` events and
  `request_user_input` all produce a visible pending card and an Interrupt-now
  action. Mona does not answer the wait in this build, and says so.

Evidence: `docs/evidence/P08-studio.md` (report), `P08-studio.json` +
`P08-studio-log.txt` (22 live Electron steps), `docs/evidence/shots-p08/`
(6 live screenshots), `P08-shell-smoke.json`, `P08-catalog-regression.json`
(P07 regression, 21/21), `P08-tests.txt`, `P08-checks.txt`, `P08-build.txt`.
Decisions D-0044 … D-0049.

Live receipt: the fixture project received one task; the runtime created
`hello.txt` (`MONA_STUDIO_OK`), ran `node check.mjs` (exit 0,
`MONA_STUDIO_CHECK_PASS`), and Mona's outcome card reported
`Status: completed`, 13.2 s, `Cost: $0.0015 (engine-priced thread delta;
provider_docs)`, `Changed paths: hello.txt`, with four tool cards carrying the
runtime's own tool inputs. A full window reload replayed the same 13 items and
sent nothing.

## Next exact action (P09)

Read P09 in `Mona_PROMPTS.md` and spec 5.1 + 14. Implement the CLI argument
parser and single-instance path dispatch, then idempotent per-user classic
folder/background context-menu registration with the exact label **Start new DS
project with Mona**. Paths are passed as data, never interpolated into shell
scripts. Reuse `parseLaunchArgs`, the existing `pendingLaunchPaths` array and
`second-instance` handling in `apps/desktop/src/main/main.ts`; the launcher must
open/register the folder, select the saved DS profile, start the runtime without
inventing a task, and focus the ready composer. Do not implement the modern
Windows 11 menu yet (P21). Handle two fast launches deterministically and test
spaces, quotes, ampersands, parentheses, Unicode, trailing separators, missing
paths, aliases/junctions, drive roots and UNC/WSL roots.

## Relevant files and spec sections

- `apps/desktop/src/main/{main.ts,studio-service.ts,studio-ipc.ts,engine-host.ts,
  catalog-service.ts,ipc.ts}`, `apps/desktop/src/shared/{studio,catalog,ipc}.ts`,
  `apps/desktop/src/preload/preload.ts`, `apps/desktop/src/renderer/{App,StudioPanel}.tsx`
- `packages/project-state/src/{store,migrations}.ts`, `packages/ui/src/markdown.tsx`
- Spec 4.2/4.3 (layout, views), 5 (journeys), 6.4 (process lifecycle), 9.1, 13.

## Open problem IDs and no-progress counts

No open blocker; `attempts.jsonl` holds only the closed P02 rows.

- **P01-ISSUE-001** — exec vs runtime endpoint fingerprint drift; P16.
- **P01-ISSUE-002** — Windows allows a second runtime in one workspace; Mona
  leases one and refuses a start for a different workspace while one is owned
  (live-verified again by the P08 probe).
- **P01-ISSUE-003** — terminal capability flags false; P18.
- **P01-ISSUE-004** — cost sample provisional; re-run after routing changes.
- **P04-ISSUE-001** — no Job Object; `taskkill /T` plus reconcile.
- **P04-ISSUE-002** — close-to-tray still has no tray affordance; P23 packaging.
- **P05-ISSUE-001** — maintenance barrier is in-process (D-0032).
- **P06-ISSUE-002** — no human screen-reader pass yet; P22 owns it.
- **P07-ISSUE-001** — probe scripts write fixed historical paths; the P08
  regression run used prompt-scoped `MONA_*` outputs as the recorded remedy. The
  scripts still default to their historical paths when those variables are absent.
- **P07-ISSUE-002** — closed by P08: submission, streaming and the control strip
  exist and are live-verified.
- **P08-ISSUE-001** — `packages/contracts` models only four engine event names
  (`turn.completed`, `item.delta`, `approval.required`, `stream.end`). The studio
  projects `item.started/completed`, `turn.*`, `workspace_snapshot` and the rest
  by name in the desktop service, with zod payloads. Move those shapes into
  contracts when P16/P18 revises the engine event model.
- **P08-ISSUE-002** — the pinned runtime emits `approval.required`, but Mona has
  no qualified approval-response route. The wait is surfaced and interruptible;
  answering it remains unsupported until a route is contract-tested.
- **P08-ISSUE-003** — the engine writes its own `.codewhale/state/*` into the
  workspace during a turn (observed in the live probe). Mona does not write there;
  the fixture project's file list is evidence for the P22 documentation work.

## Blocked dependencies

None.

## Last relevant validation

- `npx vitest run` → 215 passed (24 files; +35 in P08).
- `npm run bootstrap:test` → 13; `npm run spike:test` → 8.
- `npm run lint`, `npm run format:check`, `npm run typecheck` → pass.
- `npm run build` → contracts, adapter, project-state, ui, desktop; renderer
  288.80 kB (gzip 86.93 kB).
- `npm run check:build -w @mona/desktop` → pass, 25 named preload channels.
- `npm run studio -w @mona/desktop` → 22/22 live steps, 6 live screenshots,
  real file change + test pass, 1 usage record (1,504 µUSD).
- `npm run smoke -w @mona/desktop` (`P08-shell-smoke.json`) → pass, 25 named
  bridge methods, 335 MB.
- `npm run catalog -w @mona/desktop` (`P08-catalog-regression.json`) → 21/21.
- `node tools/build/cli.mjs validate` → OK, r27, 0 warnings.
- Spend: one live turn in the final evidence run (~$0.0015 engine-priced). Every
  other P08 check ran without a provider request.

## Human input needed

None. Standing caution unchanged: edit source with byte-safe tools. A PowerShell
`Get-Content`/`Set-Content` round-trip double-encoded `App.tsx` and
`catalog-probe.ts` in P07; `check-build.mjs` fails on mojibake. The two remaining
`Â·`/`â€™` sequences in `DECISIONS.md` and this file are quoted examples of that
incident, not corrupted text.
