# Writing Ribbon Continuation — Antigravity Handoff

Prepared on 2026-10-05. This is a continuation plan and a ready-to-use context packet. It does not certify a release or authorize implementation of every proposed delivery. The user has selected Antigravity as the intended recipient; this document has not been sent through an external agent service.

**Historical integration note (updated 2026-10-06):** The old branch-creation, preservation, and delivery instructions below describe the original handoff only; do not treat them as active instructions. PR #1 (Git) merged into `develop` as `84d9584`, then PR #2 (writing ribbon) merged as `e052afc826b3f9d7c92f272e612b248e8512c46e`. The handoff was not sent via an external service. Native/release QA remains incomplete; see [Writing Ribbon Native Acceptance](WRITING_RIBBON_NATIVE_QA.md) for per-case status. Merge provenance is not native QA evidence.

This packet preserves its original 2026-10-05 context. The uncommitted-work and HEAD notes below describe that earlier handoff; the cited `9d165da` commit is the historical writing-ribbon branch snapshot. The Git and writing-ribbon PRs have since merged into `develop` in that order. For current integration provenance, mitigation, verification, and native evidence, use [Writing Ribbon Final Review](WRITING_RIBBON_FINAL_REVIEW.md). The model-switch cause has since been identified and the regression/verification status is tracked there.

## Repository and working state

- Repository: `/home/mauri/Desktop/Portfolio/ScienceBatch`.
- Active branch: `feat/writing-ribbon`.
- Current HEAD at preparation: `d5d21ae` (`Add commits, cloning, and remote sync`).
- The original requested base was `feat/git-status-panel` at `b3ca9e8`. That is historical context, not an instruction to reset the current checkout.
- The ribbon, clipboard fix, and Typst deliveries include extensive modified and untracked files. They are not committed. Inspect `git status --short`, the actual files, and untracked files before starting. A diff against HEAD alone omits new files.
- Preserve all existing work. Do not reset, clean, stash, replace the branch, or create a fresh checkout from HEAD and assume it contains these features. If using another checkout, explicitly transfer the complete working state first.
- `SPECS.md` is ignored by Git. Its local refinements exist, but tracked documentation under `docs/` is the portable specification and verification record. Do not force-add ignored files without an explicit assignment.
- No commit, push, publish, merge, or dependency/compiler upgrade is assigned.

## Read first

1. `AGENTS.md` and `docs/AGENT_WORKFLOW.md`.
2. `docs/ROADMAP.md` and `docs/TYPST_WRITING_TOOLS.md`.
3. `docs/WRITING_RIBBON_QA.md` and `docs/WRITING_RIBBON_NATIVE_QA.md`.
4. `docs/TYPST_SYMBOLS_QA.md` and `docs/TYPST_STRUCTURES_QA.md`.
5. Local `SPECS.md`, especially SPEC-WRITE-001/002/004, plus `docs/PDF_PREVIEW.md` for the PDF report.

## Implemented behavior

The app uses React, TypeScript, Monaco, Tauri/Rust, isolated compilation workers, and an in-memory compilation pipeline. Local Git supports commits, cloning, and remote synchronization; later hosted/provider integrations remain outside this task.

The compact 36 px writing ribbon contains Symbols, Table, and Matrix. At narrow widths it uses Insert. Compilation, export, and zoom retain their positions. Dropdown menus use the app themes; symbol selection has persistent feedback, a large preview, and a constant Insert button label.

### LaTeX

- Searchable symbols with English names, commands, aliases, categories, and local KaTeX previews.
- Table creation/editing: tabular, three styles, per-column alignment, escaped Text or explicit LaTeX cells, headers, optional table wrapper/caption/label.
- Matrix creation/editing: matrix, pmatrix, bmatrix, Bmatrix, vmatrix, Vmatrix.
- Bounded compatible-source recognition and explicit package insertion with its own Undo operation.
- The schematic table preview uses natural content widths and selected alignment. It does not set the document font or guarantee a match to a document class.

### Typst

- T1: 56 verified built-in mathematical symbols, native identifiers, separate context scanner/generator, and glyph illustrations.
- T2: tables with 1–20 rows and 1–10 columns; Plain/Grid/Booktabs, alignment, semantic headers, literal Text or explicit Typst markup per cell, optional figure/caption/label.
- Matrices with 1–12 rows and columns and six delimiters. Empty cells preserve shape with an empty math string.
- Separate generators and bounded parser; unchanged supported cells retain their source arguments. Nested edits replace the smallest recognized structure. Unsupported outer metadata stays intact.
- Exact Source tab and schematic previews. Typst is never translated into LaTeX or passed to KaTeX.
- Manual tables require explicit supported columns/align/inset/stroke; matrices require an explicit supported delimiter. Dynamic or ambiguous syntax uses Edit source. See T2 QA for exact limits.

### Editing and clipboard

The language-neutral bridge captures document/model identity and version, language/context revision, directional selection, source, editability, and scroll. Changes to source, tabs/models, engine, or locks permanently invalidate a session. Apply one Monaco edit with Undo boundaries; Cancel restores a current selection/focus/scroll; stale ranges never apply to another document. Multiple selections are blocked for writing tools.

Context-menu Copy uses the Tauri clipboard plugin in desktop mode and the browser Clipboard API in browser previews. It is implemented and passes focused/browser checks; real GTK/WebKit system clipboard verification remains open.

## Non-negotiable constraints

- Compile only from the toolbar Compile action or the explicit Ctrl+S/Cmd+S shortcut. Never compile, save, or write document files from previews or source changes.
- Preserve the current PDF until explicit compilation; preserve scroll and zoom through compilation.
- Keep compilation isolated and intermediate files in memory. Do not add compiler assets or packages for QA.
- Keep all UI, accessible labels, comments, tests, errors, and documentation in English.
- Maintain listener cleanup and strict TypeScript. Any future compiler package addition must update linter, autocomplete, and project scanning together.
- Do not discard unsupported source or evaluate user macros in previews.
- Query Graphify before choosing a code change. After code changes, run extraction followed by clustering.
- If operating through Orca, use supervised Tasks and Dispatches. Do not launch an untracked implementation terminal. Antigravity is the user-selected recipient for this continuation; do not silently substitute an agent or model.

## Continuation deliveries

### Delivery A — Native acceptance and model-switch diagnosis

**Initial assignment when this handoff is submitted:** validate the current implementation and diagnose reproducible failures. Produce evidence and a scoped correction proposal before changing production code. Later deliveries remain proposals.

Use the existing working tree. Own the native QA results and a separate model-lifecycle investigation record. Read relevant modules; do not make a general ribbon/editor/compiler refactor.

Run a fresh native `pnpm tauri dev`, with one development-server owner. Port 1420 and the former QA port 1422 were free when this handoff was prepared; check again. If occupied, identify the owner before terminating anything. Do not launch a second Vite server on 1420.

Test both Quick LaTeX and Quick Typst, plus a disposable multi-file project:

- Native context-menu Copy into an independent application, including reverse and multiline selections.
- Symbols, all three table styles, all six matrix delimiters, compatible reopening, unsupported-source fallback, shrink confirmation, Cancel, Undo/Redo, focus, and scroll.
- Retention of an already compiled PDF during insertion/update, followed by exactly one explicit compilation.
- Embedded PDF figures with text/vector/raster content, at least two pages, Fit to width/screen, and 82%, 97%, 112%, 115%, 120% zoom.
- Actual workspace Git locking using a disposable local repository; reject captured sessions after locking or switching/closing tabs and engines.
- Dark, Light, and Monokai at 900×600; complete keyboard operation and themed menus.

Use `docs/WRITING_RIBBON_NATIVE_QA.md` for procedure and evidence. Record Passed, Failed, or Unverified individually, with application state, OS/WebKit version, fixture, actions, screenshots where possible, and precise outcomes. Browser mocks and headless compiler fixtures are not native UI passes. If native input/foreground access is still unavailable, record the limitation and supply a manual checklist; do not repeat the same failed automation or mark it passed.

**Historical model-switch report (updated diagnosis in the final review):** the extended T1 browser run logged a nonfatal unhandled `Canceled` rejection after a long-document/PDF/theme sequence and then switching Typst to LaTeX. Source, Undo, and stale-session assertions passed. The root cause is now traced to Monaco's `WordHighlighter` 50 ms `Delayer` cancellation when a model changes; when the behavior was introduced remains unknown. Browser corroboration compared CDN Monaco 0.55.1 with occurrence highlighting enabled and disabled. The authorized mitigation disables semantic occurrence highlighting under the cursor. Do not globally suppress rejections, patch Monaco internals, add product delays, or upgrade dependencies. See [Writing Ribbon QA](WRITING_RIBBON_QA.md#confirmed-monaco-cancellation-diagnosis-and-mitigation--2026-10-06) for evidence and tradeoff.

Reproduce the exact sequence in `docs/TYPST_SYMBOLS_QA.md`, reduce it to a minimal case, and inspect lifecycle/disposal order. Do not globally suppress Canceled, add arbitrary delays, or upgrade Monaco as a substitute for diagnosis. Any proposed fix needs a scoped assignment and a regression proving both source/session correctness and the intended runtime-error outcome.

**Acceptance:** every native case has evidence or a concrete Unverified reason; each failure has a minimal reproducible case and a proposed file scope. Confirmed fixes, when separately assigned, must preserve source/selection/Undo, editor responsiveness, PDF retention, and on-demand compilation. Keep unrelated PDF and editor-lifecycle issues separate.

### Delivery B — Selection formatting

Prepare a separate specification for Bold and Italic before implementation. Define semantics and engine-specific source adapters, compatible markup/text contexts, nonempty and empty selections, escaping, existing wrappers, and blocked math/code/comment/raw contexts. Start with one selection and supported source only.

Reuse the current bridge and compact ribbon. Each action must be one reversible edit with preserved directional-selection Undo and correct cursor placement. Never modify document-wide style or compile automatically. Only remove/toggle wrappers when a bounded recognizer proves the exact structure; do not guess at arbitrary macros or document rules.

**Acceptance for the future implementation:** both engines pass compatible-context insertion, empty/reverse selection, literal-character handling, current-wrapper behavior, stale-tab/model/engine/lock rejection, Undo/Redo, keyboard/theme/narrow-window checks, and unchanged PDF before explicit compilation.

### Delivery C — Editor font appearance

Specify editor appearance separately from document typography. Inspect existing font-size controls and persistence first; do not duplicate them. Propose a small settings surface for the editor font family and existing size behavior, with an availability/fallback policy and local persistence.

**Acceptance for the future implementation:** appearance changes only Monaco options, preserves the model, source, selection, scroll, and Undo history, persists locally, and handles unavailable fonts. No source changes, compilation, downloads, or implicit font installation.

### Delivery D — Document typography

Start with an investigation and specification. Determine which font choices the existing LaTeX and Typst engines can actually use offline. Define source changes, main-document eligibility, existing declarations and academic-template interactions, scope, availability checks, and an explicit preview/apply flow.

**Acceptance for a future approved implementation:** only verified options are offered, changes are explicit and reversible, existing declarations/templates are respected, subfiles cannot silently modify the main file, unavailable fonts produce a useful explanation, and compiler/linter/completion/scanner parity is maintained. Font installation, new bundles, cross-engine conversion, and compiler changes need their own assignment.

## Relevant modules

- `src/App.tsx`: active workspace/engine, ribbon and editor integration.
- `src/components/EditorView.tsx`: Monaco setup, model paths, bridge lifecycle, eligibility, locks.
- `src/components/WorkspaceTabs.tsx`: source/diff/asset tabs and identity transitions.
- `src/editor/writingBridge.ts` and `src/types/writing.ts`: safe session/edit contracts.
- `src/components/writing/WritingRibbon.tsx`: ribbon, symbols, language-specific dialog dispatch, modal focus lifecycle.
- `src/components/writing/TypstStructureDialog.tsx`: Typst table/matrix controls and schematic previews.
- `src/components/writing/WritingSelect.tsx`, `WritingSelect.css`, `writing.css`: themed dropdowns and layouts.
- `src/editor/writing/`: separate catalogs, adapters, context scanners, generators, parsers, validators, and LaTeX package handling.
- `src/types/typstWriting.ts`: Typst options and parsed source snapshots.
- `src/editor/typstCompletion.ts`: native symbol/structure completions.
- `src/editor/editorClipboard.ts`: Copy routing and selection snapshots.
- `src/components/PdfView.tsx`: retained PDF canvas/scroll/zoom. Inspect before proposing changes.
- `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`: existing clipboard plugin registration and permission; no new backend work is assigned by this handoff.

## Prior verification and required checks

At T2 completion, TypeScript, Rust, production build, focused frontend tests, real Monaco browser probes with mocked IPC, and explicit embedded Typst fixtures passed. This is historical verification evidence; use the [final review](WRITING_RIBBON_FINAL_REVIEW.md) for the latest branch checks and any still-pending results. All 56 symbols were checked in T1; T2 compiled 15 fixtures with zero warnings. The large build-chunk warning and PDF.js Node legacy-build warning remain recorded.

Native Copy, retained/embedded PDF zoom, and actual Git-lock UI are Unverified. The Linux GUI provider previously lacked focus/hotkey support, captured a covering window, and failed Monaco accessibility editing with an is_editable_text error. Do not treat that failed attempt as a product failure.

Re-run checks against the state you actually examine or modify:

```sh
pnpm tsc --noEmit
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/test-writing-tools.mjs
node scripts/test-writing-bridge.mjs
node scripts/test-editor-clipboard.mjs
node scripts/test-typst-writing-tools.mjs
node scripts/test-typst-structure-generation.mjs
node scripts/test-typst-structure-parser.mjs
node scripts/test-pdf-rendering-helpers.mjs
node scripts/test-git-workspace.mjs
git diff --check
```

When validating engine syntax, use a matching existing/built local binary through the explicit verifier, not the UI preview:

```sh
node scripts/verify-typst-symbols.mjs src-tauri/target/debug/sciencebatch
node scripts/verify-typst-structures.mjs src-tauri/target/debug/sciencebatch
```

After code module changes, run these sequentially:

```sh
graphify extract . --code-only
graphify cluster-only .
```

Last T2 graph: 1,117 nodes, 2,264 edges, 90 communities. Temporary browser probes under `/tmp` are supplementary local evidence and may not survive another machine/session; their recorded scenarios must remain reproducible without depending on those files.

## Return report

Report the working-state baseline, inspected/modified files, individual native outcomes, minimal reproduction and stack for each failure, proposed correction scope, check results/warnings, preserved invariants, and remaining limitations. Do not claim a release, native pass, sent handoff, commit, or publication that did not occur. Await a scoped assignment before implementing deliveries B–D.
