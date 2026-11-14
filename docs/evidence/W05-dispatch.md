# W05 — command dispatch and a real new conversation

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`
· Electron 45.3.0 / Chromium 140.0.0.0 / Node 26.13.1.

Evidence classes:

- **Real Windows runtime** — the product window dispatching `/new` and refusing a terminal-only
  command (`docs/evidence/W04-slash.json`, 14 steps, 5 screenshots; the `/new` steps are the last two).
- **Fixture** — `command-service.test.ts` (15 tests) and `command-ipc.test.ts` (5 tests).
- No provider turned on any path. Every receipt records `providerRequest: false`.

## The dispatch surface

One typed channel, `mona:command-dispatch`, accepts
`{ projectId, sessionId, text, operationKey }` and nothing else (strict schema: extra field rejected,
text ≤ 1 000, key 8–120 characters of `[A-Za-z0-9_.:-]`). The main process re-parses the text itself
against the shipped catalog — a renderer cannot reach an operation by claiming the text was
something else — then:

1. refuses anything that is not a first-line command (`unknown_command`, with candidates for an
   ambiguous prefix);
2. refuses a row whose catalog route is not `mona`, using that row's own route note
   (`not_routed`);
3. refuses a row the catalog marks `mona` when no operation is registered for it, instead of
   pretending it ran;
4. validates the arguments for **that** operation: both Mona operations take none, so
   `/new --force`, `/new ; Remove-Item …`, `/new $(whoami)`, `/new && calc.exe` are refused as
   `unexpected_argument` and nothing is executed. There is no shell in this path and no string
   interpolation anywhere;
5. refuses while a turn is in flight for the same session (`busy`), naming the turn, so the work
   stays attached to the thread that owns it;
6. otherwise performs the operation and returns a receipt.

## `/new` is a durable operation, not a keystroke

`ProjectStore.rotateSession({ projectId, oldSessionId, operationKey })` (migration 8,
`session_rotations`) records the rotation with a unique `(project_id, operation_key)` and a unique
`new_session_id`, in one transaction. Consequences that are enforced, not promised:

- **Retry/duplicate:** dispatching `/new` again with the same operation key returns the same new
  session (`replayed: true`) and creates no second row. The renderer keeps one key per distinct
  command line, so a bridge failure followed by Ctrl+Enter reuses it.
- **Restart:** the rotation is durable. A restart that retries the same key gets the same
  conversation; a person typing `/new` again is a new request and legitimately starts another one.
- **Project switch:** the key is unique *per project*, so a pending dispatch cannot be redirected
  into another project's session list.
- **Busy:** refused before anything is written.
- **Disconnected:** allowed — a new conversation is local. `threadCreated: false` and the receipt
  text say the runtime opens a thread when the new conversation first sends work.
- **Old conversation:** untouched. Its thread, timeline rows, usage and draft remain; the route
  test reads the old thread and its first row back after the rotation.

`/help` is the second route: it returns a `show-catalog` receipt and the window opens the catalog
drawer. Aliases share the same validation (`/bangzhu` → `help`, `via: 'alias'`).

The two catalog rows now read `route: 'mona'` with their own notes; the other 107 stay `tui-only`
with a reason. The generated catalog is rebuilt from the same capture, and the W04 coverage fixture
still reconciles it row for row.

**Ready for Prompt Runner (W17):** `rotateSession` plus the `new-conversation` operation is the
shared, idempotent "start a fresh conversation" primitive, with the old and new identities in the
receipt.

## Verification

```text
npx vitest run apps/desktop/src/main/command-service.test.ts   # 15 passed
npx vitest run apps/desktop/src/main/command-ipc.test.ts       # 5 passed
npx vitest run apps/desktop/src/renderer/StudioPanel.test.tsx  # 29 passed
npm test                                                       # 678 passed in 73 files
npm run ci                                                     # exit 0
npm run slash                                                  # 14 real-window steps passed
```

Real Windows runtime (`docs/evidence/W04-slash.json`):

```text
PASS a terminal-only command is explained, not sent   "/model is a Codewhale command. … This line was not sent."
PASS /new starts a new conversation in the real window
     beforeSession "Session ses_41455e54" → afterSession "Session ses_98970de6", run state "Ready"
PASS the new conversation says what happened and what was kept
     "Started a new conversation. The previous session keeps its history, draft and usage; no engine
      thread exists until the new conversation sends work."
```

Dispatch matrix (fixture):

| Case | Expected | Observed |
|---|---|---|
| `/new` idle | done, new session, no thread | done, `threadCreated: false` |
| `/new` same key twice | one rotation, same session, `replayed` | same id, one row |
| `/new` busy | refused `busy`, nothing written | refused, 0 rotations |
| `/new` with arguments (5 injection shapes) | refused `unexpected_argument` | all refused, 0 rotations |
| `/model …` (tui-only) | refused `not_routed` | refused with the row's note |
| `/not-a-real-command` | refused `unknown_command` | refused |
| `/mod` | refused with candidates | `/model` named |
| prose | refused, "ordinary text goes through Submit" | refused |
| `/help`, `/bangzhu` | done `show-catalog` | done, alias resolved |
| missing/malformed operation key | refused before any work | refused, 0 rotations |
| unknown project | refused `not_found` | refused |
| old conversation after `/new` | still readable | thread + first row returned |
| saved provider/permission profile | unchanged | unchanged |
| same key in two projects | two independent rotations | two rows, different sessions |

## What is not claimed

- The new conversation has **no engine thread until it is used**: that is deliberate, and the
  receipt says so. The engine-side creation path for a fresh conversation is the existing
  per-session thread creation in `StudioService.submit`, unchanged in this prompt.
- `/model`, `/mode`, permissions and every other route-changing command stay `tui-only`. Mona does
  not change the configured provider, endpoint, model or permission posture from a command; the
  profile test proves the saved settings are untouched.
- A real restart of the packaged application between a dispatch and its retry was not exercised by
  a machine test; the restart case is modelled at the service boundary instead (a new
  `CommandService` over the same store returns the recorded session). A real process restart of the
  packaged build remains W24's packaged-qualification scope.
- `session_rotations` is part of the replacement-import cleanup list, so a project import cannot
  leave stale rotations behind or adopt another install's conversations.
