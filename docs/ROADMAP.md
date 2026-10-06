# Product Roadmap

This document recommends an order for future product work based on the current repository and ScienceBatch's offline desktop focus. It records a proposal for discussion; it does not approve new implementation scope.

[IDEAS.md](../IDEAS.md) owns product proposals and open questions. [SPECS.md](../SPECS.md) owns technical requirements and acceptance criteria. Document order does not imply approval or delivery commitment.

## Current product foundation

ScienceBatch supports local multi-file LaTeX and Typst projects, a nested project explorer, file and folder management, asset import, project search, ZIP import and export, central source/asset/diff/PDF tabs, and local Git workflows. Git support is partially completed: its first application stage is implemented and verified on the feature branch. This is not a release. See [IDEA-009](../IDEAS.md#idea-009-local-git-actions), [SPEC-GIT-004](../SPECS.md#spec-git-004-commits-cloning-remotes-and-transfer), and [Git workflow guidance](GIT_WORKFLOWS.md). Provider accounts/OAuth, API repository creation, pull requests, merge requests, hosted authenticated-push validation, and cross-platform QA remain pending and are parked for a later Git phase.

## Proposed next priorities

1. **Validate PDF preview behavior in native Tauri.** Use a real document with embedded PDF figures and inspect the affected pages after Fit to width/screen and several zoom changes. Also confirm writing-tool edits leave the current PDF visible until explicit compilation, and verify the Git-lock UI when the native QA environment is available. The missing-content report is intermittent and not a confirmed current failure. Fix only if it reproduces. See [Bug 1](../BUGS.md#bug-1-pdf-preview-intermittently-loses-content-while-zooming), the [PDF preview investigation](PDF_PREVIEW.md), and the [writing ribbon QA record](WRITING_RIBBON_QA.md).
2. **Complete native validation of the LaTeX writing ribbon.** The searchable symbol picker and table/matrix builders from [SPEC-WRITE-002](../SPECS.md#spec-write-002-symbol-picker) and [SPEC-WRITE-001](../SPECS.md#spec-write-001-table-and-matrix-builders) are implemented and pass browser/Monaco acceptance checks on the feature branch. Native PDF-retention and Git-lock UI checks remain open; see [Writing Ribbon QA](WRITING_RIBBON_QA.md). This implementation is not a release.
3. **Complete native validation of the Typst writing ribbon.** Deliveries T1 (Symbols) and T2 (Table/Matrix creation and compatible editing) from [SPEC-WRITE-004](TYPST_WRITING_TOOLS.md) are implemented on the feature branch. Separate language modules preserve the safe Monaco session and compact interface. See [T1 verification](TYPST_SYMBOLS_QA.md) and [T2 verification](TYPST_STRUCTURES_QA.md). Complete the remaining [native acceptance procedure](WRITING_RIBBON_NATIVE_QA.md) before release; investigate the recorded Monaco model-switch cancellation separately.
4. **Follow with basic formatting and font controls.** Specify selection formatting separately from editor appearance and document font configuration. Document fonts need engine-specific source, availability checks, and respect for existing document templates. These features are deferred until the writing ribbon supports both engines.
5. **Revisit CLI, MCP, and Skills.** [IDEA-008](../IDEAS.md#idea-008-cli-mcp-and-skills) needs concrete use cases and a decision on how external compilation would fit the on-demand compilation policy before implementation.
6. **Keep Visual/Review modes and real-time collaboration later.** Resolve document synchronization, review-state, hosting, offline editing, and conflict behavior before prioritizing [SPEC-WRITE-003](../SPECS.md#spec-write-003-views-and-editing-modes) or [IDEA-010](../IDEAS.md#idea-010-real-time-collaboration).

These priorities are recommendations for discussion. Reorder them when user needs or validation results warrant it.
