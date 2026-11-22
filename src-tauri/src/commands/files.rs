use std::path::Path;
use tauri::command;

use crate::fs::project::{read_dir_recursive, validate_recent_paths as val_recent_paths};
use crate::types::FileItem;

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
pub async fn existing_file_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut existing = Vec::new();
    for path in paths {
        if path.is_empty() || path.contains('\0') {
            return Err("File paths must be non-empty and cannot contain NUL bytes.".to_string());
        }
        match tokio::fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() => {
                tokio::fs::File::open(&path).await.map_err(|error| {
                    format!("Could not check whether file '{path}' is readable: {error}")
                })?;
                existing.push(path);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not check whether file '{path}' exists: {error}"
                ))
            }
        }
    }
    Ok(existing)
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
    let trimmed_name = project_name.trim();
    if trimmed_name.is_empty()
        || trimmed_name.len() > 100
        || trimmed_name == "."
        || trimmed_name == ".."
        || trimmed_name
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '\0') || character.is_control())
    {
        return Err(
            "Project name must be a single safe folder name of at most 100 characters.".into(),
        );
    }
    let normalized_engine = engine.to_ascii_lowercase();
    let is_typst = match normalized_engine.as_str() {
        "typst" => true,
        "latex" => false,
        _ => return Err("Engine must be latex or typst.".into()),
    };
    let project_path = Path::new(&parent_dir).join(&project_name);
    tokio::fs::create_dir(&project_path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("Project folder already exists: {}", project_path.display())
        } else {
            format!("Failed to create project folder: {e}")
        }
    })?;

    let main_filename = if is_typst { "main.typ" } else { "main.tex" };
    let main_file_path = project_path.join(main_filename);
    let creation = async {
        create_new_file(&main_file_path, template_content.as_bytes()).await?;

        // Example files are materialized only in newly created template projects.
        create_new_file(
            &project_path.join("references.bib"),
            crate::compiler::embedded::SAMPLE_BIB,
        )
        .await?;
        let assets_dir = project_path.join("assets");
        tokio::fs::create_dir(&assets_dir)
            .await
            .map_err(|error| format!("Failed to create template assets folder: {error}"))?;
        create_new_file(
            &assets_dir.join("sample.png"),
            crate::compiler::embedded::SAMPLE_PNG,
        )
        .await?;
        create_new_file(
            &assets_dir.join("sample.gif"),
            crate::compiler::embedded::SAMPLE_GIF,
        )
        .await?;

        let config_json = serde_json::json!({
            "name": project_name,
            "engine": if is_typst { "typst" } else { "latex" },
            "mainFile": main_filename,
            "createdAt": format!("{:?}", std::time::SystemTime::now())
        });
        let config_bytes = serde_json::to_vec_pretty(&config_json)
            .map_err(|error| format!("Failed to encode project configuration: {error}"))?;
        create_new_file(&project_path.join(".sciencebatch.json"), &config_bytes).await?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = creation {
        let _ = tokio::fs::remove_dir_all(&project_path).await;
        return Err(error);
    }
    Ok(project_path.to_string_lossy().to_string())
}

async fn create_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| format!("Failed to create '{}': {error}", path.display()))?;
    file.write_all(bytes)
        .await
        .map_err(|error| format!("Failed to write '{}': {error}", path.display()))?;
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush '{}': {error}", path.display()))
}

#[command]
pub fn validate_recent_paths(paths: Vec<String>) -> Vec<String> {
    val_recent_paths(paths)
}

/// Opens an external web URL or email link safely in the user's default system browser
#[command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("mailto:")
    {
        open::that_detached(trimmed)
            .map_err(|err| format!("Failed to launch system browser: {err}"))?;
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
        use glib::prelude::ObjectExt;
        use glib::ObjectType;
        use webkit2gtk::WebViewExt;
        let _ = window.with_webview(|wv| {
            let webview = wv.inner();
            webview.set_zoom_level(1.0);
            webview.connect_zoom_level_notify(|wv| {
                if (wv.zoom_level() - 1.0).abs() > 0.001 {
                    wv.set_zoom_level(1.0);
                }
            });
            unsafe {
                if let Some(gesture) =
                    webview.data::<glib::gobject_ffi::GObject>("wk-view-zoom-gesture")
                {
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

#[cfg(test)]
mod tests {
    use super::create_project_folder;

    #[tokio::test]
    async fn project_folder_creation_is_new_only_and_materializes_template_examples() {
        let parent = tempfile::tempdir().unwrap();
        let parent_path = parent.path().to_string_lossy().into_owned();
        let created = create_project_folder(
            parent_path.clone(),
            "New Draft".into(),
            "latex".into(),
            "\\documentclass{article}\\begin{document}Hello\\end{document}".into(),
        )
        .await
        .unwrap();
        let root = std::path::Path::new(&created);
        assert!(root.join("main.tex").is_file());
        assert!(root.join("references.bib").is_file());
        assert!(root.join("assets/sample.png").is_file());
        assert!(root.join("assets/sample.gif").is_file());

        let existing = parent.path().join("Existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("keep.txt"), "keep me").unwrap();
        let result = create_project_folder(
            parent_path,
            "Existing".into(),
            "typst".into(),
            "#let x = 1".into(),
        )
        .await;
        assert!(result.unwrap_err().contains("already exists"));
        assert_eq!(
            std::fs::read(existing.join("keep.txt")).unwrap(),
            b"keep me"
        );
        assert!(!existing.join("main.typ").exists());
    }

    #[tokio::test]
    async fn project_folder_rejects_unsafe_names_and_unknown_engines() {
        let parent = tempfile::tempdir().unwrap();
        let parent_path = parent.path().to_string_lossy().into_owned();
        for name in ["", "..", "nested/name", "nested\\name"] {
            assert!(create_project_folder(
                parent_path.clone(),
                name.into(),
                "latex".into(),
                "".into(),
            )
            .await
            .is_err());
        }
        assert!(
            create_project_folder(parent_path, "New".into(), "unknown".into(), "".into(),)
                .await
                .is_err()
        );
    }
}
