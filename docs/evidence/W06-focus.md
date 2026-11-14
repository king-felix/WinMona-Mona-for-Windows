# W06 — Focus Studio and native Windows fullscreen

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`
· Electron 45.3.0 / Chromium 140.0 / Node 26.13.1 (development build).

Status: **implementation and all offline checks complete; one observation is still open** — see
"Not yet observed".

Evidence:

- **Real Windows runtime** — `npm run focus`, 15 steps, 4 screenshots
  (`docs/evidence/W06-focus.json`, log, `docs/evidence/shots-w06/`). No runtime is started and no
  prompt is accepted: 0 provider requests.
- **Fixture** — `window-state.test.ts` (5 tests: observed state, no double transition, sender and
  payload validation, native transition push, F11 ownership) and the Focus/fullscreen composer tests
  in `StudioPanel.test.tsx`.

## What changed

**The window's fullscreen is the window's.** A new narrow boundary
(`mona:window-state`, `mona:window-set-fullscreen`, `mona:window-event`) reports
`{ fullScreen, maximized, focused, width, height, normalWidth, normalHeight }` read from Electron's
own `isFullScreen()` / `isMaximized()` / bounds. The main process pushes the observed state on
`enter-full-screen`, `leave-full-screen`, `maximize`, `unmaximize`, `focus`, `blur`, `resize` and
`restore`. Asking for a state the window already has is a no-op, so a doubled click cannot produce a
double transition. Fullscreen is never persisted: a relaunch starts where the desktop put the window.

**F11 has exactly one owner.** There is no application menu (`Menu.setApplicationMenu(null)`), so F11
is handled in `webContents.before-input-event` — the window, not whichever editor or terminal has
focus — and the renderer has no F11 handler. A modified F11 (Alt/Ctrl/Meta) is ignored. The button in
the Studio control strip calls the same main-process operation.

**Focus Studio fills the content area.** In Focus the shell hides the topbar and the section rail via
CSS (nothing is unmounted), the workspace and studio region become a full-height single column, and
the conversation takes the remaining height with a 45 vh floor. The Studio's own control strip keeps
everything the prompt requires: **Exit focus**, **Full screen**, Interrupt now, the pause control, the
connection control, permission, model, an elapsed-time readout derived from the recorded turn start,
and the Needs-the-Human/blocked cards. The exit is also the topbar toggle in normal mode.

**Composer sizing.** The fixed transcript/composer heights are gone: the transcript is the flexible
row, and the composer has a drag handle (`role="separator"`, focusable, arrow keys move it 24 px at a
time) with a 72–360 px range clamped in code and remembered per project in `localStorage`. Focus
changes never force fullscreen and never change the composer size.

**Escape priority.** Escape closes the open catalog drawer first; inside the composer it stays with
the composer (closing the command list, never interrupting); on the page it leaves Focus; it never
sends Interrupt. The transcript's Escape returns the caret to the composer in normal mode and lets
the shell leave Focus in Focus mode.

**Scroll anchor across transitions.** Focus and fullscreen both change the shell height, and the
browser was clamping the transcript to the top when that happened. The panel now captures the stored
row at the top of the viewport (`data-seq`) before the transition and re-applies it over the next
several frames, so the reader keeps their place. This was found by the probe, not assumed: the first
run lost the anchor (`topSeq 322 → 281`) and the layout showed the transcript collapsed to 12 px.

## Verification

```text
npx vitest run apps/desktop/src/main/window-state.test.ts        # 5 passed
npx vitest run apps/desktop/src/renderer/StudioPanel.test.tsx    # 34 passed
npx vitest run apps/desktop/src/renderer/App.test.tsx            # 28 passed
npm run ci                                                       # exit 0
npm run focus                                                    # 15 real-window steps passed
```

Real Windows runtime (`docs/evidence/W06-focus.json`):

```text
PASS the window starts normal, not full screen        1280×688, not maximized
PASS Focus fills the window and keeps exit, context and interrupt
     topbar hidden, rail hidden, Exit focus and Interrupt now both visible
PASS Focus keeps the draft, the caret and the scroll anchor
     topSeq 322 → 322 (scrollTop 5775 → 5730 after the resize)
PASS the native window reports full screen            isFullScreen() === true
PASS full screen keeps the draft, caret, scroll anchor and Focus
     timeline clientHeight 336, scrollHeight 16 499, anchor row 322 held
PASS F11 leaves full screen exactly once / re-enters
PASS an open drawer survives leaving full screen
PASS minimize and restore keep the window usable
PASS Escape in the composer does not leave Focus
PASS Escape from the page leaves Focus
PASS the window is not left in full screen, and the draft survived every transition
```

Screenshots: `focus-01-normal.png`, `focus-02-focus.png`, `focus-03-fullscreen.png`,
`focus-04-exited.png`.

## Not yet observed

The checkpoint asks for these transitions "while streaming, typing, scrolled back, answering input
and opening drawers". Typing, scrolled back and an open drawer were exercised in the real window. The
**streaming** and **answering-input** variants need a live paid turn, which this session was not
authorized to start, so they are **not claimed**. What is established instead:

- the transitions make no engine call at all (`providerRequests: 0`; the only IPC used is the window
  state boundary and the layout preference), so nothing about the runtime or its subscription is
  touched by Focus or fullscreen;
- the recorded draft, caret and scroll anchor survive every transition, and the run-state readout is
  driven by the studio's own state, not re-created.

The missing observation is recorded as the open acceptance item on W06 in the review ledger and must
be repeated with a live turn (one bounded prompt) before W06 is signed off; W7 and later depend on it.

Physical 200 % display scaling and Narrator behaviour are W20's human checks. The packaged candidate
is W24's.
