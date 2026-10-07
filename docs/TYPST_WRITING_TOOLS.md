# Typst Writing Tools — SPEC-WRITE-004

**Status:** Deliveries T1 (Symbols) and T2 (tables, matrices, and compatible editing) are implemented on `feat/writing-ribbon`. See the [T1 verification record](TYPST_SYMBOLS_QA.md) and [T2 verification record](TYPST_STRUCTURES_QA.md); native release checks remain open.

## Purpose and delivery order

Extend the existing compact writing ribbon to editable Typst sources. Reuse its interaction patterns and Monaco editing session, while keeping language syntax, context recognition, source generation, and structure recognition separate from LaTeX. Ship Symbols first, then Table/Matrix creation and compatible structure editing. Bold/Italic text formatting is now specified separately in [Basic Text Formatting](TEXT_FORMATTING.md) and has been authorized as a scoped follow-up. Its planner/compiler and real-Monaco browser checks passed; native interaction remains unverified. Font selection remains future work in separate specifications.

The LaTeX implementation passes automated and browser checks. Native Copy, PDF retention, embedded-PDF zoom, and Git-lock interaction remain release checks; an unavailable automation provider must be recorded as unverified, not passed. Those checks do not require inventing a PDF fix or changing document typography.

The current local Cargo resolution uses `typst-embed` 0.1.0 with Typst 0.15.1. The T1 verification confirmed this resolved version without upgrading the compiler. Validate the curated symbols and canonical structure fixtures against the existing embedded engine before enabling the tools. Do not upgrade the compiler as part of this feature.

## Shared interaction and editing contract

- Keep the 36 px ribbon, **Symbols**, **Table**, **Matrix**, compact **Insert** menu, selected-symbol preview, constant **Insert** label, themed dropdowns, and existing dialog focus behavior. Preserve compilation, export, and zoom positions.
- Add an explicit language discriminator to writing state and use it to select the adapter. Enable tools only for an active editable `.typ` source or Typst scratchpad. Disable them for LaTeX, BibTeX, assets, diffs, multiple cursors, and workspace locks when the Typst adapter is selected. LaTeX retains its own adapter and behavior.
- Capture document identity, model identity/version, directional selection, source, and scroll before moving focus. Reject a stale session after any document, source, model, engine, or editability change. Never reuse a range on another tab.
- Insert or update with one Monaco edit and Undo boundaries. Undo restores the replaced source and previous directional selection; Redo reapplies the complete edit. Cancel restores focus, selection, and scroll for a current session. Confirm places the cursor after the insertion or replacement.
- Never save, compile, import packages, or change fonts implicitly. Keep the current PDF visible until an explicit Compile action. Preview interactions cannot call Rust compilation or compiler IPC.
- Keep every product label, message, accessible name, source comment, test, and document in English. Support keyboard operation and the three existing themes at 900×600 and larger sizes.

## Context recognition

Use a bounded lexical scanner for Typst markup, math, and code, including nested groups, strings, escapes, line/block comments, and raw spans/blocks. Recognize top-level markup and confidently identified content blocks as markup; recognize inline and display equations as math. Treat code expressions, strings, raw content, labels/references, URLs, incomplete delimiters, and uncertain contexts as unavailable for insertion.

Typst uses one `$` delimiter for both inline and display math; whitespace immediately inside both ends makes an equation display math. Do not apply LaTeX's `$`/`$$` rules. Selections must remain within a single compatible context and must not cross a mode delimiter. A lexical classifier does not resolve user-defined functions or evaluate code.

Insertion inside comments, code expressions embedded in math, and unknown nested constructs must fail with an actionable message. For recognized structure editing, use the structure parser's full range independently of the insertion classifier. This allows reopening a supported `#table(...)` while ordinary insertion into its code arguments remains blocked.

## Delivery T1 — Symbols

### Catalog and search

Maintain a separate curated Typst catalog of built-in mathematical symbols, with English names, aliases, category, Unicode glyph, native symbol identifier, and insertion syntax. Use the existing six categories: **Greek letters**, **Operators**, **Relations**, **Arrows**, **Sets and logic**, and **Miscellaneous**.

Start with symbols corresponding to the simple mathematical symbols already offered by the LaTeX picker. Verify each native identifier; do not generate mappings by removing a LaTeX backslash. Include `alpha`, `arrow.r`, `infinity`, simple sum/integral symbols, and verified variants. Exclude argument-taking functions, accents, custom bindings, imported packages, and expression templates.

Search matches English names, aliases, and native identifiers. Normalize an optional `sym.` or `#sym.` prefix for searching. LaTeX spellings may be search aliases, but never insertion source.

### Insertion and preview

In markup, insert inline math such as `$alpha$`, `$arrow.r$`, or `$infinity$`. In a math region, insert only the native identifier. Add whitespace at a boundary when required to avoid joining the identifier to adjacent identifier characters or field-access dots; do not add LaTeX command terminators. Reject a position inside an existing token instead of splitting it silently.

Show the selected glyph at large size, its English name, and the exact context-sensitive source. Use the local Unicode glyph plus an accessible text label as a symbol illustration. It is not a compiled Typst preview and does not claim to reproduce document fonts. Do not pass Typst syntax to KaTeX. Unsupported or missing glyphs keep their source/name visible. Built-in symbols require no package insertion or package control.

The catalog describes built-in symbol meanings. User bindings and document rules can affect final output; the assistant does not evaluate them or claim to resolve shadowed names.

### Acceptance

- Find and insert alpha, right arrow, and infinity using names, aliases, native identifiers, categories, keyboard, and pointer.
- Check empty search, no results, persistent selection feedback, and the large preview.
- Check markup, inline math, display math, identifier boundaries, escaped dollars, comments, raw content, code, and cross-mode selections.
- Check reverse selection, Cancel, scroll, Undo/Redo, tab/model/engine changes, and Git-lock invalidation with real Monaco.
- Verify no LaTeX source, save call, compile call, package insertion, or PDF replacement occurs.

## Delivery T2 — Tables, matrices, and compatible editing

### Tables

Start at 3×3; allow 1–20 rows and 1–10 columns. Create the built-in `table` function with a fixed integer column count, row-major cells, and explicit left/center/right alignment for each column. Keep Plain, Grid, and Booktabs as familiar UI styles: **Booktabs** is a rule arrangement implemented with Typst's table rules, not a LaTeX package dependency.

- **Plain:** no strokes or extra rules.
- **Grid:** a uniform 0.5 pt stroke on cell boundaries.
- **Booktabs:** no cell strokes, 0.8 pt top/bottom horizontal rules, and a 0.5 pt rule below an enabled header.
- Default to left alignment, Plain, 5 pt cell inset, and no header/wrapper. Header is optional, bold, and represented by `table.header` for semantics. Dimensions include the header row; permit a header-only table without inserting duplicate coincident rules.
- Text mode is the default for each cell. Serialize text as an escaped Typst string inside `text(...)` in a content block; literal markup characters must stay literal. A source representation such as `[#text("A # B")]` must display the original text. Do not apply LaTeX escaping.
- Per-cell **Typst** mode accepts balanced markup content. Keep nested groups, strings, and complete math regions intact. Reject malformed content, line breaks, comments, and any unbalanced delimiter that could escape the containing cell. Top-level commas inside a content block are text; they are not automatically invalid.
- **More options** exposes style and an optional `figure` wrapper with a caption and label. The wrapper may omit its caption when it has no label. Labels require a caption and use a conservative identifier grammar with letters first, then letters/digits/hyphen/underscore. Put the label after the figure. Caption defaults to literal text; custom numbering, placement, and caption markup are deferred.
- Use natural column sizing, not automatic full-page stretching. Show a schematic preview with the selected rules, alignment, and header; raw Typst cells are shown as source. Explain that final font/size depend on document rules. **Source** shows the exact generated code.

### Matrices

Start at 2×2 with parentheses; allow 1–12 rows and columns. Generate the built-in `mat` expression, using commas for cells and semicolons for rows at the outer argument level. Offer **None**, **Parentheses**, **Brackets**, **Braces**, **Single bars**, and **Double bars**, with explicit delimiters rather than relying on inherited defaults.

Cells contain balanced Typst math expressions. An empty cell generates an empty math string, `""`, to retain the matrix shape. Reject unbalanced groups, comments, line breaks, alignment points, code escapes, and outer commas/semicolons that would change the matrix structure. Allow separators inside balanced nested function calls; validation must track nesting and strings.

In markup, wrap the matrix in display math with whitespace at both ends, for example `$ mat(1, 2; 3, 4) $`. Inside math, insert only `mat(...)` and preserve the existing equation. Explicit delimiter fixtures must cover `none`, parentheses, brackets, braces, and both bar styles against the embedded engine.

Use a schematic matrix preview showing cell source and selected delimiters, plus exact generated source. Do not translate arbitrary Typst expressions to LaTeX for KaTeX rendering. Compiled preview, macro evaluation, and document-font matching are deferred.

### Editing and round trips

Offer **Edit table** or **Edit matrix** only for a supported recognized structure. Parse bounded tokens, groups, strings, escapes, and outer separators; do not use one global regular expression. Recognize the canonical generated grammar and equivalent manual source with harmless whitespace/trailing-comma differences. Manual tables require explicit supported column count, alignment, 5 pt inset, and stroke; matrices require an explicit supported delimiter. The parser refuses inherited defaults it cannot verify. Direct built-in calls only are supported; aliases, spreads, loops, dynamic dimensions, merged cells, custom tracks, custom cell positioning, augmentation, and unknown structural arguments require manual source editing with a contextual explanation in the live ribbon hint.

At the cursor, filter parsed candidates to source ranges that contain the cursor, including range endpoints, before choosing the smallest structure. For an unclosed call, retain its conservative source range through end of file. An unrelated nested/nearby figure table outside the actual candidate range must not become an edit target. If an outer wrapper or its metadata is unsupported but the inner table or matrix is compatible, preserve the existing **Edit table**/**Edit matrix** action and leave the outer metadata unavailable; never discard that wrapper. If the structure itself is incompatible, show a non-clickable contextual reason in the existing live ribbon hint, with the full message available as its title, in both layouts. Do not show an **Edit source** button; the user edits that source manually.

Preserve raw supported cell content as opaque source without evaluating functions. Preserve unmodified cells byte-for-byte, excluding formatting belonging to the regenerated outer structure. Do not infer effective values from `set`/`show` rules or claim a schematic preview matches them. Refuse uncertain structural syntax and internal comments rather than rewriting them.

Replacing a nested table/matrix changes only that recognized call. Replacing a recognized generated wrapper may include its caption and label; replacing a matrix with a recognized generated display wrapper may include its delimiters. Never consume adjacent prose or another structure. If an outer wrapper is unsupported but its inner table or matrix is compatible, offer editing the inner structure with outer metadata unavailable and preserve the wrapper. If the inner structure itself is incompatible, show the contextual reason and require manual source editing. Do not offer a clickable source-edit action, and never discard the wrapper.

Growing dimensions retains existing cells. Shrinking across populated cells requires an in-dialog confirmation identifying the affected rows/columns. Canceling that confirmation keeps dimensions and content.

### Acceptance

- Insert populated and empty tables in all three styles; check per-column alignment, literal `#`, brackets, dollars, quotes, backslashes, headers, caption/label, and exact source.
- Insert each matrix delimiter in markup and existing math; check empty cells and nested functions with internal separators.
- Reopen, modify, and undo generated structures and compatible manual equivalents. Check surrounding source and unmodified raw cell contents remain intact.
- Unsupported, malformed, stale, multi-selection, and locked sessions never change source. Validate shrink confirmation and Cancel.
- Check real Monaco Undo/Redo, focus, scroll, keyboard navigation, narrow layouts, all themes, and retained PDF before explicit compilation.

## Architecture, ownership, and verification

Keep `writingBridge.ts` language-neutral. Introduce a small typed adapter contract for eligibility/context, catalog/source generation, recognition, validation, and preview description. Keep language-specific option types; do not force Typst delimiters or figure options into LaTeX environment/package fields. Hide package actions for Typst. Make EditorView eligibility depend on source language instead of calling the LaTeX classifier unconditionally. Select the adapter in the ribbon using the active editor state; engine changes invalidate open sessions.

Place Typst catalog, scanner, generators, and parser in dedicated frontend modules. Reuse dialog/grid/themed-select components where practical, without a general ribbon rewrite. Update Typst completion and language registrations for emitted identifiers. Typst has no equivalent of the current LaTeX linter; do not add entries to the LaTeX registry or imply one already exists.

Assign T1 and T2 separately to `sciencebatch_implementer`, with explicit files and acceptance criteria. The coordinator owns this specification, adapter decisions, diff review, and final verification. Preserve the existing branch and uncommitted LaTeX work. No commit, push, publish, or merge is assigned by this specification.

Required checks per delivery:

- Focused scripts for context boundaries, string encoding, generation, structure recognition/rejection, and session invalidation.
- Real Monaco checks for selection direction, Undo/Redo, focus, scrolling, tab/engine changes, and lock behavior.
- Explicitly compiled syntax fixtures through the existing embedded Typst engine. Fixture verification is separate from preview interactions.
- `pnpm tsc --noEmit`, `pnpm build`, and `cargo check --manifest-path src-tauri/Cargo.toml`.
- `graphify extract . --code-only` followed by `graphify cluster-only .` after code changes.
- LaTeX regression checks and the [native QA procedure](WRITING_RIBBON_NATIVE_QA.md).

## Deferred work

Document/editor font selectors, live or compiled assistant previews, custom package catalogs, evaluation of user macros, multiline table cells, arbitrary table layouts, merged cells, matrix augmentation, cross-engine conversion, Visual/Review modes, and compiler/font bundle changes require separate scope. Bold/Italic controls are now authorized separately under [Basic Text Formatting](TEXT_FORMATTING.md); their browser verification passed and native interaction verification remains pending.

## Primary syntax references

These references describe Typst syntax; the assistant limits and interaction rules above are ScienceBatch product decisions.

- [Typst syntax and modes](https://typst.app/docs/reference/syntax/)
- [Built-in symbol identifiers](https://typst.app/docs/reference/symbols/sym/)
- [Tables and semantic headers](https://typst.app/docs/reference/model/table/)
- [Matrix syntax and delimiters](https://typst.app/docs/reference/math/mat/)
