# Typst Structures — T2 Implementation and Verification

## Implementation status

Delivery T2 from [SPEC-WRITE-004](TYPST_WRITING_TOOLS.md) adds native Typst Table/Matrix creation and compatible editing to `codex/writing-ribbon`. The changes remain uncommitted; native release checks remain open. Font and basic formatting controls require separate specifications.

Tables support 1–20 rows, 1–10 columns, per-column alignment, Plain/Grid/Booktabs, semantic bold headers, literal Text or explicit Typst markup per cell, and optional figures with literal captions and labels. Figures may omit a caption when they have no label. Matrices support 1–12 rows and columns and all six delimiters. Empty matrix cells retain their positions as `""`.

The dialogs expose a schematic preview and exact Source tab. They never evaluate user code, translate Typst to KaTeX, call compiler IPC, save, add packages, or change the current PDF. Final typography depends on document rules. A pending reduction of populated cells blocks insertion until confirmed or canceled.

The bounded parser preserves complete source arguments for unchanged cells. Generated figures and display-math wrappers reopen as a whole; nested structures replace only the recognized inner range. Unsupported figure metadata stays outside an edited inner table. Inline math delimiters remain intact. Strings, raw spans, comments, and code-context lookalikes cannot become editable structures.

## Compatibility limits

Manual tables need explicit supported `columns`, `align`, `inset: 5pt`, and `stroke` arguments. Matrices need an explicit supported `delim`. The parser does not infer inherited styling or evaluate `set`/`show` rules. Dynamic dimensions, custom tracks, merged cells, aliases, spreads, loops, augmentation, unknown structural arguments, internal comments, and malformed source use Edit source. Bare quotes in nested content arguments of code calls are conservatively rejected; literal text can use `#text("...")`.

## Verification

The coordinator reviewed the final implementation and all scoped follow-ups. These checks passed:

- `node scripts/test-typst-structure-generation.mjs`
- `node scripts/test-typst-structure-parser.mjs`
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
- `graphify extract . --code-only`, followed by `graphify cluster-only .`: 1,117 nodes, 2,264 edges, 90 communities.

The build retains the existing large-JavaScript-chunk warning; PDF.js retains its Node legacy-build warning. Graphify renamed changed communities by their hubs; extraction and clustering succeeded.

### Embedded compiler

The caller-supplied local development binary uses the existing `typst-embed` 0.1.0 / Typst 0.15.1 resolution. The explicit fixture verifier is separate from all assistant interactions:

```sh
node scripts/verify-typst-structures.mjs src-tauri/target/debug/sciencebatch
```

The final run passed **15 fixtures**, received **31,409 PDF bytes**, and reported **zero warnings or errors**. It exercises all three table formats, alignment, empty/header-only tables, literal special characters, figures with and without captions, all six matrix delimiters, empty math cells, nested functions, and raw Typst table content. Requests and PDF responses remain in memory; the script writes no compilation intermediates or document files.

### Browser and real Monaco

The coordinator ran the structure, additional-range, final-safety, Typst Symbols regression, and isolated LaTeX regression probes. Each exited with code 0 and reported zero browser runtime errors. The LaTeX probe covered Symbols, all three table formats, all six matrix environments, exact insertion, Undo, and adapter separation. The focused Chromium probes use real Monaco and mocked Tauri IPC. This verifies frontend behavior; it does not certify the native GTK/WebKit clipboard or actual Git operations. Scenarios include:

- All table formats and matrix delimiters: creation, reopen, edit, exact source, reverse-selection Undo, and complete Redo.
- Matrix insertion into existing inline/display math; empty cells and nested function separators.
- Text escaping, raw source retention, headers, metadata validation, and structural cell errors.
- Shrink confirmation, growth, stale-content rejection, incompatible-source fallback, and multiple cursors.
- Nested table/matrix ranges, unsupported outer metadata, optional captions, and label reopening.
- Fake structure source inside option strings, anonymous code groups, and hash strings never exposing Edit table/Edit matrix. Ordinary body macros remain opaque.
- Cancel preserving focus, directional selection, and scroll; keyboard select/menu Escape and modal focus containment.
- Dark, Light, and Monokai at 900×600, maximum grids, compact Insert, and fixed visible footer.
- Existing PDF canvas remaining byte-identical after insertion; the PDF comes from a mocked explicit Compile response.
- Typst Symbols regression and absence of implicit compile/save/write IPC, package actions, or KaTeX rendering.

### Native release checks and separate investigation

Native Copy, PDF retention and embedded-PDF zoom, and actual Git-lock interaction remain **Unverified** for the provider limitations recorded in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md). Browser/mock results do not replace these checks.

The engine/model-switch `Canceled` rejection investigated during T1 remains separate work, with unknown regression origin; see [T1's investigation record](TYPST_SYMBOLS_QA.md#separate-model-switch-investigation). T2 does not upgrade Monaco, suppress rejections, or introduce timing workarounds. Its focused browser runs stay on Typst and must report their own runtime-error outcomes.

No new compiler assets, dependencies, Rust changes, IPC commands, commits, push, or publication are part of T2.
