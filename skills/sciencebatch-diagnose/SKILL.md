---
name: sciencebatch-diagnose
description: Explain project preflight or compiler diagnostics and make requested, guarded source fixes.
metadata:
  version: "0.1.0"
---

# ScienceBatch Diagnose

Use this skill to explain or fix a ScienceBatch project diagnostic. Prefer connected MCP tools `sciencebatch_project_inspect` and `sciencebatch_diagnostics`; use CLI equivalents only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies the root or required permission, stop and report the denial rather than retrying via CLI. Preflight checks configuration and project health; it does not prove LaTeX or Typst syntax validity or reproduce the editor linter. Compiler diagnostics require an explicit compile operation.

Compile only when compilation is explicitly authorized by the user's task. Separate preflight findings from compiler diagnostics, quote stable codes and file/line data as returned, and never guess missing locations. For a requested fix, reread the affected source and use `sciencebatch_apply` or CLI `project apply --expected-sha256 HEX`; workspace changes additionally require `documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`. On conflict, reread and replan. Report unverified assumptions and do not install packages, download resources, change Git state, or rewrite unrelated source.

Examples:

```sh
sciencebatch-cli diagnostics --project ./paper --engine latex --main main.tex --json
# Run only when the task authorizes compiler diagnostics:
sciencebatch-cli compile --project ./paper --engine latex --main main.tex --json
```
