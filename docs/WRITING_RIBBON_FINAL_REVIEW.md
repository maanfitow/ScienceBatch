# Writing Ribbon Final Review

Review state as of 2026-10-06. This report covers the LaTeX and Typst writing ribbon and Bold/Italic work. PR #1 (Git) merged into `develop` first as `84d9584`, followed by PR #2 (writing ribbon) as `e052afc826b3f9d7c92f272e612b248e8512c46e`; this is integration provenance, not a release certification. Native QA statuses below remain in force.

## Branch and integration

The original review requested integration of `feat/git-status-panel` followed by `feat/writing-ribbon`; that instruction is historical and complete. PR #1 (Git) was merged first as `84d9584`, and PR #2 (writing ribbon) was merged second as `e052afc826b3f9d7c92f272e612b248e8512c46e`. The prior branch snapshots and remote observations in the original review are historical, not current branch instructions. Merge order alone does not certify native acceptance or release readiness.

## Implemented behavior

The compact ribbon provides LaTeX Symbols, Table, Matrix, and a responsive Insert menu, with searchable symbols, local KaTeX previews, table/matrix creation and compatible editing, and explicit package insertion. Typst T1 adds 56 native mathematical symbols. Typst T2 adds three table formats, six matrix delimiters, compatible editing, source preservation, and schematic previews. The shared Monaco editing bridge validates document/model/version/language/context revision and selection direction, preserves scroll/focus, supports Undo/Redo, and rejects stale sessions. Context-menu Copy routes through the native clipboard plugin or browser Clipboard API.

The user has authorized scoped Bold/Italic controls for compatible text in both engines. The current worktree includes native ribbon buttons and a conservative source planner for canonical LaTeX `\textbf{}` / `\textit{}` and Typst `#strong[]` / `#emph[]` wrappers. It supports selection wrapping, empty-wrapper insertion, recognized-wrapper removal, and compatible nesting through a single bridge edit; protected or ambiguous contexts remain unavailable. The governing source contract is [Basic Text Formatting](TEXT_FORMATTING.md). Font appearance and document font controls remain outside this authorization.

Writing tools make in-memory editor changes. They do not save or compile automatically. Compilation remains explicit through the toolbar Compile action or Ctrl+S/Cmd+S; the current PDF remains visible until compilation is requested. Compiler isolation and in-memory intermediate handling remain in place.

## Monaco cancellation mitigation

Antigravity traced unhandled Monaco `Canceled` errors to `WordHighlighter`: cursor movement queues work through a 50 ms `Delayer`, and changing the model during that interval cancels its promise. The earlier Codex browser corroboration supplied for this assignment used CDN Monaco 0.55.1 and reported five `Canceled` errors for five rapid changes with `occurrencesHighlight: 'singleFile'`, then zero with `'off'`; its error collector was not recorded. The locally installed `monaco-editor` package is 0.52.2 and is distinct from the CDN runtime used in the browser probes. When the behavior was introduced remains unknown.

The authorized mitigation sets `occurrencesHighlight: 'off'` in the Monaco options in `src/components/EditorView.tsx`. Its accepted tradeoff is that semantic occurrence highlighting under the cursor is disabled. The mitigation does not suppress global errors, patch Monaco internals, add arbitrary product delays, or upgrade dependencies.

The lead also ran a focused browser probe against the current mitigated source using CDN [Monaco 0.55.1](https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/editor/editor.main.js). Effective highlighting initially was `'off'`; five model changes after explicitly setting `'singleFile'` produced one `Canceled` page error. Five changes after setting `'off'` produced zero page errors. The separate browser `unhandledrejection` collector was empty. Thus the positive-control cancellation was seen by the page-error collector, while the unhandled-rejection collector remained empty; these results must not be combined into one count or described as zero errors for the whole probe.

The lead then ran [scripts/test-monaco-model-switch.mjs](../scripts/test-monaco-model-switch.mjs) successfully against CDN Monaco 0.55.1 and repeated it after adding the Bold/Italic UI. Five positive-control model changes produced one `Canceled` page error and zero other runtime errors. Five mitigated changes produced zero runtime errors and zero unhandled rejections. In the real App UI, two engine switches and two tab switches preserved exact source, rejected stale apply attempts including after round trips, retained focus, and passed Undo/Redo. Application runtime errors, unhandled rejections, and unexpected compile/save calls were all zero. Tauri IPC was mocked. The second workspace tab was seeded through test-only React state/ref setup; actual `WorkspaceTabs` buttons and product handlers drove the tab changes. The edits used the published bridge, not the full writing picker catalog UI. This verifies the browser workflow and mitigation; it does not certify native clipboard behavior or a real Git operation/filesystem lock. On the post-UI rerun, one browser startup attempt timed out after 60 seconds; a subsequent read-only diagnostic and fresh test run passed with no page, console, or request errors. The startup timeout's cause was not established.

To reproduce from the repository root, start Vite in terminal 1 with `pnpm dev --host 127.0.0.1 --port 1422 --strictPort`, then run `node scripts/test-monaco-model-switch.mjs` in terminal 2. The script closes its browser in `finally`; the caller stops the Vite server. Current host defaults use Playwright at `/home/mauri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs` and Chromium at `/home/mauri/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Other hosts can set `PLAYWRIGHT_MODULE` (absolute path or package specifier), `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and `SCIENCEBATCH_TEST_URL`. The run requires the Playwright bundle, a browser, and CDN access for Monaco; it adds or upgrades no dependency. Earlier attempts failed in test-only initialization/IME selector setup; those setup issues were corrected before the passing runs and did not indicate product regressions. This browser result does not replace the separate native checklist. See the detailed diagnosis and history in [Writing Ribbon QA](WRITING_RIBBON_QA.md#confirmed-monaco-cancellation-diagnosis-and-mitigation--2026-10-06) and [T1 verification](TYPST_SYMBOLS_QA.md#historical-model-switch-investigation).

## Verification evidence

### Existing ribbon and Monaco mitigation

All required checks listed below passed during this continuation. TypeScript and the production build were rerun after applying the Monaco option; Rust, helper scripts, and compiler verifiers passed earlier in this run and do not cover the frontend option change.

- `pnpm tsc --noEmit`
- `pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `node scripts/test-writing-tools.mjs`
- `node scripts/test-writing-bridge.mjs`
- `node scripts/test-editor-clipboard.mjs`
- `node scripts/test-typst-writing-tools.mjs`
- `node scripts/test-typst-structure-generation.mjs`
- `node scripts/test-typst-structure-parser.mjs`
- `node scripts/test-pdf-rendering-helpers.mjs`
- `node scripts/test-git-workspace.mjs`
- `node scripts/verify-typst-symbols.mjs src-tauri/target/debug/sciencebatch` — 56 symbols, 23,401 PDF bytes, zero warnings.
- `node scripts/verify-typst-structures.mjs src-tauri/target/debug/sciencebatch` — 15 fixtures, 31,409 PDF bytes, zero warnings.

The production build reports the existing Vite large-chunk warning; PDF.js reports its existing Node legacy-build warning. Both checks completed successfully. The reproducible real-Monaco model-switch regression passed, including an independent stable rerun. Its source fixtures were `Untitled.typ` and `Secondary.typ`; see the browser scope and mock boundaries above.

Before the Bold/Italic changes, Graphify was refreshed sequentially. `graphify extract . --code-only` passed, re-extracting two code files and reporting 1,124 nodes, 2,257 edges, and 94 communities. `graphify cluster-only .` then passed with 94 communities and updated graph reports. That historical graph snapshot predates the formatting code.

### Bold/Italic delivery — automated verification passed

The source planner passed `node scripts/test-text-formatting.mjs`. Local probes also passed six LaTeX declaration forms covering starred and unbraced optional-default definitions, comments between macro arguments, and normal text following each definition. These forms are recognized without rewriting later ordinary text.

The explicit compiler fixture command `node scripts/verify-text-formatting.mjs src-tauri/target/debug/sciencebatch` passed: LaTeX compiled 5 fixtures to 11,198 PDF bytes, and Typst compiled 6 fixtures to 18,913 PDF bytes; both reported zero warnings. The fixtures include escaped `*` and `#` and Typst's native partial-word case. `pnpm tsc --noEmit` and `pnpm build` passed after the latest source corrections; Vite emitted its existing large-chunk warning. The lead also reports `cargo check --manifest-path src-tauri/Cargo.toml` and the eight unchanged core/bridge/clipboard/Typst/PDF/Git scripts passed. Typst compiler verifiers passed again: 56 symbols with 23,401 PDF bytes and zero warnings; 15 structure fixtures with 31,409 PDF bytes and zero warnings. PDF.js reported its existing Node legacy-build warning.

Compatibility limits confirmed in review: canonical wrappers only; at most 100,000 UTF-16 code units and 32 relevant wrappers; partial selections inside a wrapper of the same kind are disabled; soft newlines are allowed but blank paragraphs are blocked. Only supported source declarations are recognized; unmatched enclosing LaTeX groups and unknown/protected commands inside an unwrapped body direct users to edit source. Style indicators report recognized source wrappers and do not predict computed PDF fonts.

The lead independently ran scripts/test-text-formatting-browser.mjs successfully against real CDN Monaco 0.55.1 in the mounted App, EditorView, and WritingRibbon. Both engines passed pointer Bold, keyboard Italic, directional and empty selections with typing, nested toggles and complete wrapper removal, source preservation, focus, and single-edit Undo/Redo. Protected contexts and multiple selections rejected edits. Actual engine and workspace-tab switches rejected stale sessions, including after returning. Symbols, Table, and Matrix opened and canceled successfully. The second tab was seeded through test-only App state/ref setup, then switched with actual WorkspaceTabs buttons. Runtime/page/console/request errors and unhandled rejections were zero. Exactly one explicit Compile invocation occurred, with zero formatting save/write calls.

The read-only fixture directly sets the mounted EditorView readOnlyRef and Monaco option and supplies WritingRibbon props/state. It rejects capture and stale apply while locked and permits fresh capture after unlocking. It does not exercise a parent prop transition, the App Git-lock callback, or a real Git operation. Tauri invoke/event IPC is mocked. A 4,536-byte PDF was compiled separately by the real isolated worker before browser startup and delivered only after the actual Compile button click. Formatting preserved the rendered canvas pixels, dimensions, and 115% zoom.

The final scroll fixture uses the product default wordWrap: 'on'. Short-line scroll remained 530 to 530 with horizontal offset 0. Long wrapped content remained at scroll top 1043 and content height 2527; both selection endpoints remained at viewport position 325, with zero measured reflow. Earlier apparent drift was sampled during smooth-scroll animation. The corrected fixture centers with the public ScrollType.Immediate API and waits for stable samples; no product delay was introduced. The separate ordinary-typing probe confirming an overridden wordWrap: 'off' returns to 'on' is historical and did not measure scroll preservation.

The lead visually reviewed wide and 900×600 screenshots in dark, light, and monokai themes under /tmp/sciencebatch-text-formatting-LUborv/. Bold/Italic, Insert, pressed states, and keyboard focus remained visible without ribbon overflow. The script starts and closes its own Vite server on an available localhost port with strict: false. To reproduce, run node scripts/test-text-formatting-browser.mjs after building the debug worker. Other hosts can set PLAYWRIGHT_MODULE, PLAYWRIGHT_CHROMIUM_EXECUTABLE, and SCIENCEBATCH_COMPILE_WORKER; the browser requires CDN access. Screenshots use a unique temporary directory.

Final Graphify refresh passed sequentially after code and scripts stabilized: graphify extract . --code-only re-extracted 5 files with 113 cached, producing 1,218 nodes, 2,397 edges, and 100 communities. graphify cluster-only . passed with 100 communities and updated the graph reports; hub changes renamed 91 labels. No LLM label refresh was run. The pure planner regression, final browser/compiler script syntax checks, and full git diff --check passed. Native GTK/WebKit formatting, embedded PDF figures, actual Git-operation locks, and the other native gaps retain their individual statuses in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md).

## Native evidence and remaining checks

Antigravity reported native Copy, PDF retention during writing, explicit compilation, zoom/navigation, responsive themes, and readOnly/session guards as successful. The detailed report path and run metadata were not available when this document was prepared. Codex did not independently repeat those native checks. The reported outcomes are summary-only evidence; they do not certify every native subcase.

The embedded PDF figure fixture containing text, vector lines, and raster content remains unverified. A real Git operation causing a workspace lock remains unverified; mocked lock bridge tests do not establish it. Native Cancel/Undo/Redo interaction and controlled clipboard failure feedback also remain unverified by the available summary. Browser tests and compiler fixtures do not replace these desktop checks. See the [native acceptance record](WRITING_RIBBON_NATIVE_QA.md) for individual provenance and status.

## Ribbon spacing and command colors follow-up — 2026-10-06

Bold/Italic now sit beside the insertion and compatible-edit controls with a measured 12 px gap on wide layouts. LaTeX `\\textbf` and `\\textit`, already known to completion and linting, now use the existing keyword styling in all three themes. The lead independently passed the expanded real-Monaco browser regression, inspected wide/compact screenshots, and confirmed comment/verbatim/math token behavior and unrelated function styling. TypeScript, Rust, build, pure formatting, script syntax, and diff checks passed. Graphify was refreshed sequentially after the final changes: two files re-extracted, 116 cached, and unchanged totals of 1,218 nodes, 2,397 edges, and 100 communities. Detailed colors, fixtures, mock boundaries, and evidence are in [Writing Ribbon QA](WRITING_RIBBON_QA.md#ribbon-spacing-and-latex-formatting-colors--2026-10-06). Native acceptance remains open.

## Contextual manual editing follow-up — 2026-10-06

The focus-only **Edit source** action was removed in both layouts and languages. Unsupported structures now explain the need for manual source editing in the contextual live hint; compatible **Edit table**/**Edit matrix** actions remain. A reproduced Typst figure fallback incorrectly returned an inner table even for a cursor in surrounding prose. Candidate ranges now must contain the cursor before the smallest structure is selected; conservative unclosed-call ranges and compatible inner editing remain intact.

The lead independently passed the expanded real-Monaco browser regression: same-model cursor movement scoped the warning correctly; supported table/matrix editing and cancellation preserved source in wide and compact layouts. Existing formatting, focus, Undo/Redo, stale sessions, colors, scroll, and PDF retention also passed, with zero runtime errors/rejections and zero formatting save/write calls. TypeScript, Rust, build, writing-tools/parser tests, browser syntax, and whitespace checks passed. Graphify extraction then clustering passed with 1,225 nodes, 2,384 edges, and 102 communities. The read-only check still uses a simulated fixture, and native gaps remain open. Detailed evidence is in [Writing Ribbon QA](WRITING_RIBBON_QA.md#contextual-manual-editing-and-typst-cursor-containment--2026-10-06).

## Scope boundaries

Bold/Italic is now an authorized, scoped delivery under [Basic Text Formatting](TEXT_FORMATTING.md). Planner, compiler, TypeScript, Rust, build, browser, and Graphify verification passed. Native acceptance remains open with the provenance and cases above. Font controls, dependency upgrades, and compiler/package changes remain outside scope. No commit, push, publication, merge, PR creation, or native release certification is included.
