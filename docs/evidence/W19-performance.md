# W19 — Memory and performance on the installed candidate

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 · AMD Ryzen 7 5800X, 16 logical cores, 32 GB ·
Electron 45.3.0 · installed `Mona.exe` (staged hash recorded in `W12-icons.json`) · engine
`codewhale 0.10.2 (ff466b2ed0bf)` measured separately.

Status: **measured; no app-level defect found; the under-350-MiB idle target is still missed.**
W19's engineering work is done and the evidence is honest about the miss. The performance
criterion stays open (D-0104 target unchanged, D-0111 exception unchanged).

Evidence files:

- `W19-memory-before.json` — installed candidate before this pass, 60 s idle, no history
  (353.8 MiB final, 362.4 MiB average).
- `W19-memory-after-idle.json` — rebuilt candidate, same 60 s idle-only workload
  (352.5 MiB final, 360.1 MiB average) — the like-for-like regression comparison.
- `W19-history-before.json` — pre-pass candidate, 20,000 stored timeline rows.
- `W19-memory-after.json` — rebuilt candidate, 20,000 rows, 60 s idle, plus view churn,
  two-project switching and the terminal drawer.
- `W19-qa.json` — `npm run qa` against the installed artifact: cold/warm startup, idle CPU,
  memory, 20,000-row history render and typing.

## Units and the 406.4 MB figure, reconciled before comparing

The metric is the **sum of `workingSetSize` across `app.getAppMetrics()`** — the same metric P22
and P23 used. The probe labels it `Mb` but divides KiB by 1024, so its unit is **MiB**. The engine
is a separate process and is reported separately (`engineMb`).

- If the reported **406.4** was in this probe's MiB unit, today's same-metric readings are
  **374.6 MiB** (memory probe, 20k rows) and **400.6 MiB** (QA workload), i.e. 5.8–31.8 MiB lower.
- If it was decimal MB, 406.4 MB = 387.6 MiB, so today is 13 MiB lower in the probe workload and
  13 MiB higher in the QA workload.

Either reading leaves both figures **above the 350 MiB target** (350 MiB = 367.0 MB decimal). The
target was not quietly changed, and "MB" is not used as a rounding convenience.

## Measured state (installed artifact)

- **Idle memory, like-for-like (60 s, no history):** before 353.8 MiB final / 362.4 MiB average;
  after 352.5 MiB final / 360.1 MiB average (4 processes: Browser 111.1, GPU 100.6, Utility 51.2,
  Tab 89.6). A 1.3 MiB final / 2.3 MiB average difference, i.e. unchanged within noise. **Miss**
  the 350 MiB target by 2.5 MiB final / 10.1 MiB average.
- **Idle memory with 20,000 rows (memory probe, 60 s):** 374.6 MiB final, 387.8 MiB average over
  11 samples. Renderer JS heap 4.2 MiB, DOM 4,954 nodes, 315 listeners. **Miss.**
- **Idle memory (QA, 20k-row session):** 400.6 MiB across 4 processes. Engine 303.1 MiB separately.
  **Miss.**
- **Idle CPU:** 0.03–0.06 % average, 0.15–0.25 % max over 60 s. **Pass** (target < 1 %).
- **Startup (QA, installed artifact):** cold 529 ms, warm 1,679 ms. **Pass** against 5,000 / 2,000
  ms. Scope caveat: this is spawn → `document.readyState=complete` on this machine, not a packaged
  cold-boot benchmark with disks cold; W24 owns the release timing claim.
- **Long history (20,000 rows):** 500 rows loaded, 120 rendered; paged query median 1 ms; frame
  median/p95 16.7/16.8 ms (60 fps); typing p95 0.1 ms. **Pass** for interaction.
- **Changes diff:** 4,000-line diff render +2.4 MiB working set; leaving the panel removes every
  `.diff-line` node and returns within ~5 MiB of the pre-diff total.
- **View churn (5 studio↔changes rounds):** +0 DOM nodes, +0 listeners, +0.0 MiB JS heap
  (+3.4 MiB working set noise in the idle run, −18.4 MiB in the 20k run — no direction).
- **Project switching (2 real projects, 4 switches):** +0 DOM, +0.0 MiB heap, total working set
  flat within noise (−0.7 / −2.3 MiB).
- **Terminal drawer:** opens (lazy chunk), +29.4 MiB working set while open, +1.2 MiB heap, 82 extra
  DOM nodes; closes and releases the drawer DOM (nodes +3, listeners +3). ~24 MiB working set and
  1.0 MiB heap remain after close. That is the retained xterm chunk plus allocator/canvas pages for
  a session the product deliberately keeps alive (bounded by `TERMINAL_LIMITS`); it did not grow
  across repeated opens in the churn scene.

## Profiles and what they showed

No GPU hardware is available to this VM (`gpuCompositing: disabled_software`,
`direct_rendering_display_compositor: disabled_off_ok`), so the GPU process is a ~100 MiB software
rasteriser. That is machine state, not app code, and it is the largest single block. The renderer's
JavaScript heap is 4.2 MiB with 4,954 DOM nodes — there is no retained history, no growing listener
list, no duplicate panel state, and the terminal chunk is already lazily loaded (`TerminalDrawer-*.js`
is a separate 372 KB chunk, absent from the 496 KB initial bundle).

The application-level memory that could be reduced is therefore on the order of single-digit MiB,
while the miss is ~25–50 MiB depending on the workload. Removing it would mean removing Chromium
processes (no history, no isolation), disabling rendering paths, or swapping the runtime — all
prohibited by S07, and all worse than the miss.

## Practical remaining options (for an explicit decision, not done here)

- Accept the measured state as a documented release exception (D-0111 does this for 0.1.0) and
  keep the criterion open.
- Re-measure on hardware with a functioning GPU: the GPU process drops out of software rasterisation
  and the reference-machine number changes; the target then depends on a different machine class.
- Reduce Electron's process baseline (older/major-version pin, `--process-per-site`) only with a
  demonstrated, feature-preserving measurement on this same workload — not as a blind change.
- A dedicated small window with fewer panels would not help: the renderer JS heap is already 4 MiB
  and the main cost is per-process Chromium overhead, not application data.

## Instrumentation fix made on the way

The memory probe used to report the render-window experiment as failed when no history workload was
requested (it measured 0/0 rows). That made every idle-only run exit non-zero for a scene that never
ran. The scene is now explicitly "not requested"; the product is unchanged, and the idle-only run
above is green with all 12 steps passing.

## Regression checks

`npm run typecheck`, the project-state suite (169 tests incl. 15 runner tests), the desktop build and
the installed QA run all pass on the measured candidate. No feature, accessibility path or inference
behaviour changed in this pass: the probe makes no provider request, starts no turn, and the engine
figure is reported separately.
