use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use crate::types::FileItem;
use super::project::read_dir_recursive;

pub fn export_project_to_zip(
    dest_path: &str,
    project_dir: Option<&str>,
    source_content: Option<&str>,
    engine: Option<&str>,
) -> Result<(), String> {
    let dest_file_path = Path::new(dest_path);
    if let Some(parent) = dest_file_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create destination folder: {e}"))?;
        }
    }

    let file = std::fs::File::create(&dest_file_path)
        .map_err(|e| format!("Failed to create destination ZIP file: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    if let Some(dir_str) = project_dir {
        let dir_path = Path::new(dir_str);
        if dir_path.exists() && dir_path.is_dir() {
            let canonical_dest = dest_file_path.canonicalize().ok();

            fn add_dir_to_zip<W: std::io::Write + std::io::Seek>(
                zip: &mut zip::ZipWriter<W>,
                base_dir: &Path,
                current_dir: &Path,
                canonical_dest: Option<&std::path::PathBuf>,
                options: SimpleFileOptions,
            ) -> Result<(), String> {
                let read_dir = std::fs::read_dir(current_dir)
                    .map_err(|e| format!("Failed to read directory {:?}: {e}", current_dir))?;

                for entry in read_dir.flatten() {
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();

                    // Skip hidden files, system files, and .sciencebatch.json metadata to protect sensitive project details
                    if name.starts_with('.') || name == ".sciencebatch.json" {
                        continue;
                    }

                    if let Some(dest_canon) = canonical_dest {
                        if let Ok(path_canon) = path.canonicalize() {
                            if path_canon == *dest_canon {
                                continue;
                            }
                        }
                    }

                    let rel_path = path
                        .strip_prefix(base_dir)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/");

                    if path.is_dir() {
                        zip.add_directory(&rel_path, options)
                            .map_err(|e| format!("Failed to add directory '{rel_path}' to zip: {e}"))?;
                        add_dir_to_zip(zip, base_dir, &path, canonical_dest, options)?;
                    } else if path.is_file() {
                        zip.start_file(&rel_path, options)
                            .map_err(|e| format!("Failed to add file '{rel_path}' to zip: {e}"))?;
                        let data = std::fs::read(&path)
                            .map_err(|e| format!("Failed to read file {:?}: {e}", path))?;
                        zip.write_all(&data)
                            .map_err(|e| format!("Failed to write '{rel_path}' to zip: {e}"))?;
                    }
                }
                Ok(())
            }

            add_dir_to_zip(&mut zip, dir_path, dir_path, canonical_dest.as_ref(), options)?;
            zip.finish()
                .map_err(|e| format!("Failed to finalize ZIP archive: {e}"))?;
            return Ok(());
        }
    }

    // Single document / scratchpad mode fallback
    let eng = engine.unwrap_or("latex");
    let main_filename = if eng == "typst" { "main.typ" } else { "main.tex" };
    let content = source_content.unwrap_or_default();

    zip.start_file(main_filename, options)
        .map_err(|e| format!("Failed to add '{main_filename}' to zip: {e}"))?;
    zip.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write '{main_filename}' to zip: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Failed to finalize ZIP archive: {e}"))?;
    Ok(())
}

pub fn import_project_from_zip(
    zip_path: &str,
    parent_dir: &str,
    project_name: Option<&str>,
) -> Result<String, String> {
    let zip_file_path = Path::new(zip_path);
    if !zip_file_path.exists() || !zip_file_path.is_file() {
        return Err(format!("ZIP archive does not exist: {zip_path}"));
    }

    let parent_dir_path = Path::new(parent_dir);
    if !parent_dir_path.exists() || !parent_dir_path.is_dir() {
        return Err(format!("Target directory does not exist: {parent_dir}"));
    }

    let folder_name = match project_name.filter(|s| !s.trim().is_empty()) {
        Some(name) => name.trim().to_string(),
        None => zip_file_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "ImportedProject".to_string()),
    };

    let dest_dir = parent_dir_path.join(&folder_name);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create project folder '{:?}': {e}", dest_dir))?;

    let file = std::fs::File::open(&zip_file_path)
        .map_err(|e| format!("Failed to open ZIP archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive: {e}"))?;

    // Extract all entries safely (protecting against zip-slip directory traversal)
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry #{i}: {e}"))?;

        let enclosed_name = match entry.enclosed_name() {
            Some(name) => name.to_owned(),
            None => continue, // Skip suspicious path traversal entries
        };

        let outpath = dest_dir.join(&enclosed_name);

        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory '{:?}': {e}", outpath))?;
        } else {
            if let Some(parent) = outpath.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent directory '{:?}': {e}", parent))?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file '{:?}': {e}", outpath))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Failed to write extracted file '{:?}': {e}", outpath))?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode));
            }
        }
    }

    // Auto-detect engine and main file
    let mut detected_engine = "latex";
    let mut detected_main = "main.tex".to_string();

    let files = read_dir_recursive(&dest_dir).unwrap_or_default();
    let has_main_typ = dest_dir.join("main.typ").exists();
    let has_main_tex = dest_dir.join("main.tex").exists();

    if has_main_typ && !has_main_tex {
        detected_engine = "typst";
        detected_main = "main.typ".to_string();
    } else if has_main_tex {
        detected_engine = "latex";
        detected_main = "main.tex".to_string();
    } else {
        fn find_first_by_ext(items: &[FileItem], ext: &str) -> Option<String> {
            for it in items {
                if !it.is_dir && it.name.ends_with(ext) {
                    return Some(it.name.clone());
                }
                if let Some(ref children) = it.children {
                    if let Some(found) = find_first_by_ext(children, ext) {
                        return Some(found);
                    }
                }
            }
            None
        }

        if let Some(first_tex) = find_first_by_ext(&files, ".tex") {
            detected_engine = "latex";
            detected_main = first_tex;
        } else if let Some(first_typ) = find_first_by_ext(&files, ".typ") {
            detected_engine = "typst";
            detected_main = first_typ;
        }
    }

    // Create .sciencebatch.json if not already present in ZIP
    let config_path = dest_dir.join(".sciencebatch.json");
    if !config_path.exists() {
        let config_json = serde_json::json!({
            "name": folder_name,
            "engine": detected_engine,
            "mainFile": detected_main,
            "importedFrom": zip_path,
            "createdAt": format!("{:?}", std::time::SystemTime::now())
        });
        let _ = std::fs::write(&config_path, serde_json::to_string_pretty(&config_json).unwrap_or_default());
    }

    Ok(dest_dir.to_string_lossy().to_string())
}
