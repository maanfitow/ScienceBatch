use super::{
    as_error, canonical_allowed_destination, AutomationError, OperationContext, ProjectSnapshot,
    PublicDiagnostic, MAX_LOG_BYTES, MAX_PDF_BYTES,
};
use crate::types::{CompileResponse, DiagnosticItem};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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
        }],
        warnings: vec![],
        raw_log: message.to_owned(),
    }
}

fn compile_latex(snapshot: &ProjectSnapshot) -> Result<CompileResponse, AutomationError> {
    use std::io::Cursor;
    use tectonic::driver::{OutputFormat, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;
    use tectonic_bundles::{detect_bundle, Bundle};
    use tectonic_io_base::{
        digest::DigestData, InputHandle, InputOrigin, IoProvider, OpenResult, OutputHandle,
    };
    use tectonic_status_base::StatusBackend;

    let config = match tectonic::config::PersistentConfig::open(false) {
        Ok(c) => c,
        Err(e) => {
            return Err(cache_error(format!(
                "Cannot read Tectonic configuration: {e}"
            )))
        }
    };
    let mut inner = match detect_bundle(config.default_bundle_loc().to_owned(), true, None) {
        Ok(Some(b)) => b,
        Ok(None) => {
            return Err(cache_error(
                "The local LaTeX resource bundle is missing or incomplete. Run `sciencebatch-cli resources prepare --engine latex --json` to download the existing bundle.".into(),
            ))
        }
        Err(_) => return Err(cache_error("The local LaTeX resource bundle is missing or incomplete. Run `sciencebatch-cli resources prepare --engine latex --json` to resume preparation.".into())),
    };
    let mut bundle_status = NoopStatusBackend::default();
    match inner.input_open_name("latex.ltx", &mut bundle_status) {
        OpenResult::Ok(_) => {}
        OpenResult::Err(_) | OpenResult::NotAvailable => {
            return Err(cache_error("The local LaTeX resource index or required format source is missing. Run `sciencebatch-cli resources prepare --engine latex --json` to resume preparation.".into()));
        }
    }
    let cached_bundle_files = inner
        .all_files()
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let cache_miss = Arc::new(AtomicBool::new(false));
    struct StrictBundle {
        inner: Box<dyn Bundle>,
        known: std::collections::BTreeSet<String>,
        cache_miss: Arc<AtomicBool>,
    }
    impl IoProvider for StrictBundle {
        fn input_open_name(
            &mut self,
            name: &str,
            status: &mut dyn StatusBackend,
        ) -> OpenResult<InputHandle> {
            let lower = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
            let bytes = match lower.as_str() {
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
            if let Some(bytes) = bytes {
                return OpenResult::Ok(InputHandle::new(
                    name,
                    Cursor::new(bytes.to_vec()),
                    InputOrigin::Other,
                ));
            }
            match self.inner.input_open_name(name, status) {
                OpenResult::NotAvailable => {
                    let clean = name.trim_start_matches("./");
                    if self.known.contains(clean)
                        || self
                            .known
                            .contains(clean.rsplit('/').next().unwrap_or(clean))
                    {
                        self.cache_miss
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    OpenResult::NotAvailable
                }
                result => result,
            }
        }
        fn input_open_name_with_abspath(
            &mut self,
            name: &str,
            status: &mut dyn StatusBackend,
        ) -> OpenResult<(InputHandle, Option<PathBuf>)> {
            match self.input_open_name(name, status) {
                OpenResult::Ok(h) => OpenResult::Ok((h, None)),
                OpenResult::Err(e) => OpenResult::Err(e),
                OpenResult::NotAvailable => OpenResult::NotAvailable,
            }
        }
        fn input_open_primary(&mut self, s: &mut dyn StatusBackend) -> OpenResult<InputHandle> {
            self.inner.input_open_primary(s)
        }
        fn input_open_primary_with_abspath(
            &mut self,
            s: &mut dyn StatusBackend,
        ) -> OpenResult<(InputHandle, Option<PathBuf>)> {
            self.inner.input_open_primary_with_abspath(s)
        }
        fn input_open_format(
            &mut self,
            n: &str,
            s: &mut dyn StatusBackend,
        ) -> OpenResult<InputHandle> {
            self.inner.input_open_format(n, s)
        }
        fn write_format(
            &mut self,
            n: &str,
            d: &[u8],
            s: &mut dyn StatusBackend,
        ) -> tectonic_errors::Result<()> {
            self.inner.write_format(n, d, s)
        }
        fn output_open_name(&mut self, n: &str) -> OpenResult<OutputHandle> {
            self.inner.output_open_name(n)
        }
        fn output_open_stdout(&mut self) -> OpenResult<OutputHandle> {
            self.inner.output_open_stdout()
        }
    }
    impl Bundle for StrictBundle {
        fn get_digest(&mut self) -> tectonic_errors::Result<DigestData> {
            self.inner.get_digest()
        }
        fn all_files(&self) -> Vec<String> {
            self.inner.all_files()
        }
    }

    struct SnapshotIo {
        files: BTreeMap<String, Vec<u8>>,
        denied: Arc<AtomicBool>,
    }
    impl SnapshotIo {
        fn lookup(&mut self, name: &str) -> OpenResult<InputHandle> {
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
                .map(|b| InputHandle::new(name, Cursor::new(b.clone()), InputOrigin::Other))
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
            self.lookup(name)
        }
        fn input_open_name_with_abspath(
            &mut self,
            name: &str,
            _: &mut dyn StatusBackend,
        ) -> OpenResult<(InputHandle, Option<PathBuf>)> {
            match self.lookup(name) {
                OpenResult::Ok(h) => OpenResult::Ok((h, None)),
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
            inner,
            known: cached_bundle_files,
            cache_miss: cache_miss.clone(),
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
        return Err(AutomationError::new("dependency.external_tool_unsupported", "This document requires Biber or another external bibliography tool. Automation compilation runs without external tools; use the desktop compiler or switch to a supported bibliography workflow.", 1));
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
    if cache_miss.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(cache_error("A required LaTeX resource is listed in the local bundle but is not cached. Run `sciencebatch-cli resources prepare --engine latex --json` to resume preparation.".into()));
    }
    let raw_lower = raw_log.to_ascii_lowercase();
    if raw_lower.contains("bundle index is not available in the offline cache")
        || raw_lower.contains("this bundle isn't cached")
        || raw_lower.contains("couldn't find cached")
    {
        return Err(AutomationError::new(
            "cache.unavailable_offline",
            "A required compiler resource is unavailable in the offline cache.",
            3,
        ));
    }
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
    if run.is_ok() {
        if let Some(pdf) = files.remove(&pdf_name) {
            if pdf.data.len() > MAX_PDF_BYTES {
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Compiled PDF exceeds 64 MiB.",
                    3,
                ));
            }
            return Ok(CompileResponse {
                pdf_bytes: pdf.data,
                success: true,
                errors,
                warnings,
                raw_log,
            });
        }
    }
    if errors.is_empty() {
        errors.push(DiagnosticItem {
            severity: "error".into(),
            message: "LaTeX engine failed without a source location.".into(),
            line: None,
            file: None,
            suggestion: None,
        });
    }
    let _ = prepend;
    Ok(CompileResponse {
        pdf_bytes: vec![],
        success: false,
        errors,
        warnings,
        raw_log,
    })
}

fn source_lines_before_t1_insertion(source: &str) -> usize {
    let Some(class_start) = source.find("\\documentclass") else {
        return 0;
    };
    let Some(newline) = source[class_start..].find('\n') else {
        return 0;
    };
    let insertion_byte = class_start + newline + 1;
    source[..insertion_byte]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
}

fn map_prepared_main_line(
    prepared_line: usize,
    prepended_lines: usize,
    inserted_lines: usize,
    insertion_after_lines: Option<usize>,
) -> Option<usize> {
    if prepared_line <= prepended_lines {
        return None;
    }
    let mut source_line = prepared_line.checked_sub(prepended_lines)?;
    if inserted_lines == 0 {
        return Some(source_line);
    }
    let insertion_after = insertion_after_lines?;
    if source_line <= insertion_after {
        Some(source_line)
    } else if source_line <= insertion_after + inserted_lines {
        None
    } else {
        source_line = source_line.checked_sub(inserted_lines)?;
        Some(source_line)
    }
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
    match typst_embed::render_pdf(&project, &env) {
        Ok(artifact) => {
            let bytes = artifact.bytes().to_vec();
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
            })
        }
        Err(e) => Ok(failure_response(
            &format!("Typst rendering failed: {e}"),
            None,
        )),
    }
}
