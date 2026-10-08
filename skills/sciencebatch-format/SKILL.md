---
name: sciencebatch-format
description: Apply requested source formatting, symbols, tables, or matrices in LaTeX and Typst.
metadata:
  version: "0.1.0"
---

# ScienceBatch Format

Use this skill for a bounded formatting request involving basic text styling, supported symbols, tables, or matrices. Select one explicit project file or live buffer. Prefer connected MCP operations; use CLI examples only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies the root or write permission, stop instead of retrying through CLI. Use `sciencebatch_read` then `sciencebatch_apply` (or CLI `project read` and guarded `project apply`) for saved files. For live content, select `sciencebatch_workspace_instances`, then call `sciencebatch_workspace` `read` and `apply` for an explicit `instanceId`.

Preserve unsupported or ambiguous source and make one guarded edit using the hash/revision read immediately before planning. CLI disk apply uses `--expected-sha256 HEX`; workspace apply includes `documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`. On a conflict, reread and replan. Do not reformat unrelated content, add packages, alter document-wide typography, or infer custom macros. Formatting and save operations do not compile; compile only when the user's task explicitly authorizes it. Do not expand into fonts, Git, or Visual/Review modes.

Example for a requested source formatting change:

```sh
sciencebatch-cli read --project ./paper --file main.tex --json
sciencebatch-cli apply --project ./paper --file main.tex --content-file ./formatted-main.tex --expected-sha256 HASH_FROM_READ --json
```
