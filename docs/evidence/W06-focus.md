# W06 — Focus Studio and native Windows fullscreen

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · engine `codewhale 0.10.2 (ff466b2ed0bf)`
· Electron 45.3.0 / Chromium 140.0 / Node 26.13.1 (development build).

Status: **complete.** The offline transitions were observed first (`npm run focus`, no runtime), then
repeated with `npm run focus:live` during one bounded paid turn on the configured route.

Evidence:

- **Real Windows runtime** — `npm run focus`, 15 steps, 4 screenshots
  (`docs/evidence/W06-focus.json`, log, `docs/evidence/shots-w06/`). No runtime is started and no
  prompt is accepted: 0 provider requests.
- **Real Windows runtime with a live streaming turn** — `npm run focus:live`, 21 steps, 4 screenshots
  (`docs/evidence/W06-focus-live.json`). One bounded prompt, `$0.0006`, one recorded turn.
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
npm run focus:live                                               # 21 real-window steps, one paid turn, $0.0006
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

The checkpoint asked for these transitions "while streaming, typing, scrolled back, answering input
and opening drawers". All of them except **answering input** are now observed, and the missing one is
not explainable by a paid turn:

- **Streaming, typing, scrolled back, drawer open** — `npm run focus:live` submits **one** bounded
  prompt through the real composer on the configured `deepseek`/`deepseek-flash` route and then
  repeats Focus, native fullscreen, F11 out/in, a Term drawer held across a transition and
  minimize/restore. The probe waits for the runtime's first streamed frame before it touches the
  window, so the transitions overlap actual work rather than the model's thinking gap:

```text
PASS the runtime has begun producing output for this turn
PASS Focus during streaming keeps the draft, caret, scroll anchor and the live turn
     runState running, draft kept, caret 14, topSeq 216 -> 216, deltas 0 -> 1
PASS fullscreen during streaming keeps the draft, caret, anchor and the live turn
PASS F11 leaves and re-enters full screen once each while the turn streams
PASS a drawer stays open across leaving fullscreen during streaming
PASS minimize and restore keep the streaming turn and the window usable
PASS the thread identity never changed across the transitions   thr_5339fd18... -> same
PASS exactly one turn was recorded for this project            turnCount 1, $0.0006
PASS runtime work arrived inside the transition windows         deltas 0,1,1,1,4,4
```

  Every transition was sampled while `runState` was `running`; the work-arrival windows are recorded
  per transition in `windows[]` of the report, including the windows that gained nothing, so the
  claim is limited to what was seen. No engine remount happened: the same thread id held before,
  during and after, the run state stayed `running` throughout, and the runtime was never restarted.
- **Answering input** is **not** claimed here. A real pending approval/clarification reply is the
  subject of W08; there is no reply channel in this build (`approvalResponse: unsupported`), so no
  probe can produce that state yet. W08 will exercise Focus/fullscreen across a real pending request,
  and W09 the queue/steering surfaces.

A second, cheaper guarantee stands on its own: the transitions make no engine call at all
(`providerRequests: 0` in the offline run; the live run used only the one submitted turn), so nothing
about the runtime or its subscription is touched by Focus or fullscreen.

One artefact worth recording: closing the Term drawer and then quitting prints a `node-pty`
`AttachConsole failed` trace from the ConPTY helper at teardown. The app still exits 0 and the P18
terminal probe still passes 18/18; this is teardown noise from the helper, not a transition defect,
and it is left as-is rather than silenced.

Physical 200 % display scaling and Narrator behaviour are W20's human checks. The packaged candidate
is W24's.
