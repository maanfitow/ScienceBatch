---
name: sciencebatch-write
description: Write or edit requested LaTeX or Typst source in a selected project or live editor buffer.
metadata:
  version: "0.1.0"
---

# ScienceBatch Write

Use this skill for a requested content change to a LaTeX or Typst document. Select the exact project/file or live buffer before editing. Prefer MCP when connected; use CLI examples only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies a project root or write permission, stop and report the denial instead of retrying through CLI. For disk files, use `sciencebatch_read`/`sciencebatch_apply` or `sciencebatch-cli project read/apply`; CLI apply requires `--expected-sha256 HEX`, one `--file REL` target, and `--content-file PATH` containing the complete UTF-8 replacement. For live editor content, select `sciencebatch_workspace_instances`, then use `sciencebatch_workspace` with an explicit `instanceId` and `operation: "read"` or `"apply"`.

Read the current source and obtain its SHA-256 through `sciencebatch_read`/`project read` or the current document revision through workspace `read`. Preserve surrounding structure and engine syntax, and make only the requested change. Disk apply replaces one file atomically and returns its new hash. Workspace apply must include `documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`. A hash/revision mismatch returns a conflict; reread and replan rather than overwriting. Do not invent references, identifiers, or project facts. A save or source edit never compiles; compile only when the user's task explicitly authorizes compilation. Do not broaden into fonts, Git, or Visual/Review modes.

Example guarded disk edit:

```sh
sciencebatch-cli read --project ./paper --file main.tex --json
sciencebatch-cli apply --project ./paper --file main.tex --content-file ./updated-main.tex --expected-sha256 HASH_FROM_READ --json
```
