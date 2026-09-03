use std::path::Path;
use tauri::command;

use crate::types::FileItem;
use crate::fs::project::{read_dir_recursive, validate_recent_paths as val_recent_paths};

#[command]
pub async fn list_project_files(dir_path: String) -> Result<Vec<FileItem>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&dir_path);
        if !path.exists() || !path.is_dir() {
            return Err(format!("Directory does not exist: {dir_path}"));
        }
        read_dir_recursive(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file '{path}': {e}"))
}

#[command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("Failed to write file '{path}': {e}"))
}

#[command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read binary file '{path}': {e}"))
}

#[command]
pub async fn import_file_to_project(src_path: String, dest_dir: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    if !src.exists() || !src.is_file() {
        return Err(format!("Source file does not exist: {src_path}"));
    }
    let file_name = match src.file_name() {
        Some(name) => name,
        None => return Err("Invalid file name".into()),
    };
    let dest = Path::new(&dest_dir).join(file_name);

    tokio::fs::copy(&src, &dest)
        .await
        .map_err(|e| format!("Failed to copy file '{src_path}' to '{dest:?}': {e}"))?;

    Ok(dest.to_string_lossy().to_string())
}

#[command]
pub async fn create_project_folder(
    parent_dir: String,
    project_name: String,
    engine: String,
    template_content: String,
) -> Result<String, String> {
    let project_path = Path::new(&parent_dir).join(&project_name);
    tokio::fs::create_dir_all(&project_path)
        .await
        .map_err(|e| format!("Failed to create project folder: {e}"))?;

    let is_typst = engine.to_lowercase() == "typst";
    let main_filename = if is_typst { "main.typ" } else { "main.tex" };
    let main_file_path = project_path.join(main_filename);

    tokio::fs::write(&main_file_path, &template_content)
        .await
        .map_err(|e| format!("Failed to create initial main file: {e}"))?;

    // Create starter references.bib
    let bib_path = project_path.join("references.bib");
    let _ = tokio::fs::write(&bib_path, crate::compiler::embedded::SAMPLE_BIB).await;

    // Create starter assets directory with sample.png and sample.gif
    let assets_dir = project_path.join("assets");
    if tokio::fs::create_dir_all(&assets_dir).await.is_ok() {
        let _ = tokio::fs::write(assets_dir.join("sample.png"), crate::compiler::embedded::SAMPLE_PNG).await;
        let _ = tokio::fs::write(assets_dir.join("sample.gif"), crate::compiler::embedded::SAMPLE_GIF).await;
    }

    // Create .sciencebatch.json project configuration
    let config_json = serde_json::json!({
        "name": project_name,
        "engine": if is_typst { "typst" } else { "latex" },
        "mainFile": main_filename,
        "createdAt": format!("{:?}", std::time::SystemTime::now())
    });

    let config_path = project_path.join(".sciencebatch.json");
    let _ = tokio::fs::write(&config_path, serde_json::to_string_pretty(&config_json).unwrap_or_default()).await;

    Ok(project_path.to_string_lossy().to_string())
}

#[command]
pub fn validate_recent_paths(paths: Vec<String>) -> Vec<String> {
    val_recent_paths(paths)
}

/// Opens an external web URL or email link safely in the user's default system browser
#[command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("mailto:") {
        open::that_detached(trimmed).map_err(|err| format!("Failed to launch system browser: {err}"))?;
        Ok(())
    } else {
        Err(format!("Unsupported or unsafe URL protocol: {trimmed}"))
    }
}

/// Programmatically resets webview zoom factor to 1.0 and neutralizes pinch zoom gestures on Linux
#[command]
pub fn reset_webview_zoom(window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.set_zoom(1.0);
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::WebViewExt;
        use glib::prelude::ObjectExt;
        use glib::ObjectType;
        let _ = window.with_webview(|wv| {
            let webview = wv.inner();
            webview.set_zoom_level(1.0);
            webview.connect_zoom_level_notify(|wv| {
                if (wv.zoom_level() - 1.0).abs() > 0.001 {
                    wv.set_zoom_level(1.0);
                }
            });
            unsafe {
                if let Some(gesture) = webview.data::<glib::gobject_ffi::GObject>("wk-view-zoom-gesture") {
                    glib::gobject_ffi::g_signal_handlers_block_matched(
                        gesture.as_ptr().cast(),
                        glib::gobject_ffi::G_SIGNAL_MATCH_DATA,
                        0,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        webview.as_ptr().cast(),
                    );
                    glib::gobject_ffi::g_signal_handlers_destroy(gesture.as_ptr().cast());
                }
            }
        });
    }
    Ok(())
}

