use super::{
    as_error, canonical_allowed_destination, AutomationError, OperationContext, ProjectSnapshot,
    PublicDiagnostic, MAX_LOG_BYTES, MAX_PDF_BYTES,
};
use crate::compiler::synctex::parse_synctex_gz;
use crate::diagnostics::latex_parser::{map_prepared_main_line, source_lines_before_t1_insertion};
use crate::types::{CompileResponse, DiagnosticItem};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

const MAX_RECORDED_RESOURCE_MISSES: usize = 200;

#[derive(Clone, Default)]
struct IndexedResourceMisses {
    resources: BTreeMap<String, super::resource_project::CatalogResource>,
    omitted: usize,
}

impl IndexedResourceMisses {
    fn record(&mut self, resource: super::resource_project::CatalogResource) {
        if self.resources.contains_key(&resource.path) {
            return;
        }
        if self.resources.len() < MAX_RECORDED_RESOURCE_MISSES {
            self.resources.insert(resource.path.clone(), resource);
        } else {
            self.omitted = self.omitted.saturating_add(1);
        }
    }

    fn is_empty(&self) -> bool {
        self.resources.is_empty() && self.omitted == 0
    }

    fn details(&self) -> Value {
        let pinned = super::resource_project::pinned_catalog().ok();
        let resources = self
            .resources
            .values()
            .map(|resource| {
                json!({
                    "path": resource.path,
                    "offset": resource.offset,
                    "length": resource.length,
                    "sha256": resource.sha256,
                })
            })
            .collect::<Vec<_>>();
        json!({
            "bundleDigest": pinned.as_ref().map(|catalog| catalog.digest.as_str()),
            "indexSha256": pinned.as_ref().map(|catalog| catalog.index_sha256.as_str()),
            "missingResources": resources,
            "missingOmitted": self.omitted,
            "omittedMayIncludeDuplicates": true,
            "probeCoverage": "possible_probes",
            "recovery": "Add or review selectors for the missing paths, analyze the project again, explicitly prepare the selected resources, then retry compilation.",
        })
    }
}

fn should_report_indexed_misses(
    run_succeeded: bool,
    valid_pdf: bool,
    diagnostics_empty: bool,
    misses_empty: bool,
) -> bool {
    !misses_empty && !(run_succeeded && valid_pdf && diagnostics_empty)
}

fn indexed_misses_error(
    misses: &IndexedResourceMisses,
    diagnostics: Vec<PublicDiagnostic>,
) -> AutomationError {
    AutomationError::new(
        "cache.unavailable_offline",
        "The document could not compile because one or more resources may be missing from the offline cache.",
        3,
    )
    .with_details(misses.details())
    .with_diagnostics(diagnostics)
}

fn indexed_path_for_name(
    name: &str,
    known: &BTreeSet<String>,
    indexed_by_basename: &BTreeMap<String, Vec<String>>,
) -> Option<String> {
    let clean = name.trim_start_matches("./");
    if known.contains(clean) {
        return Some(clean.to_owned());
    }
    let basename = clean.rsplit('/').next().unwrap_or(clean);
    indexed_by_basename
        .get(basename)
        .filter(|paths| paths.len() == 1)
        .and_then(|paths| paths.first().cloned())
}

pub fn worker_executable() -> Result<PathBuf, AutomationError> {
    let current = std::env::current_exe().map_err(|e| {
        AutomationError::new(
            "worker.crashed",
            format!("Cannot locate the application executable: {e}"),
            4,
        )
    })?;
    if current
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.contains("sciencebatch-cli"))
    {
        return Ok(current);
    }
    let parent = current.parent().unwrap_or_else(|| Path::new("."));
    let mut candidates = Vec::new();
    #[cfg(windows)]
    candidates.push(parent.join("sciencebatch-cli.exe"));
    #[cfg(not(windows))]
    candidates.push(parent.join("sciencebatch-cli"));
    if let Some(name) = current.file_name().and_then(|s| s.to_str()) {
        if let Some(triple) = name.rsplit_once('-').map(|(_, suffix)| suffix) {
            #[cfg(windows)]
            candidates.push(parent.join(format!("sciencebatch-cli-{triple}.exe")));
            #[cfg(not(windows))]
            candidates.push(parent.join(format!("sciencebatch-cli-{triple}")));
        }
    }
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| AutomationError::new("worker.crashed", "The sciencebatch-cli companion executable was not found next to the desktop application.", 4))
}

pub(super) fn export_and_summarize(
    snapshot: &ProjectSnapshot,
    args: &Value,
    result: CompileResponse,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    let diagnostics = public_diagnostics(snapshot, &result);
    if !result.success || !result.errors.is_empty() {
        return Err(AutomationError::new(
            "compile.document_failed",
            "Document compilation failed.",
            1,
        )
        .with_diagnostics(diagnostics));
    }
    if result.pdf_bytes.len() > super::MAX_PDF_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Compiled PDF exceeds 64 MiB.",
            3,
        ));
    }
    let (written, output) = if let Some(output_arg) = args.get("output").and_then(Value::as_str) {
        let output_path = Path::new(output_arg);
        if output_path
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|e| !e.eq_ignore_ascii_case("pdf"))
        {
            return Err(as_error(
                "output.invalid",
                "PDF output path must use the .pdf extension.",
                2,
            ));
        }
        let target = canonical_allowed_destination(output_path, context)?;
        let overwrite = args.get("overwrite").and_then(Value::as_bool) == Some(true);
        if target.exists() && !overwrite {
            return Err(as_error(
                "output.exists",
                "PDF destination already exists; pass --overwrite to replace it.",
                2,
            ));
        }
        export_pdf_atomic(
            &target,
            &result.pdf_bytes,
            overwrite,
            &context.allowed_roots,
        )?;
        (true, Some(target.to_string_lossy().to_string()))
    } else {
        (false, None)
    };
    Ok((
        json!({"success":true,"project":snapshot.root.to_string_lossy(),"engine":snapshot.engine,"mainFile":snapshot.main_file,"pdfWritten":written,"output":output,"pdfByteLength":result.pdf_bytes.len()}),
        diagnostics,
    ))
}

pub fn export_pdf_atomic(
    target: &Path,
    bytes: &[u8],
    overwrite: bool,
    allowed_roots: &[PathBuf],
) -> Result<(), AutomationError> {
    if bytes.len() > super::MAX_PDF_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "PDF output exceeds 64 MiB.",
            3,
        ));
    }
    if !bytes.starts_with(b"%PDF-")
        || !bytes
            .windows(5)
            .rev()
            .take(4096)
            .any(|window| window == b"%%EOF")
    {
        return Err(as_error(
            "output.invalid_pdf",
            "PDF output did not pass structural checks.",
            2,
        ));
    }
    if target
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|e| !e.eq_ignore_ascii_case("pdf"))
    {
        return Err(as_error(
            "output.invalid",
            "PDF output path must use the .pdf extension.",
            2,
        ));
    }
    let resolved = super::canonical_allowed_destination(
        target,
        &OperationContext {
            allowed_roots: allowed_roots.to_vec(),
            ..OperationContext::default()
        },
    )?;
    if resolved.exists() && !overwrite {
        return Err(as_error(
            "output.exists",
            "PDF destination already exists and overwrite was not requested.",
            2,
        ));
    }
    if resolved.exists() {
        let meta = fs::symlink_metadata(&resolved)
            .map_err(|e| AutomationError::new("io.output_failed", e.to_string(), 3))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(as_error(
                "path.symlink_rejected",
                "PDF destination must be a regular file.",
                2,
            ));
        }
    }
    atomic_export(&resolved, bytes, overwrite)
}

fn atomic_export(target: &Path, bytes: &[u8], overwrite: bool) -> Result<(), AutomationError> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let meta = fs::symlink_metadata(parent).map_err(|e| {
        AutomationError::new(
            "io.output_failed",
            format!("Cannot inspect output directory: {e}"),
            3,
        )
    })?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Output parent must be a real directory.",
            2,
        ));
    }
    let existing = if target.exists() {
        Some(
            fs::symlink_metadata(target)
                .map_err(|e| AutomationError::new("io.output_failed", e.to_string(), 3))?,
        )
    } else {
        None
    };
    if existing
        .as_ref()
        .is_some_and(|m| m.file_type().is_symlink() || !m.is_file())
    {
        return Err(as_error(
            "path.symlink_rejected",
            "Output destination must be a regular file.",
            2,
        ));
    }
    let seq = EXPORT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = parent.join(format!(
        ".sciencebatch-pdf-{}-{seq}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| {
            AutomationError::new(
                "io.output_failed",
                format!("Cannot create temporary PDF: {e}"),
                3,
            )
        })?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(AutomationError::new(
            "io.output_failed",
            format!("Cannot write PDF: {e}"),
            3,
        ));
    }
    if target.exists() && !overwrite {
        let _ = fs::remove_file(&temp);
        return Err(as_error(
            "output.exists",
            "PDF destination already exists and overwrite was not requested.",
            2,
        ));
    }
    if target.exists() {
        #[cfg(windows)]
        {
            // Windows rename does not replace an existing target atomically. Use a
            // sibling backup so a failed replacement restores the previous PDF.
            let backup = parent.join(format!(
                ".sciencebatch-pdf-{}-{seq}.bak",
                std::process::id()
            ));
            fs::rename(target, &backup).map_err(|e| {
                AutomationError::new(
                    "io.output_failed",
                    format!("Cannot preserve existing PDF: {e}"),
                    3,
                )
            })?;
            if let Err(e) = fs::rename(&temp, target) {
                let _ = fs::rename(&backup, target);
                let _ = fs::remove_file(&temp);
                return Err(AutomationError::new(
                    "io.output_failed",
                    format!("Cannot replace PDF: {e}"),
                    3,
                ));
            }
            let _ = fs::remove_file(backup);
            return Ok(());
        }
    }
    if !overwrite {
        fs::hard_link(&temp, target).map_err(|e| {
            let _ = fs::remove_file(&temp);
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                as_error(
                    "output.exists",
                    "PDF destination already exists and overwrite was not requested.",
                    2,
                )
            } else {
                AutomationError::new(
                    "io.output_failed",
                    format!("Cannot finalize PDF without replacing an existing destination: {e}"),
                    3,
                )
            }
        })?;
        fs::remove_file(&temp).map_err(|e| {
            AutomationError::new(
                "io.output_failed",
                format!("Cannot clean up the completed PDF write: {e}"),
                3,
            )
        })?;
        return Ok(());
    }
    fs::rename(&temp, target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        AutomationError::new("io.output_failed", format!("Cannot finalize PDF: {e}"), 3)
    })
}

static EXPORT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(super) fn public_diagnostics(
    snapshot: &ProjectSnapshot,
    response: &CompileResponse,
) -> Vec<PublicDiagnostic> {
    response
        .errors
        .iter()
        .map(|item| public_diag(snapshot, item, "error"))
        .chain(
            response
                .warnings
                .iter()
                .map(|item| public_diag(snapshot, item, "warning")),
        )
        .collect()
}

fn public_diag(
    snapshot: &ProjectSnapshot,
    item: &DiagnosticItem,
    severity: &str,
) -> PublicDiagnostic {
    let file = item
        .file
        .as_deref()
        .and_then(|path| normalize_diag_path(snapshot, path));
    let line = if file.is_some() { item.line } else { None };
    PublicDiagnostic {
        severity: severity.to_owned(),
        code: if severity == "error" {
            "compile.engine_error"
        } else {
            "compile.engine_warning"
        }
        .to_owned(),
        message: item.message.clone(),
        origin: "compiler".into(),
        file,
        line,
        column: None,
        suggestion: item.suggestion.clone(),
    }
}

fn normalize_diag_path(snapshot: &ProjectSnapshot, path: &str) -> Option<String> {
    if path == snapshot.main_file {
        return Some(snapshot.main_file.clone());
    }
    let normalized = super::normalize_project_path(path).ok()?;
    snapshot
        .files
        .contains_key(&normalized)
        .then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_indexed_probes_do_not_fail_a_valid_clean_compile() {
        assert!(!should_report_indexed_misses(true, true, true, false));
        assert!(should_report_indexed_misses(false, false, false, false));
        assert!(should_report_indexed_misses(true, false, true, false));
        assert!(should_report_indexed_misses(true, true, false, false));
        assert!(!should_report_indexed_misses(false, false, false, true));
    }

    #[test]
    fn missing_resource_details_are_bounded_and_identifiable() {
        let mut misses = IndexedResourceMisses::default();
        for index in 0..(MAX_RECORDED_RESOURCE_MISSES + 7) {
            let path = format!("tex/latex/test/resource-{index}.sty");
            misses.record(super::super::resource_project::CatalogResource {
                path,
                offset: index as u64,
                length: 12,
                sha256: format!("{index:064x}"),
            });
        }
        let details = misses.details();
        assert_eq!(misses.resources.len(), MAX_RECORDED_RESOURCE_MISSES);
        assert_eq!(misses.omitted, 7);
        assert_eq!(details["missingResources"].as_array().unwrap().len(), 200);
        assert_eq!(details["missingOmitted"], 7);
        assert!(details["bundleDigest"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(details["indexSha256"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert_eq!(
            details["missingResources"][0]["path"],
            "tex/latex/test/resource-0.sty"
        );
        assert_eq!(details["missingResources"][0]["length"], 12);
        assert_eq!(details["missingResources"][0]["offset"], 0);
        assert_eq!(
            details["missingResources"][0]["sha256"],
            format!("{:064x}", 0)
        );
        assert_eq!(details["probeCoverage"], "possible_probes");
        let recovery = details["recovery"].as_str().unwrap();
        assert!(recovery.contains("selectors"));
        assert!(recovery.contains("analyze"));
        assert!(recovery.contains("explicitly prepare"));
    }

    #[test]
    fn indexed_missing_error_keeps_details_and_compiler_diagnostics() {
        let mut misses = IndexedResourceMisses::default();
        misses.record(super::super::resource_project::CatalogResource {
            path: "article.cls".into(),
            offset: 42,
            length: 123,
            sha256: format!("{:064x}", 7),
        });
        let error = indexed_misses_error(
            &misses,
            vec![PublicDiagnostic {
                severity: "error".into(),
                code: "compile.engine_error".into(),
                message: "Missing document class.".into(),
                origin: "compiler".into(),
                file: Some("main.tex".into()),
                line: Some(1),
                column: None,
                suggestion: None,
            }],
        );
        assert_eq!(error.code, "cache.unavailable_offline");
        assert_eq!(
            error.details.as_ref().unwrap()["missingResources"][0]["path"],
            "article.cls"
        );
        assert_eq!(error.diagnostics.len(), 1);
        assert_eq!(error.diagnostics[0].message, "Missing document class.");
    }

    #[test]
    fn atomic_pdf_export_preserves_existing_destinations_without_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "sciencebatch-pdf-export-test-{}-{}",
            std::process::id(),
            EXPORT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let target = root.join("paper.pdf");
        let original = b"%PDF-1.7\noriginal\n%%EOF\n";
        let replacement = b"%PDF-1.7\nreplacement\n%%EOF\n";
        fs::write(&target, original).unwrap();

        let error = export_pdf_atomic(&target, replacement, false, &[]).unwrap_err();
        assert_eq!(error.code, "output.exists");
        assert_eq!(fs::read(&target).unwrap(), original);

        export_pdf_atomic(&target, replacement, true, &[]).unwrap();
        assert_eq!(fs::read(&target).unwrap(), replacement);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepared_main_locations_map_only_across_known_insertion_points() {
        let source = "\\documentclass{article}\nfirst source line\nsecond source line\n";
        let insertion_after = source_lines_before_t1_insertion(source);
        assert_eq!(insertion_after, 1);
        assert_eq!(map_prepared_main_line(1, 1, 1, Some(insertion_after)), None);
        assert_eq!(
            map_prepared_main_line(2, 1, 1, Some(insertion_after)),
            Some(1)
        );
        assert_eq!(map_prepared_main_line(3, 1, 1, Some(insertion_after)), None);
        assert_eq!(
            map_prepared_main_line(4, 1, 1, Some(insertion_after)),
            Some(2)
        );
        assert_eq!(map_prepared_main_line(3, 1, 0, None), Some(2));
    }

    #[test]
    fn compile_in_memory_snapshot_produces_synctex_source_map_for_main_and_input_files() {
        let main_tex = b"\\documentclass{article}\n\\begin{document}\nMain line.\n\n\\input{sections/intro.tex}\n\\end{document}\n".to_vec();
        let intro_tex = b"Intro section line.\n\nSecond intro paragraph.\n".to_vec();
        let mut files = BTreeMap::new();
        files.insert(
            "main.tex".to_owned(),
            super::super::SnapshotFile {
                bytes: main_tex.clone(),
                kind: super::super::SnapshotFileKind::Text,
            },
        );
        files.insert(
            "sections/intro.tex".to_owned(),
            super::super::SnapshotFile {
                bytes: intro_tex.clone(),
                kind: super::super::SnapshotFileKind::Text,
            },
        );
        let snapshot = ProjectSnapshot {
            engine: "latex".to_owned(),
            root: PathBuf::from("."),
            main_file: "main.tex".to_owned(),
            total_bytes: main_tex.len() + intro_tex.len(),
            files,
        };

        let resp = compile_in_memory(&snapshot).expect("in-memory LaTeX compile should not error");
        assert!(
            resp.success,
            "In-memory LaTeX compilation failed: {:?}",
            resp.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
        );
        let source_map = resp
            .source_map
            .expect("In-memory LaTeX compilation should produce a SyncTeX source map");
        assert!(
            source_map.files.iter().any(|f| f == "main.tex"),
            "Expected source_map.files to contain 'main.tex', got: {:?}",
            source_map.files
        );
        assert!(
            source_map.files.iter().any(|f| f == "sections/intro.tex"),
            "Expected source_map.files to contain 'sections/intro.tex', got: {:?}",
            source_map.files
        );
        assert!(
            !source_map.pages.is_empty() && !source_map.pages[0].boxes.is_empty(),
            "Expected non-empty pages[0].boxes"
        );
    }
}

pub(crate) fn compile_in_memory(
    snapshot: &ProjectSnapshot,
) -> Result<CompileResponse, AutomationError> {
    match snapshot.engine.as_str() {
        "latex" => compile_latex(snapshot),
        "typst" => compile_typst(snapshot),
        _ => Err(as_error(
            "engine.unsupported",
            "Unsupported compiler engine.",
            2,
        )),
    }
}

fn failure_response(message: &str, file: Option<String>) -> CompileResponse {
    CompileResponse {
        pdf_bytes: vec![],
        success: false,
        errors: vec![DiagnosticItem {
            severity: "error".into(),
            message: message.into(),
            line: None,
            file,
            suggestion: None,
            suggestion_code: None,
            suggestion_params: None,
        }],
        warnings: vec![],
        raw_log: message.to_owned(),
        source_map: None,
    }
}

fn compile_latex(snapshot: &ProjectSnapshot) -> Result<CompileResponse, AutomationError> {
    use std::io::Cursor;
    use std::str::FromStr;
    use tectonic::driver::{OutputFormat, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;
    use tectonic_bundles::Bundle;
    use tectonic_io_base::{digest::DigestData, InputHandle, InputOrigin, IoProvider, OpenResult};
    use tectonic_status_base::StatusBackend;

    let config = match tectonic::config::PersistentConfig::open(false) {
        Ok(c) => c,
        Err(e) => {
            return Err(cache_error(format!(
                "Cannot read Tectonic configuration: {e}"
            )))
        }
    };
    let pinned = super::resource_project::pinned_catalog()?;
    if config.default_bundle_loc() != pinned.url {
        return Err(AutomationError::new(
            "resources.bundle_identity_mismatch",
            "The configured LaTeX bundle does not match the bundle pinned by the resource catalog.",
            3,
        ));
    }
    let embedded_index_digest = format!("{:x}", Sha256::digest(&pinned.index_bytes));
    if embedded_index_digest != pinned.index_sha256 {
        return Err(AutomationError::new(
            "resources.catalog_invalid",
            "The embedded resource catalog index does not match its pinned SHA-256 digest.",
            4,
        )
        .with_details(json!({"catalogSha256": pinned.catalog_sha256,"expectedIndexSha256": pinned.index_sha256,"actualIndexSha256": embedded_index_digest})));
    }
    super::resource_project::validate_pinned_cache_identity_if_present()?;
    let Some(format_resource) = super::resource_project::catalog_resource("latex.ltx")? else {
        return Err(AutomationError::new(
            "resources.catalog_missing_resource",
            "The pinned bundle index is missing the required LaTeX format source.",
            3,
        ));
    };
    if super::resource_project::starter_resource_bytes("latex.ltx")?.is_none()
        && super::resource_project::verified_cached_bytes("latex.ltx")?.is_none()
    {
        let mut misses = IndexedResourceMisses::default();
        misses.record(format_resource);
        return Err(indexed_misses_error(&misses, Vec::new()));
    }

    let cached_bundle_files = super::resource_project::pinned_resource_paths()?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut indexed_by_basename = BTreeMap::<String, Vec<String>>::new();
    for path in &cached_bundle_files {
        if let Some(basename) = path.rsplit('/').next() {
            indexed_by_basename
                .entry(basename.to_owned())
                .or_default()
                .push(path.clone());
        }
    }
    let missing_resources = Arc::new(Mutex::new(IndexedResourceMisses::default()));
    let integrity_error = Arc::new(Mutex::new(None::<AutomationError>));
    struct StrictBundle {
        digest: String,
        known: BTreeSet<String>,
        indexed_by_basename: BTreeMap<String, Vec<String>>,
        missing_resources: Arc<Mutex<IndexedResourceMisses>>,
        integrity_error: Arc<Mutex<Option<AutomationError>>>,
    }
    impl IoProvider for StrictBundle {
        fn input_open_name(
            &mut self,
            name: &str,
            _status: &mut dyn StatusBackend,
        ) -> OpenResult<InputHandle> {
            use super::resource_project::{
                catalog_resource, starter_resource_bytes, verified_cached_bytes,
            };
            let lower = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
            let icon_bytes = match lower.as_str() {
                "simpleicons.sty" => Some(
                    include_bytes!("../../embedded_packages/simpleicons/simpleicons.sty")
                        .as_slice(),
                ),
                "simpleiconsglyphs-xeluatex.tex" => Some(
                    include_bytes!(
                        "../../embedded_packages/simpleicons/simpleiconsglyphs-xeluatex.tex"
                    )
                    .as_slice(),
                ),
                "simpleicons.otf" | "simpleicons" => Some(
                    include_bytes!("../../embedded_packages/simpleicons/SimpleIcons.otf")
                        .as_slice(),
                ),
                _ => None,
            };
            if let Some(bytes) = icon_bytes {
                return OpenResult::Ok(InputHandle::new(
                    name,
                    Cursor::new(bytes.to_vec()),
                    InputOrigin::Other,
                ));
            }
            let Some(path) = indexed_path_for_name(name, &self.known, &self.indexed_by_basename)
            else {
                return OpenResult::NotAvailable;
            };
            match starter_resource_bytes(&path) {
                Ok(Some(bytes)) => {
                    return OpenResult::Ok(InputHandle::new(
                        name,
                        Cursor::new(bytes),
                        InputOrigin::Other,
                    ));
                }
                Err(error) => {
                    *self
                        .integrity_error
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) = Some(error);
                    return OpenResult::Err(tectonic_errors::Error::msg(
                        "embedded starter resource failed pinned integrity verification",
                    ));
                }
                Ok(None) => {}
            }
            match catalog_resource(&path) {
                Ok(Some(resource)) => match verified_cached_bytes(&path) {
                    Ok(Some(bytes)) => OpenResult::Ok(InputHandle::new(
                        name,
                        Cursor::new(bytes),
                        InputOrigin::Other,
                    )),
                    Ok(None) => {
                        self.missing_resources
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .record(resource);
                        OpenResult::NotAvailable
                    }
                    Err(error) => {
                        *self
                            .integrity_error
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner()) = Some(error);
                        OpenResult::Err(tectonic_errors::Error::msg(
                            "cached bundle resource failed pinned integrity verification",
                        ))
                    }
                },
                Ok(None) => {
                    let error = AutomationError::new(
                        "resources.catalog_missing_resource",
                        "The pinned bundle index contains a resource that is absent from the embedded catalog.",
                        3,
                    )
                    .with_details(json!({"path":path}));
                    *self
                        .integrity_error
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) = Some(error);
                    OpenResult::Err(tectonic_errors::Error::msg(
                        "indexed bundle resource is absent from the pinned resource catalog",
                    ))
                }
                Err(error) => {
                    *self
                        .integrity_error
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) = Some(error);
                    OpenResult::Err(tectonic_errors::Error::msg(
                        "resource catalog could not verify the requested bundle resource",
                    ))
                }
            }
        }
    }
    impl Bundle for StrictBundle {
        fn get_digest(&mut self) -> tectonic_errors::Result<DigestData> {
            DigestData::from_str(&self.digest)
        }
        fn all_files(&self) -> Vec<String> {
            self.known.iter().cloned().collect()
        }
    }

    struct SnapshotIo {
        files: BTreeMap<String, Vec<u8>>,
        denied: Arc<AtomicBool>,
    }
    impl SnapshotIo {
        fn lookup(&mut self, name: &str) -> OpenResult<(InputHandle, String)> {
            let normalized = match super::project::normalize_project_path(name) {
                Ok(p) => p,
                Err(_) => {
                    self.denied
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    return OpenResult::Err(tectonic_errors::Error::msg(
                        "project input attempted to escape the snapshot root",
                    ));
                }
            };
            self.files
                .get(&normalized)
                .map(|b| {
                    (
                        InputHandle::new(name, Cursor::new(b.clone()), InputOrigin::Other),
                        normalized,
                    )
                })
                .map(OpenResult::Ok)
                .unwrap_or(OpenResult::NotAvailable)
        }
    }
    impl IoProvider for SnapshotIo {
        fn input_open_name(
            &mut self,
            name: &str,
            _: &mut dyn StatusBackend,
        ) -> OpenResult<InputHandle> {
            match self.lookup(name) {
                OpenResult::Ok((h, _)) => OpenResult::Ok(h),
                OpenResult::Err(e) => OpenResult::Err(e),
                OpenResult::NotAvailable => OpenResult::NotAvailable,
            }
        }
        fn input_open_name_with_abspath(
            &mut self,
            name: &str,
            _: &mut dyn StatusBackend,
        ) -> OpenResult<(InputHandle, Option<PathBuf>)> {
            match self.lookup(name) {
                OpenResult::Ok((h, normalized)) => {
                    OpenResult::Ok((h, Some(PathBuf::from(normalized))))
                }
                OpenResult::Err(e) => OpenResult::Err(e),
                OpenResult::NotAvailable => OpenResult::NotAvailable,
            }
        }
    }

    let original_main =
        std::str::from_utf8(&snapshot.files[&snapshot.main_file].bytes).unwrap_or("");
    let (processed, prepend, inserted) =
        crate::diagnostics::latex_parser::prepare_latex_source(original_main);
    let insertion_after_source_lines =
        (inserted > 0).then(|| source_lines_before_t1_insertion(original_main));
    let tex_input_name = snapshot.main_file.as_str();
    let log_name = std::path::Path::new(tex_input_name)
        .with_extension("log")
        .to_string_lossy()
        .into_owned();
    let pdf_name = std::path::Path::new(tex_input_name)
        .with_extension("pdf")
        .to_string_lossy()
        .into_owned();
    let synctex_name = std::path::Path::new(tex_input_name)
        .with_extension("synctex.gz")
        .to_string_lossy()
        .into_owned();
    let mut status = NoopStatusBackend::default();
    let format_cache = match config.format_cache_path() {
        Ok(p) => p,
        Err(e) => {
            return Err(AutomationError::new(
                "cache.unavailable_offline",
                format!("Cannot resolve Tectonic format cache: {e}"),
                3,
            ))
        }
    };
    let denied = Arc::new(AtomicBool::new(false));
    let project_io = SnapshotIo {
        files: snapshot
            .files
            .iter()
            .map(|(p, f)| (p.clone(), f.bytes.clone()))
            .collect(),
        denied: denied.clone(),
    };
    let mut builder = ProcessingSessionBuilder::default();
    builder
        .bundle(Box::new(StrictBundle {
            digest: pinned.digest,
            known: cached_bundle_files,
            indexed_by_basename,
            missing_resources: missing_resources.clone(),
            integrity_error: integrity_error.clone(),
        }))
        .project_io_provider(Box::new(project_io))
        .allow_external_tools(false)
        .primary_input_buffer(processed.as_bytes())
        .tex_input_name(tex_input_name)
        .format_name("latex")
        .format_cache_path(format_cache)
        .keep_logs(true)
        .keep_intermediates(false)
        .print_stdout(false)
        .synctex(true)
        .output_format(OutputFormat::Pdf)
        .do_not_write_output_files();
    let mut session = match builder.create(&mut status) {
        Ok(s) => s,
        Err(e) => {
            return Err(AutomationError::new(
                "internal.unexpected",
                format!("Cannot initialize LaTeX engine: {e}"),
                4,
            ))
        }
    };
    let run = session.run(&mut status);
    if run.as_ref().err().is_some_and(|error| {
        error
            .to_string()
            .contains("external bibliography tools are disabled")
    }) {
        return Err(AutomationError::new("dependency.external_tool_unsupported", "This document requests an external bibliography tool such as Biber. ScienceBatch supports in-memory BibTeX; use backend=bibtex or provide a compatible bibliography workflow.", 1));
    }
    let mut files = session.into_file_data();
    let log = files.remove(&log_name).map(|f| f.data).unwrap_or_default();
    if log.len() > MAX_LOG_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Compiler log exceeds the 1 MiB limit.",
            3,
        ));
    }
    let raw_log = String::from_utf8_lossy(&log).to_string();
    if denied.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(as_error(
            "path.outside_project",
            "A project input path attempted to escape the snapshot root.".to_owned(),
            2,
        ));
    }
    let raw_lower = raw_log.to_ascii_lowercase();
    let offline_cache_error = raw_lower
        .contains("bundle index is not available in the offline cache")
        || raw_lower.contains("this bundle isn't cached")
        || raw_lower.contains("couldn't find cached");
    let snapshot_paths = snapshot
        .files
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let (mut errors, mut warnings) =
        crate::diagnostics::latex_parser::parse_latex_log_with_snapshot(
            &raw_log,
            0,
            &snapshot.main_file,
            None,
            Some(&snapshot.main_file),
            Some(&snapshot_paths),
        );
    for diagnostic in errors.iter_mut().chain(warnings.iter_mut()) {
        diagnostic.file = diagnostic.file.as_deref().and_then(|p| {
            if p == tex_input_name {
                Some(snapshot.main_file.clone())
            } else {
                super::normalize_project_path(p)
                    .ok()
                    .filter(|n| snapshot.files.contains_key(n))
            }
        });
        if diagnostic.file.is_none() {
            diagnostic.line = None;
        } else if diagnostic.file.as_deref() == Some(tex_input_name) {
            diagnostic.line = diagnostic.line.and_then(|line| {
                map_prepared_main_line(line, prepend, inserted, insertion_after_source_lines)
            });
        }
    }
    let pdf = if run.is_ok() {
        files.remove(&pdf_name).map(|file| file.data)
    } else {
        None
    };
    if pdf
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_PDF_BYTES)
    {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Compiled PDF exceeds 64 MiB.",
            3,
        ));
    }
    let valid_pdf = pdf.as_deref().is_some_and(is_structurally_valid_pdf);
    let missing_snapshot = missing_resources
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let integrity_snapshot = integrity_error
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    if let Some(mut error) = integrity_snapshot {
        let partial = CompileResponse {
            pdf_bytes: Vec::new(),
            success: false,
            errors: errors.clone(),
            warnings: warnings.clone(),
            raw_log: raw_log.clone(),
            source_map: None,
        };
        error.diagnostics = public_diagnostics(snapshot, &partial);
        return Err(error);
    }
    if !missing_snapshot.is_empty()
        && should_report_indexed_misses(run.is_ok(), valid_pdf, errors.is_empty(), false)
    {
        let partial = CompileResponse {
            pdf_bytes: Vec::new(),
            success: false,
            errors: errors.clone(),
            warnings: warnings.clone(),
            raw_log: raw_log.clone(),
            source_map: None,
        };
        return Err(indexed_misses_error(
            &missing_snapshot,
            public_diagnostics(snapshot, &partial),
        ));
    }
    if let Some(pdf_bytes) = pdf.filter(|_| valid_pdf && errors.is_empty()) {
        let synctex_file = files.remove(&synctex_name).or_else(|| {
            files
                .keys()
                .find(|k| k.ends_with(".synctex.gz"))
                .cloned()
                .and_then(|k| files.remove(&k))
        });
        let source_map = synctex_file.and_then(|file| {
            parse_synctex_gz(
                &file.data,
                &snapshot.main_file,
                tex_input_name,
                None,
                Some(&snapshot_paths),
                prepend,
                inserted,
                insertion_after_source_lines,
            )
        });
        return Ok(CompileResponse {
            pdf_bytes,
            success: true,
            errors,
            warnings,
            raw_log,
            source_map,
        });
    }
    if offline_cache_error {
        let partial = CompileResponse {
            pdf_bytes: Vec::new(),
            success: false,
            errors: errors.clone(),
            warnings: warnings.clone(),
            raw_log: raw_log.clone(),
            source_map: None,
        };
        return Err(AutomationError::new(
            "cache.unavailable_offline",
            "A required compiler resource is unavailable in the offline cache.",
            3,
        )
        .with_diagnostics(public_diagnostics(snapshot, &partial)));
    }
    if errors.is_empty() {
        errors.push(DiagnosticItem {
            severity: "error".into(),
            message: "LaTeX engine failed without a source location.".into(),
            line: None,
            file: None,
            suggestion: None,
            suggestion_code: None,
            suggestion_params: None,
        });
    }
    Ok(CompileResponse {
        pdf_bytes: vec![],
        success: false,
        errors,
        warnings,
        raw_log,
        source_map: None,
    })
}

fn is_structurally_valid_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
        && bytes
            .windows(5)
            .rev()
            .take(4096)
            .any(|window| window == b"%%EOF")
}

fn cache_error(message: String) -> AutomationError {
    AutomationError::new("cache.unavailable_offline", message, 3)
}

fn compile_typst(snapshot: &ProjectSnapshot) -> Result<CompileResponse, AutomationError> {
    let source = match std::str::from_utf8(&snapshot.files[&snapshot.main_file].bytes) {
        Ok(s) => s,
        Err(_) => {
            return Ok(failure_response(
                "Typst main source is not UTF-8.",
                Some(snapshot.main_file.clone()),
            ))
        }
    };
    let env = match typst_embed::RenderEnvironment::builder()
        .font_set(crate::compiler::typst::get_system_font_set())
        .build()
    {
        Ok(env) => env,
        Err(e) => {
            return Err(AutomationError::new(
                "internal.unexpected",
                format!("Typst environment failed: {e}"),
                4,
            ))
        }
    };
    let mut builder =
        typst_embed::Project::builder(&snapshot.main_file).source_file(&snapshot.main_file, source);
    for (path, file) in &snapshot.files {
        if path != &snapshot.main_file {
            builder = builder.file(path.clone(), file.bytes.clone());
        }
    }
    let project = match builder.build() {
        Ok(p) => p,
        Err(e) => {
            return Ok(failure_response(
                &format!("Typst project validation failed: {e}"),
                None,
            ))
        }
    };
    match crate::compiler::typst_sourcemap::compile_and_extract_typst(&project, &env) {
        Ok((bytes, source_map)) => {
            if bytes.len() > MAX_PDF_BYTES {
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Compiled PDF exceeds 64 MiB.",
                    3,
                ));
            }
            Ok(CompileResponse {
                pdf_bytes: bytes,
                success: true,
                errors: vec![],
                warnings: vec![],
                raw_log: "Typst compilation completed with an in-memory project snapshot.".into(),
                source_map: Some(source_map),
            })
        }
        Err(typst_embed::RenderError::Diagnostics(items)) => {
            let mut errors = Vec::new();
            let mut raw = String::new();
            for item in items {
                let message = item.message().to_owned();
                if message.contains("would escape the project root")
                    || message.contains("path escapes the project root")
                {
                    return Err(as_error(
                        "path.outside_project",
                        "A Typst project input path attempted to escape the snapshot root.",
                        2,
                    ));
                }
                raw.push_str(&format!("{message}\n"));
                let file = item
                    .project_path()
                    .map(|p| p.get_without_slash().to_owned())
                    .filter(|p| snapshot.files.contains_key(p));
                let range = item.source_range();
                errors.push(DiagnosticItem {
                    severity: "error".into(),
                    message,
                    line: range.map(|r| r.start_line() + 1),
                    file,
                    suggestion: None,
                    suggestion_code: None,
                    suggestion_params: None,
                });
                if raw.len() > MAX_LOG_BYTES {
                    return Err(AutomationError::new(
                        "resource.limit_exceeded",
                        "Compiler log exceeds the 1 MiB limit.",
                        3,
                    ));
                }
            }
            Ok(CompileResponse {
                pdf_bytes: vec![],
                success: false,
                errors,
                warnings: vec![],
                raw_log: raw,
                source_map: None,
            })
        }
        Err(e) => Ok(failure_response(
            &format!("Typst rendering failed: {e}"),
            None,
        )),
    }
}
