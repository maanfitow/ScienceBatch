# ScienceBatch Automation Interfaces

**Status:** Implemented together on `feat/automation-interfaces`: the companion CLI, MCP server, live workspace bridge, and eight versioned Skills. [Automation QA](AUTOMATION_QA.md) records Linux verification and remaining release limits. Local commits are authorized; publication and merging remain separate.

## Choose an interface

- Use the desktop app for interactive editing and its Compile button or Ctrl+S/Cmd+S shortcut.
- Use `sciencebatch-cli` for explicit headless project and compiler operations.
- Use the MCP server when the agent host can launch a local stdio process. MCP calls the same operations as the CLI and can additionally address a selected live editor instance.
- Use a ScienceBatch Skill to route a task into the right operation. A Skill does not grant write, network, or compile permission by itself.

Disk projects and live editor workspaces are separate data sources. Select the intended project or app instance explicitly. Project CLI commands require `--project`; pass `--project .` when the current directory is the intended project. Workspace CLI allowed roots and MCP roots default to their launch directory only when no `--root` is supplied. Multiple roots and multiple app instances do not imply a default target.

## Install the Skills explicitly

The repository contains eight Skills in the versioned `skills/manifest.json` package, currently version `0.1.0`:

- `sciencebatch-project`
- `sciencebatch-write`
- `sciencebatch-format`
- `sciencebatch-bibliography`
- `sciencebatch-diagnose`
- `sciencebatch-export-pdf`
- `sciencebatch-review`
- `sciencebatch-workspace`

For a standalone bundle, run `pnpm package:skills`. This creates `dist/sciencebatch-skills.tar.gz` with the Skills, installer, and their operation documentation. Extract it, then install to a destination chosen by the user or administrator:

```sh
pnpm package:skills
mkdir -p /tmp/sciencebatch-skills
tar -xzf dist/sciencebatch-skills.tar.gz -C /tmp/sciencebatch-skills
node /tmp/sciencebatch-skills/scripts/install-sciencebatch-skills.mjs --destination "$CODEX_HOME/skills"
```

When `CODEX_HOME` is not configured, choose an explicit local Skills directory such as `~/.codex/skills`. The installer has no default destination and makes no host configuration changes. It refuses existing matching Skill folders unless `--overwrite` is supplied; overwrite is limited to matching ScienceBatch Skills and its own package manifest. Installing the files does not configure an MCP connection, alter global settings, or trigger an application operation. The package version is recorded in each Skill's metadata and manifest. A new version can be reviewed and installed explicitly.

## CLI examples

Inspection is read-only and never compiles:

```sh
sciencebatch-cli project inspect --project ./paper --json
sciencebatch-cli project inspect --project ./notes --engine typst --main chapters/main.typ --json
sciencebatch-cli project read --project ./paper --file chapters/methods.tex --json
sciencebatch-cli project search --project ./paper --query 'sample size' --json
# Short aliases for the same read/search/apply operations:
sciencebatch-cli read --project ./paper --file chapters/methods.tex --json
sciencebatch-cli search --project ./paper --query 'sample size' --json
```

Create a project or apply a guarded source replacement only when requested:

```sh
sciencebatch-cli project create --project ./new-paper --engine latex --main main.tex --json
sciencebatch-cli project apply --project ./paper --file main.tex --content-file ./proposed-main.tex --expected-sha256 CURRENT_FILE_HASH --json
sciencebatch-cli apply --project ./paper --file main.tex --content-file ./proposed-main.tex --expected-sha256 CURRENT_FILE_HASH --json
```

`project.apply` replaces one text file with the complete UTF-8 content only if the current bytes still match the supplied SHA-256. `--content-file PATH` supplies the replacement; `--content TEXT` is an alternative for short input. Both are bounded to 8 MiB. If the hash changed, reread and replan; never retry with a newly fetched hash without rechecking the user's intent.

Diagnostics are preflight-only and cover both engines. They check project settings, path safety/readability, engine/main compatibility, snapshot traversal, and non-empty main input. They do not parse complete LaTeX/Typst syntax and do not reproduce the Monaco editor linter. Compilation is the only automation operation that returns engine syntax and missing-dependency diagnostics.

```sh
sciencebatch-cli diagnostics --project ./paper --engine latex --main main.tex --json
sciencebatch-cli diagnostics --project ./slides --engine typst --json
```

Compilation must be explicitly requested. It supports LaTeX and Typst. Supply `--output` when exporting a PDF; without it the command returns diagnostics and the compiled PDF summary in memory with `pdfWritten: false` and `output: null`:

```sh
sciencebatch-cli compile --project . --main paper.tex --output paper.pdf --json
sciencebatch-cli compile --project ./paper --engine latex --main main.tex --output ./out/paper.pdf --json
sciencebatch-cli compile --project ./slides --engine typst --main deck.typ --output ./out/deck.pdf --timeout 240 --json
```

An existing output is preserved unless `--overwrite` is supplied. Compilation uses saved project files unless an explicitly selected workspace operation provides a live buffer or in-memory snapshot. It writes no source copies or TeX intermediates. Compilation does not download packages or prepare resources implicitly.

Resource inspection is read-only. Resource preparation may download compiler assets and is always a separate explicit command; it is resumable and bounded by 8 GiB or 30 minutes:

```sh
sciencebatch-cli resources status --json
sciencebatch-cli resources prepare --engine latex --json
```

On Linux, Tectonic normally stores shared resources under `$XDG_CACHE_HOME/tectonic` (or `~/.cache/tectonic`): `bundles/hashes/` contains bundle digests and check metadata, `bundles/data/` contains indexes and cached resource files, and `formats/` contains reusable `.fmt` files and atomic format-cache staging files. Explicit preparation may populate these shared resources; compilation may create cache directories and a missing format from already cached resources. It never downloads. `TECTONIC_CACHE_DIR` overrides Tectonic's cache base; use `resources status` to obtain the effective bundle location. Other platforms use Tectonic's per-user cache directory.

Explicit source edits additionally use stable per-target lock files under the per-user ScienceBatch cache's `transaction-locks/` directory (`~/.cache/sciencebatch/transaction-locks` on Linux). These files coordinate concurrent edits and contain no document source. Atomic edit/PDF staging files exist only beside the requested destination and are removed after success or failure. The owner-private workspace registry is under app-local data (`~/.local/share/com.sciencebatch.editor/workspace-bridge` on Linux), separate from compiler caches. Typst uses bundled resources without a downloadable cache.

Automation supports in-memory BibTeX. Documents requiring external Biber or another external bibliography tool return `dependency.external_tool_unsupported`; the isolated automation worker does not run external tools.

## MCP server

The MCP server uses `rmcp` 3.5.1 over stdio. Configure the host to launch the local executable directly; the host-specific configuration file is intentionally not edited by the repository installer. The server does not bind a network MCP listener, launch the GUI, or gain access outside its allowed roots.

```sh
sciencebatch-cli mcp serve --root /work/paper
sciencebatch-cli mcp serve --root /work/paper --root /work/shared-bibliography --allow-write
sciencebatch-cli mcp serve --root /work/paper --allow-resource-download
```

Repeat `--root` to grant additional project roots. Without `--root`, the launch directory is the allowed root. `--allow-write` enables MCP `project.create`, `project.apply`, and workspace mutation tools. `--allow-resource-download` enables explicit resource preparation. Both permissions default off. Omitting one does not block read-only project inspection, read, search, preflight diagnostics, or explicit compilation against locally available resources. MCP compile is always a distinct explicit tool request and never runs on save, edit, inspection, or server startup.

The public project, compiler, resource, and workspace tool names are:

```text
sciencebatch_project_inspect
sciencebatch_project_create
sciencebatch_read
sciencebatch_search
sciencebatch_apply
sciencebatch_diagnostics
sciencebatch_compile
sciencebatch_resources_status
sciencebatch_resources_prepare
sciencebatch_workspace_instances
sciencebatch_workspace
```

Workspace operations are `inspect`, `read`, `openProject`, `openFile`, `activate`, `apply`, `save`, `close`, `compile`, and `cancel`. The host selects one running app instance using its `instanceId`; if more than one is available, the client must choose. Workspace inspection exposes the available project, tabs, document IDs, dirty state, engine, and current revisions without saving. Workspace read returns the exact selected buffer and revision. Mutations must provide `documentId`, `expectedRevision`, `expectedProjectRoot`, and `workspaceGeneration`; `save` targets one selected document. Workspace compile carries a `jobId` and `timeoutSeconds`, derives the engine from the selected main file, and uses live source-tab overlays. `compile` and `cancel` are explicit workspace actions.

The CLI workspace adapter offers the same operations. List instances, inspect one, then pass operation arguments as one JSON object using `--args`. Repeat `--root` to constrain accessible projects; when omitted, the launch directory is the allowed root:

```sh
sciencebatch-cli workspace instances --json
sciencebatch-cli workspace inspect --instance INSTANCE_ID --root /work/paper --json
sciencebatch-cli workspace read --instance INSTANCE_ID --root /work/paper --args '{"documentId":"DOCUMENT_ID","expectedProjectRoot":"/work/paper","workspaceGeneration":7}' --json
sciencebatch-cli workspace apply --instance INSTANCE_ID --root /work/paper --args '{"documentId":"DOCUMENT_ID","expectedProjectRoot":"/work/paper","workspaceGeneration":7,"expectedRevision":12,"start":0,"end":0,"text":"Added text\n"}' --json
```

Obtain all IDs and revision values from the selected instance's current `inspect` or `read` response. An edit includes `documentId`, `expectedProjectRoot`, `workspaceGeneration`, `expectedRevision`, UTF-16 `start`/`end` offsets, and replacement `text`. A stale project, workspace generation, or document revision returns a conflict; reread and replan instead of inventing or refreshing guards automatically.

## Live workspace safety

The desktop publishes one owner-private registry record per running instance under app-local data. Records include schema version, instance ID, loopback host, ephemeral port, token, and PID. The bridge binds only to `127.0.0.1`; a client selects the instance explicitly. The token is required for requests and is never returned in UI results, events, or logs. The bridge does not start or control a GUI instance.

Workspace bridge requests and replies use newline-framed JSON and are capped at 256 MiB per request/reply. Requests carry schema version, ID, token, operation, and arguments. A stale editor revision returns `conflict.revision`; dirty-buffer close or project-switch conflicts return `conflict.dirty`; a repository operation lock returns `git.locked`. The backend enforces the lock and the editor rejects stale UI actions. The system does not silently choose between a dirty editor buffer and its disk version.

Documents above 1 MiB remain editable and compilable, but interactive completion, ribbon context, minimap, and line wrapping are reduced to keep large automation edits responsive. The 8 MiB text limit still applies. Normal documents retain their existing interactive tools.

Headless compilation can consume an explicitly selected in-memory workspace snapshot through the private automation worker protocol. The private protocol validates its schema and bounds snapshots at 128 MiB; PDF responses remain in memory and are limited to 64 MiB. It is an implementation detail, not a public CLI flag, MCP tool, or saved snapshot-file format. No source is copied to disk for this path.

For MCP workspace calls, use the same `instanceId`, operation arguments, and compare-and-set fields. A guarded edit has this shape:

```json
{
  "instanceId": "INSTANCE_ID_FROM_WORKSPACE_INSTANCES",
  "operation": "apply",
  "expectedProjectRoot": "/work/paper",
  "workspaceGeneration": 7,
  "documentId": "DOCUMENT_ID_FROM_INSPECT",
  "expectedRevision": 12,
  "start": 0,
  "end": 0,
  "text": "Added text\n"
}
```

## Shared limits and results

The public JSON envelope has `schemaVersion`, `command`, `ok`, `data`, `diagnostics`, and `error`. Errors contain stable `code`, English `message`, and optional `details`. CLI commands emit one JSON object plus newline on stdout; progress is sent to stderr. MCP and workspace bridge replies use their documented RPC envelopes and the same stable operation/error codes.

Shared processing caps are 10,000 project entries, depth 64, 8 MiB text source/file, 32 MiB asset read, 128 MiB workspace snapshot, 64 MiB PDF, 256 MiB private worker message, and 1 MiB captured logs. Compile timeout defaults to 120 seconds and accepts 1–900 seconds. Resource preparation stops at 8 GiB or 30 minutes and can resume. Oversize content is rejected; results are never silently truncated.

Allowed exit codes are 0 success (warnings may be present), 1 completed preflight/document failure, 2 usage/config/permission/conflict/path failure, 3 I/O/resource/cache failure, 4 worker/protocol/internal failure, 124 timeout, and 130 handled interruption. MCP uses the corresponding stable error code in the envelope rather than a process exit code.

## Skill behavior

Skills prefer the connected MCP operation when available and authorized, then use the CLI for disk projects or the explicitly selected workspace bridge for live buffers. They do not guess project roots, files, active instances, expected hashes, editor revisions, bibliographic facts, or citation references. On a hash/revision/dirty-state conflict, they stop, reread the current state, and replan.

`sciencebatch-review` is read-only by default. `sciencebatch-write` and `sciencebatch-format` only save/apply requested edits and never compile implicitly. `sciencebatch-diagnose` may fix errors when requested but compiles only when the task authorizes it. `sciencebatch-export-pdf` is for explicit compile/export requests. `sciencebatch-bibliography` uses supplied or project-verified sources and never fabricates references. All Skills avoid unrelated Git operations, broad font work, and product Visual/Review modes.

## Support scope

The current implementation phase includes project operations, both compilation engines, offline resource management, a local stdio MCP server, and live workspace access. It does not add automatic compile/watch, Git automation, font installation, broad visual editing/review modes, collaboration, or Skills that make up citations. Status and verification are maintained in the roadmap and implementation report; browser/native writing-ribbon QA records retain their existing case classifications.
