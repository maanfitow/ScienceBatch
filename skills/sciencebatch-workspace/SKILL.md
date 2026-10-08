---
name: sciencebatch-workspace
description: Read or edit the explicitly selected live ScienceBatch editor buffer safely.
metadata:
  version: "0.1.0"
---

# ScienceBatch Workspace

Use this skill when the request targets an unsaved or currently open editor buffer. Prefer the MCP workspace tools when connected; use the CLI examples only when MCP is disconnected or the user explicitly authorizes the CLI alternative. If MCP denies the project root or workspace permission, stop and report the denial instead of retrying via CLI. First call `sciencebatch_workspace_instances`, then select one `instanceId` explicitly and use `sciencebatch_workspace` with a named operation. If more than one instance is available, do not choose one implicitly. Never substitute a saved file for a dirty buffer.

Use `inspect` or `read` to obtain the current `documentId`, `expectedRevision`, project root, workspace generation, and dirty state. Before `apply`, include the selected `instanceId`, `documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`. The backend rejects stale revisions (`conflict.revision`), dirty close/project-switch conflicts (`conflict.dirty`), and active Git locks (`git.locked`); reread and replan instead of retrying with invented values. A headless snapshot is private in-memory worker input, not a public snapshot-file format. A save-only request only saves; compilation requires separate explicit task authorization. Do not switch projects, tabs, or engines implicitly, and do not change Git state, fonts, or visual/review modes.

CLI fallback examples use a user-selected instance and roots. `--args` is one JSON object; populate IDs and guards from fresh inspection/read results:

```sh
sciencebatch-cli workspace instances --json
sciencebatch-cli workspace inspect --instance INSTANCE_ID --root ./paper --json
sciencebatch-cli workspace read --instance INSTANCE_ID --root ./paper --args '{"documentId":"DOCUMENT_ID","expectedProjectRoot":"/absolute/path/to/paper","workspaceGeneration":7}' --json
sciencebatch-cli workspace apply --instance INSTANCE_ID --root ./paper --args '{"documentId":"DOCUMENT_ID","expectedProjectRoot":"/absolute/path/to/paper","workspaceGeneration":7,"expectedRevision":12,"start":0,"end":0,"text":"Added text\n"}' --json
```

The `apply` example is a single UTF-16 range edit. Obtain the revision, generation, root, and document ID from the current selected instance; do not copy sample numbers into a real request.
