use std::collections::BTreeMap;
use std::path::Path;

use crate::automation::{capture_snapshot, capture_virtual_snapshot, AutomationError};
use crate::types::{CompileResponse, DiagnosticItem};

fn normalize_main_file(project_dir: Option<&Path>, main_file: Option<&str>) -> String {
    let raw = main_file
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("main.tex");
    let raw_path = Path::new(raw);
    let is_abs_like = raw_path.is_absolute()
        || raw.starts_with('/')
        || raw.starts_with('\\')
        || raw.as_bytes().get(1) == Some(&b':');

    if let Some(dir) = project_dir {
        if is_abs_like {
            if let Ok(rel) = raw_path.strip_prefix(dir) {
                return rel.to_string_lossy().replace('\\', "/");
            }
            if let Ok(canon_dir) = std::fs::canonicalize(dir) {
                let canon_main = if raw_path.exists() {
                    std::fs::canonicalize(raw_path).ok()
                } else if let (Some(parent), Some(name)) =
                    (raw_path.parent(), raw_path.file_name())
                {
                    std::fs::canonicalize(parent).ok().map(|p| p.join(name))
                } else {
                    None
                };
                if let Some(rel) = canon_main
                    .as_ref()
                    .and_then(|p| p.strip_prefix(&canon_dir).ok())
                {
                    return rel.to_string_lossy().replace('\\', "/");
                }
            }
        }
        return raw.replace('\\', "/");
    }

    if is_abs_like {
        return raw_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("main.tex")
            .to_owned();
    }
    raw.replace('\\', "/")
}

fn automation_error_to_compile_response(err: AutomationError, main_name: &str) -> CompileResponse {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    for diag in err.diagnostics {
        let item = DiagnosticItem {
            severity: diag.severity.clone(),
            message: diag.message,
            line: diag.line,
            file: diag.file,
            suggestion: diag.suggestion,
        };
        if diag.severity == "warning" {
            warnings.push(item);
        } else {
            errors.push(item);
        }
    }
    if errors.is_empty() {
        errors.push(DiagnosticItem {
            severity: "error".into(),
            message: format!("{}: {}", err.code, err.message),
            line: None,
            file: Some(main_name.to_owned()),
            suggestion: None,
        });
    }
    let raw_log = match err.details {
        Some(details) => format!("{}: {}\n{}", err.code, err.message, details),
        None => format!("{}: {}", err.code, err.message),
    };
    CompileResponse {
        pdf_bytes: Vec::new(),
        success: false,
        errors,
        warnings,
        raw_log,
        source_map: None,
    }
}

/// Executes in-memory LaTeX compilation via the pinned offline starter/cache bundle pipeline.
pub fn compile_latex_to_pdf(
    latex: &str,
    project_dir: Option<&str>,
    main_file: Option<&str>,
) -> CompileResponse {
    let dir_path = project_dir.map(Path::new).filter(|p| p.is_dir());
    let main_name = normalize_main_file(dir_path, main_file);
    let overlays = BTreeMap::from([(main_name.clone(), latex.as_bytes().to_vec())]);

    let snapshot_res = if let Some(dir) = dir_path {
        capture_snapshot(dir, &main_name, &overlays)
    } else {
        capture_virtual_snapshot("latex", &main_name, &overlays)
    };

    let snapshot = match snapshot_res {
        Ok(snapshot) => snapshot,
        Err(err) => return automation_error_to_compile_response(err, &main_name),
    };

    match crate::automation::compiler::compile_in_memory(&snapshot) {
        Ok(response) => response,
        Err(err) => automation_error_to_compile_response(err, &main_name),
    }
}
