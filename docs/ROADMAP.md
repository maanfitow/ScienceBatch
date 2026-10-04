# Product Roadmap

This is a proposed order for the next product capabilities, based on the current repository and ScienceBatch's offline desktop focus.

This document owns scheduling. [IDEAS.md](../IDEAS.md) owns proposals and open questions; [SPECS.md](../SPECS.md) owns requirements and acceptance criteria. Stable idea and specification IDs connect the documents. A proposal or draft specification is not a delivery commitment.

## Current product foundation

ScienceBatch already supports local multi-file LaTeX and Typst projects, a nested project explorer, creating files and folders, importing assets, deleting files, project search, and ZIP import/export. The uncommitted `feat/git-status-panel` branch is being extended with central file, asset, and diff tabs, local Git initialization, staging, and branch actions. These changes are not recorded as released.

## Proposed order

1. **Workspace and local Git usability — current slice.** Review central workspace tabs (SPEC-WORK-001), diffs in the editor area (SPEC-GIT-001), Git detection and confirmed initialization (SPEC-GIT-002), and explicit staging and branch actions (SPEC-GIT-003). No remote account or authentication is needed.
2. **Git commits and remote workflows (IDEA-009).** Decide whether to add commits, author identity setup, and remote operations. Ask for authentication only for a requested remote workflow. Keep each repository-changing action user initiated.
3. **CLI, MCP, and Skills (IDEA-008).** Define automation and AI use cases, shared application operations, local context boundaries, and permissions. Investigate a CLI first, followed by MCP tools and reusable Skills, and resolve the compilation trigger policy before implementation.
4. **Real-time collaboration (IDEA-010).** Plan this after deciding how shared state, network hosting, offline edits, and conflict resolution should work. It is the largest architectural change and needs those product decisions first.

**Additional candidate:** Writing tools and editor modes (IDEA-007) now have draft requirements in SPEC-WRITE-001 through SPEC-WRITE-003. Their position relative to Git actions still needs prioritization; within that feature, LaTeX support comes before Typst. Other discovery items remain in IDEAS.md until a concrete slice is specified.

## First implementation slice

The current slice is a sidebar for status and staging controls, a central tab strip for source, diff, image, and PDF views, and safe local branch controls. It must handle folders without Git, protect unsaved source tabs during branch changes, and follow the existing Tauri and React architecture. Commits and remote operations are outside this slice.

This order is a starting recommendation for discussion and can be revised as product needs become clearer.
