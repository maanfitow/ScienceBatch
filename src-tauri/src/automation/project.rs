use super::{
    as_error, check_allowed_root, AutomationError, OperationContext, ProjectSnapshot,
    PublicDiagnostic, SnapshotFile, SnapshotFileKind, MAX_ASSET_BYTES, MAX_DEPTH, MAX_ENTRIES,
    MAX_SNAPSHOT_BYTES, MAX_TEXT_BYTES,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "eps", "ps", "otf", "ttf", "woff", "woff2",
    "zip", "gz", "mp4", "mp3", "bin", "dat",
];
const SOURCE_EXTENSIONS: &[&str] = &["tex", "typ"];
const SKIP_DIRS: &[&str] = &[".git", "target", "node_modules"];

#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub engine: Option<String>,
    pub main_file: Option<String>,
    pub engines_found: Vec<String>,
    pub main_candidates: Vec<String>,
    pub files: Vec<Value>,
}

#[derive(Default, DeserializeProject)]
struct Metadata {
    engine: Option<String>,
    #[serde(rename = "mainFile")]
    main_file: Option<String>,
}

use serde::Deserialize as DeserializeProject;

pub fn normalize_project_path(path: &str) -> Result<String, AutomationError> {
    if path.trim().is_empty() || Path::new(path).is_absolute() || path.starts_with('\\') {
        return Err(as_error(
            "path.outside_project",
            "Project paths must be relative.",
            2,
        ));
    }
    if path.contains('\0') || path.as_bytes().get(1) == Some(&b':') {
        return Err(as_error(
            "path.outside_project",
            "Project paths cannot contain a drive or NUL prefix.",
            2,
        ));
    }
    let normalized_input = path.replace('\\', "/");
    let mut parts = Vec::<&str>::new();
    for part in normalized_input.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(as_error(
                        "path.outside_project",
                        "The path escapes the project root.",
                        2,
                    ));
                }
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(as_error(
            "path.outside_project",
            "The path must identify a project file.",
            2,
        ));
    }
    Ok(parts.join("/"))
}

fn canonical_root(path: &Path) -> Result<PathBuf, AutomationError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut checked = PathBuf::new();
    for component in absolute.components() {
        checked.push(component.as_os_str());
        if checked.exists() {
            let ancestor = fs::symlink_metadata(&checked)
                .map_err(|e| AutomationError::new("io.project_unavailable", e.to_string(), 3))?;
            if ancestor.file_type().is_symlink() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Project paths cannot pass through symbolic links.",
                    2,
                ));
            }
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot inspect project root: {e}"),
            3,
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Project root must be a real directory, not a symbolic link or special file.",
            2,
        ));
    }
    fs::canonicalize(path).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot resolve project root: {e}"),
            3,
        )
    })
}

fn classify(path: &str) -> SnapshotFileKind {
    let extension = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ASSET_EXTENSIONS.contains(&extension.as_str()) {
        SnapshotFileKind::Asset
    } else {
        SnapshotFileKind::Text
    }
}

fn check_file_size(size: u64, kind: &SnapshotFileKind, path: &str) -> Result<(), AutomationError> {
    let limit = match kind {
        SnapshotFileKind::Text => MAX_TEXT_BYTES,
        SnapshotFileKind::Asset => MAX_ASSET_BYTES,
    };
    if size > limit as u64 {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            format!("Project file '{path}' exceeds the per-file limit."),
            3,
        ));
    }
    Ok(())
}

fn capture_walk(
    root: &Path,
    current: &Path,
    depth: usize,
    files: &mut BTreeMap<String, SnapshotFile>,
    total: &mut usize,
    entry_count: &mut usize,
    inventory: &mut Vec<Value>,
) -> Result<(), AutomationError> {
    if depth > MAX_DEPTH {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Project traversal exceeds the maximum depth.",
            3,
        ));
    }
    let entries = fs::read_dir(current).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot enumerate project directory: {e}"),
            3,
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            AutomationError::new(
                "io.project_unavailable",
                format!("Cannot read project entry: {e}"),
                3,
            )
        })?;
        let name = entry.file_name().into_string().map_err(|_| {
            AutomationError::new(
                "io.project_unavailable",
                "Project contains a filename that is not valid UTF-8.",
                3,
            )
        })?;
        if current == root && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if current == root && name == ".sciencebatch.json" {
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| {
            AutomationError::new(
                "io.project_unavailable",
                format!("Cannot inspect project entry: {e}"),
                3,
            )
        })?;
        *entry_count += 1;
        if *entry_count > MAX_ENTRIES {
            return Err(AutomationError::new(
                "resource.limit_exceeded",
                "Project contains more than 10,000 entries.",
                3,
            ));
        }
        if metadata.file_type().is_symlink() {
            return Err(AutomationError::new(
                "path.symlink_rejected",
                format!("Project input '{name}' is a symbolic link."),
                2,
            ));
        }
        if metadata.is_dir() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            inventory
                .push(json!({"path":relative,"kind":"directory","sizeBytes":null,"engines":[]}));
            capture_walk(root, &path, depth + 1, files, total, entry_count, inventory)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(AutomationError::new(
                "path.symlink_rejected",
                format!("Project entry '{name}' is not a regular file or directory."),
                2,
            ));
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let normalized = normalize_project_path(&relative)?;
        let kind = classify(&normalized);
        check_file_size(metadata.len(), &kind, &normalized)?;
        let file = fs::File::open(&path).map_err(|e| {
            AutomationError::new(
                "io.project_unavailable",
                format!("Cannot read '{normalized}': {e}"),
                3,
            )
        })?;
        let mut bytes = Vec::with_capacity(
            metadata
                .len()
                .min((MAX_ASSET_BYTES.max(MAX_TEXT_BYTES)) as u64) as usize,
        );
        file.take((MAX_ASSET_BYTES.max(MAX_TEXT_BYTES) + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| {
                AutomationError::new(
                    "io.project_unavailable",
                    format!("Cannot read '{normalized}': {e}"),
                    3,
                )
            })?;
        check_file_size(bytes.len() as u64, &kind, &normalized)?;
        if matches!(kind, SnapshotFileKind::Text) && std::str::from_utf8(&bytes).is_err() {
            return Err(AutomationError::new(
                "io.project_unavailable",
                format!("Text file '{normalized}' is not UTF-8."),
                3,
            ));
        }
        *total = total.checked_add(bytes.len()).ok_or_else(|| {
            AutomationError::new("resource.limit_exceeded", "Snapshot size overflow.", 3)
        })?;
        if *total > MAX_SNAPSHOT_BYTES {
            return Err(AutomationError::new(
                "resource.limit_exceeded",
                "Project snapshot exceeds 128 MiB.",
                3,
            ));
        }
        files.insert(normalized, SnapshotFile { bytes, kind });
        inventory.push(json!({"path":relative,"kind":"file","fileType":if matches!(files[&relative].kind,SnapshotFileKind::Text){"text"}else{"asset"},"sizeBytes":files[&relative].bytes.len(),"engines":engine_associations(&relative)}));
    }
    Ok(())
}

pub fn capture_snapshot(
    project: &Path,
    main_file: &str,
    overlays: &BTreeMap<String, Vec<u8>>,
) -> Result<ProjectSnapshot, AutomationError> {
    let root = canonical_root(project)?;
    let main_file = normalize_project_path(main_file)?;
    let engine = match Path::new(&main_file)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "tex" => "latex",
        "typ" => "typst",
        _ => {
            return Err(as_error(
                "engine.unsupported",
                "The selected main file must be .tex or .typ.",
                2,
            ))
        }
    }
    .to_owned();
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    let mut count = 0;
    let mut inventory = Vec::new();
    capture_walk(
        &root,
        &root,
        0,
        &mut files,
        &mut total,
        &mut count,
        &mut inventory,
    )?;
    count += 1;
    if count > MAX_ENTRIES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Project contains more than 10,000 entries.",
            3,
        ));
    }
    inventory.push(json!({"path":".","kind":"directory","sizeBytes":null,"engines":[]}));
    if root.join(".sciencebatch.json").exists() {
        count += 1;
    }
    let mut overlay_paths = BTreeSet::new();
    for (path, bytes) in overlays {
        let path = normalize_project_path(path)?;
        if path.split('/').count() > MAX_DEPTH {
            return Err(AutomationError::new(
                "resource.limit_exceeded",
                "Overlay path exceeds maximum depth.",
                3,
            ));
        }
        if !overlay_paths.insert(path.clone()) {
            return Err(as_error(
                "worker.protocol_invalid",
                "Two live overlays normalize to the same project path.",
                4,
            ));
        }
        let kind = classify(&path);
        check_file_size(bytes.len() as u64, &kind, &path)?;
        if matches!(kind, SnapshotFileKind::Text) && std::str::from_utf8(bytes).is_err() {
            return Err(AutomationError::new(
                "io.project_unavailable",
                format!("Text overlay '{path}' is not UTF-8."),
                3,
            ));
        }
        if !files.contains_key(&path) {
            count += 1;
            if count > MAX_ENTRIES {
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Project snapshot exceeds 10,000 entries.",
                    3,
                ));
            }
        }
        if let Some(old) = files.insert(
            path,
            SnapshotFile {
                bytes: bytes.clone(),
                kind,
            },
        ) {
            total = total.saturating_sub(old.bytes.len());
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_SNAPSHOT_BYTES {
            return Err(AutomationError::new(
                "resource.limit_exceeded",
                "Project snapshot exceeds 128 MiB.",
                3,
            ));
        }
    }
    if !files.contains_key(&main_file) {
        return Err(as_error(
            "project.main_missing",
            "The selected main source is missing from the snapshot.",
            2,
        ));
    }
    Ok(ProjectSnapshot {
        engine,
        root,
        main_file,
        files,
        total_bytes: total,
    })
}

pub fn capture_virtual_snapshot(
    engine: &str,
    main_file: &str,
    overlays: &BTreeMap<String, Vec<u8>>,
) -> Result<ProjectSnapshot, AutomationError> {
    let engine = match engine.to_ascii_lowercase().as_str() {
        "latex" | "typst" => engine.to_ascii_lowercase(),
        _ => {
            return Err(as_error(
                "engine.unsupported",
                "Engine must be latex or typst.",
                2,
            ))
        }
    };
    let main_file = normalize_project_path(main_file)?;
    let expected = if engine == "latex" { "tex" } else { "typ" };
    if !Path::new(&main_file)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
    {
        return Err(as_error(
            "project.main_engine_mismatch",
            "The main file extension does not match the selected engine.",
            2,
        ));
    }
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    let mut overlay_paths = BTreeSet::new();
    for (path, bytes) in overlays {
        let path = normalize_project_path(path)?;
        if path.split('/').count() > MAX_DEPTH {
            return Err(AutomationError::new(
                "resource.limit_exceeded",
                "Virtual overlay path exceeds maximum depth.",
                3,
            ));
        }
        if !overlay_paths.insert(path.clone()) {
            return Err(as_error(
                "worker.protocol_invalid",
                "Two live overlays normalize to the same project path.",
                4,
            ));
        }
        let kind = classify(&path);
        check_file_size(bytes.len() as u64, &kind, &path)?;
        if matches!(kind, SnapshotFileKind::Text) && std::str::from_utf8(bytes).is_err() {
            return Err(as_error(
                "io.project_unavailable",
                "A text overlay is not UTF-8.",
                3,
            ));
        }
        total = total.saturating_add(bytes.len());
        files.insert(
            path,
            SnapshotFile {
                bytes: bytes.clone(),
                kind,
            },
        );
    }
    if files.len() > MAX_ENTRIES || total > MAX_SNAPSHOT_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Virtual snapshot exceeds its configured limits.",
            3,
        ));
    }
    if !files.contains_key(&main_file) {
        return Err(as_error(
            "project.main_missing",
            "Virtual workspace snapshot must include the main source.",
            2,
        ));
    }
    Ok(ProjectSnapshot {
        engine,
        root: PathBuf::new(),
        main_file,
        files,
        total_bytes: total,
    })
}

fn discover(root: &Path) -> Result<ProjectInfo, AutomationError> {
    let mut files = BTreeMap::new();
    let mut total = 0;
    let mut count = 0;
    let mut inventory = Vec::new();
    capture_walk(
        root,
        root,
        0,
        &mut files,
        &mut total,
        &mut count,
        &mut inventory,
    )?;
    count += 1;
    if count > MAX_ENTRIES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Project contains more than 10,000 entries.",
            3,
        ));
    }
    inventory.push(json!({"path":".","kind":"directory","sizeBytes":null,"engines":[]}));
    let candidates: Vec<String> = files
        .keys()
        .filter(|p| {
            Path::new(p)
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| SOURCE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        })
        .cloned()
        .collect();
    let mut engines = BTreeSet::new();
    for path in &candidates {
        match Path::new(path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "tex" => {
                engines.insert("latex".to_owned());
            }
            "typ" => {
                engines.insert("typst".to_owned());
            }
            _ => {}
        }
    }
    let metadata = read_metadata(root)?;
    let engine = metadata
        .engine
        .as_deref()
        .filter(|e| ["latex", "typst"].contains(&e.to_ascii_lowercase().as_str()))
        .map(|e| e.to_ascii_lowercase());
    let mut main = metadata
        .main_file
        .as_deref()
        .map(normalize_project_path)
        .transpose()?;
    if main.is_none() {
        if let Some(engine) = &engine {
            let canonical = if engine == "latex" {
                "main.tex"
            } else {
                "main.typ"
            };
            if files.contains_key(canonical) {
                main = Some(canonical.to_owned());
            }
        }
    }
    let mains = if let Some(engine) = &engine {
        candidates
            .iter()
            .filter(|p| {
                Path::new(p)
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|e| {
                        if engine == "latex" {
                            e.eq_ignore_ascii_case("tex")
                        } else {
                            e.eq_ignore_ascii_case("typ")
                        }
                    })
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        candidates.clone()
    };
    if main.is_none() && mains.len() == 1 {
        main = mains.first().cloned();
    }
    if root.join(".sciencebatch.json").exists() {
        let meta = fs::symlink_metadata(root.join(".sciencebatch.json"))
            .map_err(|e| AutomationError::new("io.project_unavailable", e.to_string(), 3))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(as_error(
                "path.symlink_rejected",
                "Project metadata must be a regular file.",
                2,
            ));
        }
        count += 1;
        if count > MAX_ENTRIES {
            return Err(AutomationError::new(
                "resource.limit_exceeded",
                "Project contains more than 10,000 entries.",
                3,
            ));
        }
        inventory.push(json!({"path":".sciencebatch.json","kind":"file","fileType":"text","sizeBytes":meta.len(),"engines":[]}));
    }
    inventory.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let listed = inventory;
    Ok(ProjectInfo {
        root: root.to_owned(),
        engine,
        main_file: main,
        engines_found: engines.into_iter().collect(),
        main_candidates: mains,
        files: listed,
    })
}

fn read_metadata(root: &Path) -> Result<Metadata, AutomationError> {
    let path = root.join(".sciencebatch.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Metadata::default()),
        Err(e) => {
            return Err(AutomationError::new(
                "io.project_unavailable",
                format!("Cannot inspect project metadata: {e}"),
                3,
            ))
        }
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(as_error(
            "path.symlink_rejected",
            "Project metadata must be a regular file.",
            2,
        ));
    }
    if meta.len() > MAX_TEXT_BYTES as u64 {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Project metadata exceeds the text-file limit.",
            3,
        ));
    }
    let file = fs::File::open(path)
        .map_err(|e| AutomationError::new("io.project_unavailable", e.to_string(), 3))?;
    let mut bytes = Vec::new();
    file.take((MAX_TEXT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| AutomationError::new("io.project_unavailable", e.to_string(), 3))?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Project metadata exceeds the text-file limit.",
            3,
        ));
    }
    serde_json::from_slice(&bytes).map_err(|e| {
        AutomationError::new(
            "project.config_invalid",
            format!("Project metadata is invalid: {e}"),
            2,
        )
    })
}

fn resolve(
    root_arg: &str,
    engine_arg: Option<&str>,
    main_arg: Option<&str>,
    context: &OperationContext,
) -> Result<ProjectInfo, AutomationError> {
    let root = canonical_root(Path::new(root_arg))?;
    check_allowed_root(&root, context)?;
    let metadata = read_metadata(&root)?;
    if let Some(engine) = &metadata.engine {
        if !["latex", "typst"].contains(&engine.to_ascii_lowercase().as_str()) {
            return Err(as_error(
                "project.config_invalid",
                "Metadata engine must be latex or typst.",
                2,
            ));
        }
    }
    if let Some(main) = &metadata.main_file {
        let normalized = normalize_project_path(main).map_err(|_| {
            as_error(
                "project.config_invalid",
                "Metadata mainFile must be a normalized project-relative path.",
                2,
            )
        })?;
        if metadata
            .engine
            .as_deref()
            .and_then(|e| {
                engine_for_path(&normalized)
                    .map(|actual| (e.to_ascii_lowercase(), actual.to_owned()))
            })
            .is_some_and(|(expected, actual)| expected != actual)
        {
            return Err(as_error(
                "project.config_invalid",
                "Metadata engine and mainFile do not match.",
                2,
            ));
        }
    }
    let mut info = discover(&root)?;
    if let Some(configured) = metadata.main_file.as_deref() {
        let configured = normalize_project_path(configured)
            .map_err(|_| as_error("project.config_invalid", "Metadata mainFile is invalid.", 2))?;
        if !info
            .files
            .iter()
            .any(|f| f["path"].as_str() == Some(configured.as_str()))
        {
            return Err(as_error(
                "project.main_missing",
                "Configured main source does not exist.",
                2,
            ));
        }
        let engine = metadata
            .engine
            .as_deref()
            .map(str::to_ascii_lowercase)
            .or_else(|| engine_for_path(&configured).map(str::to_owned));
        if engine.as_deref() != engine_for_path(&configured) {
            return Err(as_error(
                "project.config_invalid",
                "Metadata engine and mainFile do not match.",
                2,
            ));
        }
    }
    if let Some(engine) = engine_arg {
        let engine = engine.to_ascii_lowercase();
        if !["latex", "typst"].contains(&engine.as_str()) {
            return Err(as_error(
                "engine.unsupported",
                "Engine must be latex or typst.",
                2,
            ));
        }
        info.engine = Some(engine.clone());
        info.main_candidates = info
            .files
            .iter()
            .filter_map(|v| v["path"].as_str())
            .filter(|p| {
                Path::new(p)
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|e| {
                        if engine == "latex" {
                            e.eq_ignore_ascii_case("tex")
                        } else {
                            e.eq_ignore_ascii_case("typ")
                        }
                    })
            })
            .map(str::to_owned)
            .collect();
    }
    if let Some(main) = main_arg {
        info.main_file = Some(normalize_project_path(main)?);
    } else if info
        .main_file
        .as_ref()
        .is_some_and(|p| !info.main_candidates.contains(p))
    {
        info.main_file = None;
    }
    if info.engine.is_none() && info.main_file.is_some() {
        info.engine = info
            .main_file
            .as_deref()
            .and_then(engine_for_path)
            .map(str::to_owned);
    }
    if info.engine.is_none() && info.engines_found.len() == 1 {
        info.engine = info.engines_found.first().cloned();
        let engine = info.engine.as_deref();
        info.main_candidates = info
            .files
            .iter()
            .filter_map(|entry| entry["path"].as_str())
            .filter(|path| engine_for_path(path) == engine)
            .map(str::to_owned)
            .collect();
    }
    if main_arg.is_none() && engine_arg.is_some() && info.main_file.is_none() {
        let canonical = if info.engine.as_deref() == Some("latex") {
            "main.tex"
        } else {
            "main.typ"
        };
        if info
            .files
            .iter()
            .any(|f| f["path"].as_str() == Some(canonical))
        {
            info.main_file = Some(canonical.into());
        }
    }
    if let (Some(engine), Some(main)) = (&info.engine, &info.main_file) {
        if engine_for_path(main) != Some(engine.as_str()) {
            return Err(as_error(
                "project.main_engine_mismatch",
                "Selected engine does not match the main file extension.",
                2,
            ));
        }
        if !info.files.iter().any(|f| f["path"].as_str() == Some(main)) {
            return Err(as_error(
                "project.main_missing",
                "Selected main file does not exist.",
                2,
            ));
        }
    }
    Ok(info)
}

fn engine_for_path(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "tex" => Some("latex"),
        "typ" => Some("typst"),
        _ => None,
    }
}

fn engine_associations(path: &str) -> Vec<&'static str> {
    engine_for_path(path).into_iter().collect()
}

pub(super) fn inspect(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    let root_arg = args.get("project").and_then(Value::as_str).unwrap_or(".");
    let info = resolve(
        root_arg,
        args.get("engine").and_then(Value::as_str),
        args.get("main").and_then(Value::as_str),
        context,
    )?;
    let warnings = if info.engines_found.len() > 1 && args.get("engine").is_none() {
        vec![PublicDiagnostic {
            severity: "warning".into(),
            code: "project.multiple_engines".into(),
            message: "Both LaTeX and Typst sources were found.".into(),
            origin: "preflight".into(),
            file: None,
            line: None,
            column: None,
            suggestion: Some("Select an engine and main source explicitly.".into()),
        }]
    } else {
        vec![]
    };
    Ok((
        json!({"project":info.root,"root":info.root,"engine":info.engine,"mainFile":info.main_file,"enginesFound":info.engines_found,"mainCandidates":info.main_candidates,"files":info.files,"scope":"project"}),
        warnings,
    ))
}

pub(super) fn resolve_capture(
    args: &Value,
    context: &OperationContext,
) -> Result<ProjectSnapshot, AutomationError> {
    let root_arg = args.get("project").and_then(Value::as_str).unwrap_or(".");
    let info = resolve(
        root_arg,
        args.get("engine").and_then(Value::as_str),
        args.get("main").and_then(Value::as_str),
        context,
    )?;
    let engine = info.engine.ok_or_else(|| {
        as_error(
            "project.engine_ambiguous",
            "Select an engine explicitly.",
            2,
        )
    })?;
    let main = info.main_file.ok_or_else(|| {
        AutomationError::new(
            "project.main_ambiguous",
            "Select a main source explicitly.",
            2,
        )
        .with_details(json!({"candidates":info.main_candidates}))
    })?;
    let overlays = BTreeMap::new();
    let snapshot = super::capture_snapshot(&info.root, &main, &overlays)?;
    if snapshot.engine != engine {
        return Err(as_error(
            "project.main_engine_mismatch",
            "Engine and main file do not match.",
            2,
        ));
    }
    Ok(snapshot)
}

pub(super) fn diagnostics(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    let snapshot = resolve_capture(args, context)?;
    let main = snapshot.files.get(&snapshot.main_file).ok_or_else(|| {
        as_error(
            "project.main_missing",
            "Main source is not in the project snapshot.",
            2,
        )
    })?;
    let mut diagnostics = Vec::new();
    if main.bytes.is_empty() {
        diagnostics.push(PublicDiagnostic {
            severity: "error".into(),
            code: "project.main_empty".into(),
            message: "The selected main source file is empty.".into(),
            origin: "preflight".into(),
            file: Some(snapshot.main_file.clone()),
            line: None,
            column: None,
            suggestion: Some("Add document content to the selected source file.".into()),
        });
    }
    let data = json!({"scope":"preflight","coverage":"Checks project resolution and basic source availability only; it does not check syntax completeness, package availability, or editor-linter rules.","project":snapshot.root.to_string_lossy(),"engine":snapshot.engine,"mainFile":snapshot.main_file});
    if diagnostics.iter().any(|d| d.severity == "error") {
        return Ok((data, diagnostics));
    }
    Ok((data, diagnostics))
}

pub(super) fn create(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    require_write(context)?;
    let dir = required_str(args, "project")?;
    let engine = required_str(args, "engine")?.to_ascii_lowercase();
    let main = args
        .get("main")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if engine == "latex" {
                "main.tex".into()
            } else {
                "main.typ".into()
            }
        });
    if !["latex", "typst"].contains(&engine.as_str())
        || engine_for_path(&main) != Some(engine.as_str())
    {
        return Err(as_error(
            "project.main_engine_mismatch",
            "Engine and main extension must agree.",
            2,
        ));
    }
    let dest = PathBuf::from(dir);
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let parent = canonical_root(parent)?;
    check_allowed_root(&parent, context)?;
    let name = dest.file_name().ok_or_else(|| {
        as_error(
            "path.outside_project",
            "Project path must name a directory.",
            2,
        )
    })?;
    let root = parent.join(name);
    if root.exists() {
        return Err(as_error(
            "output.exists",
            "Project directory already exists.",
            2,
        ));
    }
    let normalized = normalize_project_path(&main)?;
    fs::create_dir(&root).map_err(|e| {
        AutomationError::new("io.output_failed", format!("Cannot create project: {e}"), 3)
    })?;
    let source = if engine == "latex" {
        "\\documentclass{article}\n\\begin{document}\nScienceBatch document.\n\\end{document}\n"
    } else {
        "Hello, world!\n"
    };
    let meta = json!({"engine":engine,"mainFile":normalized});
    let write_result = (|| -> std::io::Result<()> {
        fs::create_dir_all(root.join(Path::new(&normalized).parent().unwrap_or(Path::new(""))))?;
        fs::write(root.join(&normalized), source)?;
        fs::write(
            root.join(".sciencebatch.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_dir_all(&root);
        return Err(AutomationError::new(
            "io.output_failed",
            format!("Cannot initialize project: {e}"),
            3,
        ));
    }
    Ok((
        json!({"project":root,"engine":engine,"mainFile":normalized}),
        vec![],
    ))
}

pub(super) fn read(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    let (root, path) = project_and_file(args, context)?;
    let bytes = read_confined(&root, &path)?;
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        as_error(
            "io.project_unavailable",
            "The selected file is not UTF-8 text.",
            3,
        )
    })?;
    Ok((
        json!({"file":path,"content":content,"sha256":sha256(&bytes)}),
        vec![],
    ))
}

pub(super) fn search(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    let root = resolve_root_arg(args, context)?;
    let query = required_str(args, "query")?;
    if query.is_empty() {
        return Err(as_error(
            "usage.invalid_argument",
            "Search query cannot be empty.",
            2,
        ));
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    let mut count = 0;
    let mut inventory = Vec::new();
    capture_walk(
        &root,
        &root,
        0,
        &mut files,
        &mut total,
        &mut count,
        &mut inventory,
    )?;
    let mut matches = Vec::new();
    for (path, file) in files {
        if !matches!(file.kind, SnapshotFileKind::Text) {
            continue;
        }
        let content = std::str::from_utf8(&file.bytes).unwrap_or("");
        for (index, line) in content.lines().enumerate() {
            if line.contains(query) {
                matches.push(json!({"file":path,"line":index+1,"text":line}));
                if matches.len() > 1000 {
                    return Err(AutomationError::new(
                        "resource.limit_exceeded",
                        "Search produced more than 1,000 matches.",
                        3,
                    ));
                }
            }
        }
    }
    Ok((json!({"query":query,"matches":matches}), vec![]))
}

pub(super) fn apply(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
    require_write(context)?;
    let (root, path) = project_and_file(args, context)?;
    let expected = required_str(args, "expectedSha256")?.to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(as_error(
            "usage.invalid_argument",
            "Expected SHA-256 must contain 64 hexadecimal characters.",
            2,
        ));
    }
    let content = required_str(args, "content")?.as_bytes().to_vec();
    let kind = classify(&path);
    if !matches!(kind, SnapshotFileKind::Text) {
        return Err(as_error(
            "usage.invalid_argument",
            "Only text source files can be edited.",
            2,
        ));
    }
    check_file_size(content.len() as u64, &kind, &path)?;
    if matches!(kind, SnapshotFileKind::Text) && std::str::from_utf8(&content).is_err() {
        return Err(as_error(
            "usage.invalid_argument",
            "Replacement text must be UTF-8.",
            2,
        ));
    }
    let target = root.join(&path);
    reject_symlink_ancestors(&root, &target)?;
    let _edit_lock = acquire_edit_lock(&target)?;
    let original_metadata = fs::symlink_metadata(&target).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot inspect '{path}': {e}"),
            3,
        )
    })?;
    if original_metadata.file_type().is_symlink() || !original_metadata.is_file() {
        return Err(as_error(
            "path.symlink_rejected",
            "Only regular text files may be edited.",
            2,
        ));
    }
    let parent = target.parent().unwrap_or(&root);
    let temp = parent.join(format!(
        ".sciencebatch-apply-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| {
            AutomationError::new(
                "io.output_failed",
                format!("Cannot create atomic edit file: {e}"),
                3,
            )
        })?;
    temp_file
        .write_all(&content)
        .and_then(|_| temp_file.sync_all())
        .map_err(|e| {
            let _ = fs::remove_file(&temp);
            AutomationError::new(
                "io.output_failed",
                format!("Cannot write atomic edit file: {e}"),
                3,
            )
        })?;
    fs::set_permissions(&temp, original_metadata.permissions()).map_err(|e| {
        let _ = fs::remove_file(&temp);
        AutomationError::new(
            "io.output_failed",
            format!("Cannot preserve source permissions: {e}"),
            3,
        )
    })?;
    let actual = match read_confined(&root, &path) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    };
    if sha256(&actual) != expected {
        let _ = fs::remove_file(&temp);
        return Err(as_error(
            "edit.hash_conflict",
            "The source changed since it was read.",
            2,
        ));
    }
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        AutomationError::new(
            "io.output_failed",
            format!("Cannot atomically replace source file: {e}"),
            3,
        )
    })?;
    Ok((json!({"file":path,"sha256":sha256(&content)}), vec![]))
}

static TEMP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn acquire_edit_lock(target: &Path) -> Result<fs::File, AutomationError> {
    use fs2::FileExt;
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot resolve source directory: {e}"),
            3,
        )
    })?;
    let key = sha256(
        format!(
            "{}{}{}",
            parent.display(),
            std::path::MAIN_SEPARATOR,
            target.file_name().unwrap_or_default().to_string_lossy()
        )
        .as_bytes(),
    );
    let cache = tectonic_io_base::app_dirs::directories::ProjectDirs::from(
        "",
        "ScienceBatch",
        "ScienceBatch",
    )
    .ok_or_else(|| {
        AutomationError::new(
            "io.output_failed",
            "Cannot determine the per-user transaction-lock directory.",
            3,
        )
    })?
    .cache_dir()
    .to_owned();
    let lock_dir = cache.join("transaction-locks");
    fs::create_dir_all(&lock_dir).map_err(|e| {
        AutomationError::new(
            "io.output_failed",
            format!("Cannot create source edit lock directory: {e}"),
            3,
        )
    })?;
    let dir_meta = fs::symlink_metadata(&lock_dir)
        .map_err(|e| AutomationError::new("io.output_failed", e.to_string(), 3))?;
    if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Source edit lock directory must be a real directory.",
            2,
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        if dir_meta.uid() != unsafe { libc::getuid() } {
            return Err(as_error(
                "path.symlink_rejected",
                "Transaction-lock directory must be owned by the current user.",
                2,
            ));
        }
        fs::set_permissions(&lock_dir, fs::Permissions::from_mode(0o700)).map_err(|e| {
            AutomationError::new(
                "io.output_failed",
                format!("Cannot secure source edit lock directory: {e}"),
                3,
            )
        })?;
    }
    let lock_path = lock_dir.join(format!("{key}.lock"));
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(&lock_path).map_err(|e| {
                AutomationError::new(
                    "io.output_failed",
                    format!("Cannot inspect source edit lock: {e}"),
                    3,
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Source edit lock must be a regular file.",
                    2,
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != unsafe { libc::getuid() } {
                    return Err(as_error(
                        "path.symlink_rejected",
                        "Source edit lock must be owned by the current user.",
                        2,
                    ));
                }
            }
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|e| {
                    AutomationError::new(
                        "io.output_failed",
                        format!("Cannot open source edit lock: {e}"),
                        3,
                    )
                })?
        }
        Err(error) => {
            return Err(AutomationError::new(
                "io.output_failed",
                format!("Cannot open source edit lock: {error}"),
                3,
            ))
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| {
                AutomationError::new(
                    "io.output_failed",
                    format!("Cannot secure source edit lock: {e}"),
                    3,
                )
            })?;
    }
    file.lock_exclusive().map_err(|e| {
        AutomationError::new(
            "io.output_failed",
            format!("Cannot lock source edit: {e}"),
            3,
        )
    })?;
    Ok(file)
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, AutomationError> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| {
        as_error(
            "usage.invalid_argument",
            format!("Missing string option '{key}'."),
            2,
        )
    })
}
fn require_write(context: &OperationContext) -> Result<(), AutomationError> {
    if context.allow_write {
        Ok(())
    } else {
        Err(as_error(
            "permission.write_required",
            "This operation requires --allow-write.",
            2,
        ))
    }
}
fn resolve_root_arg(args: &Value, context: &OperationContext) -> Result<PathBuf, AutomationError> {
    let root = canonical_root(Path::new(
        args.get("project").and_then(Value::as_str).unwrap_or("."),
    ))?;
    check_allowed_root(&root, context)?;
    Ok(root)
}
fn project_and_file(
    args: &Value,
    context: &OperationContext,
) -> Result<(PathBuf, String), AutomationError> {
    let root = resolve_root_arg(args, context)?;
    let path = normalize_project_path(required_str(args, "file")?)?;
    Ok((root, path))
}

fn reject_symlink_ancestors(root: &Path, target: &Path) -> Result<(), AutomationError> {
    let relative = target.strip_prefix(root).map_err(|_| {
        as_error(
            "path.outside_project",
            "The requested path escapes the project.",
            2,
        )
    })?;
    let mut current = root.to_owned();
    for component in relative.components() {
        if let Component::Normal(name) = component {
            current.push(name);
            if current.exists() {
                let meta = fs::symlink_metadata(&current).map_err(|e| {
                    AutomationError::new("io.project_unavailable", e.to_string(), 3)
                })?;
                if meta.file_type().is_symlink() {
                    return Err(as_error(
                        "path.symlink_rejected",
                        "Symbolic links are not permitted in project paths.",
                        2,
                    ));
                }
            }
        }
    }
    Ok(())
}
fn read_confined(root: &Path, path: &str) -> Result<Vec<u8>, AutomationError> {
    let target = root.join(path);
    reject_symlink_ancestors(root, &target)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot read '{path}': {e}"),
            3,
        )
    })?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(as_error(
            "path.symlink_rejected",
            "Only regular project files may be read.",
            2,
        ));
    }
    let kind = classify(path);
    check_file_size(meta.len(), &kind, path)?;
    let file = fs::File::open(target).map_err(|e| {
        AutomationError::new(
            "io.project_unavailable",
            format!("Cannot open '{path}': {e}"),
            3,
        )
    })?;
    let cap = if matches!(kind, SnapshotFileKind::Text) {
        MAX_TEXT_BYTES
    } else {
        MAX_ASSET_BYTES
    };
    let mut bytes = Vec::new();
    file.take((cap + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            AutomationError::new(
                "io.project_unavailable",
                format!("Cannot read '{path}': {e}"),
                3,
            )
        })?;
    if bytes.len() > cap {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            format!("Project file '{path}' grew beyond its read limit."),
            3,
        ));
    }
    if matches!(kind, SnapshotFileKind::Text) && std::str::from_utf8(&bytes).is_err() {
        return Err(as_error(
            "io.project_unavailable",
            "The selected text file is not UTF-8.",
            3,
        ));
    }
    Ok(bytes)
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn temp_project() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sciencebatch-automation-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("main.tex"), "before").unwrap();
        path
    }

    #[test]
    fn project_paths_normalize_inside_root_and_reject_escape() {
        assert_eq!(
            normalize_project_path("chapter/../main.tex").unwrap(),
            "main.tex"
        );
        assert_eq!(
            normalize_project_path("../../outside.tex")
                .unwrap_err()
                .code,
            "path.outside_project"
        );
        assert_eq!(
            normalize_project_path("/etc/passwd").unwrap_err().code,
            "path.outside_project"
        );
    }

    #[test]
    fn multiple_sources_for_one_engine_report_main_ambiguity() {
        let root = temp_project();
        fs::write(root.join("appendix.tex"), "appendix").unwrap();
        let args = json!({"project":root});
        let error = resolve_capture(&args, &OperationContext::local()).unwrap_err();
        assert_eq!(error.code, "project.main_ambiguous");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_expected_hash_edits_have_one_winner() {
        let root = temp_project();
        let original = b"before";
        let expected = sha256(original);
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for content in ["first", "second"] {
            let root = root.clone();
            let expected = expected.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move||{
                let context=OperationContext{allow_write:true,..OperationContext::default()};
                let args=json!({"project":root,"file":"main.tex","expectedSha256":expected,"content":content});
                barrier.wait();
                apply(&args,&context).is_ok()
            }));
        }
        barrier.wait();
        let successes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_edit_with_a_stale_hash_preserves_the_current_source() {
        let root = temp_project();
        fs::write(root.join("main.tex"), b"newer").unwrap();
        let context = OperationContext {
            allow_write: true,
            ..OperationContext::default()
        };
        let args = json!({
            "project": root,
            "file": "main.tex",
            "expectedSha256": sha256(b"before"),
            "content": "replacement"
        });
        let error = apply(&args, &context).unwrap_err();
        assert_eq!(error.code, "edit.hash_conflict");
        assert_eq!(fs::read(root.join("main.tex")).unwrap(), b"newer");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_capture_rejects_symbolic_links() {
        let root = temp_project();
        std::os::unix::fs::symlink(root.join("main.tex"), root.join("linked.tex")).unwrap();
        let error = capture_snapshot(&root, "main.tex", &BTreeMap::new()).unwrap_err();
        assert_eq!(error.code, "path.symlink_rejected");
        let _ = fs::remove_dir_all(root);
    }
}
