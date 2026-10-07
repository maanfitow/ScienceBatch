# Native Writing Ribbon Acceptance

Use this procedure to close the remaining desktop checks before release. Browser IPC mocks and helper tests do not replace these checks. Run a fresh `pnpm tauri dev` so Rust plugins and capabilities match the working tree. Do not start a second Vite server on port 1420.

## Test documents

Use an unsaved Quick LaTeX scratchpad for writing and clipboard checks. For PDF zoom, use a separate temporary project with an embedded PDF figure containing text, vector lines, and a raster image. Include at least two document pages. Do not alter a user's real project merely to perform QA. If the originally affected document is available, repeat its affected pages in addition to the fixture.

## Procedure and evidence

| Check | Procedure | Pass condition |
| --- | --- | --- |
| Native Copy | Select a unique sentence, right-click, choose Copy, and paste into an independent text editor. Repeat a reverse and multiline selection. | Exact selected text appears; source and selection remain unchanged; Undo still restores the preceding source edit. |
| Clipboard failure | If the environment permits a controlled failed write, repeat Copy. Otherwise leave this case to the focused regression script. | Failure is visible; no false success message. |
| PDF retention | Compile with the toolbar button. Insert a symbol, populated table, and matrix using the ribbon, then edit one structure. | The previous PDF stays visible with its scroll/zoom until Compile is explicitly clicked. No compilation progress appears during assistant interaction. |
| Explicit compilation | Click Compile after the edits. | The PDF updates once; scroll/zoom are preserved, without a blank-screen flash. |
| Embedded PDF zoom | Inspect each figure before/after Fit to width and zoom changes including 82%, 97%, 112%, 115%, and 120%; scroll between pages. | Text, vector lines, and raster content remain visible; page tracking remains correct. Record a reproducible failure separately if present. |
| Cancel and Undo | Open/cancel each assistant with a reverse selection; insert/update and Undo/Redo. | Cancel preserves source, selection, focus, and scroll; Undo/Redo operate on the complete insertion or update. |
| Git lock | Use a disposable local Git fixture and a controlled operation that locks the workspace while an assistant is open. Do not force checkout/reset of real work. | The editor and tools become unavailable; confirming the captured session cannot alter source after the lock. Record the operation and observed lock period. |
| Engine/tab change | Open an assistant, switch/close its source tab or switch engine, then attempt to confirm if the dialog remains open. | Stale captured ranges never apply to another model or engine. |

Record application revision, OS/WebKit version, test document, zoom levels, and screenshots before/after the relevant action. Mark each result **Passed**, **Failed**, or **Unverified**, with a concrete reason. A failure unrelated to writing source generation belongs in a separate reproducible issue.

## Latest attempt — 2026-10-05

The coordinator started the current Tauri development build and confirmed, through native accessibility state, that Quick LaTeX opened with the writing ribbon and **Document Not Compiled**. Orca's computer-use runtime was initially unavailable; starting it enabled application discovery and accessibility observation.

The Linux provider reported no focus/hotkey support. `get-app-state --restore-window` still captured the covering Orca window rather than ScienceBatch, so visual output could not be inspected. Setting Monaco's accessible editor value failed with `accessibility_error: 'Accessible' object has no attribute 'is_editable_text'`. The unchanged editor content was read back. No user document was changed, and no compilation was triggered in this attempt.

This attempt independently established no ribbon acceptance result: native Copy, PDF retention, embedded-PDF zoom, and Git-lock checks were **Unverified** because the provider could not control the foreground application.

## Antigravity report summary — 2026-10-06

The user reports that Antigravity successfully checked native Copy, retention of the current PDF during writing, explicit compilation, zoom/navigation, responsive themes, and readOnly/session guards. The detailed Antigravity report path and run metadata were not available while this record was updated. These are therefore recorded as **reported passed by Antigravity (summary only)**, not as independently repeated or fully evidenced Codex native passes. The report summary does not establish the individual selection variants, exact fixture, OS/WebKit version, zoom values, viewport, or screenshots.

| Check | Current evidence/status |
| --- | --- |
| Native Copy | **Reported passed by Antigravity (summary only).** Detailed selection variants and native app/OS evidence are unavailable. |
| Clipboard failure feedback | **Unverified.** No detailed evidence establishes a controlled native clipboard failure. |
| Retain existing PDF during writing | **Reported passed by Antigravity (summary only).** Codex did not independently repeat this in native Tauri. |
| Explicit compilation | **Reported passed by Antigravity (summary only).** Codex did not independently repeat this in native Tauri. |
| Zoom/navigation | **Reported passed by Antigravity (summary only).** Embedded PDF figure content and the specified zoom values are not established. |
| Embedded PDF figure with text, vector, and raster content | **Unverified.** No evidence establishes this fixture was tested. |
| Responsive themes | **Reported passed by Antigravity (summary only).** Exact viewport/theme coverage is unavailable. |
| readOnly/session guards | **Reported passed by Antigravity (summary only).** This does not establish behavior during a real Git workspace lock. |
| Cancel, Undo, and Redo native interaction | **Unverified.** The report summary does not establish these subcases. |
| Actual Git-operation workspace lock | **Unverified.** A mocked lock bridge and session guards are not evidence of a real Git operation locking the workspace. |

Keep these specific gaps open until the detailed report or new native evidence covers them. Do not treat this summary as blanket native QA certification. Browser probes and compiler fixtures remain separate evidence and cannot close these native cases.

## Bold/Italic native acceptance — pending

The authorized Bold/Italic controls have no native GTK/WebKit acceptance results yet. Frontend/browser verification is complete; verify both LaTeX and Typst in a fresh Tauri app using disposable scratch documents. Exercise mouse and keyboard activation for Bold and Italic with forward, reverse, and empty selections; combine and remove recognized nested wrappers; confirm unsupported partial/protected selections stay disabled; and check exact source, directional selection, focus, Undo/Redo, read-only behavior, and unchanged PDF until explicit Compile. Confirm no save or compile is triggered by formatting. Record app revision, OS/WebKit, engine/source fixture, and individual outcomes. Mark these cases **Unverified** until that native run occurs.

Browser fixtures that seed editor read-only references or mock Tauri IPC do not substitute for an actual native read-only transition. This formatting procedure also does not close the separately pending embedded-PDF figure or real Git-operation workspace-lock cases above.
