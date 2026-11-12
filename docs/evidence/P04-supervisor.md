# P04 — Runtime process ownership and stopping behaviour

**Prompt:** P04 · **Status:** completed · **Requirements:** MONA-002, MONA-012,
MONA-016 (process half) · **Environment:** win32-x64, Node v26.13.1, Electron
45.3.0, engine 0.10.2 `ff466b2ed0bf` (qualified)

P03 shipped a minimal `startOwnedRuntime` that spawned a child, polled `/health`
and killed the pid. That could not distinguish its own child from a stranger on
the same port, could not clean up descendants, and lost an exit that happened
during startup. P04 replaces it with a supervisor whose guarantees are in
mechanism, and moves the desktop lifecycle decisions out of Electron so the
matrix is testable.

## What is now real

**One desktop owner.** `app.requestSingleInstanceLock()` plus a
`second-instance` handler that parses the launcher's argv into absolute folder
paths (`parseLaunchArgs`, Electron switches ignored) and restores the existing
window. No second runtime, no second catalog.

**One runtime per workspace.** `RuntimeSupervisor` owns at most one child.
`EngineHost` refuses to start a second runtime in a session and refuses to attach
an external runtime while one is owned.

**Identity, not just a port.** Startup verifies, in order: the executable exists
and resolves to a real file; the requested port has no listener *or* is held by
something that is not a Codewhale runtime; the child reports
`service: codewhale-runtime-api`; `/v1/runtime/info` matches the expected
contract, `auth_required` is not false, `bind_host` is loopback, and the reported
port equals the port Mona chose; a stateful route (`/v1/providers`) accepts the
ownership token; the child has not exited while ownership was being recorded.

**Token handling.** The token is generated in memory (32 random bytes,
base64url), passed only through `CODEWHALE_RUNTIME_TOKEN`, and never appears in
argv — the supervisor refuses to spawn if the token is present in any argument.
The ownership record stores only `token_sha256`. Evidence confirms the written
record file contains no token.

**Ownership records.** Machine-local JSON under the app's private data
directory: runtime id, workspace, workspace key, executable path plus realpath,
size and mtime, engine version and commit, pid, **process creation time**,
parent pid, desktop instance id, loopback endpoint, token digest, timestamps and
state. Written atomically (temp file, `fsync`, rename). Never in a project
repository.

**PID reuse is handled, not assumed away.** Every kill path compares the
recorded creation time with the live one. A record whose pid now belongs to a
different process is marked `stale` and left alone; a live pid whose creation
time cannot be read is reported as unverifiable and left alone.

**Descendant cleanup (Windows).** `taskkill /PID <pid> /T` — the OS parent/child
walk for that one pid — with a grace attempt, then `/F`, then a bounded poll of
every observed descendant. No code path selects processes by image name. The
POSIX path uses a process group when available. Mechanism is
`platformProcessMechanism` (`taskkill-tree` here).

**Crash → bounded restart only.** A runtime that exits unexpectedly marks the
record `crashed`, emits `exited{expected:false}`, and restarts the *process* with
capped exponential backoff inside a sliding window (`maxRestarts`, default 0 in
the adapter, 2 in the desktop host). No turn is ever resubmitted; exhausted
restarts become a terminal `failed` state.

**Four distinct transitions.** `Pause after task` is a Mona queue boundary and
never touches the engine. `Interrupt now` is an engine call that must return a
receipt; a missing or failed channel is `outcome_unknown`, and active work is not
cleared. `Cancel queued` removes future starts only and refuses the running
task. `Quit and stop work` interrupts (best effort, with receipt), then stops the
owned runtime, and reports `partial` if either half is uncertain. Every receipt
carries `rollback_claimed: false` — stopping cannot undo sent requests or
external side effects.

**External runtimes are read-only.** `attachExternalRuntime` verifies loopback,
authentication and compatibility, exposes `owned: false`, and returns a typed
refusal from `stop()`. Evidence: the live run proves the real runtime is still
alive after the refusal.

**Idle Mona stays idle.** Nothing in this change starts a runtime at launch.
`EngineHost` starts a runtime only when a project asks for one; reconciliation
inspects records and terminates only processes this install still owns.

## Lifecycle matrix

| Signal | Consequence | Verified by |
|---|---|---|
| Renderer crash | keep runtime; destroy dead window; recreate one window | real Electron probe (10 checks) |
| Window close with owned runtime | prevent close, hide window, keep work | real Electron probe |
| Window close with nothing owned | normal quit | `decideLifecycle` unit test |
| App quit | interrupt active turn, then stop owned runtime | probe + `WorkQueue` tests |
| Runtime crash | mark crashed, bounded process restart, outcome unknown if work was active | supervisor + host tests |
| Forced app termination | next launch reconciles records, reclaims only verified own children | `reconcile` tests (`stale_pid`, `pid_reused`) |
| Machine restart | same reconcile path; stale pids cleared, live strangers untouched | `reconcile` test |
| Second launch | focus/show existing window, forward path | probe + `parseLaunchArgs` test |
| Incompatible runtime | start refused as `capability_unsupported`, existing data untouched | compatibility policy + live pinned check |

A defect found and fixed by the probe: destroying the last window fired
`window-all-closed` → `app.quit()` → stop during a renderer crash, which would
have destroyed work. `window-all-closed` now quits only when Mona owns no
runtime; the probe asserts the host stays `connected` after a crash.

A second defect found and fixed: a runtime that exited *during* startup (after
answering `/health`, before its record was written) was reported `running` with a
dead pid. The exit handler deliberately ignores exits with no recorded runtime,
so the start path now re-checks the observed exit after assignment and fails the
start (`startup_failed`), and `waitForReadiness` reports an early exit.

## Evidence

- `docs/evidence/P04-live.json` / `P04-live-log.txt` — 15/15 steps against the
  real pinned engine: authenticated readiness, qualified identity, token-free
  ownership record, creation-time match, read-only external attach, stop receipt
  (descendant observed and cleaned), port closed, record marked stopped,
  unrelated node process survived, occupied port by a real Codewhale runtime
  refused without killing it, missing executable actionable.
- `docs/evidence/P04-lifecycle.json` / `P04-lifecycle-log.txt` — 10/10 checks in
  real Electron: close-hides, renderer crash recreates exactly one window and
  keeps the runtime, crash does not start a quit, relaunch restores the same
  window and runtime, quit-and-stop ends the process.
- `docs/evidence/P04-tests.txt` — 109 Vitest (25 new: process tree, supervisor,
  work control, lifecycle matrix, engine host) + 13 bootstrap + 8 spike.
- `docs/evidence/P04-checks.txt`, `P04-build.txt` — format, lint, typecheck,
  build, static bundle checks, P02 security smoke still passing (332 MB).

Real stops report `stopped_forced`: a console process does not handle the polite
`taskkill` close message, so the grace attempt expires and the bounded forced
step runs. That is recorded as forced, with descendants observed and no
remaining pids — not presented as a graceful shutdown.

## Known limits, recorded rather than hidden

- **No Job Object.** A Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` would make kernel-level cleanup
  unconditional, but requires a native addon or a helper binary; there is no
  MSVC toolchain on this host (BLOCKERS prerequisite table). The qualified
  mechanism here is `taskkill /T` on the verified pid plus creation-identity
  reconciliation of orphans at next start. Recorded as D-0029.
- **Force-terminating the desktop app** leaves the runtime alive until the next
  Mona start reclaims it. That is a bounded, documented recovery path, not a
  daemon guarantee; the spec's initial target is exactly this.
- **No tray affordance yet.** Close-to-tray hides the window and keeps work, but
  the tray icon belongs to the desktop shell (P07). Until then a hidden window is
  restored by launching Mona again.
- **Parallel workspaces stay serialized.** MONA-012 and MONA-016 process criteria
  are satisfied; the lease is single-workspace by construction and the
  P01-ISSUE-002 serialization default still governs multi-project execution.
- **Interrupt from the desktop has no journal yet.** `EngineHost.interruptActive`
  returns no channel until a project binds a submission journal (P05/P08), so
  Quit-and-stop reports the interrupt half as `outcome_unknown` rather than
  fabricating an acknowledgement. The queue transition itself is tested.
