# Basic Text Formatting

**Integration provenance:** Bold/Italic for LaTeX and Typst is included in PR #2, merged into `develop` as `e052afc826b3f9d7c92f272e612b248e8512c46e` after PR #1 (Git, `84d9584`). Browser/compiler results below remain as recorded; native formatting interaction remains unverified.

## Scope and authorization

On 2026-10-06 the user authorized a separate Bold/Italic delivery before final native writing-ribbon QA. This extends the earlier Monaco-mitigation assignment, which excluded formatting. Font controls remain separate. The original branch and work-preservation constraints applied to that completed delivery; it was included in PR #2 and is now integrated into `develop`. Native formatting acceptance remains open.

## Source contract

| Action | LaTeX source | Typst source |
| --- | --- | --- |
| Bold | `\textbf{content}` | `#strong[content]` |
| Italic | `\textit{content}` | `#emph[content]` |

These are text operations. They do not add packages, choose document fonts, modify editor appearance, or introduce mathematical formatting commands. Typst's functions support partial words, while shorthand emphasis syntax is restricted to word boundaries. `strong` increases the current font weight; `emph` uses native emphasis semantics, including toggling inherited italics. Document `set`/`show` rules can customize emphasis. Indicators describe recognized source wrappers, not computed PDF typography. See the [Typst strong reference](https://typst.app/docs/reference/model/strong/), [Typst emphasis reference](https://typst.app/docs/reference/model/emph/), and [LaTeX font selection guide](https://www.latex-project.org/help/documentation/fntguide.pdf).

The first delivery uses a conservative source planner. It does not evaluate user macros or Typst code. Existing symbol and structure context classifiers retain their current restrictions; any formatting-specific recognition is isolated from those tools.

- A nonempty compatible text selection is wrapped without changing its contents. The inner text stays selected in the original direction.
- An empty selection inserts an empty wrapper and puts the caret inside, ready for typing. No placeholder text is added.
- A complete recognized wrapper or its complete body can be selected to remove that wrapper. A caret inside a compatible body can also remove its enclosing wrapper. Content and directional selection are preserved.
- A partial nonempty selection inside the same formatting wrapper is unavailable. The user is directed to select the complete formatted text rather than silently rewriting a broader range.
- Bold and Italic can be combined through compatible nested canonical wrappers. Unsupported shorthand, custom source, or ambiguous boundaries use direct source editing.
- Mathematics, comments, raw/verbatim content, code, strings, URLs, labels, preamble content, multiple selections, malformed groups, and protected or multi-paragraph ranges are unavailable. The planner returns a concrete English reason and makes no change.

## Interaction and safety

Bold and Italic are native labeled buttons with visible focus and `aria-pressed` state. They remain accessible at compact widths while the existing insertion tools use Insert. Button activation preserves the Monaco selection and returns focus after applying an edit. No new keyboard shortcut is assigned.

Availability is derived from the current editable document and a fresh source plan, independently of math-symbol insertion availability. Formatting is disabled while a writing assistant is open. Read-only state, workspace locks, multiple selections, and invalid sessions block edits.

Every action captures a fresh `WritingEditorBridge` session and applies one bounded edit through that bridge. Document/model/version/language/context identity and editability are checked immediately before mutation. Undo and Redo treat the operation as one edit. Writing actions never save, compile, invoke compiler IPC, or replace the current PDF.

## Acceptance and verification

The scoped implementation is present in the working tree. Pure source-planner verification has passed with `node scripts/test-text-formatting.mjs`. The isolated compiler fixtures also passed with `node scripts/verify-text-formatting.mjs src-tauri/target/debug/sciencebatch`: LaTeX compiled 5 fixtures to 11,198 PDF bytes, and Typst compiled 6 fixtures to 18,913 PDF bytes; both reported zero warnings. `pnpm tsc --noEmit` and `pnpm build` passed after the latest source changes; Vite emitted its existing large-chunk warning.

The real-Monaco formatting browser acceptance passed with `node scripts/test-text-formatting-browser.mjs` against CDN Monaco 0.55.1 (`https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/editor/editor.main.js`). The lead independently repeated the passing run. It covered LaTeX/Typst pointer Bold and keyboard Italic, reverse/empty selections and typing, nested toggle/full wrapper removal, single-edit Undo/Redo, focus, protected-context guards, actual engine/tab stale-session rejection, picker open/Cancel, and theme and pressed/focus/disabled states at 900×600. It reported zero runtime errors and unhandled rejections, exactly one explicit Compile invocation, and zero formatting saves/writes. A 4,536-byte PDF, compiled separately by the isolated worker before browser startup, was delivered through mocked Tauri IPC only after the actual Compile button click. Formatting then preserved its canvas pixels, dimensions, and 115% zoom.

The read-only fixture directly sets the actual `EditorView` `readOnlyRef` and Monaco option and supplies published `WritingRibbon` props/state. It does not exercise a real `EditorView` prop transition, the App Git-lock callback, or a real Git operation. The product's `wordWrap: 'on'` default was used. Short-line scroll stayed at top offset 530 before/after with horizontal offset 0; long wrapped content stayed at top 1043 and content height 2527, with the selection viewport anchor at 325 before/after and zero reflow. Earlier apparent scroll drift came from sampling during Monaco's smooth-scroll animation. The final fixture centers with public `ScrollType.Immediate` and waits for stable samples; no product delay was added. The separate `wordWrap: 'off'` to `'on'` typing probe remains historical and did not measure scroll.

The root visually reviewed four browser screenshots: `wide-bold-pressed.png`, `compact-900x600-dark.png`, `compact-900x600-light.png`, and `compact-900x600-monokai.png`, under `/tmp/sciencebatch-text-formatting-LUborv/`. The ribbon controls, focus, and themes were visible without overflow. The Vite harness owns and closes its server on an available localhost port with `strict: false`.

Final `pnpm tsc --noEmit`, `pnpm build`, pure planner test, explicit compiler fixtures, `node --check scripts/test-text-formatting-browser.mjs`, `node --check scripts/verify-text-formatting.mjs`, and full `git diff --check` passed. The Rust check and eight unchanged core/bridge/clipboard/Typst/PDF/Git scripts passed; both Typst compiler verifiers passed again. Final Graphify refresh passed sequentially: extraction reprocessed 5 files, with 113 cached, reporting 1,218 nodes, 2,397 edges, and 100 communities; clustering passed with 100 communities, updating the graph reports. Hub changes renamed 91 community labels; no LLM label refresh was run. Native Bold/Italic input and retained-PDF acceptance remain unverified, as do the separately tracked embedded-PDF figure, real Git-lock, and clipboard-failure cases. See [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md) and the [final review](WRITING_RIBBON_FINAL_REVIEW.md) for scope and provenance.

Browser tests do not certify native GTK/WebKit input, clipboard, embedded PDF figure rendering, or a real Git workspace lock. Final outcomes and compatibility limits are recorded in the [branch review](WRITING_RIBBON_FINAL_REVIEW.md), with native provenance and pending cases in [Native Writing Ribbon Acceptance](WRITING_RIBBON_NATIVE_QA.md).
