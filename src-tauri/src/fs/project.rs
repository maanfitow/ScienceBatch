use std::path::Path;
use crate::types::FileItem;

pub fn read_dir_recursive(dir: &Path) -> Result<Vec<FileItem>, std::io::Error> {
    let mut items = Vec::new();
    let entries = std::fs::read_dir(dir)?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') && name != ".sciencebatch.json" {
            continue;
        }

        let is_dir = path.is_dir();
        let children = if is_dir {
            read_dir_recursive(&path).ok()
        } else {
            None
        };

        items.push(FileItem {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }

    items.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(items)
}

pub fn validate_recent_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            let path = Path::new(p);
            path.exists() && path.is_dir()
        })
        .collect()
}
