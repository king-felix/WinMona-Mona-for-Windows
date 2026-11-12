# Human checklist — P23 release candidate

Five items need a person. Nothing here has been checked by an automated tool, and none is
recorded as passed. Fill in the result column; each row is one observation.

Prerequisite for item 1 only: an elevated PowerShell and the exact command in
`docs/evidence/P23-followup.md` §1.3.

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 1a | Trust the certificate | Elevated PowerShell: `Import-Certificate -FilePath 'C:\Users\victo\AppData\Local\Mona\artifacts\Mona-test-signing-0.1.0.cer' -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'` then `node 'X:\AI_projects\Mona\tools\install\cli.mjs' trust-test-certificate` | Second command reports `added: true` (or `alreadyPresent: true`) with thumbprint `5C0AD0…4C95` | ☐ |
| 1b | Package registers | `node tools/install/cli.mjs install --force` | `identity.registered: true`, no `0x800B0109` | ☐ |
| 1c | Modern entry appears on a folder | Right-click any folder in Explorer | **Start new DS project with Mona** in the Windows 11 menu (not under *Show more options*) | ☐ |
| 1d | Modern entry appears on a folder background | Open a folder, right-click empty space | Same entry, same menu | ☐ |
| 1e | Correct folder is used | Choose the entry on folder `A`, then repeat on folder `B` | Mona opens/focuses the same running window each time and shows `A`, then `B` — never a parent, never a stale folder | ☐ |
| 1f | Repeat invocation is safe | Choose the entry on the same folder three times | One window, one project, composer focused, **no task sent** | ☐ |
| 1g | Uninstall cleanup | `node tools/install/cli.mjs uninstall` | Menu entry gone from both places; program removed; projects and `~/.codewhale` intact; if machine trust exists, uninstall prints the exact `machineTrustNote` removal command | ☐ |
| 2a | Narrator opens the app | Start Narrator (Ctrl+Win+Enter), open Mona | Window title and the focused element are announced | ☐ |
| 2b | Narrator: navigation | Tab / Shift+Tab through the rail and into Studio | Every section announces a name and role; no silent focus stops | ☐ |
| 2c | Narrator: composer | Tab to the prompt box and type a word (send nothing) | Announced as an edit field named "Prompt for &lt;project&gt;" | ☐ |
| 2d | Narrator: controls and status | Tab to Submit / Pause after task / Interrupt now | Buttons announce name + disabled state; a disabled Interrupt says so | ☐ |
| 2e | Narrator: error message | Disconnect the engine and press Submit | The refusal is announced as an alert with the reason | ☐ |
| 2f | Narrator: dialog | Press `?` for shortcuts, then Escape | Dialog name announced on open; Escape returns focus to the same place | ☐ |
| 2g | Narrator: history and diff | In Studio click "Show 120 earlier item(s)"; in Changes open a diff and scroll | New rows are announced without stealing focus; the diff region is announced once, not per line | ☐ |
| 2h | No token storm | Run one short task with Narrator on | Narrator does not read every streamed fragment continuously | ☐ |
| 3a | 200% scaling | Windows Settings → Display → Scale = 200% (sign out/in if required), open Mona | Text is readable, no clipping | ☐ |
| 3b | 200% scaling: layout | At 200%, open a project and go to Studio | Composer and control strip reachable without horizontal page scrolling | ☐ |
| 3c | 200% scaling: sections | At 200%, visit Changes, Cost and Settings | Content scrolls vertically inside the window; no control is cut off | ☐ |
| 4a | Export: successful save | Studio → **Export**, choose a location | File written; notice reports item count, byte size and path; open it and confirm the text matches what the timeline showed | ☐ |
| 4b | Export: cancel | Studio → **Export**, then Cancel in the dialog | Notice says nothing was written; no file created | ☐ |
| 5 | Memory decision | Review `docs/evidence/P23-followup.md` §2 | Accept 406→371.4 MB progress with the target still unmet, or authorize §2.7 | ☐ |

Notes to record with any failure: Mona version, the exact control, what was announced
(or not), and whether it reproduces after a restart. A failure here changes the requirement
row, not the checklist.
