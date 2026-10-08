# Writing Ribbon Implementation and QA

The LaTeX/Typst ribbon and Bold/Italic changes are integrated into `develop`: PR #1 (Git) merged first as `84d9584`, followed by PR #2 (writing ribbon) as `e052afc826b3f9d7c92f272e612b248e8512c46e`. Merge provenance does not change browser/native evidence classifications or close pending native cases.

The LaTeX writing ribbon implements the symbol picker and table/matrix builders described by [SPEC-WRITE-001](../SPECS.md#spec-write-001-table-and-matrix-builders) and [SPEC-WRITE-002](../SPECS.md#spec-write-002-symbol-picker). The three LaTeX deliveries are integrated in `develop`. Typst Symbols are implemented separately under [SPEC-WRITE-004](TYPST_WRITING_TOOLS.md); see [T1 verification](TYPST_SYMBOLS_QA.md). Typst tables, matrices, and compatible editing are implemented in T2; see [T2 verification](TYPST_STRUCTURES_QA.md). The ribbon applies in-memory Monaco edits only; it does not save or compile automatically.

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

The investigation above is historical and superseded by the confirmed diagnosis below. Its minimal probe and baseline comparison did not reproduce the rapid WordHighlighter cancellation sequence.

## Validation context and follow-up

During the run, the external HEAD changed from `b3ca9e8` to `d5d21ae` (`Add commits, cloning, and remote sync`). Application code was identical for this QA; documentation, agent configuration, and `.gitignore` differences were preserved.

The local WRITE-001/002 refinements in `SPECS.md` remain in the working tree. `SPECS.md` is ignored by `.gitignore`, so those changes are absent from the ordinary Git diff unless explicitly force-added. Agents did not commit or push.

Next validation work is native Tauri PDF-retention and Git-lock UI QA. The Monaco cancellation diagnosis and authorized mitigation are recorded below.

### Follow-up specification and native attempt — 2026-10-05

[SPEC-WRITE-004](TYPST_WRITING_TOOLS.md) now defines Typst Symbols followed by Table/Matrix creation and compatible editing. At this historical 2026-10-05 documentation-only step, Typst writing tools were not yet implemented and were disabled; font controls remained future work and Bold/Italic had not yet been authorized.

The native development app started, and accessibility observation confirmed Quick LaTeX opened with the ribbon and an uncompiled document. Starting Orca made native observation available, but its Linux provider could not bring ScienceBatch to the foreground for screenshots and failed to set Monaco's accessible value. The detailed attempt and repeatable acceptance procedure are recorded in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md). Native Copy, PDF-retention/zoom, and Git-lock checks remain unverified.

`pnpm tsc --noEmit`, `cargo check --manifest-path src-tauri/Cargo.toml`, and the clipboard, writing-core, writing-bridge, and PDF-helper scripts passed again. No code modules changed, so this documentation step did not require a Graphify extraction refresh.

### Typst Symbols delivery T1 — 2026-10-05

Typst Symbols are implemented with a separate 56-entry native catalog and context/source adapter. Typst Table/Matrix remain disabled until T2. The focused picker browser checks, native compiler catalog fixture, TypeScript/Rust/build, and frontend regression scripts pass; see the [T1 verification record](TYPST_SYMBOLS_QA.md). Graphify now contains 967 nodes, 1,990 edges, and 89 communities.

The extended engine-switch run reproduced the nonfatal unhandled Monaco `Canceled` rejection described above while all source/Undo/session assertions passed. Its zero-runtime-errors assertion failed. The later investigation established the WordHighlighter cause; when the behavior was introduced remains unknown. This older failing run is historical, and the full current regression has since passed. Native release checks remain open.

### Confirmed Monaco cancellation diagnosis and mitigation — 2026-10-06

Antigravity traced the unhandled `Canceled` rejection to Monaco's `WordHighlighter`: cursor movement schedules work through a 50 ms `Delayer`, and a model change during that interval cancels the pending promise. In the earlier Codex browser corroboration supplied for this assignment, CDN Monaco 0.55.1 produced five `Canceled` errors across five rapid model changes with `occurrencesHighlight: 'singleFile'`, and zero with `'off'`. That earlier record did not specify whether those counts came from `pageerror` or `unhandledrejection` collection. The installed npm package reports Monaco 0.52.2; it is distinct from the CDN runtime and is not the version used in the browser probes.

The lead later reran a focused probe against the current mitigated source with CDN [Monaco 0.55.1](https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/editor/editor.main.js). The effective option initially was `'off'`. Across five model changes explicitly setting `'singleFile'`, the page-error collector saw one `Canceled`; after setting `'off'`, five model changes yielded zero page errors. The browser's separate `unhandledrejection` collector was empty. These counts describe separate collectors: this probe saw a page error in the positive-control phase and no unhandled rejections. This focused probe supports the mitigation and preceded the full reproducible regression below, which also passed real engine/tab switching and source/session/focus/Undo checks.

The authorized product mitigation is `occurrencesHighlight: 'off'` in the Monaco options in `src/components/EditorView.tsx`. This disables semantic occurrence highlighting for the symbol under the cursor. It is a visible editor behavior tradeoff. The mitigation does not suppress global errors, patch Monaco internals, add an arbitrary product delay, or upgrade a dependency.

The repeatable real-Monaco regression is [scripts/test-monaco-model-switch.mjs](../scripts/test-monaco-model-switch.mjs). The lead ran it successfully against CDN Monaco 0.55.1, independently repeated the stable run, and reran it after adding the Bold/Italic UI. Its positive control observed one `Canceled` page error and zero other runtime errors over five model changes; the mitigated phase observed zero runtime errors and zero unhandled rejections over five changes. In the App UI, two engine switches and two tab switches preserved the exact source, rejected stale applies including after round trips, retained focus, and passed Undo/Redo. App-level runtime errors, unhandled rejections, and unexpected compile/save calls were all zero. The source fixtures were `Untitled.typ` and `Secondary.typ`. Tauri IPC was mocked. The second workspace tab was seeded through test-only React state/ref setup, after which the actual `WorkspaceTabs` buttons and product handlers were used; the tested edits used the published bridge, not the full writing picker catalog UI. This is browser integration evidence, not native Git/filesystem lock QA. On the post-UI rerun, one browser startup attempt timed out after 60 seconds; a subsequent read-only diagnostic and fresh test run passed with no page, console, or request errors. The startup timeout's cause was not established.

To reproduce from the repository root, start Vite in terminal 1:

```sh
pnpm dev --host 127.0.0.1 --port 1422 --strictPort
```

Then run the test in terminal 2:

```sh
node scripts/test-monaco-model-switch.mjs
```

The script cleans up its browser in `finally`; the caller owns and stops the Vite server. Current host defaults use Playwright at `/home/mauri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs` and Chromium at `/home/mauri/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. On other hosts configure `PLAYWRIGHT_MODULE` (absolute path or package specifier), `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and `SCIENCEBATCH_TEST_URL`. The run needs the Playwright bundle, a browser, and network access to the CDN Monaco runtime; it introduces or upgrades no dependency. The current review checklist is in [Writing Ribbon Final Review](WRITING_RIBBON_FINAL_REVIEW.md).

### Typst structures delivery T2 — 2026-10-05

Typst Table/Matrix creation and compatible editing are implemented separately from LaTeX. They use native generators, a bounded parser, exact snapshots for unchanged cells, and schematic previews. All three table formats and six matrix delimiters pass explicit embedded-engine fixtures and real Monaco browser checks, including nested range edits, Undo/Redo, focus, cancellation, stale sessions, and PDF retention with mocked IPC. See the [T2 verification record](TYPST_STRUCTURES_QA.md) for compatibility limits and complete evidence. TypeScript, Rust, build, focused regressions, and Graphify extraction/clustering pass. Native release checks remain open; the model-switch diagnosis and mitigation are recorded above, with the passing current regression documented in the [final review](WRITING_RIBBON_FINAL_REVIEW.md).

The model-switch investigation reference in the T1 record above is historical and superseded by the confirmed WordHighlighter diagnosis and mitigation. The full real-Monaco regression has passed; see its evidence and reproducible setup above.

### Basic Bold/Italic delivery — 2026-10-06

The user has authorized scoped Bold and Italic ribbon controls for LaTeX and Typst. The current working tree includes labeled toolbar buttons and a conservative source planner using canonical `\textbf{}` / `\textit{}` and `#strong[]` / `#emph[]` wrappers through the shared editing bridge. The detailed source and interaction contract is in [Basic Text Formatting](TEXT_FORMATTING.md). Fonts and document typography are outside the authorized scope.

The pure source planner passed `node scripts/test-text-formatting.mjs`. The isolated compiler fixture command, `node scripts/verify-text-formatting.mjs src-tauri/target/debug/sciencebatch`, passed: LaTeX compiled 5 fixtures to 11,198 PDF bytes, and Typst compiled 6 fixtures to 18,913 PDF bytes, with zero warnings in both runs. `pnpm tsc --noEmit` and `pnpm build` passed after frontend corrections; Vite emitted its existing large-chunk warning.

Additional source-guard probes passed for six local LaTeX macro-definition forms, including starred and unbraced optional-default declarations. Comments between macro arguments are handled, and ordinary text following each definition remains available for formatting. Confirmed compatibility limits are canonical wrappers only; maximum range of 100,000 UTF-16 code units; at most 32 relevant wrappers; no partial selection inside a wrapper of the same kind; soft newlines allowed but blank paragraphs blocked. Unmatched enclosing LaTeX groups and unknown/protected commands inside unwrapped bodies route to direct source editing. Active indicators reflect recognized source wrappers and do not calculate the final PDF font or style.

The lead independently ran scripts/test-text-formatting-browser.mjs successfully against real CDN Monaco 0.55.1 in the mounted App, EditorView, and WritingRibbon. Both engines passed pointer Bold, keyboard Italic, directional and empty selections with typing, nested toggles and complete wrapper removal, source preservation, focus, and single-edit Undo/Redo. Protected contexts and multiple selections rejected edits. Actual engine and workspace-tab switches rejected stale sessions, including after returning. Symbols, Table, and Matrix opened and canceled successfully. The second tab was seeded through test-only App state/ref setup, then switched with actual WorkspaceTabs buttons. Runtime/page/console/request errors and unhandled rejections were zero. Exactly one explicit Compile invocation occurred, with zero formatting save/write calls.

The read-only fixture directly sets the mounted EditorView readOnlyRef and Monaco option and supplies WritingRibbon props/state. It rejects capture and stale apply while locked and permits fresh capture after unlocking. It does not exercise a parent prop transition, the App Git-lock callback, or a real Git operation. Tauri invoke/event IPC is mocked. A 4,536-byte PDF was compiled separately by the real isolated worker before browser startup and delivered only after the actual Compile button click. Formatting preserved the rendered canvas pixels, dimensions, and 115% zoom.

The final scroll fixture uses the product default wordWrap: 'on'. Short-line scroll remained 530 to 530 with horizontal offset 0. Long wrapped content remained at scroll top 1043 and content height 2527; both selection endpoints remained at viewport position 325, with zero measured reflow. Earlier apparent drift was sampled during smooth-scroll animation. The corrected fixture centers with the public ScrollType.Immediate API and waits for stable samples; no product delay was introduced. The separate ordinary-typing probe confirming an overridden wordWrap: 'off' returns to 'on' is historical and did not measure scroll preservation.

The lead visually reviewed wide and 900×600 screenshots in dark, light, and monokai themes under /tmp/sciencebatch-text-formatting-LUborv/. Bold/Italic, Insert, pressed states, and keyboard focus remained visible without ribbon overflow. The script starts and closes its own Vite server on an available localhost port with strict: false. To reproduce, run node scripts/test-text-formatting-browser.mjs after building the debug worker. Other hosts can set PLAYWRIGHT_MODULE, PLAYWRIGHT_CHROMIUM_EXECUTABLE, and SCIENCEBATCH_COMPILE_WORKER; the browser requires CDN access. Screenshots use a unique temporary directory.

Final Graphify refresh passed sequentially after code and scripts stabilized: graphify extract . --code-only re-extracted 5 files with 113 cached, producing 1,218 nodes, 2,397 edges, and 100 communities. graphify cluster-only . passed with 100 communities and updated the graph reports; hub changes renamed 91 labels. No LLM label refresh was run. The pure planner regression, final browser/compiler script syntax checks, and full git diff --check passed. Native GTK/WebKit formatting, embedded PDF figures, actual Git-operation locks, and the other native gaps retain their individual statuses in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md).

### Ribbon spacing and LaTeX formatting colors — 2026-10-06

The user reported that Bold/Italic were too far from the insertion and compatible-edit controls, and wanted LaTeX formatting commands to use command colors. The ribbon now uses `justify-content: flex-start`; its existing flexible hint preserves compact behavior. Both commands were already present in completion, linting, and the Monarch function catalog. Only `\\textbf` and `\\textit` were moved to the keyword catalog, so they receive the existing command theme styling. No package, compiler, or global theme rule changed.

The implementation agent and lead independently passed the expanded `node scripts/test-text-formatting-browser.mjs` against CDN Monaco 0.55.1. Wide Matrix-to-Bold and compatible Edit matrix-to-Bold gaps both measured 12 px. Status was empty and source unchanged before the first activation, then announced the completed edit. Compact 900×600 controls remained within bounds in dark, light, and monokai. The lead visually inspected all four screenshots under `/tmp/sciencebatch-text-formatting-TDjhVu/`.

Actual rendered `\\textbf` and `\\textit` colors matched `\\section` and differed from ordinary body text: dark `rgb(86, 156, 214)`, light `rgb(0, 0, 255)`, and monokai `rgb(249, 38, 114)`. Real Monarch tokenization returned `keyword.latex` for normal formatting commands, `comment.latex` inside comments, `string.verbatim.latex` inside verbatim, and `keyword.math.latex` inside math. Unrelated `\\emph` retained `support.function.latex`. The test waits for observable rendered fixture/token state after source changes; no product delay was introduced.

The full browser regression retained source, directional selection, focus, Undo/Redo, stale engine/tab rejection, and PDF retention coverage. It recorded zero runtime errors/rejections, one explicit Compile invocation, and zero formatting save/write calls; Tauri IPC remains mocked. TypeScript, Rust, production build, pure formatting regression, script syntax, and diff checks passed. The build retained its existing large-chunk warning. Graphify extraction then clustering passed sequentially: two files re-extracted, 116 cached, 1,218 nodes, 2,397 edges, and 100 communities. The native evidence and pending cases above remain separate.
## Contextual manual editing and Typst cursor containment — 2026-10-06

The focus-only **Edit source** button was removed from both engines and both ribbon layouts. Compatible structures retain **Edit table** and **Edit matrix**. Incompatible structures show their manual-editing reason in the existing live hint, with the full message available as its title. This contextual reason takes priority over an earlier formatting status and disappears when the cursor leaves the parsed range.

The lead reproduced a Typst parser defect with `Before text\n#figure(table(columns: count, [x]), kind: table)\nAfter text`: cursors at offsets 0 and 61 incorrectly received the inner table range 20–46. The parser now filters candidates to ranges containing the cursor, inclusively, before selecting the smallest candidate. Those outside positions return null; the position inside the table still reports incompatibility. Compatible inner structures in unsupported wrappers remain editable without consuming outer metadata. Unclosed calls intentionally retain their conservative range through end of file.

The implementation agent and lead independently passed `node scripts/test-text-formatting-browser.mjs` using real App/EditorView/WritingRibbon and CDN Monaco 0.55.1. Moving before, inside, and after the unsupported Typst figure used the same Monaco model and unchanged source; the warning appeared only inside the table. Unsupported LaTeX also displayed information without a source-edit action. Compatible Typst table/matrix dialogs opened in wide and compact layouts, and cancellation preserved exact source. The compact menu retained compatible edit entries and omitted the removed source action. Existing formatting, focus, Undo/Redo, stale engine/tab sessions, token colors, scroll, and retained-PDF checks passed. Runtime errors and unhandled rejections were zero; IPC recorded one explicit Compile invocation and zero formatting save/write calls.

The simulated read-only fixture now waits for observable React source/selection state before injecting its existing test-only ref/option/ribbon state. Its capture/apply rejection assertions remain intact. This is test setup stabilization, not a product delay, parent prop transition, or real Git-lock test. Tauri IPC remains mocked; native acceptance and its provenance remain unchanged.

TypeScript, Rust, production build, writing-tools and Typst parser regressions, browser script syntax, and whitespace checks passed. Vite retained its existing large-chunk warning. The lead visually inspected wide and compact dark screenshots under `/tmp/sciencebatch-text-formatting-FtFxqH/`. Graphify extraction and clustering passed sequentially after code stabilized: five files re-extracted, 113 cached, 1,225 nodes, 2,384 edges, and 102 communities. Clustering renamed 91 labels by their hubs; no LLM label refresh was run.
