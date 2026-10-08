# Resource Manager Planning Handoff

Prepared on 2026-10-08 for a new Codex chat. The requested next task is planning a future resource manager, not implementing it yet.

## Copyable request

Continue ScienceBatch in `/home/mauri/Desktop/Portfolio/ScienceBatch`. Read this handoff, the applicable `AGENTS.md`, local `IDEAS.md` and `SPECS.md` when present, `docs/ROADMAP.md`, `docs/CLI_SPEC.md`, `docs/AUTOMATION.md`, `docs/AUTOMATION_RESOURCES_QA.md`, and `docs/COMPILER_DISTRIBUTION_EVALUATION.md`. Inspect the current Git state and consult Graphify. Produce a concrete, phased implementation plan for IDEA-001: a graphical resource manager that prepares only the compiler resources needed by a project, using explicit dependencies, source/template detection, and dependencies observed during user-authorized compilation. Identify unresolved decisions, recommend a minimal first delivery, define its shared Rust/CLI/MCP/UI contracts and meaningful acceptance tests, and explain how it reduces startup storage without losing existing supported documents. This task authorizes planning only; do not implement, commit, push, merge, switch compiler backends, or download the full bundle as part of planning. Preserve existing changes and verification classifications.

## Repository and delivery state

- Repository: `/home/mauri/Desktop/Portfolio/ScienceBatch`; remote: `git@github.com:maanfitow/ScienceBatch.git`.
- Current delivery branch: `feat/automation-interfaces`. Inspect its actual HEAD and upstream rather than assuming this record is current.
- PR #1 (local Git) and PR #2 (writing ribbon) were merged into `develop`, in that order. The PR #2 merge is `e052afc826b3f9d7c92f272e612b248e8512c46e`.
- Baseline automation commit: `e0c9693` (`feat: add shared CLI, MCP, workspace automation and Skills`). The commit containing this handoff adds the subsequent resource preparation fixes, QA evidence, and storage evaluation. The user authorized committing and pushing this delivery branch; that does not authorize a future implementation or merge.
- The local `AGENTS.md`, `IDEAS.md`, and `SPECS.md` are ignored by Git in this checkout. They remain applicable locally; versioned automation contracts and this handoff preserve the relevant context for other checkouts. Do not force-add ignored files merely to make this record complete.

CLI, MCP, and live workspace automation are implemented. The CLI provides project inspection/creation, read/search, hash-guarded apply, diagnostics, explicit compile/PDF export, resource status/preparation, workspace operations, and an stdio MCP server. Both engines share Rust services independent of `AppHandle`. MCP uses official `rmcp` 3.5.1; write/download permissions are explicit. The live bridge uses loopback TCP, per-instance tokens, document revisions, Monaco Undo, save-only operations, and dirty/Git-lock conflicts. Eight Skills are versioned under `skills/`.

## User's proposed direction

The user suggested a future experience similar to a graphical pip-style dependency manager: personalize downloaded resources, predict what a project needs from a dependency file or its sources/templates, and progressively prepare those resources. The user endorsed discussing this direction and now wants a plan in a new chat.

The discussed workflow is:

1. Analyze an explicitly selected disk project or live workspace snapshot.
2. Show detected/declared resources, installed and missing state, source of each requirement, and expected incremental download/storage size where demonstrable.
3. Download the selected required resources through an explicit preparation action, with resumable progress and cancellation.
4. Compile offline only when the user explicitly requests compilation.

Three complementary inputs are proposed, not implemented: a project dependency manifest; static source/template detection; and dependencies actually observed during explicitly requested compilations. Initial resource sets could cover a basic document, academic article, and presentation. Shared caches should prevent repeated installation across projects.

Static analysis is not a guarantee of complete TeX dependency resolution. Macros and conditions can select resources dynamically. Resource preparation must never compile to discover dependencies. A user-authorized compile can produce an actionable missing-resource result and improve recorded dependency information; it must not silently download or automatically retry compilation.

## Current resource implementation

- Tectonic remains pinned to 0.17.0 and `tectonic_bundles` to 0.4.2, with local vendored patches. Typst uses its existing embedded resources.
- `resources prepare` currently prepares the complete existing LaTeX bundle; selective preparation is not an existing option.
- The downloader runs synchronously in a dedicated thread within its isolated worker, avoiding the cold-cache blocking HTTP/Tokio panic.
- It reuses complete files and combines adjacent missing Itar ranges, at most 32 MiB per range and four concurrent requests. Active range payload is capped at 128 MiB; that is not a bound on total process RSS.
- Downloads remain bounded to 8 GiB and 30 minutes. Whole requested ranges, including retries and padding, conservatively count toward the transfer budget. Short/oversized responses are rejected before their resources are published.
- Readiness checks exact indexed paths and lengths, rejecting unsafe paths, symlinks, and special files. Full-bundle readiness currently differs from the future notion of project readiness.
- Resource and compiler supervisors own worker semaphore permits until the child is reaped. A dropped request cannot release its permit while the worker remains alive.

Inspect `src-tauri/src/automation/resources.rs`, `worker.rs`, `mod.rs`, `project.rs`, and `compiler.rs`, plus `src-tauri/vendor/tectonic_bundles/src/{cache,itar,lib}.rs` and `src-tauri/vendor/tectonic_bundles/src/itar/batch.rs` for the actual contracts. Use Graphify for impact paths before proposing a refactor.

## Design decisions the plan must resolve

- Manifest ownership, format, schema version, and whether a separate lock file records bundle identity and exact resolved resources. All names shown in discussion are provisional.
- Package identities versus resource filenames, transitive dependency metadata, and how dynamic TeX requirements are reported with honest uncertainty.
- Prefer evaluating selective preparation from the current known bundle first. Arbitrary CTAN package versions, another package registry, or changing compiler engines are separate compatibility decisions.
- Precedence of project-local files, explicit resources, embedded packages, and shared cache. Missing user assets such as figures or bibliography files must not be replaced with downloaded examples.
- How resource state changes with dirty workspace buffers and how the plan is tied to project/snapshot identity so a stale plan cannot silently prepare the wrong dependency set.
- Resource trust, integrity, bundle pinning, concurrent cache writers/readers, resumability, cancellation, disk quotas, cleanup, and protection against removing resources used by another project.
- Separate global cache completeness from project preparation. Report detected, declared, resolved, missing, and unknown states without claiming syntax verification or guaranteed successful compilation.
- Reuse one shared backend contract for GUI, CLI, MCP, and Skills. Define permissions and explicit triggers; do not invent an automatic global client setup.
- Scope a useful first UI: analysis, resource list, incremental size, explicit preparation, and progress. Broad package browsing and advanced dependency solving can follow later.
- Define acceptance for a cold basic project, supported academic templates, transitive/missing/dynamic dependencies, disconnected operation, changed/dirty buffers, interrupted preparation, cache reuse across projects, and bounded failures.

## Storage evidence and optimization boundaries

The measurements below are Linux x86_64 observations using decimal units. Shared GTK/WebKit dependencies, user files, future cache growth, and build directories are excluded.

- Existing debug `.deb`: 132,534,018 bytes; installed-size metadata: 448,211,968 bytes.
- A temporary `strip --strip-all` experiment retained both engines and reduced the package to 49,521,468 bytes with 175,635,195 bytes of file payload. Its CLI passed the matrix; the stripped GUI was not newly verified. It is a size experiment, not a release installer.
- Complete resource cache: 2,782,353,293 logical bytes and 3,107,639,296 allocated bytes, containing 134,980 indexed resources.
- Existing partial cache: 55,910,400 allocated bytes including indices/formats. It worked for tested fixtures, not a universal supported-project baseline. Combining it with the stripped app payload is approximately 232 MB and does not establish a future product size guarantee.
- The official TinyTeX-1 Linux x86_64 v2026.10 archive was measured at 53,589,988 bytes and 177,024,338 bytes of regular-file payload, including shipped formats. It lacks the existing first-class academic classes/icon packages and Biber. This is not a feature-equivalent comparison or a measured external ScienceBatch build.
- A cold isolated release build was stopped and reaped after a 15-minute measurement budget before producing application binaries. Its temporary target was removed. Actual optimized release size remains unmeasured.

The discussed optimization order is production packaging, selective resources, measurement of a common compiler worker to reduce binary duplication, and optional external TeX support if justified. External TeX is not the selected implementation for this manager. A packed local cache is another unmeasured proposal; reducing allocated-file overhead could help without changing resource coverage.

## Invariants and exclusions

- Desktop compilation remains Compile/Ctrl+S. CLI and MCP compilation must be explicit and authorized by the user's task. Inspection, opening, editing, saving, resource preparation, and Skill installation never compile.
- Sources/assets travel through in-memory snapshots, including selected live buffers. No compilation source copies or `.aux`, `.log`, `.toc`, or other intermediates may be written to disk. Final PDF export and documented resource/format caches are distinct allowed writes.
- Compilation remains isolated, cancellable, offline for automation, and subject to strict snapshot/protocol/time limits. Preserve desktop progress, stale-result guards, and PDF scroll/zoom behavior.
- No new fonts, collaboration, Visual/Review product modes, hosting, or Git actions are included. Current supported assets must remain supported; compiler additions require editor linter/completion/scanner parity.
- All code, UI text, comments, documentation, and commit messages must remain English.
- The main agent owns contracts and review. Future authorized implementation is delegated to `sciencebatch_implementer` (Luna High), following the applicable agent workflow; planning itself remains with the main agent.

## Verification history

The resource follow-up passed 101 Rust library tests, three official MCP integration tests, eight vendored bundle tests, the strengthened headless CLI matrix with the app closed, real interruption/resumption/full preparation, and a zero-download warm pass. Offline compilation/resource receipts and limitations are linked in [Automation QA](AUTOMATION_QA.md) and [Resource QA](AUTOMATION_RESOURCES_QA.md).

Graphify was refreshed after code changes: 2,996 nodes, 6,214 edges, 299 communities. TypeScript and Rust checks also passed during the size evaluation and were rerun successfully before the follow-up commit.

Native writing-ribbon history retains its original classifications, including summary-only and unverified cases. Merges do not prove those cases. Windows/macOS release checks and a production release size remain open. Consult the QA documents for the latest actual evidence.
