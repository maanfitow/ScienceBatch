---
name: sciencebatch-bibliography
description: Maintain local BibTeX entries and citations using only verified reference information.
metadata:
  version: "0.1.0"
---

# ScienceBatch Bibliography

Use this skill to inspect or edit local bibliography files and citations. Select the project and bibliography file explicitly. Prefer MCP tools `sciencebatch_read`, `sciencebatch_search`, and `sciencebatch_apply`; use their CLI equivalents only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies the root or write permission, stop instead of retrying through CLI. A disk apply requires the latest `--expected-sha256 HEX`. For a live buffer, select an explicit workspace instance and obtain the current buffer revision before applying.

Use only reference metadata supplied by the user or already present in project sources. Never invent authors, titles, venues, dates, DOIs, URLs, or page ranges. If a required fact is unknown, leave it unresolved and ask or report the gap. A new citation key may be created when needed if it is unique within the bibliography and derived from the supplied, verified reference metadata; never invent reference facts to fill an entry. Preserve existing keys unless the user requests a rename. Apply using the expected file hash/revision (`documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration` for workspace writes). Do not fetch references or prepare compiler resources without explicit authorization. Save-only changes do not compile.

Example local workflow:

```sh
sciencebatch-cli read --project ./paper --file references.bib --json
sciencebatch-cli apply --project ./paper --file references.bib --content-file ./updated-references.bib --expected-sha256 HASH_FROM_READ --json
```
