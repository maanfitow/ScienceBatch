---
name: sciencebatch-project
description: Inspect, create, and organize an explicitly selected ScienceBatch project while preserving its files and root boundary.
metadata:
  version: "0.1.0"
---

# ScienceBatch Project

Use this skill when the user asks to inspect, create, or organize a ScienceBatch project. First select the requested disk project or live workspace explicitly; if more than one fits, ask which one. For disk projects, use `sciencebatch_project_inspect` or `sciencebatch-cli project inspect --project DIR --json`. A project creation request uses `sciencebatch_project_create` or `sciencebatch-cli project create --project DIR --engine latex|typst --json`.

Examples:

```sh
sciencebatch-cli project inspect --project ./paper --json
sciencebatch-cli project create --project ./new-paper --engine latex --main main.tex --json
```

Prefer MCP project operations when connected. Use the CLI only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies a root or permission, stop and report the denial; never retry via CLI to bypass it. Project CLI commands require `--project`; pass `--project .` when the intended project is the current directory. Inspection is read-only. Create or organize files only when the user requested that change, and report the exact paths created or changed. Never cross an allowed root, follow symlinks, install packages, change Git state, or compile as a side effect. Save-only requests remain save-only.
