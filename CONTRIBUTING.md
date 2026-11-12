# Contributing to Mona

Mona is currently a **local, single-owner project with no remote**. Nothing here authorises a
public repository, a published package, a release, or a push to any remote. Those are separate,
explicit human decisions.

## Before you change anything

1. Read `AGENTS.md` (build contract) and `docs/developer-guide.md` (how the code fits together).
2. Run the gate so you know the baseline is green:

   ```powershell
   npm ci
   npm run ci
   node tools/build/cli.mjs validate
   ```

3. If you are picking up unfinished work, read `.mona/build/HANDOFF.md` and `.mona/build/state.json`
   and resume the recorded prompt instead of starting something new.

## Ground rules

- **Codewhale executes.** Do not reimplement the provider client, the tool loop, compaction,
  permissions or orchestration. Use the engine's documented surface and verify it against the
  pinned build.
- **Preserve the economics.** No router, no summariser, no background inference, no paid UI
  feature. Idle Mona must cause zero provider requests, and probes assert it with a paid-turn
  counter.
- **Show real state.** Disconnected is not stopped, interrupted is not completed, unknown cost
  is not zero, untested is not supported.
- **No fabricated evidence.** A mock-only test is never runtime compatibility. Record the
  command, the result, the time, the version/commit and the artifact path.
- **No secrets.** Never commit keys, tokens, credential paths or private transcripts.
  `.mona/build` is shareable and redacted; keep it that way.
- **One prompt per session** unless the owner queues more. Do not drift into later scope.

## Change shape

- Smallest coherent change; preserve unrelated work in the tree.
- A behavior change needs a test at the layer that owns it (store, adapter, IPC, renderer).
- A new IPC channel needs the sender check, a payload schema, the channel allowlist entry in
  `apps/desktop/scripts/check-build.mjs`, and the preload method. The audit test will fail
  otherwise.
- A new surface that reports workspace facts must keep "unavailable" visibly distinct from
  "empty".
- Update `.mona/build/state.json`, `HANDOFF.md` and the requirement ledger when the change
  closes or moves a requirement, then commit locally.

## Reporting a problem

Open a local issue note in `.mona/build/BLOCKERS.md` if you are blocked, with the exact help
needed. If you hit the same wall three times with no material progress, stop: record the three
attempts in `.mona/build/attempts.jsonl`, mark the requirement blocked, and move to independent
work. Do not reset the counter by starting a new session.

## Style

- Prettier and ESLint are authoritative; `npm run ci` enforces both.
- Comments explain why, not what. State-machine and honesty rules deserve a comment; a getter
  does not.
- Prefer plain prose in UI copy. Status text says what happened and what it means for the user.
