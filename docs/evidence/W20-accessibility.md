# W20 — Windows accessibility: automated pass, UIA exposure, and the human checklist

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · installed `Mona.exe` (W12 stage) · display
`\\\\.\\DISPLAY1` 4096×2160 at **Windows scaling 300 %** (`AppliedDPI = 288`), one monitor.

Status: **automated pass complete and one real defect fixed; Narrator and the remaining human
observations are still open.** No claim is made that Narrator passed.

Evidence: `W20-a11y-installed.json` (12-step probe, all pass), `W20-uia.json` (Windows UI Automation
tree), `W20-a11y-memory.json` (cost of enabling accessibility), this checklist.

## The defect that was found and fixed

A plain Windows UI Automation query on the installed build exposed **9 stub elements** — one `Pane`
named “Mona” and nothing else. Chromium had not built its accessibility tree because it did not
believe an assistive client was present. With `--force-renderer-accessibility` the same query
returned 74 elements with real names and roles, which confirmed the tree was there but switched off.

`main.ts` now calls `app.setAccessibilitySupportEnabled(true)` on Windows after `app.whenReady()`.
The unforced UIA query now returns the same 74-element tree: `Document` (RootWebArea), `Edit`
“Search projects”, `Button` for every rail section, `CheckBox` “Show archived”, status text, and so
on (`W20-uia.json`).

Cost, measured rather than assumed: idle working set rose from 352.5 to 358.0 MiB (average 360.1 →
368.2 MiB) with the same 60 s workload and the same 4 processes; renderer heap 3.0 → 3.1 MiB
(`W20-a11y-memory.json`). That is the price of exposing the tree at all times and it is recorded;
the W19 target miss is unchanged and no memory claim improved.

## Automated checks (real installed window, all 12 pass)

- Composer is a labelled `textarea` (“Prompt for …”); `#draft` is addressable.
- Execution controls carry names; `Interrupt now` is honestly disabled while idle.
- The timeline is a `role=log` / `aria-live=polite` region.
- A dialog opens from the keyboard (`?`), has an accessible name, takes focus, traps Tab at the
  end, closes on Escape and returns focus to its opener.
- The older-items control is keyboard reachable and reveals 120 → 240 rows (bounded paging).
- The diff region is focusable, scrolls to its tail, and keeps a bounded row count.
- At 200 % **browser zoom** there is no horizontal overflow and the composer stays laid out. This
  is supplementary evidence; it is not the operating-system scaling test.
- Zero provider requests during the pass.

`packages/ui/src/contrast.test.ts` keeps the measured token contrast ratios (ink on surface ≥ 7,
Afterglow ink ≥ 7, and the coral-on-white rule) — that part is a unit audit, not a human contrast
theme check.

## Real OS scaling that was actually observed

The session runs at **300 % Windows scaling**, not browser zoom. At that setting the UIA tree is
complete, the window is 1,365×720 logical pixels on a 4,096×2,160 display, and the shell renders its
Home surface with every rail control reachable. What is *not* covered at that scale: Studio with a
live turn, dialogs and drawers, the terminal, and the composer at long text — those are in the
checklist below. No display-scale setting was changed by this pass.

## Checklist for a person (needs the human)

1. **Narrator walkthrough** — start Narrator, open a project, and walk Home → Studio → command
   suggestions → Focus/fullscreen → Work/Changes → Settings. Expect each control named once, status
   changes announced at turn/tool boundaries (not per token), dialogs announced and focus restored.
   *Current state:* automated evidence only; Narrator has not been run against this build.
2. **Physical 200 % scaling** — set Settings → Display → Scale to 200 %, restart Mona if offered,
   and repeat the Studio, dialog, terminal and composer checks. *Current state:* 300 % is the
   machine's setting; an exact 200 % pass has not been observed.
3. **Mixed-DPI monitors and display removal** — move the window between different-DPI monitors and
   disconnect/reconnect a display when hardware allows. *Current state:* one virtual monitor.
4. **Text size enlargement** — Settings → Accessibility → Text size above 100 %, check the HUD,
   composer and dialogs without clipping. *Current state:* not observed.
5. **Contrast theme** — enable a Windows contrast theme, confirm text, focus rings, selected rail
   items and the diff remain distinguishable. *Current state:* no forced-colours rules exist in the
   stylesheets; the token contrast audit covers the normal themes only.
6. **IME composition** — type with a physical IME in the composer and press Ctrl+Enter during
   composition; the composition must finish and submit once, not mid-composition. *Current state:*
   Chromium cannot be driven into composing state; keyboard smoke covers Ctrl+Enter only.
7. **Prompt Runner and Needs the Human surfaces** — not built yet (W16/W17). Their keyboard,
   Narrator and 200 % checks are owed when those surfaces exist; this prompt cannot qualify them
   by looking at today's UI.

Escaped defects from this pass: none beyond the accessibility-tree exposure above; every automated
step passed before and after the change.
