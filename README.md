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

- 28 of 30 product requirements **verified** against recorded evidence.
- **MONA-028 is partial**: idle memory is 352.5 MiB (360.1 MiB averaged over 60 s) on the installed
  candidate against a 350 MiB internal target, and 400.6 MiB with a 20,000-row session open. The
  app-reducible part is a ~4 MiB renderer heap; the rest is Chromium's per-process baseline plus a
  ~100 MiB GPU process doing software rasterisation on a GPU-less VM. The deviation is **accepted
  for 0.1.0** by decision (D-0111); the target itself is unchanged and not met. Narrator, exact
  200% scaling, text size, contrast themes and physical IME still need a person.
- **MONA-027 is registered, not yet seen**: the identity package registers when the signer is
  trusted, and both modern-menu verbs are declared. The shell's own verb table was observed
  invoking Mona with the selected folder (`docs/evidence/W22-shell-verb.json`). A human right-click
  confirming the item in the Windows 11 menu is still outstanding, so no complete claim is made.
- Windows accessibility is now real: a UI Automation query used to see nine stub elements and now
  sees the full named control tree, because the app asks Chromium to build it (`W20`).
- Real engine turn through the installed app: 22/22 probe steps, one turn at 596 µUSD.
- Automated gates green: 720 Vitest tests (77 files), 17 assets, 27 bootstrap, 12 launch, 29 install,
  8 spike, 8 native (1 environment skip); typecheck, lint, formatting and build all pass.
- Installed-candidate startup: cold 529 ms, warm 1,679 ms; idle CPU 0.02–0.06%.

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

## Install

The file to share is a single setup executable. It installs for the current user, needs no
administrator rights, no Node and no source checkout:

```text
Mona-Setup-0.1.0-x64.exe      (built by: node tools/install/make-setup.mjs)
```

It is **unsigned**. Windows may show a SmartScreen reputation warning, and the packaged Windows 11
Explorer entry stays unregistered until the machine trusts the signing certificate it carries (see
the prerequisite below). Everything else — the program, the Start menu entry, the classic
folder and folder-background commands, and the uninstall entry — installs without that decision.

From a source checkout, double-click **`install-mona.cmd`** in the repository root. It runs the
same per-user installer, verifies the installed build, and starts Mona. It downloads nothing,
publishes nothing and needs no elevation.

The equivalent command sequence, if you prefer a terminal:

```powershell
npm ci
npm run build
node tools/install/cli.mjs stage          # payload: build\install-stage
node tools/install/cli.mjs package --test-sign
node tools/install/make-setup.mjs         # one installable file in %LOCALAPPDATA%\Mona\artifacts
node tools/install/cli.mjs install --smoke
node tools/install/cli.mjs verify --smoke
```

`install` places the program at `%LOCALAPPDATA%\Programs\Mona`, registers the classic Explorer
entry, writes the per-user uninstall entry, and preserves `~/.codewhale` and your project
folders. It reports the identity-package result honestly: Windows refuses a test-signed package
with `0x800B0109` until the machine trusts the certificate. To enable the Windows 11 modern menu
on a development machine, run `node tools/install/cli.mjs trust-test-certificate` **in an
elevated shell**; it checks the signer, manifest and build record, writes only to
`LocalMachine\TrustedPeople`, and `untrust-test-certificate` removes exactly that thumbprint
from both `TrustedPeople` stores. It never touches `Root`, and never enables developer mode.

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
- **A shell that yields to the work.** The Inspector collapses to a rail so the agent timeline
  owns the width, and <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> scale the whole
  window in fixed steps when the display is far away.

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
- [Surfaces round](docs/evidence/P25-surfaces.md) ? the Cost lens and Work board wired to
  their services, with the criterion-basis correction (D-0114).
- [Elevated trust round](docs/evidence/P23-elevated-round.md) — the elevated import, package
  registration, the packaging guard, and the probe that proved nothing.
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
