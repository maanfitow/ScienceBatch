---
name: sciencebatch-review
description: Review a selected LaTeX or Typst project without changing files or compiling by default.
metadata:
  version: "0.1.0"
---

# ScienceBatch Review

Use this skill for a read-only review of a selected project or document. Prefer MCP tools `sciencebatch_project_inspect`, `sciencebatch_read`, and `sciencebatch_search`; use CLI equivalents only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies the project root, stop and report that instead of retrying through CLI. Review only the requested scope and cite source paths and line numbers when supplied. Explain limits and uncertainty instead of inventing references or facts.

Read-only is the default: do not apply changes, save, compile, prepare resources, or modify project metadata. If the user separately requests a fix or PDF, hand that work to the corresponding ScienceBatch skill or follow its explicit authorization and guard rules. Do not create product Visual/Review modes, change Git state, or change fonts as part of document review.

Example read-only review inputs:

```sh
sciencebatch-cli project inspect --project ./paper --json
sciencebatch-cli read --project ./paper --file main.tex --json
sciencebatch-cli search --project ./paper --query '\cite{' --json
```
