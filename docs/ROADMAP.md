# Product Roadmap

This document recommends an order for future product work based on the current repository and ScienceBatch's offline desktop focus. It records a proposal for discussion; it does not approve new implementation scope.

[IDEAS.md](../IDEAS.md) owns product proposals and open questions. [SPECS.md](../SPECS.md) owns technical requirements and acceptance criteria. Document order does not imply approval or delivery commitment.

## Current product foundation

ScienceBatch supports local multi-file LaTeX and Typst projects, a nested project explorer, file and folder management, asset import, project search, ZIP import and export, central source/asset/diff/PDF tabs, and local Git workflows. Git support is partially completed: its first application stage is implemented and verified on the feature branch. This is not a release. See [IDEA-009](../IDEAS.md#idea-009-local-git-actions), [SPEC-GIT-004](../SPECS.md#spec-git-004-commits-cloning-remotes-and-transfer), and [Git workflow guidance](GIT_WORKFLOWS.md). Provider accounts/OAuth, API repository creation, pull requests, merge requests, hosted authenticated-push validation, and cross-platform QA remain pending and are parked for a later Git phase.

## Proposed next priorities

1. **Validate PDF preview behavior in native Tauri.** Use a real document with embedded PDF figures and inspect the affected pages after Fit to width/screen and several zoom changes. The missing-content report is intermittent and not a confirmed current failure. Fix only if it reproduces; if the viewer passes this check, proceed directly to the symbol picker. See [Bug 1](../BUGS.md#bug-1-pdf-preview-intermittently-loses-content-while-zooming) and the [PDF preview investigation](PDF_PREVIEW.md).
2. **Start a small writing-tools slice: searchable LaTeX symbol picker.** Build on [SPEC-WRITE-002](../SPECS.md#spec-write-002-symbol-picker): search and insert at the cursor, support undo, and do not compile automatically. This is a proposal, not approved implementation. A current Toolbar inspection found no existing symbol-picker or table/matrix-builder control.
3. **Add table and matrix builders.** If the symbol picker proves useful, refine and prioritize [SPEC-WRITE-001](../SPECS.md#spec-write-001-table-and-matrix-builders), including supported contexts, safe editing of existing source, and package behavior.
4. **Revisit CLI, MCP, and Skills.** [IDEA-008](../IDEAS.md#idea-008-cli-mcp-and-skills) needs concrete use cases and a decision on how external compilation would fit the on-demand compilation policy before implementation.
5. **Keep Visual/Review modes and real-time collaboration later.** Resolve document synchronization, review-state, hosting, offline editing, and conflict behavior before prioritizing [SPEC-WRITE-003](../SPECS.md#spec-write-003-views-and-editing-modes) or [IDEA-010](../IDEAS.md#idea-010-real-time-collaboration).

These priorities are recommendations for discussion. Reorder them when user needs or validation results warrant it.
