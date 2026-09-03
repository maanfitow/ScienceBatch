use std::path::Path;
use crate::types::{CompileResponse, DiagnosticItem};
use crate::diagnostics::typst_parser::parse_typst_diagnostics;
use crate::compiler::embedded::{SAMPLE_PNG, SAMPLE_GIF, SAMPLE_BIB};

static SYSTEM_FONTS: std::sync::OnceLock<typst_embed::FontSet> = std::sync::OnceLock::new();

fn scan_dir_for_fonts(dir: &Path, files: &mut Vec<Vec<u8>>, max_depth: usize) {
    if max_depth == 0 {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_dir_for_fonts(&path, files, max_depth - 1);
            } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if ext.eq_ignore_ascii_case("ttf") || ext.eq_ignore_ascii_case("otf") {
                    if let Ok(bytes) = std::fs::read(&path) {
                        files.push(bytes);
                    }
                }
            }
        }
    }
}

pub fn get_system_font_set() -> typst_embed::FontSet {
    SYSTEM_FONTS
        .get_or_init(|| {
            let mut font_files = Vec::new();

            #[cfg(target_os = "linux")]
            {
                let font_roots = [
                    Path::new("/usr/share/fonts/truetype"),
                    Path::new("/usr/share/fonts/opentype"),
                    Path::new("/usr/share/fonts/dejavu"),
                    Path::new("/usr/local/share/fonts"),
                ];
                for root in &font_roots {
                    scan_dir_for_fonts(root, &mut font_files, 3);
                }
                if let Ok(home) = std::env::var("HOME") {
                    let user_fonts = Path::new(&home).join(".local/share/fonts");
                    scan_dir_for_fonts(&user_fonts, &mut font_files, 2);
                    let user_fonts_old = Path::new(&home).join(".fonts");
                    scan_dir_for_fonts(&user_fonts_old, &mut font_files, 2);
                }
            }

            #[cfg(target_os = "windows")]
            {
                if let Ok(windir) = std::env::var("WINDIR") {
                    let win_fonts = Path::new(&windir).join("Fonts");
                    scan_dir_for_fonts(&win_fonts, &mut font_files, 2);
                } else {
                    scan_dir_for_fonts(Path::new("C:\\Windows\\Fonts"), &mut font_files, 2);
                }
            }

            #[cfg(target_os = "macos")]
            {
                let mac_roots = [
                    Path::new("/System/Library/Fonts"),
                    Path::new("/Library/Fonts"),
                ];
                for root in &mac_roots {
                    scan_dir_for_fonts(root, &mut font_files, 2);
                }
                if let Ok(home) = std::env::var("HOME") {
                    let user_fonts = Path::new(&home).join("Library/Fonts");
                    scan_dir_for_fonts(&user_fonts, &mut font_files, 2);
                }
            }

            typst_embed::FontSet::bundled_plus_font_files(font_files)
        })
        .clone()
}

fn load_project_files_into_builder(
    mut builder: typst_embed::ProjectBuilder,
    base_dir: &Path,
    current_dir: &Path,
    main_filename: &str,
) -> typst_embed::ProjectBuilder {
    if let Ok(entries) = std::fs::read_dir(current_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if name.starts_with('.') && name != ".sciencebatch.json" {
                continue;
            }

            if path.is_dir() {
                builder = load_project_files_into_builder(builder, base_dir, &path, main_filename);
            } else if path.is_file() {
                if let Ok(rel) = path.strip_prefix(base_dir) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if rel_str == main_filename || rel_str == format!("./{main_filename}") {
                        continue;
                    }
                    if let Ok(bytes) = std::fs::read(&path) {
                        builder = builder.file(rel_str, bytes);
                    }
                }
            }
        }
    }
    builder
}

/// Executes in-memory compilation of Typst documents using the native typst-embed engine.
pub fn compile_typst_to_pdf(
    typst_source: &str,
    project_dir: Option<&str>,
    main_file: Option<&str>,
) -> CompileResponse {
    let font_set = get_system_font_set();

    let env = match typst_embed::RenderEnvironment::builder()
        .font_set(font_set)
        .build()
    {
        Ok(e) => e,
        Err(err) => {
            return CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors: vec![DiagnosticItem {
                    severity: "error".into(),
                    message: format!("Typst environment error: {err}"),
                    line: None,
                    file: None,
                    suggestion: Some("Verify Typst embedded environment initialization.".into()),
                }],
                warnings: Vec::new(),
                raw_log: format!("Typst Environment Error: {err}"),
            };
        }
    };

    let main_name = main_file.unwrap_or("main.typ");
    let mut builder = typst_embed::Project::builder(main_name)
        .source_file(main_name, typst_source)
        .file("assets/sample.png", SAMPLE_PNG.to_vec())
        .file("sample.png", SAMPLE_PNG.to_vec())
        .file("assets/sample.gif", SAMPLE_GIF.to_vec())
        .file("sample.gif", SAMPLE_GIF.to_vec())
        .file("references.bib", SAMPLE_BIB.to_vec());

    if let Some(dir) = project_dir {
        let base_path = Path::new(dir);
        if base_path.is_dir() {
            builder = load_project_files_into_builder(builder, base_path, base_path, main_name);
        }
    }

    let project = match builder.build() {
        Ok(p) => p,
        Err(err) => {
            return CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors: vec![DiagnosticItem {
                    severity: "error".into(),
                    message: format!("Typst project error: {err}"),
                    line: None,
                    file: main_file.map(|s| s.to_string()),
                    suggestion: Some("Check Typst entrypoint structure.".into()),
                }],
                warnings: Vec::new(),
                raw_log: format!("Typst Project Error: {err}"),
            };
        }
    };

    match typst_embed::render_pdf(&project, &env) {
        Ok(artifact) => CompileResponse {
            pdf_bytes: artifact.bytes().to_vec(),
            success: true,
            errors: Vec::new(),
            warnings: Vec::new(),
            raw_log: "Typst document compiled successfully in RAM VFS.".to_string(),
        },
        Err(err) => {
            let (errors, raw_log) = parse_typst_diagnostics(err, main_file);
            CompileResponse {
                pdf_bytes: Vec::new(),
                success: false,
                errors,
                warnings: Vec::new(),
                raw_log,
            }
        }
    }
}
