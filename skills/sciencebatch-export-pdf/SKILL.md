---
name: sciencebatch-export-pdf
description: Compile an explicitly selected LaTeX or Typst project and export its final PDF on request.
metadata:
  version: "0.1.0"
---

# ScienceBatch Export PDF

Use this skill only when the user requests compilation or PDF export. Treat that request as explicit authorization for a compile operation. Select the project root and main document; use `--project .` when the current directory is the intended project. Prefer `sciencebatch_compile` when MCP is connected. Use `sciencebatch-cli compile` only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies a root or permission, stop instead of retrying through CLI. `--output` is optional for a compile-only result and required to export a PDF. Never choose a destination that overwrites an existing file unless the user authorizes `--overwrite`. Use the requested workspace instance when compiling a live buffer.

Compile from saved disk files or the explicitly selected live workspace. A headless snapshot is private in-memory input; do not invent or save a public snapshot-file format. Never compile on save, edit, inspection, or project opening. Preserve existing output unless overwrite is explicitly authorized. Resource preparation or download requires separate explicit authorization. Report engine, main file, diagnostics, and exact output path; do not claim success without a successful structured response. Do not add fonts, change Git state, or create review/visual modes.

Examples:

```sh
# Compile in memory and return diagnostics without writing a PDF:
sciencebatch-cli compile --project . --main main.tex --json
# Export only when the user requested a PDF and the destination is clear:
sciencebatch-cli compile --project . --main main.tex --output ./main.pdf --json
```
