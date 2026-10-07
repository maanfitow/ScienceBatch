# Typst Symbols — T1 Implementation and Verification

## Implementation status

Delivery T1 from [SPEC-WRITE-004](TYPST_WRITING_TOOLS.md) is implemented on `feat/writing-ribbon`. The original uncommitted status is historical: the ribbon was committed externally at `9d165da` before this continuation. This is not a release certification. At T1 completion, Typst table/matrix creation and compatible editing remained disabled. They are now implemented separately; see [T2 verification](TYPST_STRUCTURES_QA.md). Font and formatting controls remain separate future work.

The ribbon uses a separate 56-entry built-in Typst catalog, conservative context scanner, native source generator, and symbol adapter. It reuses the selected-symbol feedback, themed categories, compact Insert menu, and Monaco editing contract. Markup insertion produces inline math; existing math receives a native identifier with boundary spacing. Comments, raw content, code, strings, labels, references, URLs, incomplete syntax, partial identifiers, and cross-context selections are unavailable.

The preview is an accessible Unicode glyph illustration with the exact generated source. It does not render through KaTeX or compile Typst, and it does not promise document-font matching. Symbols have no package requirements. Assistant interactions never save, compile, or replace the current PDF.

Editing sessions now include language and a monotonic context revision. Engine, document identity, source eligibility, and read-only transitions permanently invalidate captured sessions, including transitions away and back. The bridge remains mounted when a parent's callback identity changes; listener cleanup runs on unmount.

## Automated checks

The coordinator reviewed the implemented files and ran these checks successfully:

- `node scripts/test-typst-writing-tools.mjs`
- `node scripts/test-writing-tools.mjs`
- `node scripts/test-writing-bridge.mjs`
- `node scripts/test-editor-clipboard.mjs`
- `node scripts/test-pdf-rendering-helpers.mjs`
- `node scripts/test-git-workspace.mjs`
- `pnpm tsc --noEmit`
- `pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`
- `graphify extract . --code-only`, followed by `graphify cluster-only .`: 967 nodes, 1,990 edges, 89 communities.

Focused Typst checks cover comments inside multiline code groups, continued bindings, context expressions, nested groups/raw/string handling, complete field identifiers, symbol search aliases, and completion guards in markup and protected contexts. Vite reported the existing large-chunk warning; the PDF helper script reported its Node legacy-build warning.

## Embedded compiler verification

The resolved engine remains `typst-embed` 0.1.0 / Typst 0.15.1. This explicit diagnostic command passed against the existing development binary:

```sh
node scripts/verify-typst-symbols.mjs src-tauri/target/debug/sciencebatch
```

The verifier checks every catalog glyph against `str(sym.identifier)` and renders every emitted math identifier using the isolated compile worker. It validated 56 entries, received 23,401 PDF bytes, and reported zero warnings or errors. Requests and output stay in memory; the script writes no source, PDF, or intermediate files. It requires a caller-supplied binary and is never invoked by the picker.

## Browser and real Monaco checks

The focused Playwright run used Chromium, real Monaco, and mocked Tauri IPC. It exited with code 0 and reported no browser runtime errors. It passed:

- Alpha, right arrow, and infinity insertion through keyboard and pointer, with exact Typst source.
- Reverse selection, one-operation Undo/Redo, restored editor focus, and Cancel preserving source, selection, and scroll.
- Inline/display math, category filtering, empty/no-result searches, persistent selection feedback, and the large preview.
- Protected-context, cross-delimiter, stale-content, and multiple-cursor rejection; disabled Typst Table/Matrix controls.
- No KaTeX preview or package actions for Typst, and no implicit compile/save/write IPC.
- An existing PDF canvas remaining byte-identical after insertion; the PDF was supplied by a mocked explicit Compile response.
- Dark, Light, and Monokai themes with visible preview/footer and bounded layout at 900×600.

An extended run also passed source/selection assertions for engine round-trip invalidation, fresh bridge availability, and LaTeX Symbol/Table/Matrix insertion and Undo. A separate React/Monaco harness passed read-only lock/unlock and document-identity round-trip invalidation, plus `.tex`/BibTeX eligibility rejection. These are browser simulations of workspace state; they do not certify native Git operations.

## Historical model-switch investigation

The extended run failed its **zero runtime errors** assertion: switching Typst to LaTeX after the long-document, PDF, and theme scenarios logged an unhandled `Canceled` rejection. A diagnostic repeat reproduced it. The stack goes through cancellation/disposal in CDN Monaco 0.55.1, `setModel`, and the model-path effect in `@monaco-editor/react`. The subsequent source, stale-session, fresh insertion, and Undo assertions still passed. The standalone harness also logged `Canceled` on model lifecycle changes.

Reproduction sequence: open Quick Typst; replace a reverse selection using Symbols and Undo/Redo; repeat in inline/display math; cancel in a 120-paragraph source after scrolling; exercise stale edits and multiple cursors; compile explicitly; insert while retaining the PDF; inspect the three themes at 900×600; open Symbols and switch to LaTeX. Observe the unhandled rejection while the source remains intact and the old session stays invalid.

The root cause is now established; when the behavior was introduced remains unknown. Antigravity traced the cancellation to Monaco's `WordHighlighter`, whose 50 ms `Delayer` promise is canceled when the model changes. The earlier Codex browser corroboration used CDN Monaco 0.55.1 and reported five `Canceled` errors with `'singleFile'` and none with `'off'` across five changes; its error collector was not recorded. The installed npm package version is 0.52.2, distinct from the CDN runtime used in the browser probes. A later lead probe against the current mitigated source saw one `Canceled` page error when explicitly forcing `'singleFile'` for five changes and zero page errors after returning to `'off'` for five more. The separate `unhandledrejection` collector was empty; see [Writing Ribbon QA](WRITING_RIBBON_QA.md#confirmed-monaco-cancellation-diagnosis-and-mitigation--2026-10-06) for this probe's provenance and collector distinction. Neither of these targeted probes alone is the full checked-in regression; that regression has since passed as recorded below.

The authorized mitigation disables semantic occurrence highlighting under the cursor by setting `occurrencesHighlight: 'off'` in the Monaco options. This has the accepted visible tradeoff of removing that highlighting. It does not globally suppress errors, patch Monaco internals, add an arbitrary product delay, or upgrade dependencies. See [Writing Ribbon QA](WRITING_RIBBON_QA.md#confirmed-monaco-cancellation-diagnosis-and-mitigation--2026-10-06).

The repeatable real-Monaco regression is [scripts/test-monaco-model-switch.mjs](../scripts/test-monaco-model-switch.mjs). The lead reports it passed, including an independent stable rerun, against CDN Monaco 0.55.1: the positive control produced one `Canceled` page error over five changes, and the mitigated phase produced zero runtime errors or unhandled rejections over five changes. Actual App engine/tab controls preserved exact source over round trips, rejected stale applies, retained focus, and passed Undo/Redo. Tauri IPC was mocked; a second workspace tab was seeded via test-only React state/ref, followed by actual `WorkspaceTabs` controls/product handlers. The edits used the published bridge, not the full picker catalog UI. This is browser integration evidence and does not certify native Git/filesystem locking. Reproducible Vite and Playwright setup is documented in [Writing Ribbon QA](WRITING_RIBBON_QA.md#confirmed-monaco-cancellation-diagnosis-and-mitigation--2026-10-06); the full invocation is `pnpm dev --host 127.0.0.1 --port 1422 --strictPort`, then `node scripts/test-monaco-model-switch.mjs` from a second terminal.

## Native release checks

Native GTK/WebKit Copy, PDF retention/embedded-PDF zoom, and actual Git-lock interaction remain **Unverified** under the limitations recorded in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md). The browser checks and explicit headless compiler fixture do not replace them. No new compiler assets, IPC commands, font changes, commits, push, or publication are included in T1.
