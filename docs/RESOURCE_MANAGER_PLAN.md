# IDEA-001: Project Resource Manager Plan

Date: 2026-10-08. **Status: historical planning draft; the user subsequently authorized the four-stage MVP.**

The approved implementation scope is catalog validation, shared offline analysis, selective preparation, and GUI/CLI/MCP adapters with desktop offline snapshot compilation. Persistent observations, portable lock export, and cache cleanup remain deferred. The draft below records the original planning discussion; its pending recommendations and planning-only verification do not describe the current implementation. See [Resource Manager Contract](RESOURCE_MANAGER.md) and [Resource Manager QA](RESOURCE_MANAGER_QA.md) for the implemented contracts and measured evidence.

This plan follows [Resource Manager Handoff](RESOURCE_MANAGER_HANDOFF.md), local `AGENTS.md`, [IDEA-001](../IDEAS.md#idea-001-package-management), [Specifications](../SPECS.md), [Roadmap](ROADMAP.md), [CLI contract](CLI_SPEC.md), [Automation Interfaces](AUTOMATION.md), [Resource QA](AUTOMATION_RESOURCES_QA.md), and [Compiler Distribution Evaluation](COMPILER_DISTRIBUTION_EVALUATION.md). Names and schemas below are recommendations for review, not existing APIs. Local idea/specification files remain ignored and their statuses are unchanged.

## Recommended first delivery

Provide a project-scoped **Resources** dialog that analyzes an explicitly selected disk project or live workspace, explains each requirement, and prepares a reviewed selection from the existing Tectonic bundle. Share the resolver, cache checks, downloader, errors, and progress model across Rust, CLI, MCP, and GUI. Support a small optional declarative manifest from the first delivery; creating or editing that manifest remains a separate source mutation.

Ship a validated basic resource pack plus catalog coverage for the existing academic classes and icon suites. Select only the classes/packages/options required by the chosen project and their known closure. Include the resources needed to create a cold LaTeX format during a later explicit compilation. Resource preparation itself never generates a format or runs TeX.

The first delivery comprises stages 0–3 below. Persistent compilation observations, portable lock export, and cache cleanup follow separately. Minimal missing-resource evidence during an authorized compile is part of stage 2, so unknown/dynamic dependencies have a usable recovery path immediately.

Exclude arbitrary CTAN versions, package browsing, a new registry, engine replacement, external TeX, new font installation, a packed cache, compiler executable consolidation, collaboration, and Visual/Review modes. Keep Typst's existing embedded resources and show their state without inventing downloadable Typst support. Retain full-bundle preparation as an explicit alternative. No startup/open/save/analyze/prepare operation compiles or silently downloads resources.

## Inspected baseline and impact

Inspection found a clean `feat/automation-interfaces` checkout at `d2fee3ff2a3f7e902cbd449993be1abb907ff886`, tracking `origin/feat/automation-interfaces`. No fetch was performed; this is the locally recorded upstream state, not a remote freshness claim.

| Area | Current evidence | Planning consequence |
| --- | --- | --- |
| Shared operations | `automation/mod.rs` dispatches CLI/MCP operations without `AppHandle`; one process-local semaphore admits one automation compiler/resource worker. | Extend this service with typed resource contracts; adapters only translate transport and permissions. The semaphore does not coordinate separate application processes. |
| Resource status | `automation/resources.rs::status` checks cached digest/index and every indexed regular file/path/length. `ready` means full-bundle completeness. | Preserve legacy meaning. Add project preparation and uncertainty fields separately. Length checks are not cryptographic content verification. |
| Preparation | `resources.rs` starts `--resource-prepare-worker` with no stdin, collects one terminal JSON response, and calls `Bundle::prepare_all`. | Selective requests and live progress need a versioned bounded worker protocol; they cannot be delivered by adding a frontend checkbox alone. |
| Bundle cache | `BundleCache::prepare_all_cached` computes missing descriptors, invokes `prepare_resources`, and atomically publishes complete resources. Itar preparation uses four ranges of at most 32 MiB each. | Add explicit subset preparation at the cache/provider boundary and reuse this path. Avoid downloading a whole range spanning distant selected files. |
| Index | `ItarFileInfo` contains name, offset, and length; it has no package dependency graph or per-file content hash. | A release-owned catalog must supply package grouping, transitive metadata, and verified integrity data. Bundle identity alone does not authenticate each downloaded range. |
| Automation compilation | `automation/compiler.rs` opens a cache-only bundle, overlays a confined snapshot, supports in-memory BibTeX, rejects external tools, and currently reduces known cache misses to a boolean. | Record bounded resource identities and origins rather than relying only on log parsing or the boolean. Keep existing offline/error/limit behavior. |
| Normal desktop compilation | `useCompiler.compile` invokes `compile_document`; `compiler/latex.rs` calls `default_bundle(false)` and reads secondary inputs through a filesystem root. | This legacy path differs from workspace compilation. Explicit offline preparation and consistent dirty-buffer semantics require a scoped integration change. Do not describe them as already implemented. |
| Live workspace | `App.tsx` captures source-tab overlays and guards generations/revisions; `commands/workspace.rs` uses `capture_snapshot` or `capture_virtual_snapshot`. | Reuse these capture/identity mechanisms for analysis and preparation. Do not substitute saved files for selected live buffers. |
| Embedded resources | Desktop `EmbeddedPackageBundle` serves SimpleIcons and also sample images/`references.bib`; automation's `StrictBundle` embeds SimpleIcons only. | Separate compiler assets from template example assets. Missing user figures/bibliographies must remain missing; explicitly created templates can materialize their own examples. |
| Editor detection | `editor/projectContext.ts` inventories files and extracts custom macros; it is not a complete dependency solver. | Keep the canonical resource resolver in Rust. Reuse editor file/revision inputs and preserve linter/completion/scanner parity without pretending macro discovery resolves TeX execution. |
| Templates | New Project currently accepts starter content; no resource-pack/template dependency contract was found. | Add versioned metadata for owned starters; imported sources receive static detection, not a guessed template identity. |

Graphify was consulted with resource/worker/cache and workspace-compilation queries, `explain prepare_all_cached`, `explain EmbeddedPackageBundle`, `explain StrictBundle`, and `path AutomationService ItarBundle`. It identified the service, worker supervisor, cache publication, and snapshot modules. The shortest path passed through generic `BTreeMap` references and is not evidence of runtime dispatch; `StrictBundle` had no matching graph node. Direct source inspection established the flow and the desktop differences above. No code modules changed, so no index extraction was needed.

## Decisions recommended now

### Resource identity and resolution

Use **bundle identity + exact indexed resource path** as the immutable installation identity. A package/class is a human-facing catalog grouping, not an independently versioned CTAN installation. Two projects requesting the same bundle/path share one cache entry. Do not lowercase all identities or resolve an ambiguous basename arbitrarily; preserve engine lookup rules and return ambiguity when the catalog cannot identify one exact resource.

The catalog maps package/class IDs, recognized options, template versions, and pack IDs to resource paths and dependency edges. Its revision is pinned alongside the engine, bundle digest, and index hash. Catalog provenance distinguishes curated closure, literal detection, explicit declaration, template metadata, and compilation observation. Unknown packages, macro-built names, conditional branches, and uncatalogued options remain visible uncertainty. A broad package family may be a conservative fallback only when labeled and included in the user's reviewed selection.

Build project inputs with selected live overlays taking precedence over disk snapshot bytes. The engine then searches primary input, generated memory, project I/O, bundle and format cache in its existing order. Within the bundle layer, embedded compiler assets precede the pinned shared cache. Thus project-local files override both compiler asset layers while generated-file handling remains unchanged. Format-generation mode bypasses project I/O and must use a validated base closure. An explicit declaration adds a requirement; it never overrides a local file or replaces a missing user asset with an example.

Resolve local `.cls`/`.sty`/included `.tex` and bibliography/style references recursively under existing root/depth/size bounds, with cycle detection. Read literal `documentclass`, `LoadClass`, `usepackage`, `RequirePackage`, `input`, `include`, bibliography/style and relevant font/theme references. Respect comments/verbatim and conservatively label conditionals. Do not execute TeX, expand arbitrary macros, or claim a general dependency solver. A local class can still require shared packages and fonts. Existing source preprocessing, including the IEEE/T1 fallback, is an explicit resolver input and must contribute its own requirements.

### Project manifest and lock

Recommend a separate visible root file, **`sciencebatch.resources.json`**, to avoid silently extending existing `.sciencebatch.json` engine/main selection and its hidden-file traversal exception. Validate it through a dedicated bounded parser shared by all clients. File names remain pending approval. No manifest is required for ordinary detection.

Proposed manifest schema 1:

```json
{
  "schemaVersion": 1,
  "engine": "latex",
  "requirements": [
    { "kind": "pack", "id": "latex-basic" },
    { "kind": "package", "id": "IEEEtran" }
  ]
}
```

Allow `pack`, `package`, and exact bundle `resource` selectors. No URLs, executable hooks, arbitrary versions, external paths, negative dependency exclusions, or implicit installs. Reject unsupported schema/selector values and engine conflicts. IDs resolve only through the approved catalog/index. Manifest writes require explicit file-edit authorization and existing hash/revision guards; analysis/preparation never creates or changes it. A dirty manifest buffer belongs to the selected live input just like a dirty source buffer.

Recommend a separate optional **`sciencebatch.resources.lock.json`** in stage 4: schema version, engine compatibility identity, bundle/index/catalog identities, manifest digest, sorted exact paths/lengths/hashes and dependency provenance. It records a reproducible resource selection, not machine installation state or proof of compilation success. Do not include absolute paths, tokens, document text, or generated `.aux`/`.log` data. Creating/updating it is an explicit guarded write, never a side effect of preparation. A valid lock may supply exact selectors offline; changed manifest, unavailable bundle, or mismatching catalog must produce a conflict and an explicit refresh path. Local observations remain separate from the portable lock.

### Cold analysis and honesty about readiness

Recommend shipping trusted catalog/index metadata for one supported pinned bundle, so cold analysis can resolve known packs and estimate sizes with no network access. Measure its installer cost before approving packaging. If the configured bundle lacks matching local metadata, return `metadata_unavailable`; show literal requirements with unknown sizes and offer a separate explicit metadata preparation action. Do not make `analyze` fetch the remote digest/index. Custom bundles remain outside first-delivery selective support; explain the limitation while preserving their existing explicitly invoked full preparation path.

Keep independent dimensions:

| Dimension | Proposed values / meaning |
| --- | --- |
| Evidence | Multiple of `declared`, `detected`, `template`, `transitive`, `observed`; each retains its origin. |
| Resolution | `resolved`, `unknown`, `ambiguous`, `unsupported`; an unsupported external tool is distinct from a missing bundle file. |
| Availability | `project_local`, `embedded`, `cached_verified`, `cached_unverified`, `missing`, `invalid`, `not_applicable`. |
| Project preparation | `not_prepared`, `prepared_known_set`, `blocked`; report the exact selected set and remaining unknowns. |
| Compilation evidence | `not_run` or a result tied to the exact snapshot/engine/bundle; successful compilation covers that execution only. |
| Global cache | Legacy full-bundle completeness, independent from project preparation. |

Use UI wording **“Known resources prepared”**, with unresolved requirements beside it. Never label a static/preparation pass “Syntax verified” or promise compilation success. Typst shows embedded engine assets and separate local missing/unsupported inputs; it must not claim all external Typst packages are bundled.

## Shared contracts

All operations use existing root confinement and operation context. Keep envelope `schemaVersion: 1`; introduce `resourceSchemaVersion: 1` for additive resource payloads and an independently versioned private worker protocol. Preserve existing `resources.status`, full `resources.prepare`, CLI exit classes, and MCP flags.

| Contract | Required fields and behavior |
| --- | --- |
| `ResourceTarget` | Discriminated disk target (`project`, explicit/resolved `engine`, `mainFile`) or workspace target (`instanceId`, `expectedProjectRoot`, `workspaceGeneration`, selected document IDs/revisions). Scratch projects use the existing virtual snapshot path. Ambiguous main/engine remains an error. |
| `ResourceInputIdentity` | SHA-256 over canonical sorted paths, kinds, content hashes, engine/main, manifest/template inputs and source-preprocessing revision. Workspace also binds instance/generation/document revisions. Include assets whose presence/content affects analysis; exclude the output lock and unrelated cache state to avoid circular/stale identities. Retain a bounded snapshot only in memory. |
| `ResourceSelection` | Stable requirement IDs chosen from an analyzed plan plus explicit catalog selectors. Close all mandatory transitive/base edges. Users may deselect optional packs; they cannot drop a mandatory dependency while still claiming its parent prepared. |
| `ResourcePlan` | Target/input identity, bundle/index/catalog/engine identities, selected closure, `planDigest`, requirement/resource counts, unresolved entries, cache summary, size summary, and `coverage: "static_and_declared"` initially. The backend derives all offsets/paths; client-supplied plan data cannot authorize arbitrary fetches. |
| Requirement/resource row | Stable ID, package grouping, exact nullable path, provider, resolution, availability, mandatory flag, evidence list, dependency parents, nullable one-based file/line, indexed bytes, integrity status. No source text in stored receipts or outward progress. |
| `ResourcePrepareRequest` | Target, selection, `expectedPlanDigest`, caller job ID, reviewed transfer/storage ceilings. Recompute and validate identity/closure before starting; refuse a mismatching snapshot/bundle/catalog instead of silently expanding it. |
| `ResourcePrepareResult` | Job/plan IDs, terminal state, selected/prepared/reused/remaining counts, actual transfer accounting, newly cached logical bytes, remaining unknowns, resumability, cache location. `prepared` covers the selected known set only. Failure details carry bounded completed/remaining summaries and resume instructions. |
| `ResourceProgress` | Job ID, plan digest, monotonically increasing sequence, phase (`validating`, `waiting`, `downloading`, `publishing`, `complete`, `cancelled`, `failed`), completed/total resource counts, budgeted transfer bytes, optional known total, English message. Unknown totals produce indeterminate progress. Exactly one terminal state. |
| `DependencyObservation` (stage 4) | Snapshot/engine/bundle/catalog identity, actually opened provider/path, mandatory missing candidates, completed/failed run and coverage marker. Bound the records; overflow cannot silently claim complete coverage. A killed/crashed worker may have partial or no observations. |

`planDigest` binds inputs, resolution identities and selection, excluding mutable cache availability. Another project populating the same cache may lower the download after review. Preparation must recheck integrity and budget; eviction/corruption that would increase the approved cost returns a new review requirement. Metadata changes always invalidate the plan.

Check the target before work and before applying its result. If a source changes during download, the immutable job may finish caching its originally selected resources, but the current project view becomes stale and must reanalyze; the old receipt never marks the changed project prepared. Project switching must not cancel an unrelated client's job or attach its progress to the new project. Read-only analysis may run while editing; guarded project writes retain dirty/revision/Git-lock rules.

### Interface mapping and permissions

Proposed public additions:

| Rust operation | CLI shape | MCP / GUI adapter |
| --- | --- | --- |
| `resources.analyze` | `resources analyze --project DIR [--engine ...] [--main ...] --json` | `sciencebatch_resources_analyze`; GUI Analyze through Tauri. Read-only, network-free. |
| `resources.plan` | `resources plan --project DIR ... --selection JSON --json` | Same typed planning service for a changed selection; MCP `sciencebatch_resources_plan`. Read-only. |
| `resources.list` | `resources list --project DIR ... --selection JSON --expected-plan-sha256 HEX [--cursor TOKEN] --json` | Paged detailed rows from the same validated target/selection, through MCP/GUI. Read-only; cursors bind the plan digest and cannot address another project. |
| `resources.prepare_project` | `resources prepare-project --project DIR ... --selection JSON --expected-plan-sha256 HEX --max-download-bytes N --max-storage-bytes N --json` | `sciencebatch_resources_prepare_project`; GUI Prepare selected. Requires explicit action and MCP `--allow-resource-download`. |
| `resources.prepare_metadata` | `resources prepare-metadata --engine latex --json` | Explicit metadata-only preparation when not shipped/available; same download permission, no compile. |
| `resources.cancel` | SIGINT for a running foreground CLI job | Owner-scoped MCP cancellation and GUI job Cancel; no global kill or guessed job IDs. |

Live CLI/MCP target equivalents use the explicitly selected existing workspace bridge, adding resource analysis/planning/preparation operations to its allowlist and permission handling. Snapshot collection stays inside the selected instance. No global client setup, new network server, saved source snapshot files, or automatic Skill installation. Transport naming is finalized in stage 0; all adapters call the same business operations.

The CLI retains one final JSON object on stdout, with bounded progress records on stderr. MCP progress uses negotiated notifications and falls back to the terminal result when unsupported. Tauri emits a separate `resource-preparation-progress` stream keyed by job/plan so it cannot update compilation toasts. GUI listeners handle late subscription teardown and sequence/stale-job guards. Cancel acknowledgments mean the supervisor has stopped and reaped the worker; complete cache entries remain reusable.

Preparation writes shared cache resources and bounded receipts only. Project/lock writes additionally require `--allow-write` for MCP and explicit authoring intent. A download flag is a permission ceiling, not permission to compile or invoke preparation automatically. Existing Skills may explain the plan and call its operations only within the user's task authorization; version their operation documentation with the new contracts.

Suggested new stable codes: `resources.plan_stale`, `resources.catalog_unavailable`, `resources.bundle_mismatch`, `resources.selection_invalid`, `resources.integrity_failed`, `resources.storage_limit_exceeded`, `resources.cache_busy`, and `dependency.resource_missing`. Reuse existing permission, path, worker, timeout, and interruption codes. Stale/selection/bundle/config errors map to exit 2; cache/integrity/budget failures to 3; document failures to 1; worker/protocol failures to 4; timeout/interruption to 124/130. Preserve legacy offline errors for legacy calls; missing-resource details must identify whether an indexed compiler resource, project asset, external tool, or unresolved name is involved.

### Size accounting, trust, and limits

Report selected logical bytes, additional missing logical bytes, first-attempt range transfer bytes including padding, metadata bytes, and actual charged transfer bytes separately. Include the configured retry allowance in the reviewed transfer ceiling. Do not equate HTTP headers/retries, compressed archives, logical resources, allocated disk, or formats. Allocated disk and generated-format growth remain nullable estimates until measured; UI uses “Unknown” rather than zero. Runtime disk-full errors must still be bounded and preserve existing files.

Preserve 8 GiB/30-minute hard download ceilings, four concurrent ranges of at most 32 MiB, exact short/oversized-response rejection, root/symlink checks, and permit ownership through reaping. A user's smaller limits override the hard ceilings. Range coalescing may transfer padding but publishes only selected missing files. It never fills large gaps merely to minimize request count. The 128 MiB active range payload limit is not a total RSS guarantee.

Propose a 32 MiB selective worker request cap, 64 KiB per progress frame, and 1 MiB terminal summary cap, instead of an unbounded list inside the existing 1 MiB preparation reply. Allow at most the validated index's resource count, with a separate 200,000-entry catalog hard cap and 32 MiB index/catalog parsing cap each; stage 0 must measure these proposals against real metadata. Public detailed responses page at at most 200 rows and report counts/cursors explicitly. Scanner input keeps existing 10,000 entries/depth 64/8 MiB text/32 MiB assets/128 MiB snapshot bounds. Malformed requests, count/byte overflows and unknown schemas fail before network or allocation; pagination is never silent truncation.

Pin the supported engine/bundle and a trusted release catalog/index anchor. Obtain per-resource SHA-256 values from a verified release preparation pipeline or existing verified artifacts, with recorded provenance. Matching length and a digest fetched from the same server are insufficient proof of integrity. Verify bytes before publishing and verify adopted old cache files against catalog hashes locally. Do not download again when existing bytes verify. If trustworthy hashes cannot be established for first-delivery resources, stage 0 is blocked; do not quietly claim verified resources or fetch an unverified replacement catalog. No hash/catalog generation or full-bundle download is authorized by this planning task.

Add a cross-process cache writer lock per bundle, bounded acquisition/cancellation, and immutable verified entry publication. Readers use only complete entries. Scope temporary files to job/owner, clean abandoned staging only when no writer owns them, and coordinate Windows replacement with active readers. Validate lock/receipt directories and ownership as well as resource paths. Do not assume the current process-local semaphore or a digest check timestamp lock serializes all writers. MVP never evicts verified resources automatically; user limits cap incremental writes and cannot trigger deletion of another project's files.

## Phased implementation and acceptance gates

Each future stage receives a separate self-contained assignment with target, ownership, constraints and acceptance. The main chat owns decisions/review; authorized implementation goes to `sciencebatch_implementer` (Luna High), or a supervised Luna Dispatch when operating in Orca. Proposed file ownership below is sequential to avoid conflicting compiler/resource edits. No implementation, commit, push, merge, or engine migration is assigned here.

| Stage | Scope and likely ownership | Exit criteria |
| --- | --- | --- |
| **0 — Contract and feasibility** | Main-agent decisions; future scoped evidence work for catalog design, trusted bundle/index/hash provenance, lookup precedence, cold format closure, resource protocol and fixture inventory. Inspect `automation/resources.rs`, bundle cache/Itar, compiler providers, starter constants and QA fixtures. | Manifest/lock names, compatibility migration, trust anchor and API approved; prove exact subset access without full preparation; establish catalog sizes and base/academic dependency coverage from available verified artifacts. Any required compile/download needs a separately authorized task. No estimates presented as measurements. |
| **1 — Shared analysis and selection** | New Rust resource types/catalog/resolver beside `automation/resources.rs`; `project.rs` bounded manifest/overlay inputs. Catalog definitions for basic, academic article and presentation groups, with existing icons. | Deterministic plans from disk/live snapshots; explanations and transitive closure; local override, cycles, malformed manifests, unknown/dynamic requirements and stale selection rejection. Cold analysis has zero network/compile/cache population. Legacy status semantics retained. |
| **2 — Selective preparation and failure recovery** | `resources.rs` supervisor/protocol, vendor `lib.rs`/`cache.rs`/`itar.rs`/`itar/batch.rs` subset path; compiler providers and both worker response paths for bounded missing-resource evidence. | Exact selected verified resources only; explicit permissions; progress/cancel/reap; budgets, resume, cross-process lock and warm zero-transfer reuse. Authorized offline compile returns actionable missing requirements without download or retry. Normal desktop migration must pass its separate parity gate. |
| **3 — Graphical MVP and adapter parity** | Resource dialog/hook/types, Toolbar/Menu entry, Tauri command registration, existing workspace bridge, CLI parser, MCP schemas and existing Skill docs. Reuse theme tokens/Lucide and existing project identity mechanisms. | End-to-end Analyze → review/selection → Prepare/Cancel → terminal state on an explicit project. Disk/live parity and transport-equivalent plans/errors; no source save, compile or PDF change from resource actions. Supported-fixture cold/offline matrix and native UI checks pass. This is the first user-facing delivery. |
| **4 — Observations and reproducible selection** | Shared compiler I/O observers, bounded metadata receipts, explicit lock export/update, incremental resolver inputs. | Capture actual successful opens and meaningful failures across format/TeX/BibTeX/PDF/font paths; failed/cancelled runs marked partial; stale observations cannot remove static/base dependencies or certify a new snapshot. Lock export is guarded, portable and reproducible against identical identities. |
| **5 — Cache administration, if needed** | Cache inventory, project registration/reference tracking, leases and explicit cleanup/quota UI. Separate task/specification. | Preview reclaimable bytes; protect resources referenced by any registered project and all active jobs; unknown/unregistered consumers receive explicit protection policy. Cleanup and preparation cannot race. No destructive default or silent eviction. |

For desktop migration, recommend routing Compile through the shared confined live snapshot compiler while retaining exactly the existing Compile/Ctrl+S triggers, intended save behavior, progress/cancel ownership and PDF continuity. Disable network in every compiler path exposed by this delivery. Audit dormant compatibility commands as well as the toolbar. This is an observable behavior change from the legacy provider, so approve it in stage 0 and validate supported documents before enabling the manager. Preserve in-memory BibTeX; do not carry legacy external-tool staging into the shared path. Templates relying on embedded examples must explicitly create their examples when the user creates that template; analysis/preparation never writes examples into existing projects.

### First UI interaction contract

Add **Project Resources…** near project actions; open a dialog with the current project's name, main file, engine and **Saved files / Current workspace** scope. Default the in-app view to current workspace; headless disk commands always say saved files. With no selected main, request selection before analysis. For scratch documents, show ephemeral workspace identity and no claim of a persistent manifest.

Show package/class groups with status text, provenance, dependency explanations, local/embedded/cache providers, and incremental byte information. Expand detailed resource rows with pagination or virtualization; do not render 134,980 rows at once. Offer filters for missing/unknown/selected and explain mandatory children. **Prepare selected** is the primary action only after a current plan and budget exist. It says what will be downloaded; cached/embedded resources show zero additional transfer. Full-bundle preparation is a separate explicit action with its own much larger estimate.

Use phases/counts and honest determinate/indeterminate progress. **Cancel** stops the owned job; **Resume** revalidates the current target and reuses complete entries. Keep actionable errors inline after toasts expire. Editing marks the displayed plan **Out of date**; reanalysis can refresh it but must not prepare automatically. A compile's missing-resource result can open the dialog with a suggested selection; it does not download or recompile. No “Prepare and compile” action in the MVP.

Use current semantic themes and icon conventions. Keyboard access, visible focus, focus containment/return, textual status beyond color, labeled checkboxes, and restrained screen-reader progress announcements are acceptance criteria. Long paths wrap or remain accessible without hiding controls at narrow desktop widths and larger text scales. Listeners are removed even if subscription setup resolves after unmount. Focus/progress/error-recovery guidance was checked with the local `ui-ux-pro-max` skill; its React 19-specific dataset result is not a dependency-upgrade requirement for this React 18 repository.

## Acceptance matrix

These are future tests, not passes recorded by this planning task. Use isolated temporary caches; never clear or populate the normal user cache as a fixture. Compilation in the matrix must be explicitly included in its future authorized verification assignment.

| ID | Scenario | Observable acceptance |
| --- | --- | --- |
| A01 | Cold basic article, no `.fmt` | Analyze performs no network/TeX/cache population. Explicit prepare downloads only the validated base/document closure. Later explicitly requested offline compile produces valid non-empty PDF and may cache `.fmt`; no source copies or intermediates on disk. Full-bundle `ready` can remain false. |
| A02 | Existing supported templates | Cold and warm fixtures cover `IEEEtran`, `acmart`, `llncs`, `curve`, `beamer`, `fontawesome5`, `simpleicons`, `academicons` and the existing resume fonts/IEEE preprocessing. Each explicit preparation enables its subsequent offline fixture compile. No supported fixture is removed to meet a size target; macro linter/completion/scanner behavior remains intact. |
| A03 | Local and transitive dependencies | A local class/style overrides its bundle counterpart, still resolves its literal nested requirements and relevant fonts/themes/bibliography styles, explains parent edges, and detects cycles/limits. Duplicate/shared requirements download once. |
| A04 | User assets and examples | A missing figure or bibliography is reported as a project input, never replaced from the bundle or embedded sample fallback. Local SimpleIcons override and template-owned examples have explicit tested provenance. |
| A05 | Dynamic/unknown selection | Macro/conditional resource names and uncatalogued options remain unknown. An authorized compile records actionable indexed misses without downloading or automatically retrying. Normal missing probes such as absent first-run `.aux` are not all treated as mandatory dependencies. Preparing the suggestion still requires a new explicit action. |
| A06 | Disconnected operation | Analyze/status work from available metadata/cache with no network. An unknown catalog reports unavailable metadata rather than fetching. Warm project prepare returns zero charged transfer and unchanged verified entries; offline compile succeeds only for sufficient local resources. Cold prepare fails clearly and preserves completed resources. |
| A07 | Dirty/stale inputs | Disk and live plans differ when a secondary `.tex`/`.cls`/`.sty` or manifest is dirty. Edit, delete, rename, main/engine switch, generation change or another instance invalidates the relevant plan. Stale preparation cannot certify the new project. No buffer is saved or discarded by resource work. |
| A08 | Interrupt/resume and worker faults | Interrupt after publication, process death, timeout, dropped request and malformed/oversize protocol all stop/reap and release permits only afterward. Complete verified files retain bytes/mtime; resume adds remaining files without retransfer. Unowned events/cancellation cannot affect another job. |
| A09 | Cache reuse/concurrency | Two projects and two processes with overlapping closure use one bundle/path copy. Cross-process writer/reader tests show no partial reads, corrupted publication or missing active files, including Windows replacement behavior. Warm cache verifies locally without network. |
| A10 | Trust/path attacks | Wrong bundle/index/catalog, same-length corrupted resource, short/oversized ranges, traversal, absolute/drive paths, symlinks/reparse points, special files and hostile manifest offsets/URLs fail before unsafe publication. A forged client plan cannot bypass backend selection or root policy. |
| A11 | Budgets and pagination | Retries/padding/metadata count toward the reviewed transfer ceiling; disk-full/storage limits stop without deleting other resources. Requests/frames/catalogs just over their limits fail. Paged row counts/cursors cover the complete selection without silent omission. Progress does not claim 128 MiB total RSS. |
| A12 | Interface and permission parity | Equivalent disk/live requests produce equivalent normalized plans through CLI, MCP and GUI. MCP read-only server analyzes but refuses prepare without download permission; lock/manifest export additionally requires write permission. Stdout stays one final envelope; progress and secrets never contaminate it. |
| A13 | GUI/invariants | Startup/open/edit/save/analyze/prepare/Skill installation never compiles. Both desktop compile triggers remain explicit. Resource actions preserve active PDF bytes, scroll/zoom, source Undo and focus. No white flash or stale result; listener teardown and keyboard/error recovery work in native Tauri. |
| A14 | Typst/external tools | Typst embedded resources show zero download and retain current fixtures. Unsupported external packages/tools are explicit; Biber is not silently replaced by BibTeX. No font/engine installation is implied. |
| A15 | Later observations/lock/cleanup | Observations retain execution identity and incomplete coverage; lock import/export fails stale identity conflicts; cleanup previews and preserves registered/active resources, and is never a preparation side effect. Required only for the stages introducing these features. |

At each implementation stage run `pnpm tsc --noEmit`, `cargo check --manifest-path src-tauri/Cargo.toml`, focused meaningful Rust/vendor/CLI/MCP tests, and Graphify extraction/clustering after code changes. Native GUI and Windows/macOS checks have separate receipts. Existing automation and writing-ribbon evidence classifications remain unchanged.

## Storage objective and measurement

The measured full cache contains 134,980 indexed resources: 2,782,353,293 logical bytes including metadata, and 3,107,639,296 allocated bytes. Selective preparation removes the need to populate that entire cache for a small project; shared identities avoid duplicate copies across projects. Startup only uses shipped metadata/embedded assets and existing cache, so resource startup growth is zero unless the user prepares resources. This does not reduce the embedded engine binary sizes by itself.

Measure a fresh install plus shipped metadata, then isolated basic/article/presentation/resume preparations, generated formats from later authorized compilations, and two-project incremental reuse. Record actual transfer, logical files, allocated cache, total application payload, cold/warm timings and peak worker RSS separately, with bundle/catalog/engine/filesystem identities. Compare the same fixture's selective and full-cache output/diagnostics under offline compilation. Require smaller selected payload than full preparation for the basic fixture and zero additional transfer for its warm repetition; choose numeric pack ceilings only after these measurements. A larger valid project may legitimately approach full-bundle size.

The prior 55,910,400-byte partial allocated cache and approximately 232 MB combination with a stripped app are fixture observations, not a starter-pack target or release guarantee. Production release size is still unmeasured. Keep release packaging, shared compiler worker and packed-cache optimization independent from this manager.

## Pending decisions and implementation blockers

| Decision | Recommendation | Must settle |
| --- | --- | --- |
| Supported bundle/catalog trust | One pinned known bundle; trusted release index and per-resource hashes with provenance, no arbitrary CTAN/version selection. | Stage 0: actual identities/hash provenance and packaging/update policy. Engine crate pins alone do not pin the mutable configured bundle. |
| Cold metadata delivery | Ship metadata sufficient for the supported bundle; explicit metadata-only preparation for unavailable metadata. | Stage 0: measured catalog/index overhead, redistribution and reproducible generation. |
| Manifest/lock ownership | Separate visible schema-1 manifest; optional separate lock in stage 4; no implicit project writes. | Stage 0: names, validation/unknown-field policy; stage 4: lock refresh/export semantics. |
| Pack definitions and coverage | Validated base plus composable academic/presentation/resume dependencies; compile-time format sources included. | Stages 0–1: exact closure, conditional/options policy, source-preprocessing version and supported fixture list. |
| Desktop behavior migration | Shared offline live snapshot path; explicit examples at template creation; retain triggers/save/PDF behavior. | Stage 0: approve compatibility behavior and external-tool boundary; stages 2–3: parity evidence before enabling GUI. |
| Job lifecycle after UI closes | Closing the dialog hides progress while its owned job remains visible from the Resources entry; explicit Cancel stops it; app exit cancels/reaps. No detached unattended download service. | Stage 0: final GUI/MCP lifecycle, progress protocol, stale-target and cancellation ownership. |
| Quotas and locking | Reviewed incremental caps, disk-space check, cross-process writer lock, no automatic eviction. | Stage 2: lock timeouts/storage reservation/platform implementation; stage 5: global quota and unknown-project cleanup policy. |
| Observation persistence | Local bounded metadata receipts; portable lock updated only explicitly. | Stage 4: retention/privacy, failed-probe classification, font/format observation hooks and exact stale-history rules. |
| UI location | Project Resources dialog using current theme; no global package marketplace. | Stage 3: entry placement and native keyboard/layout review. |

Proceed only after stage-0 blockers and the first-delivery scope are settled and implementation is explicitly assigned. Then delegate stage 1 with the approved contracts and matrix, review its actual diff, and assign each following stage separately. This plan makes no changes to the roadmap's existing release priorities or QA statuses.

## Verification of this planning task

- Read the handoff, applicable local guidelines/backlog/specifications and versioned resource/automation/storage documents; inspected current source and local Git state.
- Consulted Graphify; recorded its useful nodes and query limitations above.
- `pnpm tsc --noEmit`: passed on 2026-10-08.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed on 2026-10-08.
- No application code, compiler configuration or resource cache was changed; no documents were compiled, no resources downloaded, and no Git publication action taken.
- Only this planning document was added. No code changes required a Graphify refresh. Historical verification classifications are preserved; the acceptance matrix is unexecuted future work.
