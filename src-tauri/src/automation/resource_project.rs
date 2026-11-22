//! Offline, transport-independent analysis and planning for project resources.
//!
//! This module only reads the selected snapshot, embedded catalog metadata, and
//! already cached files. It never downloads resources, writes the cache, or
//! invokes a compiler.

use super::{as_error, AutomationError, ProjectSnapshot, SnapshotFileKind, MAX_SNAPSHOT_BYTES};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use tectonic_bundles::CachableBundle;

const RESOURCE_SCHEMA_VERSION: u32 = 1;
const MAX_CATALOG_TABLE_BYTES: usize = 32 * 1024 * 1024;
const MAX_LIST_PAGE: usize = 200;
const MAX_SELECTOR_COUNT: usize = 1_000;
const MAX_RESOURCE_TEXT_BYTES: usize = 4_096;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_PLAN_ROWS: usize = 20_000;
const MANIFEST_PATH: &str = "sciencebatch.resources.json";
const LOCK_PATH: &str = "sciencebatch.resources.lock.json";
const PREPROCESSING_REVISION: &str = "sciencebatch-latex-resource-preprocess-v1";

const METADATA_GZ: &[u8] = include_bytes!("../../resource_catalog/metadata.json");
const INDEX_GZ: &[u8] = include_bytes!("../../resource_catalog/index.txt.gz");
const RESOURCES_GZ: &[u8] = include_bytes!("../../resource_catalog/resources.tsv.gz");
const SOURCE_FILES_GZ: &[u8] = include_bytes!("../../resource_catalog/source-files.tsv.gz");
const SOURCE_REFERENCES_GZ: &[u8] =
    include_bytes!("../../resource_catalog/source-references.tsv.gz");
const PACKS_JSON: &[u8] = include_bytes!("../../resource_catalog/packs.json");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSelector {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEvidence {
    pub kind: String,
    pub file: Option<String>,
    pub line: Option<usize>,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUnknown {
    pub id: String,
    pub expression: String,
    pub reason: String,
    pub file: Option<String>,
    pub line: Option<usize>,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRequirement {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub path: Option<String>,
    pub provider: String,
    pub resolution: String,
    pub availability: String,
    pub mandatory: bool,
    pub evidence: Vec<ResourceEvidence>,
    pub parents: Vec<String>,
    pub indexed_bytes: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePlan {
    pub resource_schema_version: u32,
    pub project: String,
    pub engine: String,
    pub main_file: String,
    pub input_digest: String,
    pub plan_digest: String,
    pub bundle_digest: Option<String>,
    pub index_sha256: Option<String>,
    pub bundle_url: Option<String>,
    pub catalog_sha256: Option<String>,
    pub catalog_packs: Vec<(String, String)>,
    pub bundle_metadata_state: String,
    pub metadata_storage_bytes: u64,
    pub coverage: String,
    pub selection: Vec<ResourceSelector>,
    pub requirements: Vec<ResourceRequirement>,
    pub unknown: Vec<ResourceUnknown>,
    pub project_state: String,
    pub total_resources: usize,
    pub resolved_resources: usize,
    pub cached_verified_resources: usize,
    pub missing_resources: usize,
    pub invalid_resources: usize,
    pub unresolved_count: usize,
    pub total_indexed_bytes: u64,
    pub cached_verified_bytes: u64,
    pub estimated_transfer_bytes: u64,
    pub incremental_storage_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct ResourceManifest {
    schema_version: u32,
    #[serde(default)]
    engine: Option<String>,
    #[serde(default)]
    requirements: Vec<ResourceSelector>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogMetadata {
    schema: u32,
    bundle: CatalogBundle,
    resources: ArtifactMetadata,
    source_metadata: SourceMetadata,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogBundle {
    digest: String,
    index: IndexMetadata,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexMetadata {
    sha256: String,
    bytes: usize,
    entries: usize,
    file: String,
    compressed_bytes: usize,
    compressed_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactMetadata {
    file: String,
    sha256: String,
    compressed_bytes: usize,
    decompressed_bytes: Option<usize>,
    entries: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceMetadata {
    files: ArtifactMetadata,
    references: ArtifactMetadata,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct PacksFile {
    schema_version: u32,
    engine: String,
    bundle_digest: String,
    index_sha256: String,
    packs: Vec<ResourcePack>,
    package_packs: BTreeMap<String, String>,
    #[serde(default)]
    format_resources: Vec<String>,
    provenance: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct ResourcePack {
    id: String,
    label: String,
    engine: String,
    mandatory: bool,
    resources: Vec<String>,
    #[serde(default)]
    fixture: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct IndexedResource {
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
struct SourceReference {
    file: String,
    line: usize,
    command: String,
    expression: String,
    classification: String,
}

#[derive(Clone, Debug)]
struct Catalog {
    metadata: CatalogMetadata,
    catalog_sha256: String,
    packs_file: PacksFile,
    resources: BTreeMap<String, IndexedResource>,
    package_paths: BTreeMap<String, Vec<String>>,
    references: BTreeMap<String, Vec<SourceReference>>,
    embedded_paths: BTreeSet<String>,
    format_resource_paths: BTreeSet<String>,
    index_bytes: Vec<u8>,
    bundle_url: String,
}

#[derive(Clone, Debug)]
pub(super) struct PinnedBundleInfo {
    pub url: String,
}

#[derive(Clone, Debug)]
pub(super) struct PinnedResourceDescriptor {
    pub path: String,
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub(super) struct CatalogResource {
    pub path: String,
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub(super) struct PinnedCatalog {
    pub url: String,
    pub digest: String,
    pub index_sha256: String,
    pub index_bytes: Vec<u8>,
    pub catalog_sha256: String,
}

static CATALOG: OnceLock<Result<Catalog, AutomationError>> = OnceLock::new();

#[derive(Default)]
struct PlanBuilder {
    requirement_map: BTreeMap<String, ResourceRequirement>,
    unknown_map: BTreeMap<String, ResourceUnknown>,
    traversed_sources: BTreeSet<String>,
    selectors: BTreeSet<ResourceSelector>,
    selected_paths: BTreeSet<String>,
    cache_root: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct Reference {
    command: String,
    expression: String,
    line: usize,
}

/// Analyze a selected disk or in-memory snapshot and return a bounded summary.
pub fn analyze_snapshot(
    snapshot: &ProjectSnapshot,
    args: &Value,
) -> Result<Value, AutomationError> {
    let plan = resolved_plan(snapshot, args)?;
    plan_summary(&plan)
}

/// Resolve a stable resource plan for reuse by the Tauri and preparation layers.
/// The returned resource offsets and hashes come only from the embedded catalog.
pub fn resolved_plan(
    snapshot: &ProjectSnapshot,
    args: &Value,
) -> Result<ResourcePlan, AutomationError> {
    resolved_plan_with_cache_root(snapshot, args, super::resources::cache_directory().ok())
}

pub(super) fn resolved_plan_with_cache_root(
    snapshot: &ProjectSnapshot,
    args: &Value,
    cache_root: Option<PathBuf>,
) -> Result<ResourcePlan, AutomationError> {
    validate_snapshot(snapshot)?;
    let catalog = catalog()?;
    let workspace_identity = args.get("workspaceIdentity").cloned();
    let input_digest = input_digest(snapshot, workspace_identity.as_ref(), catalog)?;
    if let Some(expected) = args.get("expectedInputDigest").and_then(Value::as_str) {
        if expected != input_digest {
            return Err(as_error(
                "resources.input_changed",
                "The project snapshot changed after analysis; analyze it again.",
                2,
            ));
        }
    }

    let manifest = parse_manifest(snapshot)?;
    if let Some(manifest_engine) = manifest.as_ref().and_then(|m| m.engine.as_deref()) {
        if !manifest_engine.eq_ignore_ascii_case(&snapshot.engine) {
            return Err(as_error(
                "resources.engine_mismatch",
                "The resource manifest engine does not match the selected project engine.",
                2,
            ));
        }
    }
    let mut selected = parse_selection(args.get("selection"))?;
    if let Some(manifest) = &manifest {
        if manifest.requirements.len() > MAX_SELECTOR_COUNT {
            return Err(limit_exceeded("Resource manifest exceeds 1,000 selectors."));
        }
        selected.extend(manifest.requirements.iter().cloned());
    }
    if selected.len() > MAX_SELECTOR_COUNT {
        return Err(limit_exceeded(
            "Combined resource selection exceeds 1,000 selectors.",
        ));
    }
    if snapshot.engine == "latex" {
        selected.insert(ResourceSelector {
            kind: "pack".into(),
            id: "latex-basic".into(),
        });
    }
    validate_selectors(snapshot, catalog, &selected)?;

    let mut builder = PlanBuilder {
        selectors: selected.clone(),
        cache_root: cache_root.clone(),
        ..PlanBuilder::default()
    };
    for selector in &selected {
        builder.apply_selector(snapshot, catalog, selector, true, None)?;
    }

    snapshot.files.get(&snapshot.main_file).ok_or_else(|| {
        as_error(
            "project.main_missing",
            "The selected main source is missing from the snapshot.",
            2,
        )
    })?;
    match snapshot.engine.as_str() {
        "latex" => {
            builder.scan_project_file(snapshot, catalog, &snapshot.main_file, "detected", None)?;
            builder.add_preprocessor_dependencies(snapshot, catalog)?;
        }
        "typst" => {
            builder.add_embedded_requirement(
                "typst-engine-assets",
                "Typst engine assets",
                ResourceEvidence {
                    kind: "embedded".into(),
                    file: Some(snapshot.main_file.clone()),
                    line: None,
                    parent: None,
                },
            );
            builder.scan_typst(snapshot, &snapshot.main_file)?;
        }
        _ => {
            return Err(as_error(
                "engine.unsupported",
                "Resource analysis supports latex and typst projects.",
                2,
            ));
        }
    }
    let unknown: Vec<_> = builder.unknown_map.into_values().collect();
    if requirements_exceed_bound(builder.requirement_map.len(), unknown.len()) {
        return Err(limit_exceeded(
            "Resource analysis exceeds the bounded plan row limit.",
        ));
    }
    let unresolved_count = unknown.len();
    let final_selection = builder.selectors.clone();
    let requirements: Vec<_> = builder.requirement_map.into_values().collect();
    let selected_paths = requirements
        .iter()
        .filter_map(|row| row.path.as_ref())
        .filter(|path| builder.selected_paths.contains(*path))
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut plan_material = json!({
        "resourceSchemaVersion": RESOURCE_SCHEMA_VERSION,
        "inputDigest": input_digest,
        "selection": final_selection,
        "paths": selected_paths,
        "bundleDigest": catalog.metadata.bundle.digest,
        "indexSha256": catalog.metadata.bundle.index.sha256,
        "catalogSha256": catalog.catalog_sha256,
        "preprocessingRevision": PREPROCESSING_REVISION,
    });
    canonicalize_json(&mut plan_material);
    let plan_digest =
        digest_bytes(&serde_json::to_vec(&plan_material).map_err(|error| {
            AutomationError::new("worker.protocol_invalid", error.to_string(), 4)
        })?);
    let (
        resolved_resources,
        cached_verified_resources,
        missing_resources,
        invalid_resources,
        total_indexed_bytes,
        cached_verified_bytes,
    ) = summarize_requirements(&requirements);
    let mut incremental_storage_bytes = 0u64;
    let missing_paths = requirements
        .iter()
        .filter(|row| row.provider == "pinned_bundle" && row.availability == "missing")
        .filter_map(|row| {
            incremental_storage_bytes =
                incremental_storage_bytes.saturating_add(row.indexed_bytes.unwrap_or(0));
            row.path.clone()
        })
        .collect::<Vec<_>>();
    let estimated_transfer_bytes = estimate_pinned_transfer_bytes(&missing_paths)?;
    let (bundle_metadata_state, metadata_storage_bytes) = if snapshot.engine == "typst" {
        ("embedded".to_owned(), 0)
    } else {
        match cache_root.as_deref() {
            Some(cache_root) => match pinned_cache_metadata_state_at(catalog, cache_root)? {
                (state, _) if state == "missing" => ("embedded".into(), 0),
                result => result,
            },
            None => ("embedded".into(), 0),
        }
    };
    let project_state = if invalid_resources > 0 || bundle_metadata_state == "invalid" {
        "blocked"
    } else if missing_resources == 0
        && matches!(
            bundle_metadata_state.as_str(),
            "cached_verified" | "embedded"
        )
    {
        "prepared_known_set"
    } else {
        "not_prepared"
    };
    let total_resources = requirements
        .iter()
        .filter(|row| row.provider == "pinned_bundle")
        .count();
    let project = if snapshot.root.as_os_str().is_empty() {
        "workspace://selected".to_owned()
    } else {
        snapshot.root.to_string_lossy().into_owned()
    };
    Ok(ResourcePlan {
        resource_schema_version: RESOURCE_SCHEMA_VERSION,
        project,
        engine: snapshot.engine.clone(),
        main_file: snapshot.main_file.clone(),
        input_digest,
        plan_digest,
        bundle_digest: (snapshot.engine == "latex").then(|| catalog.metadata.bundle.digest.clone()),
        index_sha256: (snapshot.engine == "latex")
            .then(|| catalog.metadata.bundle.index.sha256.clone()),
        bundle_url: (snapshot.engine == "latex").then(|| catalog.bundle_url.clone()),
        catalog_sha256: (snapshot.engine == "latex").then(|| catalog.catalog_sha256.clone()),
        catalog_packs: if snapshot.engine == "latex" {
            catalog
                .packs_file
                .packs
                .iter()
                .map(|pack| (pack.id.clone(), pack.label.clone()))
                .collect()
        } else {
            Vec::new()
        },
        bundle_metadata_state,
        metadata_storage_bytes,
        coverage: "static_and_declared".into(),
        selection: final_selection.into_iter().collect(),
        requirements,
        unknown,
        project_state: project_state.into(),
        total_resources,
        resolved_resources,
        cached_verified_resources,
        missing_resources,
        invalid_resources,
        unresolved_count,
        total_indexed_bytes,
        cached_verified_bytes,
        estimated_transfer_bytes,
        incremental_storage_bytes,
    })
}

pub(super) fn dispatch(
    command: &str,
    snapshot: &ProjectSnapshot,
    args: &Value,
) -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    for field in ["expectedInputDigest", "expectedPlanDigest", "cursor"] {
        if args.get(field).is_some_and(|value| !value.is_string()) {
            return Err(as_error(
                "usage.invalid_argument",
                format!("{field} must be a string when provided."),
                2,
            ));
        }
    }
    if args.get("limit").is_some_and(|value| !value.is_u64()) {
        return Err(as_error(
            "usage.invalid_argument",
            "limit must be a non-negative integer when provided.",
            2,
        ));
    }
    if command == "resources.plan"
        && args
            .get("expectedInputDigest")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(as_error(
            "usage.invalid_argument",
            "expectedInputDigest is required for resources.plan.",
            2,
        ));
    }
    let plan = resolved_plan(snapshot, args)?;
    if command == "resources.plan"
        && args
            .get("expectedPlanDigest")
            .and_then(Value::as_str)
            .is_some_and(|expected| expected != plan.plan_digest)
    {
        return Err(as_error(
            "resources.plan_changed",
            "The resource plan changed; review the new plan before continuing.",
            2,
        ));
    }
    match command {
        "resources.analyze" | "resources.plan" => Ok((plan_summary(&plan)?, Vec::new())),
        "resources.list" => Ok((list_page(&plan, args)?, Vec::new())),
        _ => Err(as_error(
            "usage.invalid_argument",
            format!("Unknown resource project operation '{command}'."),
            2,
        )),
    }
}

pub(super) fn plan_summary_for_external(plan: &ResourcePlan) -> Result<Value, AutomationError> {
    plan_summary(plan)
}

fn plan_summary(plan: &ResourcePlan) -> Result<Value, AutomationError> {
    let unknown = plan
        .unknown
        .iter()
        .take(MAX_LIST_PAGE)
        .cloned()
        .collect::<Vec<_>>();
    let unknown_omitted = plan.unknown.len().saturating_sub(unknown.len());
    let result = json!({
        "resourceSchemaVersion": plan.resource_schema_version,
        "project": plan.project,
        "engine": plan.engine,
        "mainFile": plan.main_file,
        "inputDigest": plan.input_digest,
        "planDigest": plan.plan_digest,
        "bundleDigest": plan.bundle_digest,
        "indexSha256": plan.index_sha256,
        "bundleUrl": plan.bundle_url,
        "catalogSha256": plan.catalog_sha256,
        "catalogPacks": plan.catalog_packs.iter().map(|(id, label)| json!({"id":id,"label":label})).collect::<Vec<_>>(),
        "bundleMetadataState": plan.bundle_metadata_state,
        "coverage": plan.coverage,
        "selection": plan.selection,
        "projectState": plan.project_state,
        "summary": {
            "totalResources": plan.total_resources,
            "resolvedResources": plan.resolved_resources,
            "cachedVerifiedResources": plan.cached_verified_resources,
            "missingResources": plan.missing_resources,
            "invalidResources": plan.invalid_resources,
            "unresolvedCount": plan.unresolved_count,
            "totalIndexedBytes": plan.total_indexed_bytes,
            "cachedVerifiedBytes": plan.cached_verified_bytes,
            "estimatedTransferBytes": plan.estimated_transfer_bytes,
            "incrementalStorageBytes": plan.incremental_storage_bytes,
            "metadataStorageBytes": plan.metadata_storage_bytes,
        },
        "unknown": unknown,
        "unknownOmitted": unknown_omitted,
    });
    ensure_bounded_json(&result)?;
    Ok(result)
}

fn list_page(plan: &ResourcePlan, args: &Value) -> Result<Value, AutomationError> {
    let expected = args
        .get("expectedPlanDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "expectedPlanDigest is required.",
                2,
            )
        })?;
    if expected != plan.plan_digest {
        return Err(as_error(
            "resources.plan_changed",
            "The plan changed after analysis; analyze the project again.",
            2,
        ));
    }
    let limit = args
        .get("limit")
        .map_or(100, |value| value.as_u64().unwrap_or(0)) as usize;
    if !(1..=MAX_LIST_PAGE).contains(&limit) {
        return Err(as_error(
            "usage.invalid_argument",
            "Resource list limit must be between 1 and 200.",
            2,
        ));
    }
    let offset = match args.get("cursor").and_then(Value::as_str) {
        None => 0,
        Some(cursor) => parse_cursor(cursor, expected)?,
    };
    let mut rows = plan
        .requirements
        .iter()
        .cloned()
        .map(|item| json!({"itemType":"requirement","item":item}))
        .collect::<Vec<_>>();
    rows.extend(
        plan.unknown
            .iter()
            .cloned()
            .map(|item| json!({"itemType":"unknown","item":item})),
    );
    rows.sort_by(|left, right| {
        left["item"]["id"]
            .as_str()
            .cmp(&right["item"]["id"].as_str())
    });
    let total = rows.len();
    if offset > total {
        return Err(as_error(
            "usage.invalid_argument",
            "Resource cursor is outside this plan.",
            2,
        ));
    }
    let page = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next_offset = offset + page.len();
    let next_cursor = (next_offset < total).then(|| format!("{}:{next_offset}", plan.plan_digest));
    let result = json!({
        "resourceSchemaVersion": RESOURCE_SCHEMA_VERSION,
        "planDigest": plan.plan_digest,
        "offset": offset,
        "limit": limit,
        "total": total,
        "items": page,
        "nextCursor": next_cursor,
    });
    ensure_bounded_json(&result)?;
    Ok(result)
}

fn parse_cursor(cursor: &str, expected_digest: &str) -> Result<usize, AutomationError> {
    let (digest, offset) = cursor
        .split_once(':')
        .ok_or_else(|| as_error("usage.invalid_argument", "Resource cursor is malformed.", 2))?;
    if digest != expected_digest || offset.is_empty() || !offset.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(as_error(
            "resources.plan_changed",
            "Resource cursor belongs to a different plan.",
            2,
        ));
    }
    offset
        .parse()
        .map_err(|_| as_error("usage.invalid_argument", "Resource cursor is malformed.", 2))
}

fn parse_manifest(snapshot: &ProjectSnapshot) -> Result<Option<ResourceManifest>, AutomationError> {
    let Some(file) = snapshot.files.get(MANIFEST_PATH) else {
        return Ok(None);
    };
    if file.kind != SnapshotFileKind::Text {
        return Err(as_error(
            "resources.manifest_invalid",
            "The project resource manifest must be a UTF-8 text file.",
            2,
        ));
    }
    if file.bytes.len() > MAX_OUTPUT_BYTES {
        return Err(limit_exceeded(
            "The resource manifest exceeds the 1 MiB input limit.",
        ));
    }
    let manifest: ResourceManifest = serde_json::from_slice(&file.bytes).map_err(|error| {
        AutomationError::new(
            "resources.manifest_invalid",
            format!("The project resource manifest is invalid: {error}"),
            2,
        )
    })?;
    if manifest.schema_version != RESOURCE_SCHEMA_VERSION {
        return Err(as_error(
            "resources.manifest_version_unsupported",
            "The project resource manifest schema version is unsupported.",
            2,
        ));
    }
    for selector in &manifest.requirements {
        validate_selector(selector)?;
    }
    Ok(Some(manifest))
}

fn parse_selection(value: Option<&Value>) -> Result<BTreeSet<ResourceSelector>, AutomationError> {
    let Some(value) = value else {
        return Ok(BTreeSet::new());
    };
    if value
        .as_array()
        .is_some_and(|items| items.len() > MAX_SELECTOR_COUNT)
    {
        return Err(limit_exceeded(
            "Resource selection exceeds 1,000 selectors.",
        ));
    }
    let selectors: Vec<ResourceSelector> =
        serde_json::from_value(value.clone()).map_err(|error| {
            AutomationError::new(
                "usage.invalid_argument",
                format!("Resource selection is invalid: {error}"),
                2,
            )
        })?;
    let mut result = BTreeSet::new();
    for selector in selectors {
        validate_selector(&selector)?;
        result.insert(selector);
    }
    if result.len() > MAX_SELECTOR_COUNT {
        return Err(limit_exceeded(
            "Resource selection exceeds 1,000 selectors.",
        ));
    }
    Ok(result)
}

fn validate_selector(selector: &ResourceSelector) -> Result<(), AutomationError> {
    if !["pack", "package", "resource"].contains(&selector.kind.as_str()) {
        return Err(as_error(
            "resources.selector_unsupported",
            "Resource selector kind must be pack, package, or resource.",
            2,
        ));
    }
    if selector.id.trim().is_empty()
        || selector.id.len() > MAX_RESOURCE_TEXT_BYTES
        || selector.id.contains('\0')
        || selector.id.contains("://")
        || selector.id.starts_with('/')
        || selector.id.contains('\\')
    {
        return Err(as_error(
            "resources.selector_invalid",
            "Resource selector ID must be a package, pack, or relative bundle path.",
            2,
        ));
    }
    if selector.kind == "resource" && !safe_bundle_path(&selector.id) {
        return Err(as_error(
            "resources.selector_invalid",
            "Resource selector path must be a normalized path inside the pinned bundle.",
            2,
        ));
    }
    if selector.kind != "resource" && (selector.id.contains('/') || selector.id.contains(':')) {
        return Err(as_error(
            "resources.selector_invalid",
            "Package and pack selectors cannot contain filesystem paths or URLs.",
            2,
        ));
    }
    if selector.kind == "resource"
        && matches!(
            selector.id.as_str(),
            "sample.png" | "sample.gif" | "references.bib"
        )
    {
        return Err(as_error(
            "resources.selector_invalid",
            "Project examples and bibliographies cannot be selected from the provider bundle.",
            2,
        ));
    }
    Ok(())
}

fn validate_selectors(
    snapshot: &ProjectSnapshot,
    catalog: &Catalog,
    selectors: &BTreeSet<ResourceSelector>,
) -> Result<(), AutomationError> {
    for selector in selectors {
        match selector.kind.as_str() {
            "pack" => {
                let Some(pack) = catalog
                    .packs_file
                    .packs
                    .iter()
                    .find(|pack| pack.id == selector.id)
                else {
                    return Err(as_error(
                        "resources.selector_unknown",
                        format!("Unknown resource pack '{}'.", selector.id),
                        2,
                    ));
                };
                if !pack.engine.eq_ignore_ascii_case(&snapshot.engine) {
                    return Err(as_error(
                        "resources.engine_mismatch",
                        format!(
                            "Pack '{}' is incompatible with the selected engine.",
                            selector.id
                        ),
                        2,
                    ));
                }
            }
            "package" if snapshot.engine != "latex" => {
                return Err(as_error(
                    "resources.engine_mismatch",
                    "Tectonic package selectors are not valid for Typst projects.",
                    2,
                ));
            }
            "resource" if snapshot.engine != "latex" => {
                return Err(as_error(
                    "resources.engine_mismatch",
                    "Bundle resource selectors are not valid for Typst projects.",
                    2,
                ));
            }
            "resource" if !catalog.resources.contains_key(&selector.id) => {
                return Err(as_error(
                    "resources.selector_unknown",
                    format!("Resource '{}' is not in the pinned bundle.", selector.id),
                    2,
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

impl PlanBuilder {
    fn apply_selector(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        selector: &ResourceSelector,
        mandatory: bool,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        let evidence = ResourceEvidence {
            kind: if parent.is_some() {
                "transitive"
            } else {
                "declared"
            }
            .into(),
            file: parent.map(str::to_owned),
            line: None,
            parent: parent.map(str::to_owned),
        };
        match selector.kind.as_str() {
            "pack" => {
                let pack = catalog
                    .packs_file
                    .packs
                    .iter()
                    .find(|pack| pack.id == selector.id)
                    .ok_or_else(|| {
                        as_error(
                            "resources.selector_unknown",
                            format!("Unknown resource pack '{}'.", selector.id),
                            2,
                        )
                    })?;
                self.selectors.insert(selector.clone());
                for path in &pack.resources {
                    self.add_bundle_path(
                        snapshot,
                        catalog,
                        path,
                        mandatory || pack.mandatory,
                        evidence.clone(),
                        Some(&selector.id),
                    )?;
                }
            }
            "resource" => {
                self.selectors.insert(selector.clone());
                self.add_bundle_path(snapshot, catalog, &selector.id, mandatory, evidence, parent)?;
            }
            "package" => {
                self.selectors.insert(selector.clone());
                self.resolve_package(
                    snapshot,
                    catalog,
                    &selector.id,
                    "selector",
                    mandatory,
                    evidence,
                    parent,
                )?;
            }
            _ => unreachable!("selectors are validated before resolution"),
        }
        Ok(())
    }

    fn resolve_package(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        package: &str,
        reference_kind: &str,
        mandatory: bool,
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        let required_extension = match reference_kind {
            "class" => Some("cls"),
            "package" => Some("sty"),
            _ => None,
        };
        let local_candidates: Vec<String> = required_extension
            .map(|extension| vec![format!("{package}.{extension}")])
            .unwrap_or_else(|| vec![format!("{package}.sty"), format!("{package}.cls")]);
        for local in local_candidates {
            if snapshot.files.contains_key(&local) {
                self.add_local_path(
                    snapshot,
                    catalog,
                    &local,
                    mandatory,
                    evidence.clone(),
                    parent,
                )?;
                return Ok(());
            }
        }
        if package == "simpleicons" {
            for path in &catalog.embedded_paths {
                self.add_embedded_requirement(path, path, evidence.clone());
            }
            return Ok(());
        }
        if let Some(pack_id) = catalog.packs_file.package_packs.get(package) {
            let selector = ResourceSelector {
                kind: "pack".into(),
                id: pack_id.clone(),
            };
            self.apply_selector(snapshot, catalog, &selector, mandatory, Some(package))?;
        }
        let mut matches = catalog
            .package_paths
            .get(package)
            .cloned()
            .unwrap_or_default();
        if let Some(extension) = required_extension {
            matches.retain(|path| {
                Path::new(path).extension().and_then(|ext| ext.to_str()) == Some(extension)
            });
        }
        if matches.is_empty() {
            if let Some(pack_id) = catalog.packs_file.package_packs.get(package) {
                if let Some(pack) = catalog
                    .packs_file
                    .packs
                    .iter()
                    .find(|candidate| &candidate.id == pack_id)
                {
                    for path in &pack.resources {
                        self.add_bundle_path(
                            snapshot,
                            catalog,
                            path,
                            mandatory,
                            evidence.clone(),
                            Some(package),
                        )?;
                    }
                    return Ok(());
                }
            }
            self.add_unknown(
                &format!("package:{package}"),
                package,
                "package_not_in_pinned_catalog",
                evidence,
            );
            return Ok(());
        }
        matches.sort_by_key(|path| {
            let extension = Path::new(path)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("");
            if extension.eq_ignore_ascii_case("sty") {
                0
            } else if extension.eq_ignore_ascii_case("cls") {
                1
            } else {
                2
            }
        });
        matches.dedup();
        for path in matches {
            self.add_bundle_path(
                snapshot,
                catalog,
                &path,
                mandatory,
                evidence.clone(),
                Some(package),
            )?;
        }
        Ok(())
    }

    fn add_bundle_path(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        path: &str,
        mandatory: bool,
        evidence: ResourceEvidence,
        package: Option<&str>,
    ) -> Result<(), AutomationError> {
        if !safe_bundle_path(path) {
            return Err(as_error(
                "resources.catalog_invalid",
                "The embedded catalog contains an unsafe resource path.",
                4,
            ));
        }
        let Some(resource) = catalog.resources.get(path) else {
            self.add_unknown(path, path, "resource_not_in_pinned_catalog", evidence);
            return Ok(());
        };
        let local_override = snapshot.files.contains_key(path);
        let force_pinned = catalog.format_resource_paths.contains(path);
        if local_override && !force_pinned {
            let local = &snapshot.files[path];
            if local.kind == SnapshotFileKind::Text && is_scannable(path) {
                self.scan_project_file(snapshot, catalog, path, "detected", package)?;
            }
            self.add_local_path(snapshot, catalog, path, mandatory, evidence, package)?;
            return Ok(());
        }
        let availability = self.cached_state(path, resource);
        let id = format!("resource:{path}");
        self.selected_paths.insert(path.to_owned());
        let row = self
            .requirement_map
            .entry(id.clone())
            .or_insert_with(|| ResourceRequirement {
                id,
                kind: "resource".into(),
                label: path.to_owned(),
                path: Some(path.to_owned()),
                provider: "pinned_bundle".into(),
                resolution: "resolved".into(),
                availability,
                mandatory,
                evidence: Vec::new(),
                parents: Vec::new(),
                indexed_bytes: Some(resource.length),
                sha256: Some(resource.sha256.clone()),
            });
        row.mandatory |= mandatory;
        add_evidence(row, evidence.clone());
        if let Some(package) = package {
            if row.parents.len() < 32 && !row.parents.iter().any(|p| p == package) {
                row.parents.push(package.to_owned());
            }
        }
        if local_override && force_pinned {
            let local = &snapshot.files[path];
            if local.kind == SnapshotFileKind::Text && is_scannable(path) {
                self.scan_project_file(snapshot, catalog, path, "detected", package)?;
            }
            self.add_local_path(
                snapshot,
                catalog,
                path,
                mandatory,
                evidence.clone(),
                package,
            )?;
        }
        self.scan_catalog_source(snapshot, catalog, path, package)?;
        Ok(())
    }

    fn add_local_path(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        path: &str,
        mandatory: bool,
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        let Some(file) = snapshot.files.get(path) else {
            self.add_unknown(path, path, "project_local_file_missing", evidence);
            return Ok(());
        };
        let id = format!("local:{path}");
        let row = self
            .requirement_map
            .entry(id.clone())
            .or_insert_with(|| ResourceRequirement {
                id,
                kind: "resource".into(),
                label: path.to_owned(),
                path: Some(path.to_owned()),
                provider: "project_local".into(),
                resolution: "resolved".into(),
                availability: "local".into(),
                mandatory,
                evidence: Vec::new(),
                parents: Vec::new(),
                indexed_bytes: Some(file.bytes.len() as u64),
                sha256: Some(digest_bytes(&file.bytes)),
            });
        row.mandatory |= mandatory;
        add_evidence(row, evidence);
        if let Some(parent) = parent {
            if row.parents.len() < 32 && !row.parents.iter().any(|p| p == parent) {
                row.parents.push(parent.to_owned());
            }
        }
        if file.kind == SnapshotFileKind::Text && is_scannable(path) {
            self.scan_project_file(snapshot, catalog, path, "transitive", parent)?;
        }
        Ok(())
    }

    fn add_embedded_requirement(&mut self, path: &str, label: &str, evidence: ResourceEvidence) {
        let id = format!("embedded:{path}");
        let row = self
            .requirement_map
            .entry(id.clone())
            .or_insert_with(|| ResourceRequirement {
                id,
                kind: "resource".into(),
                label: label.to_owned(),
                path: Some(path.to_owned()),
                provider: "embedded".into(),
                resolution: "resolved".into(),
                availability: "embedded".into(),
                mandatory: true,
                evidence: Vec::new(),
                parents: Vec::new(),
                indexed_bytes: None,
                sha256: None,
            });
        add_evidence(row, evidence);
    }

    fn add_unknown(
        &mut self,
        id: &str,
        expression: &str,
        reason: &str,
        evidence: ResourceEvidence,
    ) {
        let stable = format!(
            "unknown:{}",
            digest_bytes(format!("{id}\0{expression}\0{:?}", evidence.file).as_bytes())
        );
        self.unknown_map
            .entry(stable.clone())
            .or_insert(ResourceUnknown {
                id: stable,
                expression: expression.to_owned(),
                reason: reason.to_owned(),
                file: evidence.file,
                line: evidence.line,
                parent: evidence.parent,
            });
    }

    fn scan_project_file(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        path: &str,
        evidence_kind: &str,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        if !self.traversed_sources.insert(format!("local:{path}")) {
            return Ok(());
        }
        let Some(file) = snapshot.files.get(path) else {
            return Ok(());
        };
        let text = match std::str::from_utf8(&file.bytes) {
            Ok(text) => text,
            Err(_) => {
                self.add_unknown(
                    path,
                    path,
                    "source_not_utf8",
                    ResourceEvidence {
                        kind: evidence_kind.into(),
                        file: Some(path.into()),
                        line: None,
                        parent: parent.map(str::to_owned),
                    },
                );
                return Ok(());
            }
        };
        for reference in scan_references(text)? {
            let evidence = ResourceEvidence {
                kind: evidence_kind.into(),
                file: Some(path.to_owned()),
                line: Some(reference.line),
                parent: parent.map(str::to_owned),
            };
            if reference.command == "documentclass" || reference.command == "LoadClass" {
                for class in split_list(&reference.expression) {
                    self.select_detected_package(
                        snapshot,
                        catalog,
                        &class,
                        "class",
                        evidence.clone(),
                        parent,
                    )?;
                }
            } else if is_package_command(&reference.command) {
                for package in split_list(&reference.expression) {
                    if is_literal_id(&package) {
                        if path == snapshot.main_file
                            && is_preprocessed_font_package(text, &package)
                        {
                            continue;
                        }
                        let package = theme_package_name(&reference.command, &package);
                        self.select_detected_package(
                            snapshot,
                            catalog,
                            &package,
                            "package",
                            evidence.clone(),
                            parent,
                        )?;
                    } else {
                        self.add_unknown(
                            &package,
                            &package,
                            "macro_valued_package_reference",
                            evidence.clone(),
                        );
                    }
                }
            } else if is_font_command(&reference.command) {
                for font in split_list(&reference.expression) {
                    self.resolve_font_reference(
                        snapshot,
                        catalog,
                        &font,
                        evidence.clone(),
                        parent,
                    )?;
                }
            } else if reference.command == "bibliographystyle" {
                for style in split_list(&reference.expression) {
                    self.resolve_bundle_file(
                        snapshot,
                        catalog,
                        &style,
                        &["bst"],
                        evidence.clone(),
                        parent,
                    )?;
                }
            } else if is_user_asset_command(&reference.command) {
                for asset in split_list(&reference.expression) {
                    self.resolve_local_asset(snapshot, catalog, &asset, evidence.clone(), parent)?;
                }
            } else if is_file_command(&reference.command) {
                for input in split_list(&reference.expression) {
                    if !is_literal_id(&input) {
                        self.add_unknown(
                            &input,
                            &input,
                            "macro_valued_file_reference",
                            evidence.clone(),
                        );
                    } else {
                        self.resolve_input(
                            snapshot,
                            catalog,
                            path,
                            &input,
                            evidence.clone(),
                            parent,
                        )?;
                    }
                }
            }
        }
        let sanitized = strip_comments_and_verbatim(text);
        if let Some((line, expression)) = first_conditional(&sanitized) {
            self.add_unknown(
                path,
                &expression,
                "conditional_tex_dependency",
                ResourceEvidence {
                    kind: evidence_kind.into(),
                    file: Some(path.into()),
                    line: Some(line),
                    parent: parent.map(str::to_owned),
                },
            );
        }
        Ok(())
    }

    fn select_detected_package(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        package: &str,
        kind: &str,
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        self.resolve_package(snapshot, catalog, package, kind, true, evidence, parent)
    }

    fn resolve_input(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        source_path: &str,
        input: &str,
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        let mut candidates = Vec::new();
        let source_parent = Path::new(source_path)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        let raw = Path::new(input);
        let joined = if raw.is_absolute() {
            None
        } else {
            Some(source_parent.join(raw).to_string_lossy().replace('\\', "/"))
        };
        if let Some(joined) = joined {
            if let Ok(normalized) = super::normalize_project_path(&joined) {
                candidates.push(normalized);
            }
        }
        if let Ok(normalized) = super::normalize_project_path(input) {
            if !candidates.contains(&normalized) {
                candidates.push(normalized);
            }
        }
        let bibliography = candidates.iter().any(|candidate| {
            Path::new(candidate)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("bib"))
        });
        for candidate in &candidates {
            if snapshot.files.contains_key(candidate) {
                self.add_local_path(snapshot, catalog, candidate, true, evidence, parent)?;
                return Ok(());
            }
            if bibliography {
                continue;
            }
            let extension = Path::new(candidate)
                .extension()
                .and_then(|ext| ext.to_str());
            if extension.is_some() && catalog.resources.contains_key(candidate) {
                self.add_bundle_path(snapshot, catalog, candidate, true, evidence, parent)?;
                return Ok(());
            }
        }
        if bibliography {
            self.add_unknown(
                input,
                input,
                "missing_project_bibliography_not_downloadable",
                evidence,
            );
            return Ok(());
        }
        if Path::new(input).extension().is_none() {
            for extension in ["tex", "sty", "cls", "def", "cfg", "ldf"] {
                for candidate in &candidates {
                    let with_extension = format!("{candidate}.{extension}");
                    if snapshot.files.contains_key(&with_extension) {
                        self.add_local_path(
                            snapshot,
                            catalog,
                            &with_extension,
                            true,
                            evidence,
                            parent,
                        )?;
                        return Ok(());
                    }
                    if catalog.resources.contains_key(&with_extension) {
                        self.add_bundle_path(
                            snapshot,
                            catalog,
                            &with_extension,
                            true,
                            evidence,
                            parent,
                        )?;
                        return Ok(());
                    }
                }
            }
        }
        self.add_unknown(
            input,
            input,
            "input_not_found_in_project_or_bundle",
            evidence,
        );
        Ok(())
    }

    fn resolve_bundle_file(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        stem: &str,
        extensions: &[&str],
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        for extension in extensions {
            let path = if stem.ends_with(&format!(".{extension}")) {
                stem.to_owned()
            } else {
                format!("{stem}.{extension}")
            };
            if snapshot.files.contains_key(&path) {
                self.add_local_path(snapshot, catalog, &path, true, evidence, parent)?;
                return Ok(());
            }
            if catalog.resources.contains_key(&path) {
                self.add_bundle_path(snapshot, catalog, &path, true, evidence, parent)?;
                return Ok(());
            }
        }
        self.add_unknown(stem, stem, "bundle_style_not_found", evidence);
        Ok(())
    }

    fn resolve_local_asset(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        asset: &str,
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        if !is_literal_id(asset) {
            self.add_unknown(asset, asset, "macro_valued_user_asset", evidence);
            return Ok(());
        }
        let mut candidates = vec![asset.to_owned()];
        if Path::new(asset).extension().is_none() {
            candidates.extend(
                ["bib", "pdf", "png", "jpg", "jpeg", "eps", "svg", "gif"]
                    .map(|ext| format!("{asset}.{ext}")),
            );
        }
        let found = candidates.into_iter().find_map(|candidate| {
            super::normalize_project_path(&candidate)
                .ok()
                .filter(|path| snapshot.files.contains_key(path))
        });
        if let Some(path) = found {
            self.add_local_path(snapshot, catalog, &path, true, evidence, parent)?;
        } else {
            self.add_unknown(
                asset,
                asset,
                "missing_project_asset_not_downloadable",
                evidence,
            );
        }
        Ok(())
    }

    fn resolve_font_reference(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        font: &str,
        evidence: ResourceEvidence,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        if !is_literal_id(font) {
            self.add_unknown(font, font, "macro_valued_font_reference", evidence);
            return Ok(());
        }
        let extension = Path::new(font).extension().and_then(|value| value.to_str());
        if !extension
            .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "otf" | "ttf"))
        {
            self.add_unknown(font, font, "font_family_resolution_unknown", evidence);
            return Ok(());
        }
        let path = super::normalize_project_path(font).ok();
        if let Some(path) = path.filter(|path| snapshot.files.contains_key(path)) {
            self.add_local_path(snapshot, catalog, &path, true, evidence, parent)?;
        } else if catalog.resources.contains_key(font) {
            self.add_bundle_path(snapshot, catalog, font, true, evidence, parent)?;
        } else {
            self.add_unknown(font, font, "font_file_not_found", evidence);
        }
        Ok(())
    }

    fn scan_catalog_source(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
        path: &str,
        parent: Option<&str>,
    ) -> Result<(), AutomationError> {
        if !self.traversed_sources.insert(format!("bundle:{path}")) {
            return Ok(());
        }
        let Some(references) = catalog.references.get(path) else {
            return Ok(());
        };
        for reference in references {
            let evidence = ResourceEvidence {
                kind: "transitive".into(),
                file: Some(reference.file.clone()),
                line: Some(reference.line),
                parent: parent.map(str::to_owned),
            };
            if reference.classification != "literal" {
                self.add_unknown(
                    &reference.expression,
                    &reference.expression,
                    "macro_valued_catalog_reference",
                    evidence,
                );
                continue;
            }
            if reference.command == "documentclass" || reference.command == "LoadClass" {
                for class in split_list(&reference.expression) {
                    self.resolve_package(
                        snapshot,
                        catalog,
                        &class,
                        "class",
                        true,
                        evidence.clone(),
                        Some(path),
                    )?;
                }
            } else if is_package_command(&reference.command) {
                for package in split_list(&reference.expression) {
                    self.resolve_package(
                        snapshot,
                        catalog,
                        &package,
                        "package",
                        true,
                        evidence.clone(),
                        Some(path),
                    )?;
                }
            } else if reference.command == "bibliographystyle" {
                for style in split_list(&reference.expression) {
                    self.resolve_bundle_file(
                        snapshot,
                        catalog,
                        &style,
                        &["bst"],
                        evidence.clone(),
                        Some(path),
                    )?;
                }
            } else if is_file_command(&reference.command) {
                self.resolve_input(
                    snapshot,
                    catalog,
                    path,
                    &reference.expression,
                    evidence,
                    Some(path),
                )?;
            }
        }
        Ok(())
    }

    fn add_preprocessor_dependencies(
        &mut self,
        snapshot: &ProjectSnapshot,
        catalog: &Catalog,
    ) -> Result<(), AutomationError> {
        let Some(main) = snapshot.files.get(&snapshot.main_file) else {
            return Ok(());
        };
        let source = String::from_utf8_lossy(&main.bytes);
        let needs_t1 = (source.contains("IEEEtran") || source.contains("{ptm}"))
            && !source.contains("{fontenc}")
            && !source.contains("{fontspec}");
        if needs_t1 {
            let evidence = ResourceEvidence {
                kind: "detected".into(),
                file: Some(snapshot.main_file.clone()),
                line: scan_references(&source)?
                    .iter()
                    .find(|reference| reference.command == "documentclass")
                    .map(|reference| reference.line),
                parent: Some("ScienceBatch source preprocessing".into()),
            };
            self.resolve_package(
                snapshot,
                catalog,
                "fontenc",
                "package",
                true,
                evidence,
                Some("preprocessor"),
            )?;
        }
        for (package, filenames) in [
            (
                "cochineal",
                [
                    "Cochineal-Roman.otf",
                    "Cochineal-Bold.otf",
                    "Cochineal-Italic.otf",
                    "Cochineal-BoldItalic.otf",
                ]
                .as_slice(),
            ),
            (
                "cabin",
                [
                    "Cabin-Regular.otf",
                    "Cabin-Bold.otf",
                    "Cabin-Italic.otf",
                    "Cabin-BoldItalic.otf",
                ]
                .as_slice(),
            ),
        ] {
            if source.contains(&format!("{{{package}}}")) {
                let evidence = ResourceEvidence {
                    kind: "detected".into(),
                    file: Some(snapshot.main_file.clone()),
                    line: None,
                    parent: Some("ScienceBatch source preprocessing".into()),
                };
                self.resolve_package(
                    snapshot,
                    catalog,
                    "fontspec",
                    "package",
                    true,
                    evidence.clone(),
                    Some("preprocessor"),
                )?;
                for filename in filenames {
                    if catalog.resources.contains_key(*filename) {
                        self.add_bundle_path(
                            snapshot,
                            catalog,
                            filename,
                            true,
                            evidence.clone(),
                            Some(package),
                        )?;
                    } else {
                        self.add_unknown(
                            filename,
                            filename,
                            "preprocessor_font_not_in_catalog",
                            evidence.clone(),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn scan_typst(
        &mut self,
        snapshot: &ProjectSnapshot,
        path: &str,
    ) -> Result<(), AutomationError> {
        if !self.traversed_sources.insert(format!("typst:{path}")) {
            return Ok(());
        }
        let Some(file) = snapshot.files.get(path) else {
            return Ok(());
        };
        let text = String::from_utf8_lossy(&file.bytes);
        for reference in scan_typst_imports(&text) {
            let evidence = ResourceEvidence {
                kind: "detected".into(),
                file: Some(path.into()),
                line: Some(reference.line),
                parent: None,
            };
            if reference.command == "dynamic" || !is_literal_id(&reference.expression) {
                self.add_unknown(
                    &reference.expression,
                    &reference.expression,
                    "typst_dynamic_reference",
                    evidence,
                );
            } else if reference.command == "image" {
                let Some(local_path) = relative_project_reference(path, &reference.expression)
                else {
                    self.add_unknown(
                        &reference.expression,
                        &reference.expression,
                        "typst_external_or_missing_asset",
                        evidence,
                    );
                    continue;
                };
                self.resolve_local_asset(snapshot, catalog()?, &local_path, evidence, Some(path))?;
            } else if let Some(local) = relative_project_reference(path, &reference.expression)
                .filter(|name| snapshot.files.contains_key(name))
            {
                let id = format!("local:{local}");
                let local_file = &snapshot.files[&local];
                self.requirement_map
                    .entry(id.clone())
                    .or_insert(ResourceRequirement {
                        id,
                        kind: "resource".into(),
                        label: local.clone(),
                        path: Some(local.clone()),
                        provider: "project_local".into(),
                        resolution: "resolved".into(),
                        availability: "local".into(),
                        mandatory: true,
                        evidence: vec![evidence],
                        parents: vec![path.into()],
                        indexed_bytes: Some(local_file.bytes.len() as u64),
                        sha256: Some(digest_bytes(&local_file.bytes)),
                    });
                self.scan_typst(snapshot, &local)?;
            } else {
                self.add_unknown(
                    &reference.expression,
                    &reference.expression,
                    "typst_external_or_missing_import",
                    evidence,
                );
            }
        }
        Ok(())
    }

    fn cached_state(&self, path: &str, resource: &IndexedResource) -> String {
        if crate::compiler::starter::contains(path) {
            return "embedded".into();
        }
        let Some(root) = self.cache_root.as_ref() else {
            return "missing".into();
        };
        let bundle_root = root.join("data").join(
            catalog()
                .map(|catalog| catalog.metadata.bundle.digest.as_str())
                .unwrap_or(""),
        );
        match verify_cached_resource(&bundle_root, path, resource) {
            CacheState::Verified => "cached_verified".into(),
            CacheState::Invalid => "invalid".into(),
            CacheState::Missing => "missing".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CacheState {
    Missing,
    Verified,
    Invalid,
}

pub(super) fn verify_cached_resource(
    root: &Path,
    relative: &str,
    resource: &IndexedResource,
) -> CacheState {
    if !safe_bundle_path(relative) {
        return CacheState::Invalid;
    }
    match validate_cache_ancestors(root) {
        CacheState::Missing => return CacheState::Missing,
        CacheState::Invalid => return CacheState::Invalid,
        CacheState::Verified => {}
    }
    let canonical_root = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(_) => return CacheState::Invalid,
    };
    let mut current = root.to_path_buf();
    let parts = relative.split('/').collect::<Vec<_>>();
    for (index, component) in parts.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return CacheState::Missing
            }
            Err(_) => return CacheState::Invalid,
        };
        if metadata.file_type().is_symlink() {
            return CacheState::Invalid;
        }
        if index + 1 == parts.len() {
            if !metadata.is_file() || metadata.len() != resource.length {
                return CacheState::Invalid;
            }
        } else if !metadata.is_dir() {
            return CacheState::Invalid;
        }
    }
    let canonical_file = match fs::canonicalize(&current) {
        Ok(path) => path,
        Err(_) => return CacheState::Invalid,
    };
    if !canonical_file.starts_with(&canonical_root) {
        return CacheState::Invalid;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = match options.open(&current) {
        Ok(file) => file,
        Err(_) => return CacheState::Invalid,
    };
    let before = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return CacheState::Invalid,
    };
    if !before.is_file() || before.len() != resource.length {
        return CacheState::Invalid;
    }
    let mut hash = Sha256::new();
    let mut bounded = file.by_ref().take(resource.length.saturating_add(1));
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = match bounded.read(&mut buffer) {
            Ok(count) => count,
            Err(_) => return CacheState::Invalid,
        };
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > resource.length {
            return CacheState::Invalid;
        }
        hash.update(&buffer[..count]);
    }
    if total != resource.length {
        return CacheState::Invalid;
    }
    drop(bounded);
    let after = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return CacheState::Invalid,
    };
    if file_signature(&before) != file_signature(&after) {
        return CacheState::Invalid;
    }
    let actual = format!("{:x}", hash.finalize());
    if actual == resource.sha256 {
        CacheState::Verified
    } else {
        CacheState::Invalid
    }
}

fn validate_cache_ancestors(path: &Path) -> CacheState {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return CacheState::Missing
            }
            Err(_) => return CacheState::Invalid,
        };
        if metadata.file_type().is_symlink() {
            return CacheState::Invalid;
        }
        if current != absolute && !metadata.is_dir() {
            return CacheState::Invalid;
        }
    }
    let metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(_) => return CacheState::Invalid,
    };
    if metadata.is_dir() {
        CacheState::Verified
    } else {
        CacheState::Invalid
    }
}

fn file_signature(metadata: &fs::Metadata) -> (u64, u128, u64, u64) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.len(), modified, metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        (metadata.len(), modified, 0, 0)
    }
}

fn catalog() -> Result<&'static Catalog, AutomationError> {
    let result = CATALOG.get_or_init(load_catalog);
    result.as_ref().map_err(Clone::clone)
}

pub(super) fn pinned_bundle_info() -> Result<PinnedBundleInfo, AutomationError> {
    let catalog = catalog()?;
    Ok(PinnedBundleInfo {
        url: catalog.bundle_url.clone(),
    })
}

pub(super) fn pinned_index_bytes() -> Result<&'static [u8], AutomationError> {
    Ok(catalog()?.index_bytes.as_slice())
}

pub(super) fn pinned_catalog() -> Result<PinnedCatalog, AutomationError> {
    let catalog = catalog()?;
    Ok(PinnedCatalog {
        url: catalog.bundle_url.clone(),
        digest: catalog.metadata.bundle.digest.clone(),
        index_sha256: catalog.metadata.bundle.index.sha256.clone(),
        index_bytes: catalog.index_bytes.clone(),
        catalog_sha256: catalog.catalog_sha256.clone(),
    })
}

pub(super) fn catalog_resource(path: &str) -> Result<Option<CatalogResource>, AutomationError> {
    let Some(resource) = catalog()?.resources.get(path) else {
        return Ok(None);
    };
    Ok(Some(CatalogResource {
        path: path.to_owned(),
        offset: resource.offset,
        length: resource.length,
        sha256: resource.sha256.clone(),
    }))
}

pub(crate) fn is_starter_resource(path: &str) -> Result<bool, AutomationError> {
    let _ = catalog()?;
    Ok(crate::compiler::starter::contains(path))
}

pub(crate) fn starter_resource_bytes(path: &str) -> Result<Option<Vec<u8>>, AutomationError> {
    let Some(resource) = catalog()?.resources.get(path) else {
        return Ok(None);
    };
    if !crate::compiler::starter::contains(path) {
        return Ok(None);
    }
    let bytes = crate::compiler::starter::read(path).map_err(|message| {
        as_error(
            "resources.catalog_invalid",
            format!("Embedded starter resource validation failed: {message}"),
            4,
        )
    })?;
    match bytes {
        Some(bytes)
            if bytes.len() as u64 == resource.length && digest_bytes(&bytes) == resource.sha256 =>
        {
            Ok(Some(bytes))
        }
        Some(_) => Err(as_error(
            "resources.catalog_invalid",
            "Embedded starter resource does not match the pinned catalog hash.",
            4,
        )),
        None => Ok(None),
    }
}

pub(crate) fn pinned_resource_paths() -> Result<Vec<String>, AutomationError> {
    Ok(catalog()?.resources.keys().cloned().collect())
}

/// Return bytes only when a cache entry is verified and unchanged on the opened handle.
pub(super) fn verified_cached_bytes(path: &str) -> Result<Option<Vec<u8>>, AutomationError> {
    let Some(resource) = catalog()?.resources.get(path) else {
        return Ok(None);
    };
    if resource.length > 32 * 1024 * 1024 {
        return Err(limit_exceeded(
            "Indexed resource exceeds the 32 MiB read limit.",
        ));
    }
    let root = super::resources::cache_directory()?
        .join("data")
        .join(&catalog()?.metadata.bundle.digest);
    verified_cache_bytes_at(&root, path, resource)
}

fn verified_cache_bytes_at(
    root: &Path,
    relative: &str,
    resource: &IndexedResource,
) -> Result<Option<Vec<u8>>, AutomationError> {
    if resource.length > 32 * 1024 * 1024 {
        return Err(limit_exceeded(
            "Indexed resource exceeds the 32 MiB read limit.",
        ));
    }
    match validate_cache_ancestors(root) {
        CacheState::Missing => return Ok(None),
        CacheState::Invalid => {
            return Err(as_error(
                "path.symlink_rejected",
                "Resource cache path contains a symlink or invalid ancestor.",
                2,
            ))
        }
        CacheState::Verified => {}
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let mut current = root.to_path_buf();
    let components = relative.split('/').collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ))
            }
        };
        if metadata.file_type().is_symlink() || (index + 1 < components.len() && !metadata.is_dir())
        {
            return Err(as_error(
                "path.symlink_rejected",
                "Cached resource path contains a symlink or non-directory ancestor.",
                2,
            )
            .with_details(json!({"path":relative})));
        }
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if !metadata.is_file() || metadata.len() != resource.length {
        return Err(as_error(
            "resources.cache_invalid",
            "Cached resource has an invalid file type or length.",
            3,
        )
        .with_details(json!({"path":relative,"expectedLength":resource.length})));
    }
    let canonical_file = fs::canonicalize(&current)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(as_error(
            "path.symlink_rejected",
            "Cached resource resolves outside its bundle cache.",
            2,
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&current).map_err(|error| {
        AutomationError::new("resources.cache_invalid", error.to_string(), 3)
            .with_details(json!({"path":relative}))
    })?;
    let before = file
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if !before.is_file() || before.len() != resource.length {
        return Err(as_error(
            "resources.cache_invalid",
            "Cached resource changed before verification.",
            3,
        )
        .with_details(json!({"path":relative})));
    }
    let mut bytes = Vec::with_capacity(resource.length as usize);
    file.by_ref()
        .take(resource.length.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let after = file
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if bytes.len() as u64 != resource.length
        || file_signature(&before) != file_signature(&after)
        || format!("{:x}", Sha256::digest(&bytes)) != resource.sha256
    {
        return Err(as_error("resources.cache_invalid", "Cached resource failed pinned hash or concurrent-change verification.", 3).with_details(json!({"path":relative,"expectedLength":resource.length,"expectedSha256":resource.sha256})));
    }
    Ok(Some(bytes))
}

pub(crate) fn validate_pinned_cache_identity_if_present() -> Result<(), AutomationError> {
    let catalog = catalog()?;
    let cache = super::resources::cache_directory()?;
    match pinned_cache_metadata_state_at(catalog, &cache)?.0.as_str() {
        "missing" | "embedded" | "cached_verified" => Ok(()),
        "invalid" => Err(as_error(
            "resources.bundle_identity_mismatch",
            "Existing compiler cache metadata does not match the pinned bundle identity.",
            3,
        )),
        _ => Err(as_error(
            "resources.catalog_invalid",
            "Compiler cache metadata has an unsupported state.",
            4,
        )),
    }
}

fn pinned_cache_metadata_state_at(
    catalog: &Catalog,
    cache: &Path,
) -> Result<(String, u64), AutomationError> {
    match validate_cache_ancestors(&cache) {
        CacheState::Invalid => return Ok(("invalid".into(), 0)),
        CacheState::Missing | CacheState::Verified => {}
    }
    let hash_path = cache
        .join("hashes")
        .join(tectonic_io_base::app_dirs::sanitize(&catalog.bundle_url));
    let index_path = cache
        .join("data")
        .join(format!("{}.index", catalog.metadata.bundle.digest));
    let mut missing_bytes = 0u64;
    let mut invalid = false;
    for (path, limit, expected_length) in [
        (
            &hash_path,
            256usize,
            catalog.metadata.bundle.digest.len() as u64,
        ),
        (
            &index_path,
            MAX_CATALOG_TABLE_BYTES,
            catalog.index_bytes.len() as u64,
        ),
    ] {
        match read_identity_file(path, limit) {
            Ok(bytes) => {
                let matches = if path == &hash_path {
                    String::from_utf8_lossy(&bytes).trim() == catalog.metadata.bundle.digest
                } else {
                    bytes == catalog.index_bytes
                        && format!("{:x}", Sha256::digest(&bytes))
                            == catalog.metadata.bundle.index.sha256
                };
                invalid |= !matches;
            }
            Err(error) if safe_path_is_missing(path) => {
                let _ = error;
                missing_bytes = missing_bytes.saturating_add(expected_length);
            }
            Err(_) => invalid = true,
        }
    }
    if invalid {
        Ok(("invalid".into(), 0))
    } else if missing_bytes > 0 {
        Ok(("missing".into(), missing_bytes))
    } else {
        Ok(("cached_verified".into(), 0))
    }
}

fn safe_path_is_missing(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return false,
            Ok(metadata) if current != path && !metadata.is_dir() => return false,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        }
    }
    false
}

fn read_identity_file(path: &Path, limit: usize) -> Result<Vec<u8>, AutomationError> {
    let parent = path.parent().ok_or_else(|| {
        as_error(
            "path.symlink_rejected",
            "Cache metadata path has no parent.",
            2,
        )
    })?;
    match validate_cache_ancestors(parent) {
        CacheState::Verified => {}
        CacheState::Missing => {
            return Err(as_error(
                "cache.unavailable_offline",
                "Pinned cache metadata is missing.",
                3,
            ))
        }
        CacheState::Invalid => {
            return Err(as_error(
                "path.symlink_rejected",
                "Pinned cache metadata path contains a symlink.",
                2,
            ))
        }
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() as usize > limit {
        return Err(as_error(
            "path.symlink_rejected",
            "Pinned cache metadata must be a bounded regular file.",
            2,
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let before = file
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let after = file
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if bytes.len() as u64 != before.len()
        || bytes.len() > limit
        || file_signature(&before) != file_signature(&after)
    {
        return Err(as_error(
            "resources.cache_invalid",
            "Pinned cache metadata changed while being read.",
            3,
        ));
    }
    Ok(bytes)
}

pub(super) fn pinned_descriptors(
    paths: &[String],
) -> Result<Vec<PinnedResourceDescriptor>, AutomationError> {
    if paths.len() > MAX_PLAN_ROWS {
        return Err(limit_exceeded("Resource preparation exceeds 20,000 paths."));
    }
    let catalog = catalog()?;
    let mut seen = BTreeSet::new();
    let mut descriptors = Vec::with_capacity(paths.len());
    for path in paths {
        if path.len() > MAX_RESOURCE_TEXT_BYTES
            || !safe_bundle_path(path)
            || !seen.insert(path.as_str())
        {
            return Err(as_error(
                "resources.selector_invalid",
                "Resource preparation paths must be unique normalized bundle paths.",
                2,
            ));
        }
        let resource = catalog.resources.get(path).ok_or_else(|| {
            as_error(
                "resources.selector_unknown",
                format!("Resource '{path}' is not in the pinned bundle."),
                2,
            )
        })?;
        descriptors.push(PinnedResourceDescriptor {
            path: path.clone(),
            offset: resource.offset,
            length: resource.length,
            sha256: resource.sha256.clone(),
        });
    }
    Ok(descriptors)
}

pub(super) fn estimate_pinned_transfer_bytes(paths: &[String]) -> Result<u64, AutomationError> {
    if paths.is_empty() {
        return Ok(0);
    }
    let bundle_info = pinned_bundle_info()?;
    let mut bundle = tectonic_bundles::itar::ItarBundle::new(bundle_info.url)
        .map_err(|error| AutomationError::new("resources.catalog_invalid", error.to_string(), 4))?;
    bundle
        .initialize_index(&mut Cursor::new(pinned_index_bytes()?))
        .map_err(|error| AutomationError::new("resources.catalog_invalid", error.to_string(), 4))?;
    let mut infos = Vec::with_capacity(paths.len());
    for path in paths {
        let info = bundle.search(path).ok_or_else(|| {
            as_error(
                "resources.catalog_invalid",
                format!("Pinned index is missing selected resource '{path}'."),
                4,
            )
        })?;
        infos.push(info);
    }
    tectonic_bundles::itar::estimate_prepare_bytes(&infos)
        .map_err(|error| as_error("resource.limit_exceeded", error.to_string(), 2))
}

fn load_catalog() -> Result<Catalog, AutomationError> {
    let metadata: CatalogMetadata = serde_json::from_slice(METADATA_GZ).map_err(|error| {
        AutomationError::new(
            "resources.catalog_invalid",
            format!("Resource metadata is invalid: {error}"),
            4,
        )
    })?;
    if metadata.schema != 1
        || metadata.bundle.index.entries == 0
        || metadata.bundle.index.file != "index.txt.gz"
        || metadata.resources.file != "resources.tsv.gz"
        || metadata.source_metadata.files.file != "source-files.tsv.gz"
        || metadata.source_metadata.references.file != "source-references.tsv.gz"
        || metadata
            .resources
            .decompressed_bytes
            .is_none_or(|bytes| bytes > MAX_CATALOG_TABLE_BYTES)
    {
        return Err(as_error(
            "resources.catalog_invalid",
            "Resource catalog metadata version or limits are invalid.",
            4,
        ));
    }
    let index = gunzip(INDEX_GZ, metadata.bundle.index.bytes)?;
    let table = gunzip(RESOURCES_GZ, MAX_CATALOG_TABLE_BYTES)?;
    let source_files = gunzip(SOURCE_FILES_GZ, MAX_CATALOG_TABLE_BYTES)?;
    let source_refs = gunzip(SOURCE_REFERENCES_GZ, MAX_CATALOG_TABLE_BYTES)?;
    check_artifact(
        INDEX_GZ,
        &metadata.bundle.index.compressed_sha256,
        metadata.bundle.index.compressed_bytes,
    )?;
    if digest_bytes(&index) != metadata.bundle.index.sha256
        || index.len() != metadata.bundle.index.bytes
    {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded bundle index integrity check failed.",
            4,
        ));
    }
    check_artifact(
        RESOURCES_GZ,
        &metadata.resources.sha256,
        metadata.resources.compressed_bytes,
    )?;
    if Some(table.len()) != metadata.resources.decompressed_bytes {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded resource table length does not match its metadata.",
            4,
        ));
    }
    check_artifact(
        SOURCE_FILES_GZ,
        &metadata.source_metadata.files.sha256,
        metadata.source_metadata.files.compressed_bytes,
    )?;
    check_artifact(
        SOURCE_REFERENCES_GZ,
        &metadata.source_metadata.references.sha256,
        metadata.source_metadata.references.compressed_bytes,
    )?;
    let packs_file: PacksFile = serde_json::from_slice(PACKS_JSON).map_err(|error| {
        AutomationError::new(
            "resources.catalog_invalid",
            format!("Resource pack metadata is invalid: {error}"),
            4,
        )
    })?;
    if packs_file.schema_version != 1
        || packs_file.engine != "latex"
        || packs_file.bundle_digest != metadata.bundle.digest
        || packs_file.index_sha256 != metadata.bundle.index.sha256
        || packs_file.provenance.get("kind").and_then(Value::as_str)
            != Some("locally captured offline resource-open fixture traces")
    {
        return Err(as_error(
            "resources.catalog_invalid",
            "Resource packs do not match the pinned bundle identity.",
            4,
        ));
    }
    let mut resources = BTreeMap::new();
    for line in std::str::from_utf8(&table)
        .map_err(|error| AutomationError::new("resources.catalog_invalid", error.to_string(), 4))?
        .lines()
    {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 4 || !safe_bundle_path(fields[0]) || fields[3].len() != 64 {
            return Err(as_error(
                "resources.catalog_invalid",
                "Embedded resource table contains a malformed row.",
                4,
            ));
        }
        let offset = fields[1].parse().map_err(|_| {
            as_error(
                "resources.catalog_invalid",
                "Embedded resource offset is malformed.",
                4,
            )
        })?;
        let length = fields[2].parse().map_err(|_| {
            as_error(
                "resources.catalog_invalid",
                "Embedded resource length is malformed.",
                4,
            )
        })?;
        if resources
            .insert(
                fields[0].to_owned(),
                IndexedResource {
                    offset,
                    length,
                    sha256: fields[3].to_owned(),
                },
            )
            .is_some()
        {
            return Err(as_error(
                "resources.catalog_invalid",
                "Embedded resource table has duplicate paths.",
                4,
            ));
        }
    }
    if resources.len() != metadata.resources.entries
        || resources.len() != metadata.bundle.index.entries
    {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded resource table entry count is inconsistent.",
            4,
        ));
    }
    let index_text = std::str::from_utf8(&index)
        .map_err(|error| AutomationError::new("resources.catalog_invalid", error.to_string(), 4))?;
    let mut indexed_offsets = BTreeMap::new();
    for line in index_text.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 || !safe_bundle_path(fields[0]) {
            return Err(as_error(
                "resources.catalog_invalid",
                "Embedded bundle index contains a malformed row.",
                4,
            ));
        }
        let offset: u64 = fields[1].parse().map_err(|_| {
            as_error(
                "resources.catalog_invalid",
                "Embedded bundle index offset is malformed.",
                4,
            )
        })?;
        let length: u64 = fields[2].parse().map_err(|_| {
            as_error(
                "resources.catalog_invalid",
                "Embedded bundle index length is malformed.",
                4,
            )
        })?;
        if indexed_offsets
            .insert(fields[0].to_owned(), (offset, length))
            .is_some()
        {
            return Err(as_error(
                "resources.catalog_invalid",
                "Embedded bundle index has duplicate resource paths.",
                4,
            ));
        }
    }
    if indexed_offsets.len() != resources.len()
        || resources.iter().any(|(path, resource)| {
            indexed_offsets.get(path) != Some(&(resource.offset, resource.length))
        })
    {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded resource table does not match the original bundle index.",
            4,
        ));
    }
    let catalog_resource_hashes = resources
        .iter()
        .map(|(path, resource)| (path.clone(), (resource.length, resource.sha256.clone())))
        .collect::<BTreeMap<_, _>>();
    crate::compiler::starter::validate_catalog(
        &metadata.bundle.digest,
        &metadata.bundle.index.sha256,
        &catalog_resource_hashes,
    )
    .map_err(|message| {
        as_error(
            "resources.catalog_invalid",
            format!("Embedded starter resource validation failed: {message}"),
            4,
        )
    })?;
    let mut package_paths: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in std::str::from_utf8(&source_files)
        .map_err(|error| AutomationError::new("resources.catalog_invalid", error.to_string(), 4))?
        .lines()
    {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 4 || !resources.contains_key(fields[0]) {
            return Err(as_error(
                "resources.catalog_invalid",
                "Embedded source inventory contains an invalid resource path.",
                4,
            ));
        }
        let extension = Path::new(fields[0])
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let stem = Path::new(fields[0])
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned();
        if ["sty", "cls", "tex", "def", "cfg", "ldf", "fd", "map", "bst"]
            .contains(&extension.as_str())
        {
            package_paths
                .entry(stem)
                .or_default()
                .push(fields[0].to_owned());
        }
    }
    let mut references: BTreeMap<String, Vec<SourceReference>> = BTreeMap::new();
    let mut pending_reference: Option<SourceReference> = None;
    for line in std::str::from_utf8(&source_refs)
        .map_err(|error| AutomationError::new("resources.catalog_invalid", error.to_string(), 4))?
        .lines()
    {
        let fields = line.split('\t').collect::<Vec<_>>();
        let header = fields.len() >= 4
            && resources.contains_key(fields[0])
            && fields[1].parse::<usize>().is_ok()
            && !fields[2].is_empty();
        if header {
            if let Some(pending) = pending_reference.take() {
                references
                    .entry(pending.file.clone())
                    .or_default()
                    .push(pending);
            }
            let line_no = fields[1].parse::<usize>().unwrap_or(0);
            let has_classification = fields.len() >= 5
                && matches!(fields.last(), Some(&"literal") | Some(&"unresolved"));
            let expression_end = if has_classification {
                fields.len() - 1
            } else {
                fields.len()
            };
            let expression = fields[3..expression_end].join("\t");
            if expression.len() > MAX_RESOURCE_TEXT_BYTES {
                return Err(as_error(
                    "resources.catalog_invalid",
                    "Embedded source reference exceeds the expression limit.",
                    4,
                ));
            }
            let reference = SourceReference {
                file: fields[0].into(),
                line: line_no,
                command: fields[2].into(),
                expression,
                classification: if has_classification {
                    fields[expression_end].into()
                } else {
                    "unresolved".into()
                },
            };
            if has_classification {
                references
                    .entry(reference.file.clone())
                    .or_default()
                    .push(reference);
            } else {
                pending_reference = Some(reference);
            }
        } else if let Some(pending) = pending_reference.as_mut() {
            if pending.expression.len().saturating_add(line.len() + 1) > MAX_RESOURCE_TEXT_BYTES {
                return Err(as_error(
                    "resources.catalog_invalid",
                    "Embedded source reference exceeds the expression limit.",
                    4,
                ));
            }
            pending.expression.push('\n');
            pending.expression.push_str(line);
            pending.classification = "unresolved".into();
        } else {
            return Err(as_error(
                "resources.catalog_invalid",
                "Embedded source reference contains an invalid row.",
                4,
            ));
        }
    }
    if let Some(pending) = pending_reference {
        references
            .entry(pending.file.clone())
            .or_default()
            .push(pending);
    }
    for paths in package_paths.values_mut() {
        paths.sort();
    }
    for pack in &packs_file.packs {
        if pack.id.is_empty()
            || pack.label.is_empty()
            || pack.fixture.as_deref().is_none_or(str::is_empty)
            || pack.engine != packs_file.engine
            || pack
                .resources
                .iter()
                .any(|path| !resources.contains_key(path))
        {
            return Err(as_error(
                "resources.catalog_invalid",
                "A resource pack references an incompatible or unknown resource.",
                4,
            ));
        }
    }
    for pack_id in packs_file.package_packs.values() {
        if !packs_file.packs.iter().any(|pack| &pack.id == pack_id) {
            return Err(as_error(
                "resources.catalog_invalid",
                "A package selector maps to an unknown resource pack.",
                4,
            ));
        }
    }
    let format_resource_paths = packs_file
        .format_resources
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if format_resource_paths.len() > 1_000
        || format_resource_paths.len() != packs_file.format_resources.len()
        || format_resource_paths
            .iter()
            .any(|path| !safe_bundle_path(path) || !resources.contains_key(path))
    {
        return Err(as_error(
            "resources.catalog_invalid",
            "Format resource metadata references an unknown bundle path.",
            4,
        ));
    }
    let mut catalog_material = Sha256::new();
    hash_field(&mut catalog_material, metadata.resources.sha256.as_bytes());
    hash_field(
        &mut catalog_material,
        metadata.source_metadata.files.sha256.as_bytes(),
    );
    hash_field(
        &mut catalog_material,
        metadata.source_metadata.references.sha256.as_bytes(),
    );
    hash_field(&mut catalog_material, PACKS_JSON);
    let catalog_sha256 = format!("{:x}", catalog_material.finalize());
    let embedded_paths = [
        "embedded://simpleicons/simpleicons.sty",
        "embedded://simpleicons/simpleiconsglyphs-xeluatex.tex",
        "embedded://simpleicons/SimpleIcons.otf",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let bundle_url = tectonic_bundles::get_fallback_bundle_url(tectonic::FORMAT_SERIAL);
    Ok(Catalog {
        metadata,
        catalog_sha256,
        packs_file,
        resources,
        package_paths,
        references,
        embedded_paths,
        format_resource_paths,
        index_bytes: index,
        bundle_url,
    })
}

fn gunzip(compressed: &[u8], max_bytes: usize) -> Result<Vec<u8>, AutomationError> {
    let decoder = GzDecoder::new(compressed);
    let mut output = Vec::new();
    decoder
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|error| {
            AutomationError::new(
                "resources.catalog_invalid",
                format!("Cannot decompress embedded resource catalog: {error}"),
                4,
            )
        })?;
    if output.len() > max_bytes {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded resource catalog exceeds its decompression limit.",
            4,
        ));
    }
    Ok(output)
}

fn check_artifact(
    bytes: &[u8],
    expected_hash: &str,
    expected_bytes: usize,
) -> Result<(), AutomationError> {
    if bytes.len() != expected_bytes || digest_bytes(bytes) != expected_hash {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded resource catalog artifact integrity check failed.",
            4,
        ));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &ProjectSnapshot) -> Result<(), AutomationError> {
    if snapshot.total_bytes > MAX_SNAPSHOT_BYTES
        || !["latex", "typst"].contains(&snapshot.engine.as_str())
    {
        return Err(as_error(
            "resources.snapshot_invalid",
            "The project snapshot exceeds limits or has an unsupported engine.",
            2,
        ));
    }
    let main = super::normalize_project_path(&snapshot.main_file)?;
    if main != snapshot.main_file || !snapshot.files.contains_key(&main) {
        return Err(as_error(
            "project.main_missing",
            "The selected main source is not in the project snapshot.",
            2,
        ));
    }
    if !snapshot.root.as_os_str().is_empty() {
        let metadata = fs::symlink_metadata(&snapshot.root).map_err(|error| {
            AutomationError::new("io.project_unavailable", error.to_string(), 3)
        })?;
        let canonical_root = fs::canonicalize(&snapshot.root).map_err(|error| {
            AutomationError::new("io.project_unavailable", error.to_string(), 3)
        })?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || canonical_root != snapshot.root
        {
            return Err(as_error(
                "path.symlink_rejected",
                "Project root and its ancestors must resolve to a real directory without symbolic links.",
                2,
            ));
        }
    }
    for path in snapshot.files.keys() {
        if path == LOCK_PATH {
            continue;
        }
        if path.len() > MAX_RESOURCE_TEXT_BYTES {
            return Err(limit_exceeded(
                "A project path exceeds the 4,096-byte path limit.",
            ));
        }
        if super::normalize_project_path(path)? != *path {
            return Err(as_error(
                "path.outside_project",
                "Snapshot contains a non-normalized path.",
                2,
            ));
        }
    }
    if snapshot.files.len() > MAX_PLAN_ROWS {
        return Err(limit_exceeded(
            "The project snapshot contains too many paths for resource analysis.",
        ));
    }
    Ok(())
}

fn limit_exceeded(message: &str) -> AutomationError {
    as_error("resource.limit_exceeded", message, 2)
}

fn requirements_exceed_bound(requirements: usize, unknown: usize) -> bool {
    requirements.saturating_add(unknown) > MAX_PLAN_ROWS
}

fn ensure_bounded_json(value: &Value) -> Result<(), AutomationError> {
    let size = serde_json::to_vec(value)
        .map_err(|error| AutomationError::new("worker.protocol_invalid", error.to_string(), 4))?
        .len();
    if size > MAX_OUTPUT_BYTES {
        return Err(limit_exceeded(
            "Resource response exceeds the 1 MiB output limit.",
        ));
    }
    Ok(())
}

fn input_digest(
    snapshot: &ProjectSnapshot,
    workspace: Option<&Value>,
    catalog: &Catalog,
) -> Result<String, AutomationError> {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, b"sciencebatch-resource-input-v1");
    hash_field(&mut hasher, snapshot.engine.as_bytes());
    hash_field(&mut hasher, snapshot.main_file.as_bytes());
    hash_field(&mut hasher, snapshot.root.to_string_lossy().as_bytes());
    hash_field(&mut hasher, PREPROCESSING_REVISION.as_bytes());
    hash_field(&mut hasher, catalog.metadata.bundle.digest.as_bytes());
    hash_field(&mut hasher, catalog.metadata.bundle.index.sha256.as_bytes());
    hash_field(&mut hasher, catalog.catalog_sha256.as_bytes());
    if let Some(workspace) = workspace {
        let mut canonical = workspace.clone();
        canonicalize_json(&mut canonical);
        hash_field(
            &mut hasher,
            &serde_json::to_vec(&canonical).map_err(|error| {
                AutomationError::new("worker.protocol_invalid", error.to_string(), 4)
            })?,
        );
    }
    for (path, file) in &snapshot.files {
        if path == LOCK_PATH {
            continue;
        }
        hash_field(&mut hasher, path.as_bytes());
        hash_field(
            &mut hasher,
            if file.kind == SnapshotFileKind::Text {
                b"text"
            } else {
                b"asset"
            },
        );
        hash_field(&mut hasher, &file.bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

fn canonicalize_json(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(canonicalize_json),
        Value::Object(values) => {
            let mut sorted = values
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>();
            for value in sorted.values_mut() {
                canonicalize_json(value);
            }
            *values = sorted.into_iter().collect();
        }
        _ => {}
    }
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn safe_bundle_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

pub(super) fn safe_bundle_path_for_cache(path: &str) -> bool {
    safe_bundle_path(path)
}

fn scan_references(source: &str) -> Result<Vec<Reference>, AutomationError> {
    let clean = strip_comments_and_verbatim(source);
    let mut refs = Vec::new();
    let commands = [
        "documentclass",
        "LoadClass",
        "usepackage",
        "RequirePackage",
        "input",
        "include",
        "subfile",
        "includeonly",
        "InputIfFileExists",
        "bibliography",
        "addbibresource",
        "bibliographystyle",
        "includegraphics",
        "includepdf",
        "lstinputlisting",
        "usetheme",
        "usecolortheme",
        "usefonttheme",
        "setmainfont",
        "setsansfont",
        "setmonofont",
    ];
    let pattern = format!(
        r"\\(?P<cmd>{})\*?(?:\s*\[[^\]]*\])?\s*\{{(?P<arg>[^{{}}]*)\}}",
        commands.join("|")
    );
    let regex = regex::Regex::new(&pattern).expect("static resource scanner pattern");
    let mut covered_inputs = Vec::<usize>::new();
    for captures in regex.captures_iter(&clean) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        let command = captures
            .name("cmd")
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_owned();
        let expression = captures
            .name("arg")
            .map(|m| m.as_str().trim().to_owned())
            .unwrap_or_default();
        if expression.len() > MAX_RESOURCE_TEXT_BYTES {
            return Err(limit_exceeded(
                "A resource reference exceeds the 4,096-byte expression limit.",
            ));
        }
        let line = clean[..full.start()]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1;
        if matches!(command.as_str(), "input" | "include") {
            covered_inputs.push(full.start());
        }
        refs.push(Reference {
            command,
            expression,
            line,
        });
        if refs.len() > MAX_PLAN_ROWS {
            return Err(limit_exceeded(
                "Source contains too many resource references.",
            ));
        }
    }
    // TeX also permits the common unbraced form `\\input chapter`. Keep the
    // scanner deliberately literal: macro-valued and nested arguments become
    // visible unknowns in the resolver rather than disappearing from the plan.
    let input_command = regex::Regex::new(r"\\(?P<cmd>input|include)\b(?P<tail>[^\n%]*)")
        .expect("static TeX input scanner pattern");
    for captures in input_command.captures_iter(&clean) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        if covered_inputs.contains(&full.start()) {
            continue;
        }
        let command = captures.name("cmd").unwrap().as_str().to_owned();
        let tail = captures
            .name("tail")
            .map(|value| value.as_str().trim())
            .unwrap_or("");
        let expression = if let Some(braced) = tail.strip_prefix('{') {
            braced.strip_suffix('}').unwrap_or(braced).trim().to_owned()
        } else {
            tail.split_whitespace().next().unwrap_or("").to_owned()
        };
        if expression.len() > MAX_RESOURCE_TEXT_BYTES {
            return Err(limit_exceeded(
                "A resource reference exceeds the 4,096-byte expression limit.",
            ));
        }
        let line = clean[..full.start()]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1;
        refs.push(Reference {
            command,
            expression,
            line,
        });
        if refs.len() > MAX_PLAN_ROWS {
            return Err(limit_exceeded(
                "Source contains too many resource references.",
            ));
        }
    }
    Ok(refs)
}

fn scan_typst_imports(source: &str) -> Vec<Reference> {
    let clean = strip_typst_comments(source);
    let regex = regex::Regex::new(
        r#"#(?P<cmd>import|include)\s+(?:"(?P<quoted>[^"]+)"|(?P<dynamic>[^\s;]+))|\bimage\(\s*(?:"(?P<image>[^"]+)"|(?P<image_dynamic>[^)\s,]+))"#,
    )
        .expect("static Typst scanner pattern");
    regex
        .captures_iter(&clean)
        .filter_map(|captures| {
            let full = captures.get(0)?;
            let expression = captures
                .name("quoted")
                .or_else(|| captures.name("dynamic"))
                .or_else(|| captures.name("image"))
                .or_else(|| captures.name("image_dynamic"))?
                .as_str()
                .to_owned();
            let quoted = captures.name("quoted").is_some() || captures.name("image").is_some();
            let command = if !quoted {
                "dynamic".to_owned()
            } else {
                captures
                    .name("cmd")
                    .map(|value| value.as_str())
                    .unwrap_or("image")
                    .to_owned()
            };
            Some(Reference {
                command,
                expression,
                line: clean[..full.start()]
                    .bytes()
                    .filter(|byte| *byte == b'\n')
                    .count()
                    + 1,
            })
        })
        .collect()
}

fn relative_project_reference(source_path: &str, reference: &str) -> Option<String> {
    let referenced = Path::new(reference);
    if referenced.is_absolute() {
        return None;
    }
    let parent = Path::new(source_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let joined = parent.join(referenced).to_string_lossy().replace('\\', "/");
    super::normalize_project_path(&joined).ok()
}

fn strip_typst_comments(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut in_block = false;
    for line in source.lines() {
        let bytes = line.as_bytes();
        let mut index = 0;
        let mut end = bytes.len();
        while index < bytes.len() {
            if in_block {
                if bytes[index..].starts_with(b"*/") {
                    result.push_str("  ");
                    index += 2;
                    in_block = false;
                } else {
                    result.push(if bytes[index] == b'\t' { '\t' } else { ' ' });
                    index += 1;
                }
            } else if bytes[index..].starts_with(b"/*") {
                result.push_str("  ");
                index += 2;
                in_block = true;
            } else if bytes[index..].starts_with(b"//") {
                end = index;
                break;
            } else {
                let ch = line[index..].chars().next().unwrap();
                result.push(ch);
                index += ch.len_utf8();
            }
        }
        if end < bytes.len() {
            result.push_str(&" ".repeat(bytes.len() - end));
        }
        result.push('\n');
    }
    result
}

fn strip_comments(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    for line in source.lines() {
        let bytes = line.as_bytes();
        let mut end = bytes.len();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'%' {
                let slash_count = bytes[..index]
                    .iter()
                    .rev()
                    .take_while(|value| **value == b'\\')
                    .count();
                if slash_count % 2 == 0 {
                    end = index;
                    break;
                }
            }
        }
        result.push_str(&line[..end]);
        result.push('\n');
    }
    result
}

fn strip_comments_and_verbatim(source: &str) -> String {
    let original = source.as_bytes();
    let mut bytes = original.to_vec();
    let mut index = 0;
    let environments: [&[u8]; 6] = [
        b"verbatim",
        b"Verbatim",
        b"lstlisting",
        b"minted",
        b"comment",
        b"alltt",
    ];
    while index < original.len() {
        if original[index..].starts_with(b"\\begin{") {
            let name_start = index + b"\\begin{".len();
            if let Some(relative_end) = original[name_start..].iter().position(|byte| *byte == b'}')
            {
                let name_end = name_start + relative_end;
                let name = &original[name_start..name_end];
                if environments.contains(&name) {
                    let body_start = name_end + 1;
                    let terminator = [b"\\end{".as_slice(), name, b"}"].concat();
                    if let Some(relative_terminator) = original[body_start..]
                        .windows(terminator.len())
                        .position(|window| window == terminator)
                    {
                        let end = body_start + relative_terminator + terminator.len();
                        mask_non_newlines(&mut bytes, index, end);
                        index = end;
                        continue;
                    }
                }
            }
        }
        if original[index..].starts_with(b"\\detokenize{") {
            let body_start = index + b"\\detokenize{".len();
            let mut depth = 1usize;
            let mut cursor = body_start;
            while cursor < original.len() && depth > 0 {
                match original[cursor] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                cursor += 1;
            }
            if depth == 0 {
                mask_non_newlines(&mut bytes, index, cursor);
                index = cursor;
                continue;
            }
        }
        if original[index..].starts_with(b"\\verb") {
            let mut delimiter_index = index + b"\\verb".len();
            if original.get(delimiter_index) == Some(&b'*') {
                delimiter_index += 1;
            }
            if let Some(&delimiter) = original.get(delimiter_index) {
                if delimiter != b'\n' {
                    if let Some(relative_end) = original[delimiter_index + 1..]
                        .iter()
                        .position(|byte| *byte == delimiter)
                    {
                        let end = delimiter_index + 2 + relative_end;
                        mask_non_newlines(&mut bytes, index, end);
                        index = end;
                        continue;
                    }
                }
            }
        }
        index += 1;
    }
    let masked = String::from_utf8(bytes).unwrap_or_else(|_| source.to_owned());
    strip_comments(&masked)
}

fn mask_non_newlines(bytes: &mut [u8], start: usize, end: usize) {
    for byte in &mut bytes[start..end] {
        if *byte != b'\n' && *byte != b'\r' {
            *byte = b' ';
        }
    }
}

fn first_conditional(source: &str) -> Option<(usize, String)> {
    let regex = regex::Regex::new(r"\\(?:if[a-zA-Z@]*|newif)\b")
        .expect("static conditional scanner pattern");
    let found = regex.find(source)?;
    let line = source[..found.start()]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1;
    Some((line, source[found.start()..found.end()].to_owned()))
}

fn is_package_command(command: &str) -> bool {
    matches!(
        command,
        "usepackage" | "RequirePackage" | "usetheme" | "usecolortheme" | "usefonttheme"
    )
}
fn theme_package_name(command: &str, name: &str) -> String {
    let prefix = match command {
        "usetheme" => "beamertheme",
        "usecolortheme" => "beamercolortheme",
        "usefonttheme" => "beamerfonttheme",
        _ => return name.to_owned(),
    };
    format!("{prefix}{name}")
}
fn is_font_command(command: &str) -> bool {
    matches!(command, "setmainfont" | "setsansfont" | "setmonofont")
}
fn is_preprocessed_font_package(source: &str, package: &str) -> bool {
    matches!(package.to_ascii_lowercase().as_str(), "cochineal" | "cabin")
        && source
            .to_ascii_lowercase()
            .contains(&format!("{{{}}}", package.to_ascii_lowercase()))
}
fn is_file_command(command: &str) -> bool {
    matches!(
        command,
        "input" | "include" | "subfile" | "includeonly" | "InputIfFileExists"
    )
}
fn is_user_asset_command(command: &str) -> bool {
    matches!(
        command,
        "bibliography" | "addbibresource" | "includegraphics" | "includepdf" | "lstinputlisting"
    )
}
fn is_scannable(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["tex", "sty", "cls", "cfg", "def", "ldf"].contains(&ext.to_ascii_lowercase().as_str())
        })
}
fn is_literal_id(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && !value.contains('#')
        && !value.contains('$')
        && !value.contains('{')
        && !value.contains('}')
        && !value.contains(':')
}
fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn add_evidence(row: &mut ResourceRequirement, evidence: ResourceEvidence) {
    let duplicate = row.evidence.iter().any(|existing| {
        existing.kind == evidence.kind
            && existing.file == evidence.file
            && existing.line == evidence.line
            && existing.parent == evidence.parent
    });
    if !duplicate && row.evidence.len() < 32 {
        row.evidence.push(evidence);
    }
}

fn summarize_requirements(rows: &[ResourceRequirement]) -> (usize, usize, usize, usize, u64, u64) {
    let mut resolved = 0;
    let mut cached = 0;
    let mut missing = 0;
    let mut invalid = 0;
    let mut total_bytes = 0u64;
    let mut cached_bytes = 0u64;
    for row in rows {
        if row.path.is_none()
            || row.availability == "local"
            || (row.availability == "embedded" && row.provider != "pinned_bundle")
        {
            continue;
        }
        if row.resolution == "resolved" {
            resolved += 1;
        }
        total_bytes = total_bytes.saturating_add(row.indexed_bytes.unwrap_or(0));
        match row.availability.as_str() {
            "cached_verified" => {
                cached += 1;
                cached_bytes = cached_bytes.saturating_add(row.indexed_bytes.unwrap_or(0));
            }
            "missing" => missing += 1,
            "invalid" => invalid += 1,
            _ => {}
        }
    }
    (
        resolved,
        cached,
        missing,
        invalid,
        total_bytes,
        cached_bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::capture_virtual_snapshot;
    use std::collections::BTreeMap;

    fn default_showcase_source() -> String {
        let source_file = include_str!("../../../src/editor/latexData.ts");
        let (_, source) = source_file
            .split_once("export const DEFAULT_LATEX_SOURCE = `")
            .expect("default LaTeX source export should exist");
        source
            .split_once("`;\n")
            .expect("default LaTeX source template should be terminated")
            .0
            .replace("\\\\", "\\")
    }

    fn snapshot(main: &str, extra: &[(&str, &str)]) -> ProjectSnapshot {
        let mut files = BTreeMap::new();
        files.insert("main.tex".into(), main.as_bytes().to_vec());
        for (path, content) in extra {
            files.insert((*path).into(), content.as_bytes().to_vec());
        }
        capture_virtual_snapshot("latex", "main.tex", &files).unwrap()
    }

    #[test]
    fn catalog_and_basic_pack_are_pinned_and_bounded() {
        let catalog = catalog().unwrap();
        assert_eq!(catalog.resources.len(), 134_980);
        let pack = catalog
            .packs_file
            .packs
            .iter()
            .find(|pack| pack.id == "latex-basic")
            .unwrap();
        assert_eq!(pack.resources.len(), 301);
        assert!(pack.resources.contains(&"latex.ltx".to_owned()));
        let plan = resolved_plan(
            &snapshot(
                "\\documentclass{article}\n\\begin{document}Hi\\end{document}",
                &[],
            ),
            &Value::Null,
        )
        .unwrap();
        assert_eq!(plan.selection[0].id, "latex-basic");
        assert!(plan.total_resources >= 301);
        assert!(
            plan.plan_digest.starts_with(&plan.input_digest[..8]) || plan.plan_digest.len() == 64
        );
    }

    #[test]
    fn default_showcase_is_fully_available_without_a_resource_cache() {
        let source = default_showcase_source();
        let mut files = BTreeMap::new();
        files.insert("main.tex".into(), source.into_bytes());
        files.insert(
            "references.bib".into(),
            crate::compiler::embedded::SAMPLE_BIB.to_vec(),
        );
        files.insert(
            "assets/sample.png".into(),
            crate::compiler::embedded::SAMPLE_PNG.to_vec(),
        );
        files.insert(
            "assets/sample.gif".into(),
            crate::compiler::embedded::SAMPLE_GIF.to_vec(),
        );
        let project = capture_virtual_snapshot("latex", "main.tex", &files).unwrap();
        let plan = resolved_plan_with_cache_root(&project, &Value::Null, None).unwrap();
        assert_eq!(plan.bundle_metadata_state, "embedded");
        assert_eq!(plan.missing_resources, 0);
        assert_eq!(plan.invalid_resources, 0);
        assert_eq!(plan.estimated_transfer_bytes, 0);
        assert_eq!(plan.metadata_storage_bytes, 0);
        assert_eq!(plan.project_state, "prepared_known_set");
        assert!(plan.requirements.iter().any(|row| {
            row.path.as_deref() == Some("latex.ltx") && row.availability == "embedded"
        }));
    }

    #[test]
    fn embedded_metadata_replaces_cold_cache_metadata_and_cache_state_does_not_change_plan_digest()
    {
        let catalog = catalog().unwrap();
        let project = snapshot("\\documentclass{article}", &[]);
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("bundles");
        let missing =
            resolved_plan_with_cache_root(&project, &Value::Null, Some(cache.clone())).unwrap();
        assert_eq!(missing.bundle_metadata_state, "embedded");
        assert_eq!(missing.metadata_storage_bytes, 0);
        assert_eq!(missing.project_state, "prepared_known_set");
        assert_eq!(missing.missing_resources, 0);
        assert_eq!(missing.estimated_transfer_bytes, 0);

        let hash_path = cache
            .join("hashes")
            .join(tectonic_io_base::app_dirs::sanitize(&catalog.bundle_url));
        let index_path = cache
            .join("data")
            .join(format!("{}.index", catalog.metadata.bundle.digest));
        fs::create_dir_all(hash_path.parent().unwrap()).unwrap();
        fs::create_dir_all(index_path.parent().unwrap()).unwrap();
        fs::write(&hash_path, &catalog.metadata.bundle.digest).unwrap();
        fs::write(&index_path, &catalog.index_bytes).unwrap();
        let verified =
            resolved_plan_with_cache_root(&project, &Value::Null, Some(cache.clone())).unwrap();
        assert_eq!(verified.bundle_metadata_state, "cached_verified");
        assert_eq!(verified.metadata_storage_bytes, 0);
        assert_eq!(verified.plan_digest, missing.plan_digest);

        fs::remove_file(&index_path).unwrap();
        let missing_index =
            resolved_plan_with_cache_root(&project, &Value::Null, Some(cache.clone())).unwrap();
        assert_eq!(missing_index.bundle_metadata_state, "embedded");
        assert_eq!(missing_index.metadata_storage_bytes, 0);
        assert_eq!(missing_index.plan_digest, verified.plan_digest);

        fs::write(&index_path, &catalog.index_bytes).unwrap();
        fs::write(&hash_path, "0".repeat(64)).unwrap();
        let invalid = resolved_plan_with_cache_root(&project, &Value::Null, Some(cache)).unwrap();
        assert_eq!(invalid.bundle_metadata_state, "invalid");
        assert_eq!(invalid.project_state, "blocked");
        assert_eq!(invalid.plan_digest, verified.plan_digest);
    }

    #[test]
    fn follows_reachable_local_inputs_transitives_and_cycles() {
        let project = snapshot(
            "\\documentclass{localclass}\n\\begin{document}\\input{chapter}\\end{document}",
            &[
                ("localclass.cls", "\\RequirePackage{localpkg}\n"),
                ("localpkg.sty", "\\RequirePackage{cyclea}\n"),
                ("cyclea.sty", "\\RequirePackage{cycleb}\n"),
                ("cycleb.sty", "\\RequirePackage{cyclea}\n"),
                ("chapter.tex", "Chapter text."),
                ("unrelated.tex", "\\usepackage{neverloaded}"),
            ],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        let paths = plan
            .requirements
            .iter()
            .filter_map(|row| row.path.as_deref())
            .collect::<BTreeSet<_>>();
        assert!(paths.contains("localclass.cls"));
        assert!(paths.contains("localpkg.sty"));
        assert!(paths.contains("cyclea.sty"));
        assert!(paths.contains("cycleb.sty"));
        assert!(paths.contains("chapter.tex"));
        assert!(!paths.contains("unrelated.tex"));
    }

    #[test]
    fn local_class_and_simpleicons_sources_override_provider_packs() {
        let project = snapshot(
            "\\documentclass{IEEEtran}\n\\usepackage{IEEEtran}\n\\usepackage{simpleicons}",
            &[
                ("IEEEtran.cls", "\\RequirePackage{localclassdep}\n"),
                ("IEEEtran.sty", "\\RequirePackage{localstyledep}\n"),
                ("localclassdep.sty", ""),
                ("localstyledep.sty", ""),
                ("simpleicons.sty", "\\RequirePackage{localicondep}\n"),
                ("localicondep.sty", ""),
            ],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        let paths = plan
            .requirements
            .iter()
            .filter_map(|row| row.path.as_deref())
            .collect::<BTreeSet<_>>();
        assert!(paths.contains("IEEEtran.cls"));
        assert!(paths.contains("IEEEtran.sty"));
        assert!(paths.contains("simpleicons.sty"));
        assert!(paths.contains("localclassdep.sty"));
        assert!(paths.contains("localstyledep.sty"));
        assert!(paths.contains("localicondep.sty"));
        assert!(!plan
            .requirements
            .iter()
            .any(|row| row.provider == "embedded"));
        let ieee_pack = catalog()
            .unwrap()
            .packs_file
            .packs
            .iter()
            .find(|pack| pack.id == "latex-ieeetran")
            .unwrap();
        for pack_only in [
            "lmroman12-regular.otf",
            "lmroman17-regular.otf",
            "lmroman5-regular.otf",
        ] {
            if ieee_pack.resources.iter().any(|path| path == pack_only) {
                assert!(!paths.contains(pack_only));
            }
        }
    }

    #[test]
    fn local_format_source_keeps_the_pinned_format_resource() {
        let project = snapshot(
            "\\documentclass{article}",
            &[("latex.ltx", "% project-local format source\n")],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        assert!(plan.requirements.iter().any(|row| {
            row.id == "resource:latex.ltx" && row.provider == "pinned_bundle" && row.mandatory
        }));
        assert!(plan.requirements.iter().any(|row| {
            row.id == "local:latex.ltx" && row.provider == "project_local" && row.mandatory
        }));
    }

    #[test]
    fn manifest_rejects_unknown_fields_schema_and_unsafe_selectors() {
        for manifest in [
            r#"{"schemaVersion":1,"requirements":[],"other":true}"#,
            r#"{"schemaVersion":2,"requirements":[]}"#,
            r#"{"schemaVersion":1,"requirements":[{"kind":"url","id":"https://example.invalid"}]}"#,
        ] {
            let project = snapshot("\\documentclass{article}", &[(MANIFEST_PATH, manifest)]);
            assert!(resolved_plan(&project, &Value::Null).is_err());
        }
    }

    #[test]
    fn identity_binds_overlays_manifest_and_selection_but_not_cache_state() {
        let base = snapshot("\\documentclass{article}", &[]);
        let changed = snapshot("\\documentclass{book}", &[]);
        let first = resolved_plan(&base, &Value::Null).unwrap();
        let second = resolved_plan(&changed, &Value::Null).unwrap();
        assert_ne!(first.input_digest, second.input_digest);
        assert_ne!(first.plan_digest, second.plan_digest);
        let mut overlay = BTreeMap::new();
        overlay.insert("main.tex".into(), b"\\documentclass{article}\n".to_vec());
        let overlaid = capture_virtual_snapshot("latex", "main.tex", &overlay).unwrap();
        assert_ne!(
            first.input_digest,
            resolved_plan(&overlaid, &Value::Null).unwrap().input_digest
        );
    }

    #[test]
    fn dynamic_and_conditional_requirements_stay_unknown_and_assets_are_not_substituted() {
        let project = snapshot(
            "\\documentclass{article}\n\\usepackage{\\selectedPackage}\n\\ifdraft\\input{draft}\\fi\n\\includegraphics{figure}\n\\bibliography{references}\n",
            &[],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        assert!(plan
            .unknown
            .iter()
            .any(|unknown| unknown.reason == "macro_valued_package_reference"));
        assert!(plan
            .unknown
            .iter()
            .any(|unknown| unknown.reason == "conditional_tex_dependency"));
        assert!(plan
            .unknown
            .iter()
            .any(|unknown| unknown.reason == "missing_project_asset_not_downloadable"));
        let mut cursor: Option<String> = None;
        let mut paged_unknown_ids = BTreeSet::new();
        loop {
            let mut args = json!({"expectedPlanDigest":plan.plan_digest,"limit":1});
            if let Some(value) = &cursor {
                args["cursor"] = json!(value);
            }
            let page = list_page(&plan, &args).unwrap();
            for row in page["items"].as_array().unwrap() {
                if row["itemType"] == "unknown" {
                    paged_unknown_ids.insert(row["item"]["id"].as_str().unwrap().to_owned());
                }
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(paged_unknown_ids.len(), plan.unknown.len());
    }

    #[test]
    fn selectors_are_validated_and_simpleicons_are_embedded() {
        let project = snapshot("\\documentclass{article}\n\\usepackage{simpleicons}", &[]);
        let value = json!({"selection":[{"kind":"package","id":"simpleicons"}]});
        let plan = resolved_plan(&project, &value).unwrap();
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.provider == "embedded"
                && row.path.as_deref().unwrap_or("").contains("simpleicons")));
        let bad = json!({"selection":[{"kind":"resource","id":"../outside"}]});
        assert!(resolved_plan(&project, &bad).is_err());
    }

    #[test]
    fn list_cursor_is_bound_to_expected_plan_and_limited() {
        let project = snapshot("\\documentclass{article}", &[]);
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        let first = list_page(
            &plan,
            &json!({"expectedPlanDigest":plan.plan_digest,"limit":1}),
        )
        .unwrap();
        let cursor = first["nextCursor"].as_str().unwrap();
        assert!(list_page(
            &plan,
            &json!({"expectedPlanDigest":plan.plan_digest,"limit":1,"cursor":cursor})
        )
        .is_ok());
        assert!(list_page(
            &plan,
            &json!({"expectedPlanDigest":"wrong","limit":1,"cursor":cursor})
        )
        .is_err());
        assert!(list_page(
            &plan,
            &json!({"expectedPlanDigest":plan.plan_digest,"limit":201})
        )
        .is_err());
    }

    #[test]
    fn source_scanner_skips_verbatim_regions_and_enforces_reference_bounds() {
        let source = r#"
\usepackage{real}
\begin{verbatim}
\usepackage{notloaded}
\end{verbatim}
\begin{lstlisting}
\input{notloadedeither}
\end{lstlisting}
\verb|\usepackage{alsoignored}|
\detokenize{\includegraphics{example}}
"#;
        let references = scan_references(source).unwrap();
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].expression, "real");
        let too_large = format!(
            "\\usepackage{{{}}}",
            "x".repeat(MAX_RESOURCE_TEXT_BYTES + 1)
        );
        assert_eq!(
            scan_references(&too_large).unwrap_err().code,
            "resource.limit_exceeded"
        );
    }

    #[test]
    fn selector_and_output_contracts_are_bounded() {
        let project = snapshot("\\documentclass{article}", &[]);
        let oversized_selection = json!({"selection": (0..=MAX_SELECTOR_COUNT).map(|_| json!({"kind":"package","id":"one"})).collect::<Vec<_>>()});
        assert_eq!(
            resolved_plan(&project, &oversized_selection)
                .unwrap_err()
                .code,
            "resource.limit_exceeded"
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        let response = list_page(
            &plan,
            &json!({"expectedPlanDigest":plan.plan_digest,"limit":MAX_LIST_PAGE}),
        )
        .unwrap();
        assert!(serde_json::to_vec(&response).unwrap().len() <= MAX_OUTPUT_BYTES);
        let stale = json!({"expectedInputDigest":"wrong"});
        assert_eq!(
            resolved_plan(&project, &stale).unwrap_err().code,
            "resources.input_changed"
        );
    }

    #[test]
    fn cache_verification_rejects_same_length_poison_and_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("data").join("bundle");
        fs::create_dir_all(&root).unwrap();
        let data = b"good";
        let resource = IndexedResource {
            offset: 0,
            length: data.len() as u64,
            sha256: digest_bytes(data),
        };
        fs::write(root.join("item.sty"), b"evil").unwrap();
        assert_eq!(
            verify_cached_resource(&root, "item.sty", &resource),
            CacheState::Invalid
        );
        fs::write(root.join("item.sty"), data).unwrap();
        assert_eq!(
            verify_cached_resource(&root, "item.sty", &resource),
            CacheState::Verified
        );
        #[cfg(unix)]
        {
            let outside = directory.path().join("outside");
            fs::write(&outside, data).unwrap();
            fs::remove_file(root.join("item.sty")).unwrap();
            std::os::unix::fs::symlink(outside, root.join("item.sty")).unwrap();
            assert_eq!(
                verify_cached_resource(&root, "item.sty", &resource),
                CacheState::Invalid
            );
        }
        assert_eq!(
            verify_cached_resource(&root, "missing.sty", &resource),
            CacheState::Missing
        );
        fs::remove_file(root.join("item.sty")).ok();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/item.sty"), b"evil").unwrap();
        assert_eq!(
            verified_cache_bytes_at(&root, "nested/item.sty", &resource)
                .unwrap_err()
                .code,
            "resources.cache_invalid"
        );
        fs::write(root.join("nested/item.sty"), data).unwrap();
        assert_eq!(
            verified_cache_bytes_at(&root, "nested/item.sty", &resource).unwrap(),
            Some(data.to_vec())
        );
        #[cfg(unix)]
        {
            let outside_dir = directory.path().join("outside-dir");
            fs::create_dir(&outside_dir).unwrap();
            fs::write(outside_dir.join("item.sty"), data).unwrap();
            fs::remove_dir_all(root.join("nested")).unwrap();
            std::os::unix::fs::symlink(&outside_dir, root.join("nested")).unwrap();
            assert_eq!(
                verified_cache_bytes_at(&root, "nested/item.sty", &resource)
                    .unwrap_err()
                    .code,
                "path.symlink_rejected"
            );
        }
    }

    #[test]
    fn font_references_resolve_exact_files_and_keep_dynamic_or_family_names_unknown() {
        let project = snapshot(
            "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Cochineal-Roman.otf}\n\\setsansfont{\\selectedFont}\n\\setmonofont{Family Name}\n\\setmainfont{local/custom.ttf}",
            &[("local/custom.ttf", "font bytes")],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("Cochineal-Roman.otf")));
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("local/custom.ttf")
                && row.provider == "project_local"));
        assert!(plan
            .unknown
            .iter()
            .any(|row| row.reason == "macro_valued_font_reference"));
        assert!(plan
            .unknown
            .iter()
            .any(|row| row.reason == "font_family_resolution_unknown"));

        let local_project = snapshot(
            "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{local/custom.ttf}",
            &[("local/custom.ttf", "font bytes")],
        );
        let local_plan = resolved_plan(&local_project, &Value::Null).unwrap();
        assert!(local_plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("local/custom.ttf")
                && row.provider == "project_local"));
    }

    #[test]
    fn tex_unbraced_inputs_are_followed_and_dynamic_nested_inputs_stay_visible() {
        let project = snapshot(
            "\\documentclass{article}\n\\input chapters/intro\n\\input\\chapterName\n\\input{nested{\\selectedChapter}}\n\\begin{verbatim}\n\\input{ignored}\n\\end{verbatim}",
            &[("chapters/intro.tex", "\\input ../shared/details"), ("shared/details.tex", "text")],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("chapters/intro.tex")));
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("shared/details.tex")));
        assert!(plan
            .unknown
            .iter()
            .any(|row| row.reason == "macro_valued_file_reference"));
        assert!(!plan
            .unknown
            .iter()
            .any(|row| row.expression.contains("ignored")));
    }

    #[test]
    fn typst_references_resolve_from_nested_file_and_dynamic_forms_are_visible() {
        let mut project = snapshot(
            "#import \"sections/chapter.typ\"\n#import dynamicModule\n// #import \"commented.typ\"",
            &[
                (
                    "sections/chapter.typ",
                    "#import \"../shared.typ\"\n#image(imagePath)\n// image(\"not-real.png\")",
                ),
                ("shared.typ", "#image(\"assets/picture.png\")"),
                ("assets/picture.png", "image"),
            ],
        );
        project.engine = "typst".into();
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("shared.typ")));
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("assets/picture.png")));
        assert!(plan
            .unknown
            .iter()
            .any(|row| row.reason == "typst_dynamic_reference"));
        assert!(!plan
            .unknown
            .iter()
            .any(|row| row.expression.contains("commented")));
        assert!(!plan
            .unknown
            .iter()
            .any(|row| row.expression.contains("not-real")));
    }

    #[test]
    fn shared_resource_arguments_reject_wrong_json_types() {
        let project = snapshot("\\documentclass{article}", &[]);
        for args in [
            json!({"limit":"10"}),
            json!({"cursor":3}),
            json!({"expectedPlanDigest":false}),
            json!({"expectedInputDigest":2}),
        ] {
            assert_eq!(
                dispatch("resources.list", &project, &args)
                    .unwrap_err()
                    .code,
                "usage.invalid_argument"
            );
        }
    }

    #[test]
    fn beamer_theme_names_map_to_catalog_resources_without_guessing_dynamic_values() {
        let project = snapshot(
            "\\documentclass{beamer}\n\\usetheme{default}\n\\usecolortheme{\\selectedTheme}",
            &[],
        );
        let plan = resolved_plan(&project, &Value::Null).unwrap();
        assert!(plan
            .requirements
            .iter()
            .any(|row| row.path.as_deref() == Some("beamerthemedefault.sty")));
        assert!(plan
            .unknown
            .iter()
            .any(|row| row.reason == "macro_valued_package_reference"));
    }

    #[test]
    fn snapshot_root_rejects_symbolic_links() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = directory.path().join("project-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&real, &link).unwrap();
        let mut project = snapshot("\\documentclass{article}", &[]);
        project.root = link;
        assert_eq!(
            resolved_plan(&project, &Value::Null).unwrap_err().code,
            "path.symlink_rejected"
        );
    }
}
