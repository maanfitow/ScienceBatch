# SPEC-CLI-001: Project and Automation CLI

**Status:** Implemented on `feat/automation-interfaces`. Linux CLI, MCP, Skills, and focused native workspace verification are recorded in [Automation QA](AUTOMATION_QA.md). Local commits are authorized; publication, merging, and cross-platform release certification remain separate.

**Origin:** [IDEA-008](../IDEAS.md#idea-008-cli-mcp-and-skills). Companion deployment, server setup, Skill installation, and examples are in [Automation Interfaces](AUTOMATION.md).

## Purpose and boundaries

Provide headless access to project inspection, creation, reading, search, guarded source updates, diagnostics, explicit compilation, and explicit resource preparation. All operations act on a user-selected disk project or an explicitly selected workspace snapshot. The CLI and MCP server share the same application operations and JSON contract.

The default desktop binary and GUI startup remain unchanged. The public CLI is `sciencebatch-cli`; its private worker mode is not a supported public command. The MCP server uses `rmcp` 3.5.1 over stdio. It is a separate process and never launches the GUI. Live editor access goes through an explicitly selected running-instance workspace bridge.

### On-demand compilation policy

Compilation may start only from the desktop Compile button, desktop Ctrl+S/Cmd+S, an explicit `sciencebatch-cli compile` command, or an explicit MCP compile tool invocation. Skills may compile only when the user's task authorizes compilation, such as a request to export a PDF. Inspection, project creation/opening, source edits, saves, diagnostics, resource preparation, server startup, and Skill installation do not compile. The private worker is an execution detail and does not add a trigger.

Resource preparation is a separate explicit operation. It may download compiler resources only after explicit CLI invocation or when an MCP server was launched with `--allow-resource-download`; it never runs as part of inspection, diagnostics, compilation, startup, or a Skill install. Project create/apply are file mutations. CLI invocations are explicit; MCP project mutations are disabled unless the server is launched with `--allow-write`.

## Public CLI syntax

Every operation command requires `--json`. The JSON envelope uses `schemaVersion: 1` and is described below.

```text
sciencebatch-cli project inspect --project DIR [--engine latex|typst] [--main REL] --json
sciencebatch-cli project create --project DIR --engine latex|typst [--main REL] --json
sciencebatch-cli project read --project DIR --file REL --json
sciencebatch-cli project search --project DIR --query TEXT --json
sciencebatch-cli project apply --project DIR --file REL --content-file PATH --expected-sha256 HEX --json
sciencebatch-cli read --project DIR --file REL --json
sciencebatch-cli search --project DIR --query TEXT --json
sciencebatch-cli apply --project DIR --file REL --content-file PATH --expected-sha256 HEX --json
sciencebatch-cli diagnostics --project DIR [--engine latex|typst] [--main REL] --json
sciencebatch-cli compile --project DIR [--engine latex|typst] [--main REL] [--output PDF] --json [--overwrite] [--timeout 1..900]
sciencebatch-cli resources status --json
sciencebatch-cli resources prepare [--engine latex|typst] --json
sciencebatch-cli workspace instances --json
sciencebatch-cli workspace OPERATION --instance ID [--root DIR ...] [--args JSON] --json
sciencebatch-cli mcp serve [--root DIR ...] [--allow-write] [--allow-resource-download]
```

Every project CLI command requires `--project`; pass `--project .` when the process working directory is the intended project. Workspace CLI roots default to the launch directory when `--root` is omitted. MCP `--root` may be repeated; if none is supplied, the server launch directory is its sole allowed root. Resolve roots once to canonical directories and reject every operation outside the allowed set. Project creation uses an explicit destination and engine. `project.apply` replaces one text source file only after `expected-sha256` matches the current bytes; it never edits multiple files in one request. CLI input uses `--content-file PATH` or `--content TEXT` for short input. Both replace the complete UTF-8 file content and obey the same size and hash rules. MCP passes the complete content string directly.

Engine selection is strict and shared by both engines: explicit engine, then valid project metadata, then selected main-file extension. Main-file selection is explicit `--main`, metadata `mainFile`, canonical `main.tex`/`main.typ` for a known engine, then a unique matching source candidate. Conflicts, malformed metadata, missing configured mains, ambiguous candidates, and incompatible extensions return an error; never guess the first file. `project.inspect` may return both engines and a sorted candidate list with `engine` and `mainFile` null when selection is implicit and ambiguous. `diagnostics` and `compile` require an unambiguous compatible main.

## Operations

| Operation | Behavior | Writes / compilation |
| --- | --- | --- |
| `project.inspect` | Return project metadata, engine/main selection, sorted recursive file inventory, entry count, and stable warnings/errors. Includes `.sciencebatch.json` but not source contents. | Read-only; never compiles. |
| `project.create` | Create a new project at an explicit non-existing destination with a selected engine and canonical starter file; refuse an existing project. | Creates only the requested project files; never compiles. |
| `project.read` | Read one explicit project-relative text file and return content plus SHA-256 for optimistic concurrency. | Read-only. Binary assets are summarized/limited rather than decoded as source. |
| `project.search` | Search project text files for a literal query; return sorted file/line/context matches and truncation status under bounds. | Read-only. |
| `project.apply` | Replace one explicit text file atomically only when the caller's expected SHA-256 still matches. Return the new SHA-256. | Writes one requested file; never compiles. |
| `diagnostics` | Validate project config, path containment/readability, engine/main compatibility, snapshot traversal, and non-empty main input. | Preflight only; no compiler or editor linter. Never compiles. |
| `compile` | Compile an explicitly selected LaTeX or Typst disk project or explicit in-memory workspace snapshot and return structured compiler diagnostics. If `--output` is supplied, export the final PDF there. | Explicit compilation; final PDF export only when an output path is supplied. No intermediate source or TeX artifact writes. |
| `resources.status` | Report locally available engine resources and cache state. | Read-only; never downloads. |
| `resources.prepare` | Explicitly prepare selected engine resources within fixed time/byte budgets; resumable after interruption. | Network/cache writes are allowed only for this explicit operation. Never compiles. |

Diagnostics are preflight checks, not syntax analysis and not the Monaco linter. Only compilation reports engine syntax and missing-dependency failures. Diagnostics for both LaTeX and Typst use the same preflight scope. Never describe a preflight pass as proof that a document will compile.

Project inspection sorts relative paths using `/` separators. It excludes hidden files/directories except root `.sciencebatch.json`, never follows symlinks/reparse points, and fails rather than returning a partial inventory when traversal/readability fails. The inventory includes file/directory kind, byte size when applicable, and engine association for `.tex`/`.typ` source files. Do not return project file contents from inspection.

`project.apply` is deliberately narrow. Validate the project-relative path, reject symlinks/reparse points and root escapes, verify the exact expected hash immediately before replacement, preserve the previous file on failure, and return a conflict instead of overwriting concurrent edits. File operations must remain within one allowed root even when the path is nested. Project writes do not change Git state.

## Limits and offline behavior

Limits are hard bounds. Reject oversize work with a structured error; never silently truncate a source, snapshot, worker response, log, or PDF.

| Resource | Limit |
| --- | ---: |
| Project entries | 10,000 |
| Directory depth | 64 |
| Text source/file | 8 MiB |
| Asset read | 32 MiB |
| Headless workspace snapshot | 128 MiB |
| Returned PDF | 64 MiB |
| Private worker request/response | 256 MiB |
| Captured logs | 1 MiB |
| Compile timeout | 120 seconds default; 1–900 seconds allowed |
| Resource preparation | 8 GiB or 30 minutes, whichever comes first; resumable |

The workspace bridge additionally caps each newline-framed JSON request/reply at 256 MiB. [Automation Interfaces](AUTOMATION.md) documents resource/format caches, transaction locks, registry files, and allowed staging writes. Compilation is offline by default and does not install or download packages. Resource downloads happen only through `resources.prepare` after its explicit authorization. A cold missing cache must yield a structured actionable error without falling back to network access. Automation bibliography uses in-memory BibTeX; external tools such as Biber return `dependency.external_tool_unsupported`.

No compilation source copies, TeX intermediates, or compiler logs may be written to disk anywhere. The only allowed writes are the exact files requested through `project.create`/`project.apply` or an explicit workspace save, the explicitly requested final PDF, and documented shared resource/format caches. `project.apply` may stage only the caller-provided replacement content within the destination filesystem; it must be bounded, preserve the existing file on failure, and never copy or retain the old source as a compilation artifact. An atomic staging file may be used for final PDF export; it must be bounded, private to the destination operation, removed on failure, and preserve an existing destination until the new PDF is validated.

## JSON contract

Each handled `--json` invocation writes exactly one JSON object and newline to stdout. Progress belongs on stderr. stdout contains no prose, compiler logs, or PDF bytes. The stable envelope is:

```json
{
  "schemaVersion": 1,
  "command": "project.read",
  "ok": true,
  "data": {},
  "diagnostics": [],
  "error": null
}
```

The empty `data` shown above is a shape illustration, not a valid success payload. Every operation defines its data fields below. On failure, `ok` is false, `data` is null, and `error` contains stable `code`, English `message`, and optional structured `details`. `diagnostics` is always an array. File paths in results are project-relative with `/`; locations that cannot be determined are null, never guessed. No operation returns source contents except `project.read` and the explicitly requested compiler result metadata.

Success data fields:

| Command | Fields |
| --- | --- |
| `project.inspect` | Canonical `project`, nullable `engine`/`mainFile`, sorted `enginesFound`, sorted `mainCandidates`, sorted `files` (`path`, `kind`, nullable `sizeBytes`, `engines`), `scope: "project"`. |
| `project.create` | `project`, `engine`, `mainFile`, `createdFiles`. |
| `project.read` | `project`, `file`, `content`, `sha256`, `encoding: "utf-8"`. |
| `project.search` | `query`, `matches` (`file`, one-based `line`, `context`), `truncated`. |
| `project.apply` | `project`, `file`, `sha256`, `bytesWritten`. |
| `diagnostics` | `scope: "preflight"`, `coverage`, `project`, `engine`, `mainFile`. |
| `compile` | `project`, `engine`, `mainFile`, nullable `output`, `pdfWritten`, `pdfByteLength`. With no `--output`, return the compiled result and diagnostics with `output: null` and `pdfWritten: false`; with `--output`, report the normalized destination and `pdfWritten: true` only after successful export. |
| `resources.status` | `engines`, per-engine `available`/`cached` state, `cacheLocation` without secret data. |
| `resources.prepare` | `engine`, `prepared`, `bytesDownloaded`, `resumable`, `cacheLocation`. |

Diagnostics have `severity`, stable `code`, `message`, `origin`, nullable `file`, nullable one-based `line` and `column`, and nullable `suggestion`. `origin` is `preflight` or `compiler`. Preflight has no syntax coverage. Compiler line/file attribution is nullable if upstream logs do not establish it.

JSON-RPC requests to the workspace bridge use `{schemaVersion:1,id,token,operation,args}`. Replies use `{schemaVersion:1,id,ok,data?,error?}` and share the envelope error shape. Tokens never appear in events or UI responses. The server implements MCP over stdio with `rmcp` 3.5.1; MCP tool wrappers call the same application operations and do not duplicate business rules. Public tool names are `sciencebatch_project_inspect`, `sciencebatch_project_create`, `sciencebatch_read`, `sciencebatch_search`, `sciencebatch_apply`, `sciencebatch_diagnostics`, `sciencebatch_compile`, `sciencebatch_resources_status`, `sciencebatch_resources_prepare`, `sciencebatch_workspace_instances`, and `sciencebatch_workspace`. The last tool accepts an operation from `inspect`, `read`, `openProject`, `openFile`, `activate`, `apply`, `save`, `close`, `compile`, or `cancel`.

## Exit codes and error mapping

| Exit | Meaning |
| ---: | --- |
| 0 | Operation completed; warnings may be present. |
| 1 | Completed diagnostics with error findings or completed compiler document failure. |
| 2 | Usage, malformed config, unresolved ambiguity, unsupported engine, permission denied, conflict, or rejected root/path boundary. |
| 3 | Filesystem/cache/resource limit or output I/O failure. |
| 4 | Worker crash, malformed worker protocol, or unexpected internal failure. |
| 124 | Compile timeout; worker terminated and reaped. |
| 130 | User interruption; worker terminated and reaped. |

Stable codes include `usage.invalid_argument`, `project.config_invalid`, `project.engine_ambiguous`, `project.main_ambiguous`, `project.main_missing`, `project.main_engine_mismatch`, `engine.unsupported`, `path.outside_project`, `path.symlink_rejected`, `path.output_conflicts_input`, `permission.write_required`, `edit.hash_conflict`, `conflict.revision`, `conflict.dirty`, `git.locked`, `project.main_empty`, `compile.document_failed`, `compile.engine_error`, `compile.engine_warning`, `resources.download_denied`, `cache.unavailable_offline`, `resource.limit_exceeded`, `io.project_unavailable`, `io.output_failed`, `worker.crashed`, `worker.protocol_invalid`, `worker.busy`, `internal.unexpected`, `operation.timeout`, and `operation.interrupted`. Error prose is not stable API. `edit.hash_conflict` returns exit 2; reread and replan rather than retrying with a new hash automatically.

A compile is successful only when the worker reports success, returns a non-empty valid PDF within 64 MiB, and has no error-severity diagnostics. A completed unsuccessful compilation returns exit 1 even if no PDF bytes exist. A worker claiming success without a valid PDF is a protocol failure (exit 4). Timeout/interruption takes precedence and kills/reaps the child. An independent CLI/MCP compile must not cancel or supersede a desktop compile.

## Path, workspace, and concurrency safety

Canonicalize every allowed root. Reject `..` escapes, absolute paths where a relative path is required, symlinks/reparse points, path cycles, and any resolved dependency or output target outside the selected root policy. Root checks must be enforced in the compiler worker/engine read path, not only at the CLI boundary. Tectonic 0.17.0 with `FilesystemIo::new(&filesystem_root, false, true, hidden_input_paths)` does not provide this containment by itself; tests must prove confinement for engine-level reads.

A headless workspace snapshot is an explicit in-memory input chosen by the caller, never an automatic replacement for disk files. Preserve dirty state and per-buffer revision/hash. Do not invent revision values. Workspace mutations identify one `documentId` and send `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`; disk edits send `expectedSha256`. Reject stale state. If the workspace has a dirty buffer, report the conflict and do not silently choose between unsaved memory and disk. A workspace request must include an explicit running-app `instanceId` when using the live bridge.

The bridge binds only to `127.0.0.1` on an ephemeral port. Each running app owns one private registry file at `app-local-data/workspace-bridge/<instanceId>.json` with `schemaVersion:1`, `instanceId`, `host`, `port`, `token`, and `pid`. A client selects the instance explicitly; if multiple instances are available, there is no default. The bridge never launches the GUI. Mutations require `documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`; stale revision returns `conflict.revision`, a dirty close/project switch returns `conflict.dirty`, and an active repository mutation returns `git.locked`. The backend enforces the lock and the frontend rejects stale UI actions. Saving targets one selected document and never compiles; compile/cancel are explicit operations. Workspace compile requests carry a `jobId` and `timeoutSeconds`, derive the engine from the selected main file, and may use live source-tab overlays.

The CLI workspace adapter mirrors the live bridge operations. `workspace instances` lists eligible instances without returning their tokens. Other workspace commands require `--instance`; `--args` must contain a JSON object, and repeatable `--root` values constrain project access. Without `--root`, only the command's current directory is allowed. Use IDs, project roots, workspace generations, and revisions from current responses. A guarded live edit passes `documentId`, `expectedProjectRoot`, `workspaceGeneration`, `expectedRevision`, UTF-16 `start`/`end` offsets, and replacement `text`. Reread after any conflict before planning another edit.

## Implementation and acceptance gates

This implementation is approved for the current branch. Do not expand it into broad font management, Git operations, automatic compile/watch, document-wide visual/review modes, collaboration, or arbitrary macros. The eight Skills are separate, versioned, explicitly installed artifacts and never auto-install globally.

Acceptance must cover: headless execution with both engines; project inspect/create/read/search/apply; strict roots and symlink confinement; stable hashes and concurrent-write conflicts; empty/malformed/ambiguous projects; JSON cleanliness for every exit class; offline resource status and explicitly authorized resumable preparation; LaTeX and Typst compile success/failure; output overwrite protection; timeout/interruption/worker crash containment; workspace selection with multiple app instances, tokens omitted from outward events, dirty-buffer and Git-lock conflict handling; and desktop Compile/Ctrl+S plus current PDF, cancellation, progress, and listener behavior unchanged.

**Implementation limits:** Numeric caps above are required acceptance bounds. A release report must state which commands/scenarios were actually exercised and any gaps. Existing native writing-ribbon statuses in the QA records remain unchanged; this automation implementation does not certify them.
