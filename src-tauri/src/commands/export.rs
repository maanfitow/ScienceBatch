use tauri::command;

use crate::exporters::markdown::{latex_to_markdown_with_dir, typst_to_markdown_with_dir};
use crate::exporters::html::{latex_to_html_with_dir, typst_to_html_with_dir};
use crate::fs::archive::{
    export_project_to_zip as fs_export_zip,
    import_project_from_zip as fs_import_zip,
};

#[command]
pub async fn export_project_to_zip(
    dest_path: String,
    project_dir: Option<String>,
    source_content: Option<String>,
    engine: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        fs_export_zip(
            &dest_path,
            project_dir.as_deref(),
            source_content.as_deref(),
            engine.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn import_project_from_zip(
    zip_path: String,
    parent_dir: String,
    project_name: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        fs_import_zip(&zip_path, &parent_dir, project_name.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn export_document_to_markdown(
    path: String,
    source: String,
    engine: String,
    project_dir: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p_dir = project_dir.as_deref().map(std::path::Path::new);
        let md = if engine == "typst" {
            typst_to_markdown_with_dir(&source, p_dir)
        } else {
            latex_to_markdown_with_dir(&source, p_dir)
        };
        std::fs::write(&path, &md)
            .map_err(|e| format!("Failed to save Markdown to '{path}': {e}"))?;

        if let Some(src_dir) = p_dir {
            let dest_path = std::path::Path::new(&path);
            if let Some(dest_dir) = dest_path.parent() {
                if dest_dir != src_dir {
                    let image_paths = crate::exporters::markdown::extract_markdown_image_paths(&md);
                    for rel_img in image_paths {
                        let mut src_img_file = src_dir.join(&rel_img);
                        if !src_img_file.exists() {
                            for ext in &["jpg", "jpeg", "png", "svg", "webp", "gif"] {
                                let cand = src_dir.join(format!("{rel_img}.{ext}"));
                                if cand.exists() && cand.is_file() {
                                    src_img_file = cand;
                                    break;
                                }
                            }
                        }
                        if src_img_file.exists() && src_img_file.is_file() {
                            let dest_img_name = if std::path::Path::new(&rel_img).extension().is_none() {
                                if let Some(ext) = src_img_file.extension() {
                                    format!("{}.{}", rel_img, ext.to_string_lossy())
                                } else {
                                    rel_img.clone()
                                }
                            } else {
                                rel_img.clone()
                            };
                            let dest_img_file = dest_dir.join(&dest_img_name);
                            if let Some(parent) = dest_img_file.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            let _ = std::fs::copy(&src_img_file, &dest_img_file);
                        }
                    }
                }
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn export_document_to_html(
    path: String,
    source: String,
    engine: String,
    title: Option<String>,
    project_dir: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let doc_title = title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "ScienceBatch Document".to_string());
        let p_dir = project_dir.as_deref().map(std::path::Path::new);
        let html = if engine == "typst" {
            typst_to_html_with_dir(&source, &doc_title, p_dir)
        } else {
            latex_to_html_with_dir(&source, &doc_title, p_dir)
        };
        std::fs::write(&path, html)
            .map_err(|e| format!("Failed to save HTML to '{path}': {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
