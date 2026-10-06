# Writing Ribbon Implementation and QA

The LaTeX writing ribbon implements the symbol picker and table/matrix builders described by [SPEC-WRITE-001](../SPECS.md#spec-write-001-table-and-matrix-builders) and [SPEC-WRITE-002](../SPECS.md#spec-write-002-symbol-picker). The three LaTeX deliveries are implemented on the current feature branch. Typst Symbols are now implemented separately under [SPEC-WRITE-004](TYPST_WRITING_TOOLS.md); see [T1 verification](TYPST_SYMBOLS_QA.md). Typst tables, matrices, and compatible editing are now implemented in T2; see [T2 verification](TYPST_STRUCTURES_QA.md). The ribbon applies in-memory Monaco edits only; it does not save or compile automatically.

## Automated verification

All of these checks passed:

- `pnpm tsc --noEmit`
- `pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `node scripts/test-writing-tools.mjs`
- `node scripts/test-writing-bridge.mjs`
- `node scripts/test-editor-clipboard.mjs`
- `node scripts/test-git-workspace.mjs`
- `node scripts/test-pdf-rendering-helpers.mjs`
- `graphify extract . --code-only && graphify cluster-only .` — index refreshed with 914 nodes, 1,871 edges, and 81 communities.

Vite reported a large-chunk warning, and PDF.js reported its existing Node legacy-build warning. Neither prevented a successful build or helper checks.

## Browser and Monaco verification

The writing-only Playwright run exercised the real Monaco editor with mocked Tauri IPC, exited with code 0, passed all 28 assertions, and reported no browser runtime errors. The following scenarios passed:

- Symbol insertion with reverse selections, text/math contexts, and Undo/Redo.
- Create, reopen, edit, and undo all six supported matrix environments and all three table formats, starting table edits from a bold header.
- Separate package-add Undo with selection rebasing; raw caption editing; and table resizing without losing retained cell contents.
- Cancel without changing source while preserving scroll position; compact 900×600 layout, keyboard interaction, focus visibility, and all three themes.
- Stale-content invalidation, multiple-selection rejection, and disabled writing tools in Typst.
- Mocked Git-lock bridge invalidation.

### Follow-up menu and preview QA

The writing ribbon feedback fixes keep the **Insert** label visible, place a large selected-symbol preview below **Category**, bound the results scroller, and use an opaque footer so selected-item status does not overlap content. Category, table alignment/format, and matrix menus use themed combobox/listbox behavior; focus remains on the trigger, and Escape closes the menu before its dialog.

`node /tmp/sciencebatch-ribbon-menu-qa.mjs` passed against real Monaco with mocked Tauri IPC. It verified persistent selection and hover, Insert and Undo, Space/Home/End/arrows/typeahead/Enter/Escape/Tab navigation, fitting labels in all three themes, and dialog/viewport bounds. At 900×600 the preview and footer remain visible; arrow-scrolling a long all-category list keeps its final option visible. The run made no save or compile calls and reported no browser errors.

The latest `pnpm tsc --noEmit`, `pnpm build`, `cargo check --manifest-path src-tauri/Cargo.toml`, `node scripts/test-writing-tools.mjs`, and `node scripts/test-writing-bridge.mjs` checks passed. Vite emitted the large-chunk warning recorded above.

### Table layout preview

The table preview sizes columns to their content, follows the selected left/center/right alignment (left by default), and bolds only an enabled header row. Empty cells remain blank. Plain has no rules, Grid draws every cell border, and Booktabs shows top/bottom rules with a header separator only when enabled. Wide tables scroll horizontally inside the preview frame without widening the dialog. The preview uses a compact serif font and spacing as a screen approximation; final size and font depend on the LaTeX document. Raw LaTeX cells are shown as source. Generated LaTeX is unchanged.

`node /tmp/sciencebatch-table-preview-qa.mjs` passed against real Monaco with mocked Tauri IPC. It covered the supplied 3×3 sample, default/mixed/all-center alignment, all three formats including a one-row Booktabs table, visible blank rows, the three themes, and long-cell scrolling with bounded layout at 900×600. Source insertion, Undo/Redo, cancellation, and dialog bounds remained correct; the run reported no runtime errors and made no save or compile calls. `pnpm tsc --noEmit` and `cargo check --manifest-path src-tauri/Cargo.toml` passed. Native Tauri visual verification remains unavailable because the required `orca-ide` runtime metadata is missing.

### Editor context-menu Copy

Monaco's **Copy** command now writes selected plain text through the Tauri clipboard manager in the desktop runtime and uses the browser Clipboard API in browser previews. Only native text-write permission is enabled. Copy preserves source, selection, and Undo history, supports reverse and multiple selections, and remains available for read-only editors. Empty selections follow Monaco's `emptySelectionClipboard` option. Failed writes show **Copy failed** with details. The shared command registration and editor listeners are disposed when editors unmount.

`node /tmp/sciencebatch-copy-qa.mjs` passed with the real Monaco editor. It covered mouse activation through a real right-click menu, normal keyboard menu navigation, forward/reverse/multiline/multiple/empty selections, read-only copying, failed native writes, and unchanged source/selection/Undo. Desktop clipboard IPC was mocked; browser menu Copy and Ctrl+C were verified by reading back the real browser clipboard. No save or compile calls occurred, and the run reported no browser runtime errors. The probe waits for Monaco's menu activation before clicking; an immediate synthetic click had been dropped by Monaco's mouseup protection. No timing workaround or Monaco version change was added to the product.

`node scripts/test-editor-clipboard.mjs` passed native/browser dispatch, selection snapshots before asynchronous writes, URI routing, stale-tab rejection, line-copy settings, failure feedback, and shared command/listener cleanup. TypeScript, Rust, the production build, and Graphify extraction/clustering passed after integration.

The native GTK/WebKit system clipboard remains unverified because native GUI automation is unavailable. Restart `pnpm tauri dev` to load the newly registered Rust clipboard plugin before manual desktop verification.

Native Tauri verification of PDF retention and Git-lock UI behavior could not be completed because `orca-ide` runtime metadata required by the native GUI automation tooling was unavailable. The mock bridge check passed; the native check remains open.

In a separate extended engine-switch run, the zero-runtime-errors assertion failed on a nonfatal unhandled Monaco `Canceled` rejection after a long-document scenario. Assertions for Typst tool disabling and tab closing passed. The stack passed through CDN Monaco 0.55.1 cancellation/disposal and `setModel` in `@monaco-editor/react`. A minimal engine-only reproduction did not reproduce it, and the archived `b3ca9e8` baseline also did not reproduce it. Treat this as an unconfirmed follow-up investigation; it is not evidence of a pre-existing defect, and no editor or engine changes were made for it.

## Validation context and follow-up

During the run, the external HEAD changed from `b3ca9e8` to `d5d21ae` (`Add commits, cloning, and remote sync`). Application code was identical for this QA; documentation, agent configuration, and `.gitignore` differences were preserved.

The local WRITE-001/002 refinements in `SPECS.md` remain in the working tree. `SPECS.md` is ignored by `.gitignore`, so those changes are absent from the ordinary Git diff unless explicitly force-added. Agents did not commit or push.

Next validation work is native Tauri PDF-retention and Git-lock UI QA. Investigate the Monaco cancellation log separately only if it reproduces in a minimal scenario.

### Follow-up specification and native attempt — 2026-10-05

[SPEC-WRITE-004](TYPST_WRITING_TOOLS.md) now defines Typst Symbols followed by Table/Matrix creation and compatible editing. This step changes documentation only; Typst writing tools remain unimplemented and disabled. Font and formatting controls remain separate future work.

The native development app started, and accessibility observation confirmed Quick LaTeX opened with the ribbon and an uncompiled document. Starting Orca made native observation available, but its Linux provider could not bring ScienceBatch to the foreground for screenshots and failed to set Monaco's accessible value. The detailed attempt and repeatable acceptance procedure are recorded in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md). Native Copy, PDF-retention/zoom, and Git-lock checks remain unverified.

`pnpm tsc --noEmit`, `cargo check --manifest-path src-tauri/Cargo.toml`, and the clipboard, writing-core, writing-bridge, and PDF-helper scripts passed again. No code modules changed, so this documentation step did not require a Graphify extraction refresh.

### Typst Symbols delivery T1 — 2026-10-05

Typst Symbols are implemented with a separate 56-entry native catalog and context/source adapter. Typst Table/Matrix remain disabled until T2. The focused picker browser checks, native compiler catalog fixture, TypeScript/Rust/build, and frontend regression scripts pass; see the [T1 verification record](TYPST_SYMBOLS_QA.md). Graphify now contains 967 nodes, 1,990 edges, and 89 communities.

The extended engine-switch run reproduced the nonfatal unhandled Monaco `Canceled` rejection described above while all source/Undo/session assertions passed. Its zero-runtime-errors assertion failed, and its regression origin remains unknown. Native release checks remain open.

### Typst structures delivery T2 — 2026-10-05

Typst Table/Matrix creation and compatible editing are implemented separately from LaTeX. They use native generators, a bounded parser, exact snapshots for unchanged cells, and schematic previews. All three table formats and six matrix delimiters pass explicit embedded-engine fixtures and real Monaco browser checks, including nested range edits, Undo/Redo, focus, cancellation, stale sessions, and PDF retention with mocked IPC. See the [T2 verification record](TYPST_STRUCTURES_QA.md) for compatibility limits and complete evidence. TypeScript, Rust, build, focused regressions, and Graphify extraction/clustering pass. Native release checks and the separate model-switch cancellation investigation remain open.
