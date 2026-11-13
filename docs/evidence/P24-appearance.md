# P24 — the Inspector yields, and Ctrl +/−/0 scales the window

**Date:** 2026-11-12. **Machine:** Windows 11 Pro 10.0.26200, Ryzen 7 5800X, 32 GB, x64, on a TV.
**Engine:** Codewhale `0.10.2 (ff466b2ed0bf)` — untouched; **0 µUSD**, no provider request.
**Requested:** the Inspector out of the way so the agent timeline gets the space; Ctrl with
<kbd>+</kbd>/<kbd>−</kbd> to change the size of everything, with the layout floating correctly.

## 1. Inspector — collapsed by default, one labelled control

`.workspace` was `minmax(0,1fr) 300px`; the Inspector owned a fixed column whether or not its
reference facts were being read. It now collapses to a 32 px rail carrying a vertical
**‹ Inspector** button, and the panel itself carries **Hide**.

Measured live (appearance probe, `studio-inspector-*` screenshots):

| State | Timeline column width |
|---|---|
| Inspector collapsed (default) | **933 px** |
| Inspector open | **665–680 px** |

So the conversation/agent surface gains **253–268 px** of width, and closing it returns exactly
the width it took (`restored: 933`). The choice is stored in `localStorage` under
`mona.inspector` — presentation only, so it needs no schema migration and cannot corrupt state.
Focus Mode still hides the panel and restores the saved choice when you leave it.

## 2. Window scale — Ctrl +/−/0

Applied with `webContents.setZoomFactor()` in the **main process**, on a fixed ladder:

`50, 60, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200` %.

- <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>=</kbd> / numpad-+ → one rung up
- <kbd>Ctrl</kbd>+<kbd>−</kbd> / numpad-− → one rung down
- <kbd>Ctrl</kbd>+<kbd>0</kbd> → 100 %

Why the main process: the shortcut must work wherever focus is (a textarea, the command palette,
the terminal's xterm instance), and window scale is a property of the web contents. Scaling the
whole contents means every panel reflows together, which is the "float appropriately" part of the
request: nothing grows while its neighbours stay fixed.

Delivery: three validated IPC channels (`mona:appearance-get`, `mona:appearance-zoom`,
`mona:appearance-event`), sender-checked like every other channel and covered by the existing IPC
audit. The renderer may request a **direction**, never an arbitrary number. Persistence is
`state/appearance.json` next to the other UI preferences, so a scale chosen for a TV survives a
restart; it is isolated per profile, so probes never touch the real one.

Status bar: **−  100%  +**, where the percentage is also the reset control. A rung at either end
disables that button rather than silently accepting and clamping it.

## 3. A defect found by measuring, not by looking

At 150 % the first capture showed the studio card painting **over** the status bar: `.layout` had
no bounded row, so the scroll region grew past the shell instead of scrolling inside it. Fixed by
giving `.layout` `grid-template-rows: minmax(0, 1fr)` and `overflow: hidden`. The probe now
asserts `studio-region.bottom <= statusbar.top` at a raised scale (`overlap: 0`), so the fix
cannot silently regress.

## 4. Live verification

`npm run appearance` drives the real window (development build and the installed candidate):

```text
PASS a real project opens through the catalog
PASS the studio timeline is on screen
PASS the Inspector is closed by default :: {"collapsedWorkspace":"workspace inspector-collapsed","railPresent":true}
PASS a labelled control reopens it
PASS the collapsed state is the layout class, not a hidden panel
PASS the timeline column is captured while collapsed :: {"narrow":933}
PASS the Inspector opens from the rail :: {"timelineWidthCollapsed":933,"timelineWidthOpen":680}
PASS opening it costs the timeline width, so closing it really gives space back
PASS the open Inspector is captured
PASS the Inspector closes again and the width returns :: {"restored":933,"narrow":933}
PASS Ctrl+= makes everything larger :: {"startZoom":1,"afterPlus":1.1}
PASS the status bar reports the applied scale, not an intention :: {"label":"110%"}
PASS Ctrl+- makes everything smaller :: {"afterPlus":1.1,"afterMinus":1}
PASS at a larger scale the page has no horizontal overflow :: {"zoom":1.5,"overflow":0,"composer":544,"strip":81,"overlap":0}
PASS the work area ends above the status bar instead of painting over it :: {"overlap":0}
PASS the composer is still laid out at a larger scale
PASS the larger scale is captured
PASS Ctrl+0 returns to 100% :: {"reset":1}
PASS the chosen scale is persisted beside the other UI preferences
P24 appearance probe: 19 steps passed, 3 screenshots
```

The keys are pressed through `webContents.sendInputEvent`, so the **main-process handler** is what
passes, not a stubbed callback. Screenshots: `docs/evidence/shots-p24/` (development build) and
`shots-p24-installed/` (installed candidate).

Evidence files: `P24-appearance.json` (development), `P24-appearance-installed.json` (installed),
`P24-package.json`, `P24-install.json`, plus their logs.

## 5. Gates and artifact

| Check | Result |
|---|---|
| `npm run ci` | exit 0 — Prettier, ESLint, typecheck (5 workspaces), **558 Vitest in 68 files**, 14 bootstrap, 12 launch, 26 install, 8 spike, production build |
| `npm run a11y` (development) | **12/12** after the layout change, including no horizontal overflow at 200 % zoom |
| `npm run appearance` (dev / installed) | **19/19** each |
| `install --force` | 1,681 files, 0 checksum problems, package `Status: Ok` |
| `verify --smoke` | exit 0, installed app renders at 0.1.0 |

Artifact: payload **1,681 files / 452,756,367 bytes**; `Mona-0.1.0-x64.msix` 127,928 bytes,
sha256 `8c815f83e830b28937fe615fb1fa1e11e37b4cc61c15ada9d68e841a4839abc2`, test-signed, trusted
chain on this machine only.

## 6. What the user still decides

- Whether 100 % is the right default for this TV. The ladder makes a smaller scale one keypress
  away and remembers it; no default was changed on a guess.
- Nothing else here touches the route, the model, credentials, permissions or recorded data.
