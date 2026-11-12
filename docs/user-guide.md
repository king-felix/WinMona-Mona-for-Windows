# Mona user guide

This guide describes Mona as built and measured for the 0.1.0 release candidate. Where
something is not verified, it says so. Every screen named here exists in the shipped build.

## 1. Install

Prerequisites: Windows 11 x64, an installed Codewhale engine, and a provider configured in
Codewhale. Mona does not need, ask for, or store a provider key.

```powershell
npm ci
npm run build
node tools/install/cli.mjs stage
node tools/install/cli.mjs package --test-sign
node tools/install/cli.mjs install --smoke
```

What the installer does:

- Copies the program tree to `%LOCALAPPDATA%\Programs\Mona` (per user, no elevation).
- Registers the classic Explorer entry **Start new DS project with Mona** for folders and
  folder backgrounds, using the exact registered command line — no script strings are built.
- Writes a per-user uninstall entry (`Apps & features` → Mona).
- Attempts to register the Windows 11 modern menu identity package and **reports the result**.
  Windows refuses a test-signed package (`0x800B0109`) until the machine trusts the certificate;
  after the verified elevated `trust-test-certificate` step the package registers and the menu
  entry is declared for folders and folder backgrounds. It never imports a root certificate
  silently and never enables developer mode.
- Leaves `~/.codewhale`, your projects and any existing Codewhale installation untouched.

Exit codes: `0` success, `3` deferred (Mona is running with work in flight), `4` a prerequisite
is missing (payload, toolchain, trust).

## 2. First launch

Mona opens to Home. Pick a project folder, or create one. Nothing is sent anywhere on first
launch: the engine is not started until you ask for it, and the window makes no provider
request while idle.

The first run seeds the saved profile **DS Full Access** (provider `deepseek`, model
`deepseek-flash`, endpoint `https://api.deepseek.com`) once. That profile is a recorded
default for new threads; it is not a per-turn confirmation dialog.

If local state cannot be opened, Mona says so and stays usable offline: the catalog, drafts and
recorded history remain readable, and engine actions explain the failure rather than hang.

## 3. Existing credentials

Your credentials belong to Codewhale (`~/.codewhale`). Mona reads provider *identity and
presence* through the engine's own surfaces and shows the observed route; it never prints,
copies or stores a secret. If the engine reports a missing credential, Mona says that and
leaves the route unchanged instead of switching provider or model.

## 4. Launch a project from Explorer

Right-click a folder, or the background of an open folder, and choose **Start new DS project
with Mona**. On Windows 11 the entry sits in the modern menu when the identity package is
registered; otherwise it is under **Show more options** in the classic menu.

Mona validates the path, opens or reuses the existing project, selects the DS Full Access
profile, starts its own engine runtime, and puts the caret in the composer. It never sends a
task on your behalf. A second launch reuses the running window. Inaccessible folders, missing
paths, drive roots and UNC/WSL paths are explained instead of guessed; broad roots ask you to
choose a project rather than indexing a drive.

## 5. What Full Access means

Full Access is Codewhale's tool authority operating **inside your Windows account's rights**:

- It is not an elevation prompt and it does not bypass UAC, managed policy, missing credentials
  or OS file permissions.
- Mona runs as a normal desktop process.
- Mona displays the *observed* permission posture of the active thread separately from the
  saved default. If the runtime reports a different posture, both values are shown; nothing is
  widened silently.
- In **Plan** mode the engine plans; in **Work** mode it executes. The mode is explicit and is
  recorded per thread.

## 6. Assign a bounded prompt

Write the task in the composer (Ctrl+Enter sends). You can add project-relative file
references; they are composed into the prompt exactly as shown, and absolute, traversing or
control-character references are refused.

The prompt is submitted **once**. Mona records a submission journal record before sending, so a
lost response is reconciled instead of re-sent. While a turn runs, the control strip stays
visible: **Pause after task**, **Interrupt now**, and any blocked problem.

Plan completion is not task completion. Mona's work board requires evidence: a recorded test
receipt, an artifact with a matching hash, or a recorded human check.

## 7. Resume after closing or interrupting

- Closing the window keeps Mona in the tray while work runs, with a one-time explanation.
- Reopening reconnects to the same runtime and reconciles state.
- A full app or machine restart restores the last verified record and marks uncertain work
  interrupted. **Resume** means reconcile first, then continue — it never replays a tool call
  that may already have executed.
- Interrupting stops the engine's turn. Work already sent is not rolled back; the receipt says
  that plainly.

## 8. Costs

The Cost lens shows recorded usage with its pricing source. Rules the interface follows:

- Unknown is shown as unknown, never as zero.
- Cached and non-cached input tokens are reported as the engine reports them.
- Optional per-session, per-task or per-day budgets **warn** and **stop**; a stopped budget
  blocks the next submission, never a mid-flight turn.
- **Export CSV** writes the rows you can see, with their sources.
- Mona adds no inference of its own: idle, navigation, exports, reconnects, notification focus
  and studio replay cost nothing.

The measured real turn in this release was one 22-step task at **596 µUSD** on
`deepseek-flash`. Pricing changes upstream; the ledger records the rate revision it used.

## 9. Stopping work

- **Pause after task** finishes the current task, then holds the queue.
- **Interrupt now** asks the runtime to stop the active turn and records the outcome.
- **Stop engine** stops the runtime Mona owns (and only that one).
- **Quit and stop** (tray or Settings) stops the engine before exiting.
- A runtime Mona did not start is attached read-only and is never killed.

## 10. Blockers

A blocked problem shows the problem, its attempts, the evidence and the exact help needed.
Three consecutive attempts with no material progress block that problem; acknowledging the card
does not clear it or reset the count. Independent work stays eligible. A blocker is cleared
only with new evidence or a recorded decision.

## 11. Backups, restore and its limits

- Before any schema migration, Mona writes a verified backup of the database; migration failure
  rolls back and keeps the recovery files.
- **Memory → settings backup/restore** writes and restores a digest-checked settings envelope
  under an exclusive maintenance barrier, appending a new settings version.
- **Memory → portable export/import** moves a project's task/decision/evidence state as a
  digest-checked JSON envelope. It is not a ZIP and does not carry machine-local bindings.
- **Restore** from the change view is Git-based: it previews scope and conflicts, refuses when
  a file changed after the preview, when the path has staged changes, or when it is untracked.
  It restores to HEAD only. It is **not** a snapshot engine, and for a non-Git folder it says so
  instead of pretending.
- Deleting a project from the catalog never deletes a file. Neither does archiving, renaming or
  uninstalling.

## 12. Privacy

- No telemetry, no analytics endpoint, no remote content in the window.
- The renderer cannot reach the file system, the shell, or the network; it calls named,
  validated IPC methods, and the main process checks the sender frame first.
- Diagnostics previews redact your home path and credentials before you copy them.
- Lock-screen and notification payloads carry no project detail; quiet hours silence delivery,
  not computation.
- Conversation export writes exactly the recorded timeline to a file you choose; it calls no
  model.

## 13. Updates

`node tools/install/cli.mjs install` (or `upgrade`) replaces the program tree atomically and
leaves user data alone. If Mona is running:

- with work in flight, the installer **defers** (exit `3`) and changes nothing;
- idle, it closes and replaces only when you pass `--close-running`.

Explorer is never restarted by the installer. The current build has no automatic update channel;
checking for a newer Mona is a manual, local operation.

## 14. Uninstall

```powershell
node tools/install/cli.mjs uninstall
```

Removes the program files, the Mona registry keys, the classic menu registration and any
installer-created test certificate. It keeps your projects, `%LOCALAPPDATA%\Mona` data
(artifacts, backups, logs) and `~/.codewhale`. Remove those directories yourself only when you
intend to lose the history.

## 15. Known limits in 0.1.0

- The Windows 11 modern menu needs a trusted signing certificate; on this reference machine the
  verified elevated import is done and the package registers. A human right-click confirming the
  entry has not been recorded, so treat first appearance as unconfirmed.
- The screen-reader walkthrough and physical 200% scaling check are human-only and outstanding.
- Idle memory measured 370.5 MB across four processes (internal target 350 MB).
- Paint frame timing was not measured; the measurement window was not presented.
- Restore covers HEAD only; arbitrary-commit restore is not implemented.
- The engine's own terminal route is unavailable on Windows; Mona's own ConPTY terminal is used
  instead and reported separately.
