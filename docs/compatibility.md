# Compatibility policy

Mona drives an installed Codewhale engine over its documented runtime surface. It does not
bundle, patch or reimplement the engine. Compatibility is therefore a statement about one
specific engine build, re-checked at every connection.

## Qualified build

| Fact | Value |
|---|---|
| Engine | Codewhale `0.10.2 (ff466b2ed0bf)` |
| Install method on the reference machine | WinGet package `HunterBown.CodeWhale` |
| Runtime API contract | `docs/RUNTIME_API.md` surface, verified route by route in P01 |
| Qualification evidence | `docs/discovery-report.md`, `docs/evidence/P01-contract.json`, `docs/codewhale-capabilities.json` |

Re-check the installed identity at any time:

```powershell
codewhale --version
```

The P23 release check re-ran this and observed the same string, `codewhale 0.10.2
(ff466b2ed0bf)`. An upstream documentation or repository check could not be completed during
P23 because `api.github.com` did not resolve from this machine; no upstream claim is made.

## Statuses

Mona classifies the connected engine into exactly one of three states:

- **qualified** — version and commit match the pinned build. Every surface Mona uses is enabled.
- **compatible_unqualified** — the engine reports a different build. Mona keeps safe,
  already-verified operations working (project browsing, recorded history, offline views) and
  shows the drift; operations whose contract is not verified on that build are labelled
  unqualified rather than silently retried.
- **unsupported** — the engine is outside the accepted range. Submission and any unsafe
  operation are refused with an actionable message. Offline project access is preserved.

Missing capability flags are treated as **false**, never as true-by-default. A route that is
absent is reported as unavailable with its reason; it is not simulated by a terminal shim or a
synthesised model turn.

## Platform matrix

| Component | Version used | Notes |
|---|---|---|
| Windows | 11 Pro 10.0.26200 (25H2) | Qualified on this build only. Package floor is Windows 10 2004. |
| Electron | 45.3.0 | Chromium 156, Node 24.22 inside the app |
| Node.js (build tooling) | 26.13.1 | `engines.node >= 22` for building |
| node-pty | 1.1.0 | Shipped N-API prebuild; the package install script is denied |
| SQLite | `node:sqlite` in Electron's Node | Product database, single write path |
| Capability ledger | `docs/codewhale-capabilities.json` | 57 rows: qualified, read-qualified, discovered, unavailable-by-choice, unavailable-on-platform |

## Adding a supported build

1. Install the candidate engine.
2. Run `node tools/spike/qualify-capabilities.mjs` and the P01 contract probe against it.
3. Update the pinned version/commit in the adapter's compatibility context and the ledger.
4. Re-run `npm test`, the live probes, and record the evidence artifact.
5. Only then change the status text a surface displays.

A build is never declared compatible because it "looks similar". The qualification record must
name the version, the commit, the routes exercised and the date.

## What drift means for you

On an unqualified build Mona still opens, still shows your projects, drafts, history and costs,
and still refuses to pretend: the top bar and the provider workbench show the drift, and
submission explains why it is held back. Nothing is auto-downgraded, and no fallback provider or
model is contacted.
