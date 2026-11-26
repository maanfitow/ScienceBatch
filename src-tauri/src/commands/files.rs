use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use tauri::command;

use crate::fs::project::{read_dir_recursive, validate_recent_paths as val_recent_paths};
use crate::types::FileItem;

/// Lexically normalizes `.` and `..` path components without touching the filesystem.
fn normalize_lexical(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("files.path_escapes_root: Path traverses above filesystem root.".to_string());
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

/// Resolves `target` and verifies it stays strictly contained within `project_root`.
///
/// Canonicalizes `project_root` (requiring an existing directory) and resolves `target` by
/// canonicalizing its nearest existing ancestor and re-attaching remaining normalized
/// components, blocking `..` and symlink escapes outside `project_root`.
pub(crate) fn resolve_contained_path(
    project_root: &str,
    target: &str,
) -> Result<(PathBuf, PathBuf), String> {
    if project_root.is_empty() || project_root.contains('\0') {
        return Err("files.invalid_path: Project root must be non-empty and cannot contain NUL bytes.".to_string());
    }
    if target.is_empty() || target.contains('\0') {
        return Err("files.invalid_path: Target path must be non-empty and cannot contain NUL bytes.".to_string());
    }

    let root_path = Path::new(project_root);
    let canonical_root = std::fs::canonicalize(root_path)
        .map_err(|e| format!("files.invalid_project_root: Invalid project root '{project_root}': {e}"))?;
    if !canonical_root.is_dir() {
        return Err(format!("files.invalid_project_root: Project root is not a directory: '{project_root}'"));
    }

    let raw_target = Path::new(target);
    let candidate = if raw_target.is_absolute() {
        raw_target.to_path_buf()
    } else {
        canonical_root.join(raw_target)
    };
    let normalized = normalize_lexical(&candidate)?;

    let mut probe = normalized;
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if probe.exists() || std::fs::symlink_metadata(&probe).is_ok() {
            let canonical_ancestor = std::fs::canonicalize(&probe)
                .map_err(|e| format!("files.path_resolve_failed: Failed to resolve path '{}': {e}", probe.display()))?;
            let mut resolved = canonical_ancestor;
            for part in tail.iter().rev() {
                resolved.push(part);
            }
            if !resolved.starts_with(&canonical_root) {
                return Err(format!("files.path_escapes_root: Path '{target}' escapes the project root."));
            }
            return Ok((canonical_root, resolved));
        }

        match (probe.file_name().map(|s| s.to_os_string()), probe.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                probe = parent.to_path_buf();
            }
            _ => {
                return Err(format!(
                    "files.path_no_ancestor: Path '{target}' has no existing ancestor inside the project root."
                ));
            }
        }
    }
}

fn copy_path_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(src)
        .map_err(|e| format!("files.io_failed: Failed to inspect '{}': {e}", src.display()))?;

    if meta.file_type().is_symlink() {
        let target_meta = std::fs::metadata(src)
            .map_err(|e| format!("files.io_failed: Failed to follow symlink '{}': {e}", src.display()))?;
        if target_meta.is_dir() {
            return Err(format!(
                "files.symlink_dir_unsupported: Cannot recursively duplicate symlinked directory '{}'.",
                src.display()
            ));
        }
    }

    if meta.is_dir() {
        std::fs::create_dir_all(dest)
            .map_err(|e| format!("files.io_failed: Failed to create directory '{}': {e}", dest.display()))?;
        let entries = std::fs::read_dir(src)
            .map_err(|e| format!("files.io_failed: Failed to read directory '{}': {e}", src.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|e| format!("files.io_failed: Failed to read entry in '{}': {e}", src.display()))?;
            copy_path_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "files.io_failed: Failed to create parent directory '{}': {e}",
                    parent.display()
                )
            })?;
        }
        std::fs::copy(src, dest).map_err(|e| {
            format!(
                "files.io_failed: Failed to copy '{}' to '{}': {e}",
                src.display(),
                dest.display()
            )
        })?;
    }
    Ok(())
}

#[command]
pub async fn list_project_files(dir_path: String) -> Result<Vec<FileItem>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&dir_path);
        if !path.exists() || !path.is_dir() {
            return Err(format!("files.dir_not_found: Directory does not exist: {dir_path}"));
        }
        read_dir_recursive(path).map_err(|e| format!("files.io_failed: {e}"))
    })
    .await
    .map_err(|e| format!("files.task_failed: {e}"))?
}

#[command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("files.io_failed: Failed to read file '{path}': {e}"))
}

#[command]
pub async fn existing_file_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut existing = Vec::new();
    for path in paths {
        if path.is_empty() || path.contains('\0') {
            return Err("files.invalid_path: File paths must be non-empty and cannot contain NUL bytes.".to_string());
        }
        match tokio::fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() => {
                tokio::fs::File::open(&path).await.map_err(|error| {
                    format!("files.io_failed: Could not check whether file '{path}' is readable: {error}")
                })?;
                existing.push(path);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "files.io_failed: Could not check whether file '{path}' exists: {error}"
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
        .map_err(|e| format!("files.io_failed: Failed to write file '{path}': {e}"))
}

#[command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("files.io_failed: Failed to read binary file '{path}': {e}"))
}

#[command]
pub async fn import_file_to_project(src_path: String, dest_dir: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    if !src.exists() || !src.is_file() {
        return Err(format!("files.file_not_found: Source file does not exist: {src_path}"));
    }
    let file_name = match src.file_name() {
        Some(name) => name,
        None => return Err("files.invalid_path: Invalid file name".into()),
    };
    let dest = Path::new(&dest_dir).join(file_name);

    tokio::fs::copy(&src, &dest)
        .await
        .map_err(|e| format!("files.io_failed: Failed to copy file '{src_path}' to '{dest:?}': {e}"))?;

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
            "files.invalid_project_name: Project name must be a single safe folder name of at most 100 characters.".into(),
        );
    }
    let normalized_engine = engine.to_ascii_lowercase();
    let is_typst = match normalized_engine.as_str() {
        "typst" => true,
        "latex" => false,
        _ => return Err("files.invalid_engine: Engine must be latex or typst.".into()),
    };
    let project_path = Path::new(&parent_dir).join(&project_name);
    tokio::fs::create_dir(&project_path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("files.project_exists: Project folder already exists: {}", project_path.display())
        } else {
            format!("files.io_failed: Failed to create project folder: {e}")
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
            .map_err(|error| format!("files.io_failed: Failed to create template assets folder: {error}"))?;
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
            .map_err(|error| format!("files.io_failed: Failed to encode project configuration: {error}"))?;
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
        .map_err(|error| format!("files.io_failed: Failed to create '{}': {error}", path.display()))?;
    file.write_all(bytes)
        .await
        .map_err(|error| format!("files.io_failed: Failed to write '{}': {error}", path.display()))?;
    file.flush()
        .await
        .map_err(|error| format!("files.io_failed: Failed to flush '{}': {error}", path.display()))
}

/// Creates a new empty file inside `project_root`, creating missing parent directories.
#[command]
pub async fn create_project_file(project_root: String, path: String) -> Result<(), String> {
    let (canonical_root, resolved) = resolve_contained_path(&project_root, &path)?;
    if resolved == canonical_root {
        return Err("files.cannot_modify_root: Cannot create a file at the project root path.".to_string());
    }
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            format!(
                "files.io_failed: Failed to create parent directories for '{}': {e}",
                resolved.display()
            )
        })?;
    }
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&resolved)
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("files.already_exists: File already exists: '{}'", resolved.display())
            } else {
                format!("files.io_failed: Failed to create file '{}': {e}", resolved.display())
            }
        })?;
    Ok(())
}

/// Creates a directory (and any missing parents) inside `project_root`.
#[command]
pub async fn create_project_directory(project_root: String, path: String) -> Result<(), String> {
    let (_, resolved) = resolve_contained_path(&project_root, &path)?;
    if let Ok(meta) = tokio::fs::symlink_metadata(&resolved).await {
        if !meta.is_dir() {
            return Err(format!(
                "files.file_exists_at_path: Cannot create directory '{}': a file already exists at that path.",
                resolved.display()
            ));
        }
    }
    tokio::fs::create_dir_all(&resolved)
        .await
        .map_err(|e| format!("files.io_failed: Failed to create directory '{}': {e}", resolved.display()))?;
    Ok(())
}

/// Renames or moves a file or directory within `project_root`.
#[command]
pub async fn rename_project_path(
    project_root: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let (canonical_root, resolved_old) = resolve_contained_path(&project_root, &old_path)?;
    let (_, resolved_new) = resolve_contained_path(&project_root, &new_path)?;
    if resolved_old == canonical_root || resolved_new == canonical_root {
        return Err("files.cannot_modify_root: Cannot rename or overwrite the project root directory.".to_string());
    }
    let old_meta = tokio::fs::symlink_metadata(&resolved_old)
        .await
        .map_err(|_| format!("files.not_found: Source path does not exist: '{}'", resolved_old.display()))?;
    if tokio::fs::symlink_metadata(&resolved_new).await.is_ok() {
        return Err(format!(
            "files.already_exists: Destination path already exists: '{}'",
            resolved_new.display()
        ));
    }
    if old_meta.is_dir() && resolved_new.starts_with(&resolved_old) {
        return Err("files.move_into_self: Cannot move a directory into a subdirectory of itself.".to_string());
    }
    if let Some(parent) = resolved_new.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            format!(
                "files.io_failed: Failed to create parent directory for '{}': {e}",
                resolved_new.display()
            )
        })?;
    }
    tokio::fs::rename(&resolved_old, &resolved_new)
        .await
        .map_err(|e| {
            format!(
                "files.io_failed: Failed to rename '{}' to '{}': {e}",
                resolved_old.display(),
                resolved_new.display()
            )
        })?;
    Ok(())
}

/// Moves a file or directory inside `project_root` to the OS trash.
#[command]
pub async fn delete_project_path(project_root: String, path: String) -> Result<(), String> {
    let (canonical_root, resolved) = resolve_contained_path(&project_root, &path)?;
    if resolved == canonical_root {
        return Err("files.cannot_delete_root: Cannot delete the project root directory.".to_string());
    }
    if tokio::fs::symlink_metadata(&resolved).await.is_err() {
        return Err(format!("files.not_found: Path does not exist: '{}'", resolved.display()));
    }
    tokio::task::spawn_blocking(move || {
        trash::delete(&resolved)
            .map_err(|e| format!("files.trash_failed: Failed to move '{}' to trash: {e}", resolved.display()))
    })
    .await
    .map_err(|e| format!("files.task_failed: Trash task failed: {e}"))?
}

/// Duplicates a file or directory recursively within `project_root`.
#[command]
pub async fn duplicate_project_path(
    project_root: String,
    src_path: String,
    dest_path: String,
) -> Result<(), String> {
    let (canonical_root, resolved_src) = resolve_contained_path(&project_root, &src_path)?;
    let (_, resolved_dest) = resolve_contained_path(&project_root, &dest_path)?;
    if resolved_src == canonical_root || resolved_dest == canonical_root {
        return Err("files.cannot_modify_root: Cannot duplicate or overwrite the project root directory.".to_string());
    }
    let src_meta = tokio::fs::symlink_metadata(&resolved_src)
        .await
        .map_err(|_| format!("files.not_found: Source path does not exist: '{}'", resolved_src.display()))?;
    if tokio::fs::symlink_metadata(&resolved_dest).await.is_ok() {
        return Err(format!(
            "files.already_exists: Destination path already exists: '{}'",
            resolved_dest.display()
        ));
    }
    if src_meta.is_dir() && resolved_dest.starts_with(&resolved_src) {
        return Err("files.copy_into_self: Cannot duplicate a directory into a subdirectory of itself.".to_string());
    }
    tokio::task::spawn_blocking(move || copy_path_recursive(&resolved_src, &resolved_dest))
        .await
        .map_err(|e| format!("files.task_failed: Duplicate task failed: {e}"))?
}

#[cfg(target_os = "linux")]
fn encode_file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut encoded = String::from("file://");
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Reveals and selects a file or directory in the operating system's file manager.
#[command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') {
        return Err("files.invalid_path: Path must be non-empty and cannot contain NUL bytes.".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let target = Path::new(&path);
        if !target.exists() {
            return Err(format!("files.not_found: Path does not exist: '{path}'"));
        }
        let canonical = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
        let path_str = canonical.to_string_lossy().to_string();

        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(format!("/select,{path_str}"))
                .spawn()
                .map_err(|e| format!("files.reveal_failed: Failed to reveal '{path_str}' in Explorer: {e}"))?;
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(["-R", &path_str])
                .spawn()
                .map_err(|e| format!("files.reveal_failed: Failed to reveal '{path_str}' in Finder: {e}"))?;
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        {
            let file_uri = encode_file_uri(&canonical);
            let dbus_spawn = std::process::Command::new("dbus-send")
                .args([
                    "--session",
                    "--dest=org.freedesktop.FileManager1",
                    "--type=method_call",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("array:string:{file_uri}"),
                    "string:",
                ])
                .spawn();

            if dbus_spawn.is_ok() {
                return Ok(());
            }

            let fallback_target = if canonical.is_dir() {
                canonical.as_path()
            } else {
                canonical.parent().unwrap_or(canonical.as_path())
            };
            open::that_detached(fallback_target)
                .map_err(|e| format!("files.reveal_failed: Failed to open file manager for '{path_str}': {e}"))?;
            return Ok(());
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let fallback_target = if canonical.is_dir() {
                canonical.as_path()
            } else {
                canonical.parent().unwrap_or(canonical.as_path())
            };
            open::that_detached(fallback_target)
                .map_err(|e| format!("files.reveal_failed: Failed to open file manager for '{path_str}': {e}"))?;
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("files.task_failed: Reveal task failed: {e}"))?
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
            .map_err(|err| format!("files.open_url_failed: Failed to launch system browser: {err}"))?;
        Ok(())
    } else {
        Err(format!("files.unsafe_url: Unsupported or unsafe URL protocol: {trimmed}"))
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
    use super::{
        create_project_directory, create_project_file, create_project_folder, delete_project_path,
        duplicate_project_path, rename_project_path, resolve_contained_path,
    };

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

    #[test]
    fn resolve_contained_path_allows_nested_and_blocks_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let project_dir = dir.path().join("project");
        let outside_dir = dir.path().join("outside");
        std::fs::create_dir(&project_dir).unwrap();
        std::fs::create_dir(&outside_dir).unwrap();

        let root_str = project_dir.to_string_lossy().into_owned();
        let canonical_root = std::fs::canonicalize(&project_dir).unwrap();

        let (resolved_root, resolved_nested) =
            resolve_contained_path(&root_str, "chapters/intro.tex").unwrap();
        assert_eq!(resolved_root, canonical_root);
        assert_eq!(resolved_nested, canonical_root.join("chapters/intro.tex"));

        let abs_target = project_dir.join("figures/diagram.pdf");
        let (_, resolved_abs) =
            resolve_contained_path(&root_str, &abs_target.to_string_lossy()).unwrap();
        assert_eq!(resolved_abs, canonical_root.join("figures/diagram.pdf"));

        for invalid in [
            "",
            "bad\0path",
            "../outside/secret.tex",
            "chapters/../../outside/secret.tex",
        ] {
            assert!(
                resolve_contained_path(&root_str, invalid).is_err(),
                "Expected containment failure for {invalid:?}"
            );
        }

        let outside_abs = outside_dir.join("secret.tex");
        assert!(resolve_contained_path(&root_str, &outside_abs.to_string_lossy()).is_err());

        #[cfg(unix)]
        {
            let link_path = project_dir.join("escape_link");
            std::os::unix::fs::symlink(&outside_dir, &link_path).unwrap();
            assert!(resolve_contained_path(&root_str, "escape_link/secret.tex").is_err());
        }
    }

    #[tokio::test]
    async fn create_project_file_creates_nested_and_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_string_lossy().into_owned();
        let nested_file = dir.path().join("sections/ch1/intro.tex");

        create_project_file(root_str.clone(), nested_file.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(nested_file.is_file());
        assert_eq!(std::fs::read(&nested_file).unwrap(), b"");

        std::fs::write(&nested_file, b"original content").unwrap();
        let err = create_project_file(root_str.clone(), "sections/ch1/intro.tex".into())
            .await
            .unwrap_err();
        assert!(err.contains("already exists"));
        assert_eq!(std::fs::read(&nested_file).unwrap(), b"original content");

        assert!(create_project_file(root_str, "../escape.tex".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn create_project_directory_creates_recursively_and_rejects_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_string_lossy().into_owned();
        let nested_dir = dir.path().join("assets/images/raw");

        create_project_directory(root_str.clone(), nested_dir.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(nested_dir.is_dir());

        let existing_file = dir.path().join("notes.txt");
        std::fs::write(&existing_file, b"text").unwrap();
        let err = create_project_directory(root_str, "notes.txt".into())
            .await
            .unwrap_err();
        assert!(err.contains("file already exists"));
    }

    #[tokio::test]
    async fn rename_project_path_moves_and_guards_conflicts_and_root() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_string_lossy().into_owned();
        let src = dir.path().join("draft.tex");
        let moved = dir.path().join("archive/final.tex");
        std::fs::write(&src, b"hello").unwrap();

        rename_project_path(
            root_str.clone(),
            src.to_string_lossy().into_owned(),
            moved.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read(&moved).unwrap(), b"hello");

        let other = dir.path().join("other.tex");
        std::fs::write(&other, b"other").unwrap();
        assert!(rename_project_path(
            root_str.clone(),
            moved.to_string_lossy().into_owned(),
            other.to_string_lossy().into_owned(),
        )
        .await
        .is_err());

        assert!(
            rename_project_path(root_str.clone(), ".".into(), "renamed_root".into())
                .await
                .is_err()
        );
        assert!(delete_project_path(root_str, ".".into()).await.is_err());
    }

    #[tokio::test]
    async fn duplicate_project_path_copies_files_and_directories_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_string_lossy().into_owned();

        let src_file = dir.path().join("main.tex");
        let dest_file = dir.path().join("main_copy.tex");
        std::fs::write(&src_file, b"\\section{One}").unwrap();

        duplicate_project_path(
            root_str.clone(),
            src_file.to_string_lossy().into_owned(),
            dest_file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest_file).unwrap(), b"\\section{One}");

        let src_dir = dir.path().join("chapters");
        std::fs::create_dir_all(src_dir.join("sub")).unwrap();
        std::fs::write(src_dir.join("a.tex"), b"A").unwrap();
        std::fs::write(src_dir.join("sub/b.tex"), b"B").unwrap();

        let dest_dir = dir.path().join("chapters_copy");
        duplicate_project_path(
            root_str.clone(),
            src_dir.to_string_lossy().into_owned(),
            dest_dir.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(dest_dir.join("a.tex")).unwrap(), b"A");
        assert_eq!(std::fs::read(dest_dir.join("sub/b.tex")).unwrap(), b"B");

        // Cannot duplicate a directory into a subdirectory of itself
        assert!(duplicate_project_path(
            root_str,
            src_dir.to_string_lossy().into_owned(),
            src_dir.join("nested_copy").to_string_lossy().into_owned(),
        )
        .await
        .is_err());
    }
}
