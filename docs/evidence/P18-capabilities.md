# P18 — Advanced access and the capability explorer

**Status:** completed (terminal remains blocked by the pinned engine on Windows)
**Prompt:** P18 — Complete advanced access and the capability explorer
**Requirements:** MONA-022 (verified), MONA-023 (blocked at terminal, logs and
isolation passed), MONA-030 (version drift and coverage passed; upgrade
qualification stays P21/P22)
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)`, Windows x64
**Spend:** zero provider requests. The probe submitted no turn and the runtime
usage totals stayed at zero turns / zero tokens / zero cost.

## What Mona now exposes

A new **Capabilities** section (Alt+7, also in the command palette) joins the
versioned ledger with the running engine:

- **Auditable rows.** Every ledger row shows ID, upstream name/surface/source/
  version, platform, read/write class, permission implications, cost class,
  required arguments, integration label, UI location, tests, evidence paths,
  status and gap. Nothing is hidden because it is awkward.
- **Coverage counts.** The explorer computes total, qualified, read-qualified,
  discovered, unavailable, blocked and unknown rows plus integration counts.
  It labels the percentage as **catalog coverage**, not parity. At capture time:
  56 rows, 25 verified entry points (45%), 27 discovered-only, 4 unavailable,
  0 blocked.
- **Live identity and drift.** The running version, commit, API version, bind
  host/port, auth requirement, pid, start time, uptime and executable sit beside
  the ledger’s pinned version/commit. A version or commit mismatch is shown as
  drift; ledger claims are never inherited silently.
- **Live capability flags.** Every flag from `GET /v1/runtime/info` is listed
  with its true/false value.
- **Read-only logs.** `GET /v1/logs` lists sources and files; `GET
  /v1/logs/{name}` is read in at most 64 KiB slices with `offset`/`limit`.
  Mona rejects path-like names, redacts credential-shaped values, and shows
  “more remains” instead of truncating silently.
- **Palette entries.** Every capability row becomes a locally ranked palette
  item (`capability:CAP-…`). Selecting one opens the explorer and focuses that
  row. Selecting a capability never invokes it.
- **Terminal state.** The panel shows the engine’s terminal flags, the route,
  and the exact limitation. An explicit **Check terminal route** action calls the
  route and displays the real HTTP response.

## The terminal result — honest unavailable, not faked

`GET /v1/runtime/info` reports:

```
terminal_stream = false
terminal_input  = false
terminal_resize = false
terminal_kill   = false
```

A direct `GET /v1/terminal/mona-probe/output` returns **HTTP 501**:

```
terminal sessions are Unix-only in this build;
native Windows PTY support is not implemented yet
```

Mona therefore does **not** ship a terminal widget, a pseudo-PTY, or a
`child_process` shell that pretends to be one. The row `CAP-0053` is
`unavailable-on-platform` with integration `Unavailable`. MONA-023/terminal is
blocked with `ISSUE-0018`; Victor must either accept terminal as unavailable
on Windows for 1.0 or authorize a native Windows PTY path (likely P21).

## Live evidence (`docs/evidence/P18-capabilities.json`)

The isolated probe created a log directory with a secret-bearing line and a
200,000-byte log, started the real runtime, and exercised the same
`CapabilityService` the desktop uses. All checks passed:

1. The explorer reports 0.10.2 / ff466b2ed0bf with zero drift.
2. Every ledger row is present (56) and coverage totals match.
3. Verified + discovered-only + unavailable + blocked + unknown equals total.
4. CAP-0053 is `unavailable-on-platform` / `Unavailable`.
5. All four terminal flags are false.
6. The terminal reason names the engine limitation.
7. The palette exposes all 56 rows.
8. The explicit route check returns the engine 501 message.
9. Logs are listed read-only (`big.log`, `runtime.log`).
10. The secret-bearing log is redacted and bounded.
11. The 200,000-byte log returns exactly 65,536 bytes and `truncated: true`.
12. `..\config.toml` is refused as a log name.
13. Usage before and after is identical: zero turns, zero tokens, zero cost.

## Capability coverage rows added

- **CAP-0056 — runtime info:** read-qualified. Version/commit/capability flags.
- **CAP-0055 — process:** read-qualified. Runtime identity and uptime.
- **CAP-0054 — logs:** read-qualified. Bounded, redacted, path-safe.
- **CAP-0053 — terminal:** unavailable-on-platform. Exact 501 and false flags.

`docs/codewhale-capabilities.json` now has 56 rows. The explorer reads the same
file that ships with the desktop build (`dist/resources/capabilities.json`).

## Isolation and safety

- The preload exposes no terminal, shell, filesystem or generic invoke channel.
  There is no terminal IPC to reach. Logs cross IPC as bounded text and render in
  a `<pre>` element; escape sequences and hyperlinks are text, not commands.
- Log names are validated twice (IPC schema and adapter) and cannot contain path
  separators or `..`.
- Log content and terminal error text pass through a credential-shape redactor.
- Capability selection only navigates; it never executes a mutating operation.
- Discovered-only rows are displayed as discovered, not promoted to supported.

## Small regression fixed

The P17 palette added “Go to Extensions” but the action switch did not route
`action:extensions`; selecting it did nothing. P18's palette work exposed it and
now routes both `action:extensions` and `action:capabilities`.

## Tests and checks

- `packages/adapter/src/diagnostics.test.ts` — identity mapping, log listing,
  bounded/redacted reads, path refusal, 501 terminal answer.
- `apps/desktop/src/main/capability-service.test.ts` — ledger join, coverage,
  drift, disconnected state, log/terminal forwarding, invalid ledger.
- `apps/desktop/src/main/capability-ipc.test.ts` — declared channels, payload
  validation, path refusal, untrusted sender, unavailable service.
- `apps/desktop/src/renderer/App.test.tsx` — Capabilities navigation, coverage,
  terminal check, bounded log display, palette capability entry.
- `npm test`, `npm run build`, `npm run typecheck`, `npm run lint`,
  `npm run format:check`, and `npm run check:build -w @mona/desktop` pass; the
  preload exposes 54 named channels.
