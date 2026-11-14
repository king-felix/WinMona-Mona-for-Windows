# W08 — Native approval and clarification replies

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`
· Electron 45.3.0 (development build).

Status: **implementation complete and qualified at the protocol and service boundary; one
observation is open** — a real pending approval was never produced on this machine (see
"Not yet observed").

Evidence:

- **Protocol, live** — `node tools/spike/approval-reply.mjs`, 8 steps, 0 provider requests
  (`docs/evidence/W08-reply.json`). Starts the pinned runtime on loopback, opens a real thread, and
  sends a reply to ids the runtime does not hold, through the same `EngineAdapter` calls the studio
  uses.
- **Round trip attempt, live** — `node tools/spike/approval-roundtrip.mjs`, one bounded turn on the
  configured route under an "ask" posture (`docs/evidence/W08-roundtrip.json`). Recorded as a
  negative finding, not a pass.
- **Fixture/service** — 8 new `studio-service` tests, 2 adapter tests, 1 IPC test, 2 renderer tests,
  2 contract tests.

## The contract, read from the pinned engine

The engine ships its own web client inside the binary, and that client is the authoritative
description of the reply protocol:

```text
POST /v1/approvals/{approval_id}          body { decision: "allow" | "deny", remember: boolean }
POST /v1/user-input/{thread_id}/{request_id}  body { answers: [{ id, label, value }] }
events: approval.required | approval.decided | approval.timeout
        user_input.required | user_input.answered | user_input.canceled
payload: approval_id (or id), tool_name, description, summary, intent_summary, turn_id
         request.questions[] = { id, header, question, multi_select, options[{label, description}] }
```

Two defects in Mona's earlier contract were found while reading it:

- `ApprovalRequiredPayload` required camelCase `approvalId`/`toolName`, so a real `approval.required`
  carrying `approval_id`/`tool_name` failed payload parsing and the event was dropped as unreadable.
  The schema now accepts both spellings and `normalizeApprovalRequired` is the single place that
  decides whether a payload is answerable.
- The runtime's thread posture `ask` was not in `PermissionPosture`, so a thread that pauses before a
  side effect was displayed as `unknown`. It is now its own value; it is not a synonym for workspace
  write.

## What changed

**The request is durable, not a renderer flag.** Migration 9 adds `human_requests` (project, thread,
turn, kind, engine request id, tool name, question JSON, permitted reply schema, status, claim time,
answer, acknowledgement), unique on `(thread_id, engine_request_id)`. A replayed event returns the
row that exists; a reload, reconnect or restart restores the card from the database
(`rehydratePending`), because the engine does not replay the request. Earlier builds lost the card
and left the turn waiting invisibly.

**The reply is a typed operation on the runtime's own route.** `StudioService.respond` validates the
answer against the schema recorded *with the request* (not against whatever the renderer shows),
claims the send in the database, calls `respondToApproval`/`respondToUserInput`, and only closes the
card on an acknowledgement. Consequences that are tested, not asserted:

- two clicks produce one decision (`conflict`, no second POST);
- a renderer bug cannot widen the answer — an unknown option, a missing answer, a multi-answer on a
  single-select question, an answer for a question that is not in the request, and an unknown
  approval decision are all refused before anything is sent;
- a runtime refusal settles the row as `expired` and keeps the card honest instead of retrying with a
  new identity;
- a request that belongs to another project is `not_found`;
- a decision the runtime reports on its own (`approval.decided`, `user_input.answered`,
  `approval.timeout`, `user_input.canceled`) settles the row and clears the card without Mona
  claiming it sent anything.

**The UI answers, and dismissal does not.** The pending card now offers `Allow`/`Deny` with an
optional "remember for this session", or the runtime's questions with radio/checkbox options plus the
always-available `Other` response, a `Send answer` control, and the recorded validation problem. It
plays back the acknowledgement. `Interrupt now` remains, and it still does not decide anything.
`capabilities.approvalResponse` is now `supported` and names both routes.

## Verification

```text
npx vitest run packages/contracts                        # 25 passed
npx vitest run packages/adapter/src/adapter.test.ts       # 26 passed (2 new reply tests)
npx vitest run apps/desktop/src/main/studio-service.test.ts  # 37 passed (8 new)
npx vitest run apps/desktop/src/main/studio-ipc.test.ts   # 11 passed (1 new)
npx vitest run apps/desktop/src/renderer/StudioPanel.test.tsx  # 36 passed (2 new)
npx vitest run                                            # 700 passed in 76 files
npm run check:build -w @mona/desktop                       # 90 named preload channels
node tools/spike/approval-reply.mjs                        # 8 steps, 0 provider requests
```

Live protocol evidence (`docs/evidence/W08-reply.json`):

```text
PASS the pinned runtime starts on loopback with a bearer token
PASS the runtime identifies itself as the pinned engine     0.10.2 / ff466b2ed0bf
PASS a real thread opens without any provider request
PASS a clarification reply reaches POST /v1/user-input and is refused for an unknown request
PASS an approval decision reaches POST /v1/approvals and is refused for an unknown approval
PASS the approval route exists and names the approval it does not hold
     {"status":404,"body":"{\"error\":{\"message\":\"no pending approval with id 'mona_probe_missing_approval'\"...
PASS the clarification route exists and answers from its own handler
PASS a different method or path is refused as a route problem, not mistaken for a request problem
```

## Not yet observed — Needs the Human

A **real pending approval** was not produced, so no live decision has been accepted by the runtime.
Two attempts are recorded under `P-W08-001`:

1. A thread created with `allow_shell: true, trust_mode: false, auto_approve: false` in a throwaway
   engine home: the turn was refused with HTTP 400 because that home has no provider key.
2. The same thread against the machine's own engine home: the thread reported
   `permission_posture: "ask"`, the `bash` tool ran, and the turn completed — with **no**
   `approval.required` event at all.

The cause is configuration, not code: `~/.codewhale/settings.toml` records
`permission_posture = "full-access"`, and the binary documents that `auto_approve`, `trust_mode` and
`allow_shell` *"are capped at what that [policy] allows"*. The saved Full Access posture therefore
outranks the thread flags this probe can set, and Mona is not allowed to change the user's saved
posture on its own.

**What clears it:** with Mona's saved permission posture switched to `ask` (Settings → Provider →
permission, a supported user action) for one bounded turn, `approval-roundtrip.mjs` should observe
`approval.required`, send `allow`, and see `approval.decided` followed by `turn.completed`. Then
repeat `npm run focus:live`-style transitions across that pending card to close W06's last item too.

Everything else in W08 — the durable request, the reply transport, validation, acknowledgement,
duplicate/expired/concurrent handling, reconnect and project isolation — is covered by the fixtures
and the live route qualification above. The unobserved part is one live decision, not the design.
