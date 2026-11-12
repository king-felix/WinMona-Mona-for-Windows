# Mona

Mona is a local Windows desktop workbench for [Codewhale](https://github.com/codewhale-hq/Codewhale).
Codewhale owns the model, the tools, the permissions and the execution loop; Mona owns the
window, the project catalog, the work record and the review surfaces around it. Nothing in
Mona performs inference of its own: idle Mona makes no provider request, and every price and
token count in the interface comes from the engine's own usage report.

**Release candidate: 0.1.0.** Not a 1.0-complete claim. See [Status](#status) for exactly what
is verified, what is measured, and what is still waiting on a human decision.

## Status

Verified on this machine (Windows 11 Pro 10.0.26200, Ryzen 7 5800X, 32 GB):

- 27 of 30 product requirements **verified** against recorded evidence.
- **MONA-028 is partial**: idle memory is 371.4 MB on the installed candidate against a 350 MB
  internal target (down from 404 MB after windowing rendered timeline rows), and the Windows
  screen-reader and physical 200% scaling checks need a person.
- **MONA-027 is blocked**: the Windows 11 modern folder menu is built and test-signed, and its
  signer is verified, but Windows will not register the identity package until this machine
  trusts the signing certificate — one elevated command. The classic menu works today.
- Real engine turn through the installed app: 22/22 probe steps, one turn at 596 µUSD.
- Automated gates green: 549 Vitest tests (67 files), 14 bootstrap, 12 launch, 25 install,
  8 spike, 7 native; typecheck, lint, formatting and build all pass.
- Installed-candidate startup: cold 422 ms, warm 738 ms; idle CPU 0.04%.

The full matrix, with evidence paths, is in [docs/release-notes-0.1.0.md](docs/release-notes-0.1.0.md),
[docs/evidence/P23-followup.md](docs/evidence/P23-followup.md) and
[docs/evidence/P22-product-QA.md](docs/evidence/P22-product-QA.md).

## Requirements

- Windows 11 x64 (Windows 10 2004+ is the package floor; only Windows 11 was qualified).
- An installed Codewhale engine. Mona is qualified against **0.10.2 (ff466b2ed0bf)** and
  refuses unsafe operations on an unknown version while keeping offline project access.
- A configured provider and credential **in Codewhale**, not in Mona. Mona never asks for,
  reads or stores a provider key.
- Node.js 22+ only to build from source or to run the build tooling.

## Install from this repository

```powershell
npm ci
npm run build
node tools/install/cli.mjs stage          # payload: %LOCALAPPDATA%\Mona\stage
node tools/install/cli.mjs package --test-sign
node tools/install/cli.mjs install --smoke
node tools/install/cli.mjs verify --smoke
```

`install` places the program at `%LOCALAPPDATA%\Programs\Mona`, registers the classic Explorer
entry, writes the per-user uninstall entry, and preserves `~/.codewhale` and your project
folders. It reports the identity-package result honestly: on a machine that does not trust the
test certificate the modern menu entry reports `0x800B0109` and stays unregistered. To enable
it on a development machine, verify and trust the certificate first — see
`node tools/install/cli.mjs trust-test-certificate`, which checks the signer, manifest and build
record before importing anything, and writes only to `LocalMachine\TrustedPeople`.

Uninstall removes Mona-owned files and registration and keeps your projects, the project
database and the engine's history:

```powershell
node tools/install/cli.mjs uninstall
```

## What Mona does

- **Projects, not chats.** One catalog over local folders, with branch/worktree awareness,
  drafts and view state per project, and a hard rule that removing a catalog entry never
  deletes files.
- **One owner of execution.** Mona starts and stops the engine itself, records a submission
  journal before sending, reconciles uncertain turns, and never replays a possibly-executed
  tool call.
- **Prompt work board.** Tasks with dependencies and acceptance criteria; evidence-gated
  completion; three failed no-progress attempts block the problem instead of spinning.
- **Cost lens.** Recorded usage with its pricing source, unknown values labelled unknown,
  optional budgets, and CSV export.
- **Changes and evidence.** A hash comparison against a baseline you capture, real Git text
  diffs with a virtualized viewer, test receipts with output digests, and honest
  "unavailable" states.
- **Agents, memory, extensions, capabilities.** Native goals/fleets/runs, local term search
  over recorded state, MCP/skill/plugin/hook inventory, and a capability explorer over the
  pinned engine surface — each row says what is qualified, discovered, or unavailable.

## Documentation

- [User guide](docs/user-guide.md) — install, first launch, credentials, folder launch,
  prompts, resume, costs, stopping work, blockers, backups, privacy, updates, uninstall.
- [Developer guide](docs/developer-guide.md) — layout, reproducible builds, adapter
  qualification, schemas and migrations, failure fixtures, adding capability coverage.
- [Compatibility](docs/compatibility.md) — engine/version policy and what drift does.
- [Release notes 0.1.0](docs/release-notes-0.1.0.md) — artifact hashes, provenance, known
  issues, rollback.
- [P23 follow-up](docs/evidence/P23-followup.md) — trust verification, memory breakdown,
  accessibility observations, startup measurements.
- [Human checklist](docs/evidence/P23-human-checklist.md) — the checks that need a person.
- [Third-party notices](THIRD_PARTY_NOTICES.md), [contributing](CONTRIBUTING.md),
  [security](SECURITY.md).
- Product specification and build sequence: `Mona_Project.md`, `Mona_PROMPTS.md`.

## Repository layout

```text
apps/desktop/          Electron main, preload, React renderer, probes and scripts
packages/contracts/    Zod schemas, fixtures, upstream mapping
packages/adapter/      Engine HTTP adapter, SSE parser, supervisor, work queue
packages/project-state/SQLite store, migrations, tasks, costs, changes, memory
packages/ui/           Design tokens and primitives (Daybreak/Afterglow)
native/windows-shell/  IExplorerCommand menu helper (COM DLL)
tools/build/           Bootstrap state/ledger utility (not a product dependency)
tools/install/         Per-user installer, identity package, signing, certificate trust
docs/                  Requirements ledger, capability ledger, evidence, ADRs
.mona/build/           Durable build state, decisions, blockers, attempts, handoffs
```

## Security and privacy

Mona keeps its own boundary: a sandboxed renderer, a frozen preload with named methods only,
validated IPC that checks the sender frame first, no remote content in the renderer, and no
credentials in the renderer process. Local state lives under `%LOCALAPPDATA%\Mona` and
`%APPDATA%\@mona\desktop`. There is no telemetry and no analytics endpoint. See
[SECURITY.md](SECURITY.md) and [docs/evidence/P20-security-review.md](docs/evidence/P20-security-review.md).

## License

Mona has **no license yet**. Choosing one is Victor's decision and is part of authorising a
public release; until then all rights are reserved. Bundled third-party components keep their
own licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Support and scope

This is a local, single-user Windows build. macOS, Linux, ARM64, WSL, mobile, cloud sync,
team accounts and background AI summarisation are explicitly out of scope for 1.0 and are not
partially implemented behind hidden switches.
