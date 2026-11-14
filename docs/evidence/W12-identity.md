# W12 — The approved Mona mark, all the way into the executable

Captured 2026-11-14 · Windows 11 Pro 10.0.26200 (x64) · Electron 45.3.0 · source `960e00c` + this
change set.

Status: **complete for the engineering work.** The artwork, the deterministic pipeline, the
package images and the window/tray surfaces already existed. Two real defects sat underneath them:

1. **The committed `mona.ico` was not a valid Windows icon.** `tools/assets/build-icons.mjs`
   encoded the ICO container big-endian. Read as Windows reads it, the file claimed type 256 with
   1792 directory entries, and Electron's `nativeImage` returned an **empty image** — so the
   window/taskbar icon had been silently absent. The pipeline's own test read the same file
   big-endian, so it agreed with the bug.
2. **`Mona.exe` still carried Electron's icon.** The installer renamed `electron.exe`; nothing
   replaced the PE resource group that Explorer, Task Manager and the unpinned taskbar read. The
   brand README recorded this as a known limitation.

Evidence files: `W12-icons.json` (measurements, hashes, verifications) and this note.

## What changed

- `tools/assets/build-icons.mjs` — ICO container written little-endian; `pipeline_version` 2.
  The ICO comment now states why, so the next editor does not "fix" it back.
- `tools/assets/embed-exe-icon.mjs` — new deterministic PE resource rewriter:
  parses the resource tree, replaces `RT_ICON` (7 images) and `RT_GROUP_ICON`, preserves every
  other resource byte-for-byte, keeps the resource RVA, moves `.reloc` past the grown section,
  updates `SizeOfImage` and the resource/relocation data directories. Refuses a signed input
  (Electron's binary is unsigned, so nothing is invalidated). `--verify` reads the result back
  through the same parser; the installer uses the verifying write path.
- `tools/install/installer.mjs` — staging embeds the artwork into `Mona.exe` immediately after the
  rename and fails the stage if the embedded bytes do not verify.
- `tests/assets/icon-pipeline.test.mjs` — reads ICO fields little-endian, like Windows.
- `tests/assets/exe-icon.test.mjs` — new: real `electron.exe` fixture proves the group is replaced,
  types 1/12/16/24 are preserved byte-for-byte, `.rsrc`/`.reloc` stay disjoint and aligned, a
  re-embed is byte-identical, and an unpatched runtime is reported as not carrying the artwork.
- `assets/brand/README.md` — records the endianness defect, the embedding pipeline and the
  verification; the "embedded icon is still Electron's" limitation is removed because it is false
  now.

## Verification — what was observed, and how

**Fixtures / unit (`node --test tests/assets`, 17 pass, 0 skip):** ICO structure and entry order;
byte-stability of the generated files; resource replacement and preservation on the real runtime
binary; idempotent re-embed; unpatched-runtime detection.

**Real Windows runtime, installed bytes:**

- `build/install-stage/Mona.exe` → installed to `%LOCALAPPDATA%\Programs\Mona\Mona.exe`;
  installed hash equals the staged hash (`W12-icons.json`).
- `node tools/assets/embed-exe-icon.mjs <installed Mona.exe> --verify` → `ok: true`, seven images,
  16…256 px, each payload byte-identical to `mona.ico`.
- Windows `ExtractIconEx` on the installed executable returns 16 px and 32 px bitmaps whose RGBA
  bytes match `mona-16.png` / `mona-32.png` exactly — mean and maximum channel difference 0, no
  white matte, no stretch.
- Electron `nativeImage.createFromPath(mona.ico)` now decodes at 256 px; the previous committed
  file decodes as empty. This is the readout that shows the window-icon path is actually alive
  again.
- Start menu: `Get-StartApps` reports `Mona` → `MonaWorkbench_beqf7zj0yys3p!Mona`; the uninstall
  entry's `DisplayIcon` is the installed `Mona.exe`. Package identity (`MonaWorkbench`, publisher
  `CN=Mona Development`) is unchanged — no rename was used to defeat icon caching.
- Upgrade path: the same package identity was reinstalled over the existing 0.1.0 registration.

## Not verified here (kept honest)

- **Physical high-DPI icon selection** (100 %/200 %/mixed-DPI taskbar and Start tile rendering) is a
  human observation on real hardware; this session's display is a 1365×720 virtual desktop. The
  256/128/64 px payloads are present and byte-exact, so the shell has correct images to choose
  from — that is not the same as having watched it choose them. Tracked under W20.
- **16 px legibility** is a judgement, unchanged: the ribbon collapses into the tile at that size.
  This remains recorded as open artwork work, not silently "fixed".
- A screenshot of the taskbar was attempted; GDI screen capture on this virtual display returned
  garbage (uniform gradient, no shell). The extraction and package evidence above stand in its
  place rather than being described as a visual pass.
