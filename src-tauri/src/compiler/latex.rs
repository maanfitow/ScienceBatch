use std::path::Path;
use tectonic::driver::ProcessingSessionBuilder;
use tectonic::status::NoopStatusBackend;
use tectonic_bundles::Bundle;

use crate::types::{CompileResponse, DiagnosticItem};
use crate::diagnostics::latex_parser::{parse_latex_log, prepare_latex_source};
use super::embedded::EmbeddedPackageBundle;

/// Executes in-memory compilation using Tectonic's ProcessingSessionBuilder for LaTeX.
pub fn compile_latex_to_pdf(latex: &str, project_dir: Option<&str>, main_file: Option<&str>) -> CompileResponse {
    let (processed_latex, prepended_lines, inserted_lines) = prepare_latex_source(latex);
    let total_injected = prepended_lines + inserted_lines;
    let mut status = NoopStatusBackend::default();

    let config = match tectonic::config::PersistentConfig::open(false) {
        Ok(c) => c,
        Err(e) => {
            return CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors: vec![DiagnosticItem {
                    severity: "error".into(),
                    message: format!("Failed to open Tectonic configuration: {e}"),
                    line: None,
                    file: None,
                    suggestion: None,
                }],
                warnings: Vec::new(),
                raw_log: format!("Config error: {e}"),
            };
        }
    };

    let bundle: Box<dyn Bundle> = match config.default_bundle(false) {
        Ok(b) => Box::new(EmbeddedPackageBundle { inner: b }),
        Err(e) => {
            return CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors: vec![DiagnosticItem {
                    severity: "error".into(),
                    message: format!("Failed to load resource bundle: {e}"),
                    line: None,
                    file: None,
                    suggestion: None,
                }],
                warnings: Vec::new(),
                raw_log: format!("Bundle error: {e}"),
            };
        }
    };

    let format_cache_path = match config.format_cache_path() {
        Ok(p) => p,
        Err(e) => {
            return CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors: vec![DiagnosticItem {
                    severity: "error".into(),
                    message: format!("Failed to set up format cache: {e}"),
                    line: None,
                    file: None,
                    suggestion: None,
                }],
                warnings: Vec::new(),
                raw_log: format!("Format cache error: {e}"),
            };
        }
    };

    let mut sb = ProcessingSessionBuilder::default();
    sb.bundle(bundle)
        .primary_input_buffer(processed_latex.as_bytes())
        .tex_input_name("texput.tex")
        .format_name("latex")
        .format_cache_path(format_cache_path)
        .keep_logs(true)
        .keep_intermediates(false)
        .print_stdout(false)
        .output_format(tectonic::driver::OutputFormat::Pdf)
        .do_not_write_output_files();

    if let Some(dir) = project_dir {
        let p = Path::new(dir);
        if p.is_dir() {
            sb.filesystem_root(p);
        }
    }

    let mut sess = match sb.create(&mut status) {
        Ok(s) => s,
        Err(e) => {
            return CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors: vec![DiagnosticItem {
                    severity: "error".into(),
                    message: format!("Failed to initialize LaTeX processing session: {e}"),
                    line: None,
                    file: None,
                    suggestion: None,
                }],
                warnings: Vec::new(),
                raw_log: format!("Session init error: {e}"),
            };
        }
    };

    let result = sess.run(&mut status);
    let mut files = sess.into_file_data();

    let raw_log = if let Some(log_file) = files.remove("texput.log") {
        String::from_utf8_lossy(&log_file.data).to_string()
    } else {
        String::new()
    };

    let root_file = main_file.unwrap_or("main.tex");
    let (mut errors, warnings) = parse_latex_log(&raw_log, total_injected, root_file, project_dir, main_file);

    if result.is_ok() {
        if let Some(pdf) = files.remove("texput.pdf") {
            return CompileResponse {
                pdf_bytes: pdf.data,
                success: true,
                errors,
                warnings,
                raw_log,
            };
        }
    }

    if errors.is_empty() {
        errors.push(DiagnosticItem {
            severity: "error".into(),
            message: "LaTeX engine finished with error (no PDF output created).".into(),
            line: None,
            file: main_file.map(|s| s.to_string()),
            suggestion: Some("Review document syntax or inspect the raw log below.".into()),
        });
    }

    CompileResponse {
        pdf_bytes: Vec::new(),
        success: false,
        errors,
        warnings,
        raw_log,
    }
}
