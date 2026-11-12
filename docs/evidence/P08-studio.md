# P08 — the live work studio

**Status:** completed. **Requirements:** MONA-007, MONA-008, MONA-012, MONA-014.
**Environment:** Electron 45.3.0 / Chromium 156.0.8078.96 / Node 24.22.2, Windows
x64, pinned Codewhale 0.10.2 (ff466b2ed0bf), provider `deepseek`, model
`deepseek-flash`, Full Access posture.

Mona now submits work, streams the runtime's own events into a durable timeline,
and shows the result the runtime reported. Opening, searching or re-rendering the
studio still sends no prompt and starts no turn.

## What was built

- **`StudioService`** (`apps/desktop/src/main/studio-service.ts`) — the one main-
  process path for studio work. It binds one engine thread per Mona session and
  mode, submits through the P03 adapter, projects the SSE stream, drives the P04
  `WorkQueue`, records turn/usage rows, and keeps raw lifecycle lines away from
  user-facing explanation.
- **Persistence** — migration v2 adds `threads.session_id`, `threads.mode`,
  `threads.profile_json` and `timeline_items` with a unique `(thread_id, seq)`
  index. A replayed engine sequence can never become a second row.
- **IPC** — seven named channels (`studio-get`, `studio-submit`,
  `studio-interrupt`, `studio-pause`, `studio-resume`, `studio-pick-references`
  and the `studio-event` push). Each validates the sender frame, then a strict
  payload; the preload exposes named methods and one event subscription, never a
  generic invoke.
- **Renderer** — `StudioPanel.tsx` with a persistent control strip (run state,
  Plan/Work, observed permission, spend, Pause after task, Interrupt now,
  Connect/Stop engine), a scrollable timeline, an optimistic pending prompt, the
  composer with explicit file references, an approval/input card, and a separate
  diagnostics disclosure.
- **Safe Markdown** (`packages/ui/src/markdown.tsx`) — a small escaped renderer
  for model output: fenced code, headings, lists, quotes, inline code, bold and
  italic. Raw HTML is text. Links render as inert text plus the address, so model
  output cannot navigate the app, open a remote page, or reach IPC.

## Timeline projection rules

| Engine event | Rendering |
|---|---|
| `item.started` / `item.completed` (`user_message`) | one `user` card, updated in place |
| `item.started` / `item.completed` (`agent_message`) | one `assistant` card rendered as safe Markdown |
| `item.delta` | appended to the assistant card; throttled to 250 ms per write |
| `item.*` (`tool_call`, `tool_result`) | `tool` card with the runtime's own tool input |
| `status` items with `metadata.visibility = internal` | diagnostics only, never shown as content |
| `turn.started` | small `status` row with the runtime's input summary |
| `turn.usage` | remembered for the turn; recorded with the completion |
| `turn.workspace_snapshot` | `changed_paths` attributed to the turn |
| `turn.completed` | `outcome` card: status, duration, usage, cost source, changed paths |
| `approval.required` and unrecognized `approval.*` | prominent pending card, run state `awaiting_approval`, Interrupt now |
| `request_user_input` tool call in progress | pending `input` card with the same handling |
| `turn.provider_request`, `model.tools.snapshot`, `turn.lifecycle` | diagnostics only |
| anything else | one redacted diagnostic line, never invented content |

Item bodies are capped at 64 KB; anything larger is labeled truncated. The
renderer shows the first 2,000 characters (1,500 for tools) with an on-demand
"Show all" control.

## Plan/Work and permission

Victor's DS Full Access profile is written once to `settings_versions`
(`scope = profile`, version 1) on first launch and read back afterwards. It is
what Mona asks for; it is not displayed as an observed fact. The studio shows the
**observed** profile from the engine thread (`permission_posture`, `allow_shell`,
`trust_mode`, `auto_approve`, provider, model) as soon as a thread exists, and
labels the saved profile as saved until then. Plan and Work are separate engine
threads: switching modes and submitting opens a new thread and leaves the other
thread's items stored.

## Approval and input waits

Full Access auto-approves the tools the runtime is allowed to use, but the
runtime can still pause. When it does, Mona:

1. shows the approval/input card above the timeline and sets the run state to
   `Awaiting approval`;
2. states that this build cannot answer the wait, with the raw event in
   Diagnostics;
3. offers **Interrupt now**, which returns the engine's own receipt.

Nothing spins unseen. An approval event this build does not recognize is also
surfaced, with a diagnostic naming it.

## Live run receipt

`npm run studio -w @mona/desktop` (output `docs/evidence/P08-studio.json`,
`P08-studio-log.txt`, screenshots `docs/evidence/shots-p08/`) drove the real
window end to end:

- 22/22 steps passed in a real Electron window against the pinned runtime.
- The fixture project received: *"Create a file named hello.txt … Then run
  `node check.mjs` … Do not change any other file."*
- Outcome card: `Status: completed`, 14.8 s, usage `in 1,174 (65,792 cached) ·
  out 631 · reasoning 135`, `Cost: $0.0015 (engine-priced thread delta;
  provider_docs)`, `Changed paths: hello.txt`.
- Independent checks: `hello.txt` contains `MONA_STUDIO_OK`; `node check.mjs`
  exits 0 with `MONA_STUDIO_CHECK_PASS`; four tool cards carry the runtime's own
  tool inputs; one usage record of 1,504 µUSD is stored for the project.
- Observed permission: `full_access`, `allowShell/trustMode/autoApprove = true`.
- Re-rendering the studio after a full window reload showed the same 13 items and
  started no new turn.
- Opening, connecting the engine and re-rendering created no thread and no
  message. The engine start itself sends no prompt (P04).

Screenshots: ready studio, filled composer, running turn, completed turn, the
outcome card with cost/change evidence, and the studio after a reload.

## Verification

- `npx vitest run` — 215 tests in 24 files (+35 for P08: studio persistence,
  studio service, studio IPC, safe Markdown, renderer).
- `npm run bootstrap:test` — 13; `npm run spike:test` — 8.
- `npm run typecheck`, `npm run lint`, `npm run format:check` — pass.
- `npm run build` — renderer 288.80 kB (gzip 86.93 kB).
- `npm run check:build -w @mona/desktop` — 25 named preload channels, no
  fixtures, no credentials, no remote origins, no `/v1/` in the bundle.
- `npm run smoke -w @mona/desktop` (`P08-shell-smoke.json`) — remote navigation
  and popup refused, 25 named bridge methods, 335 MB.
- `npm run catalog -w @mona/desktop` (`P08-catalog-regression.json`) — the P07
  shell/catalog probe still passes 21/21 with prompt-scoped output paths
  (P07-ISSUE-001 mechanism), including project switching mid-runtime.

## Limits recorded

- Mona cannot answer an engine approval or input request in this build; the
  wait is visible and interruptible, and `capabilities.approvalResponse` says so.
- Attachments are unsupported by the turn contract Mona implements; the composer
  disables the control and explains why. File references are explicit
  project-relative paths and appear verbatim in the sent prompt.
- The pinned runtime writes its own `.codewhale/state/*` inside the workspace
  (observed during the probe). That is engine behaviour, not a Mona write; Mona's
  only workspace write is the `.mona/project/project.json` marker.
- `docs/evidence/` keeps the raw event log at
  `docs/evidence/engine/`; the studio's diagnostics are bounded to 200 redacted
  lines per session and are not exported.
