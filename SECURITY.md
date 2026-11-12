# Security policy

## Reporting a vulnerability

Mona has **no public repository, no public issue tracker and no security inbox** at this time,
so there is no address to publish here. Report findings directly to the project owner through
the private channel you already use for this project. Do not open a public issue, and do not
attach secrets, credential files or private transcripts to any report.

There is no PGP key configured for this project, so do not claim encrypted delivery that does
not exist. If a report will contain credential material, say so first and agree on a channel
before sending it.

Please include: the Mona version and commit, the Windows build, the engine version and commit,
what you did, what you observed, and the smallest reproduction you have. A saved diagnostics
preview (Settings → Diagnostics) is redacted and is usually enough context.

## Supported versions

Only the current release candidate is supported. This is a local, per-user Windows build.

## Scope

In scope:

- The renderer boundary: sandbox, context isolation, preload surface, IPC validation, CSP.
- Credential handling: anything that could expose a provider key or engine token to the
  renderer, a log, an export, a notification or the lock screen.
- Path handling: Explorer launch arguments, project-relative references, diff paths, import
  paths, terminal paths.
- Local state: database writes, migrations, backups, restores, portable bundles, prompt packs.
- The installed program tree and the per-user registry surface the installer owns.

Out of scope:

- The Codewhale engine itself (report to its publisher).
- The provider API and your account (report to DeepSeek).
- Vulnerabilities that require you to run untrusted code with your own account's full rights
  outside Mona's process.
- Physical access to an unlocked machine.

## What Mona already enforces

- Renderer: `contextIsolation` on, `nodeIntegration` off, sandboxed, no remote content, CSP with
  `connect-src 'none'` in production, navigation and popups denied, permission requests denied.
- Preload: one frozen object of named methods; no generic `invoke`, no channel names from the
  renderer, no Node modules.
- IPC: every handled channel checks the sender frame before parsing the payload, then validates
  with Zod. One audit test asserts that all channels refuse an untrusted sender.
- Runtime: the engine is reached only from the main process over loopback with a bearer token
  that is never placed in argv or in a log; a runtime Mona did not start is read-only.
- Local state: single write path with revision checks; migrations are checksummed and
  fail-closed; pre-migration backups are verified.
- Redaction: diagnostics previews redact the home path and credentials; terminal clipboard is a
  narrow channel; lock-screen payloads carry no project detail.

The evidence for these claims, including the boundary review and its residual risks, is
`docs/evidence/P20-security-review.md` and `docs/evidence/P20-failure-matrix.md`.

## Known limitations

- Codewhale reports that its own sandbox is unavailable on the reference host, so Mona's
  boundary is process, IPC and content based, not OS-sandbox based.
- The Windows 11 identity package is test-signed. Installing a test certificate into a trust
  store is a deliberate, interactive decision; the installer never does it silently.
- Mona runs with the rights of your Windows account. Under Full Access, the engine's tools have
  the same rights. That is the product's stated posture, not a defect.
