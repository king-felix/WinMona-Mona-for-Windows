# Memory deviation — accepted for 0.1.0, target unchanged

**Date:** 2026-11-12. **Recorded because Victor accepted the compromise after the measurement;
it is a decision, not a measurement.**

## What was measured

Idle memory, the same metric P22 recorded (sum of `workingSetSize` across `app.getAppMetrics()`,
60 s idle, 20,000 seeded timeline rows, 120 of 500 rendered), on the installed 0.1.0 candidate:

| Run | Idle total | Average | Notes |
|---|---|---|---|
| `P23-memory-installed.json` | 371.4 MB | — | first windowed build |
| `P23-memory-installed-2.json` | 370.5 MB | 382.5 MB | 11 samples, CPU 0.01 %, renderer heap 3.3 MB / 2,497 nodes |
| Earlier P23 runs | up to 377.1 MB | — | same workload |

Baseline before windowing was 404 MB (P22), reproduced at 404.0–404.4 MB. The windowed timeline
was worth −32.6 MB; expanding 120 → 500 rendered rows costs +28.5 MB, which is why the window
exists.

Budget: **350 MB** internal target. Measured: **370.5–377.1 MB**. Unmet by ~20 MB.

## What Victor decided

On 2026-11-12 Victor accepted the recorded deviation for the 0.1.0 candidate. In practice:

- the 350 MB target is **not** changed, and no document may say the budget is met;
- MONA-028's `performance` criterion is **not** upgraded to passed by this decision — it carries
  the measured numbers and stays `partial`;
- MONA-028's `human-qa` criterion is unaffected: Narrator and physical 200 % scaling are still
  outstanding, so the requirement stays `partial` regardless;
- the next evidence-led memory step (`P23-followup.md` §2.7) is **not** authorized; it stays
  available if the deviation ever needs to be closed rather than accepted.

## What this does not license

- It does not permit moving the target to the measurement.
- It does not permit dropping the windowed timeline or any feature to reach 350 MB.
- It does not make a 1.0-complete claim.

Recorded in `.mona/build/DECISIONS.md` as D-0111.
