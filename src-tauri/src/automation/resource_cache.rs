//! Explicit inventory and removal for the pinned, shared Tectonic cache.
#[cfg(unix)]
use super::resource_prepare;
use super::{
    as_error, resource_project, resources, AutomationError, OperationContext, ProjectSnapshot,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::path::{Component, Path, PathBuf};
#[cfg(unix)]
use std::time::{Duration, Instant};
use std::time::UNIX_EPOCH;

const PAGE_MAX: usize = 200;
const REMOVE_MAX: usize = 200;
#[cfg(unix)]
const LOCK_WAIT: Duration = Duration::from_secs(3);
const SCAN_MAX: usize = 200_000;

#[derive(Clone)]
struct Entry {
    path: String,
    bytes: u64,
    required: bool,
    removable: bool,
    #[cfg_attr(not(unix), allow(dead_code))]
    signature: String,
}

struct Inventory {
    #[cfg_attr(not(unix), allow(dead_code))]
    cache: PathBuf,
    bundle_digest: String,
    digest: String,
    entries: Vec<Entry>,
    installed_bytes: u64,
    metadata_bytes: u64,
    other_bytes: u64,
    embedded_files: usize,
    embedded_bytes: u64,
}

pub(super) fn dispatch(
    operation: &str,
    snapshot: &ProjectSnapshot,
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    validate_args(args)?;
    match operation {
        "resources.cache_list" => Ok((list(snapshot, args, context)?, Vec::new())),
        "resources.cache_remove" => Ok((remove(snapshot, args, context)?, Vec::new())),
        _ => Err(as_error(
            "usage.invalid_argument",
            "Unsupported cache operation.",
            2,
        )),
    }
}

fn validate_args(args: &Value) -> Result<(), AutomationError> {
    for field in ["expectedInputDigest", "expectedCacheDigest", "cursor"] {
        if args.get(field).is_some_and(|value| !value.is_string()) {
            return Err(as_error(
                "usage.invalid_argument",
                format!("{field} must be a string when provided."),
                2,
            ));
        }
    }
    if args.get("limit").is_some_and(|value| !value.is_u64()) {
        return Err(as_error(
            "usage.invalid_argument",
            "limit must be a non-negative integer.",
            2,
        ));
    }
    if args
        .get("removePaths")
        .is_some_and(|value| !value.is_array())
    {
        return Err(as_error(
            "usage.invalid_argument",
            "removePaths must be an array of paths.",
            2,
        ));
    }
    Ok(())
}

fn list(
    snapshot: &ProjectSnapshot,
    args: &Value,
    context: &OperationContext,
) -> Result<Value, AutomationError> {
    if context.cancelled() {
        return Err(as_error(
            "operation.interrupted",
            "Cache inventory was cancelled.",
            130,
        ));
    }
    let plan = resource_project::resolved_plan(snapshot, args)?;
    let required = required_paths(&plan);
    let inventory = build_inventory(&required, &plan.input_digest)?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(PAGE_MAX as u64) as usize;
    if limit == 0 || limit > PAGE_MAX {
        return Err(as_error(
            "usage.invalid_argument",
            "limit must be between 1 and 200.",
            2,
        ));
    }
    let offset = match args.get("cursor").and_then(Value::as_str) {
        None => 0,
        Some(cursor) => decode_cursor(cursor, &inventory.digest)?,
    };
    if offset > inventory.entries.len() {
        return Err(as_error(
            "resources.cursor_invalid",
            "Cache inventory cursor is out of range.",
            2,
        ));
    }
    let end = offset.saturating_add(limit).min(inventory.entries.len());
    let items = inventory.entries[offset..end]
        .iter()
        .map(|entry| {
            json!({
                "path": entry.path,
                "bytes": entry.bytes,
                "requiredByProject": entry.required,
                "removable": entry.removable,
            })
        })
        .collect::<Vec<_>>();
    let next_cursor =
        (end < inventory.entries.len()).then(|| encode_cursor(&inventory.digest, end));
    let result = json!({
        "cacheDigest": inventory.digest,
        "bundleDigest": inventory.bundle_digest,
        "offset": offset,
        "total": inventory.entries.len(),
        "nextCursor": next_cursor,
        "items": items,
        "summary": {
            "installedFiles": inventory.entries.len(),
            "installedBytes": inventory.installed_bytes,
            "metadataBytes": inventory.metadata_bytes,
            "otherBytes": inventory.other_bytes,
            "embeddedFiles": inventory.embedded_files,
            "embeddedBytes": inventory.embedded_bytes,
        },
    });
    if serde_json::to_vec(&result).map_or(true, |encoded| encoded.len() > 1024 * 1024) {
        return Err(as_error(
            "resource.limit_exceeded",
            "Cache inventory page exceeds 1 MiB.",
            3,
        ));
    }
    Ok(result)
}

fn remove(
    snapshot: &ProjectSnapshot,
    args: &Value,
    context: &OperationContext,
) -> Result<Value, AutomationError> {
    remove_with_cache(snapshot, args, context, resources::cache_directory()?)
}

fn remove_with_cache(
    snapshot: &ProjectSnapshot,
    args: &Value,
    context: &OperationContext,
    cache: PathBuf,
) -> Result<Value, AutomationError> {
    if !context.allow_write {
        return Err(as_error(
            "permission.write_required",
            "Cache removal requires explicit write permission.",
            2,
        ));
    }
    if context.cancelled() {
        return Err(as_error(
            "operation.interrupted",
            "Cache removal was cancelled.",
            130,
        ));
    }
    let expected_input = args
        .get("expectedInputDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "expectedInputDigest is required for cache removal.",
                2,
            )
        })?;
    let expected_cache = args
        .get("expectedCacheDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "expectedCacheDigest is required for cache removal.",
                2,
            )
        })?;
    if !is_digest(expected_input) || !is_digest(expected_cache) {
        return Err(as_error(
            "usage.invalid_argument",
            "Input and cache digests must be SHA-256 values.",
            2,
        ));
    }
    let requested = args
        .get("removePaths")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "removePaths is required for cache removal.",
                2,
            )
        })?;
    if requested.is_empty() || requested.len() > REMOVE_MAX {
        return Err(as_error(
            "usage.invalid_argument",
            "removePaths must contain between 1 and 200 paths.",
            2,
        ));
    }
    let mut paths = BTreeSet::new();
    for item in requested {
        let path = item.as_str().ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "removePaths must contain strings.",
                2,
            )
        })?;
        if path.len() > 4096 || !safe_relative_path(path) || !paths.insert(path.to_owned()) {
            return Err(as_error(
                "path.symlink_rejected",
                "A removal path is unsafe or duplicated.",
                2,
            ));
        }
    }
    let plan =
        resource_project::resolved_plan_with_cache_root(snapshot, args, Some(cache.clone()))?;
    if plan.input_digest != expected_input {
        return Err(as_error(
            "resources.input_changed",
            "The project snapshot changed; analyze it again before removing cache files.",
            2,
        ));
    }
    #[cfg(not(unix))]
    {
        let _ = (&context, expected_cache, &paths);
        Err(as_error(
            "resources.cache_read_only",
            "Cache removal is unavailable on this platform because safe directory-relative unlinking is not supported.",
            2,
        ))
    }
    #[cfg(unix)]
    {
        let required = required_paths(&plan);
        let pinned = resource_project::pinned_catalog()?;

        // This exclusive lease shares the established writer lock with preparation and
        // the compiler's shared reader lease. The bounded wait happens on spawn_blocking.
        let _lease = resource_prepare::acquire_bundle_lock_for_url(
            &cache,
            &pinned.url,
            Instant::now() + LOCK_WAIT,
        )?;
        if context.cancelled() {
            return Err(as_error(
                "operation.interrupted",
                "Cache removal was cancelled while waiting for the cache lock.",
                130,
            ));
        }
        let inventory = build_inventory_at(&cache, &required, &plan.input_digest, &pinned)?;
        ensure_expected_cache_digest(expected_cache, &inventory.digest)?;
        let by_path = inventory
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut selected = Vec::with_capacity(paths.len());
        for path in &paths {
            let entry = by_path.get(path.as_str()).ok_or_else(|| {
                as_error(
                    "resources.cache_path_unknown",
                    "A selected path is not an installed pinned bundle file.",
                    2,
                )
            })?;
            if validate_entry_removable(
                entry,
                &required,
                resource_project::is_starter_resource(path)?,
            )
            .is_err()
            {
                return Err(as_error(
                    "resources.cache_path_protected",
                    "A selected cache file is required by the current project or is embedded.",
                    2,
                ));
            }
            validate_removal_target(
                &inventory.cache,
                &inventory.bundle_digest,
                path,
                &entry.signature,
            )?;
            selected.push((path.clone(), entry.bytes, entry.signature.clone()));
        }
        let mut removed_files = 0usize;
        let mut removed_bytes = 0u64;
        for (path, bytes, signature) in selected {
            if context.cancelled() {
                return Err(AutomationError::new(
                    "operation.interrupted",
                    "Cache removal was cancelled.",
                    130,
                )
                .with_details(json!({"removedFiles":removed_files,"removedBytes":removed_bytes})));
            }
            safe_unlink(
                &inventory.cache,
                &inventory.bundle_digest,
                &path,
                &signature,
            )
            .map_err(|error| {
                AutomationError::new(
                    "cache.unavailable_offline",
                    format!("Cannot remove selected cache file: {error}"),
                    3,
                )
                .with_details(
                    json!({"removedFiles":removed_files,"removedBytes":removed_bytes,"path":path}),
                )
            })?;
            removed_files += 1;
            removed_bytes = removed_bytes.saturating_add(bytes);
        }
        Ok(json!({"removedFiles":removed_files,"removedBytes":removed_bytes}))
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
fn ensure_expected_cache_digest(expected: &str, actual: &str) -> Result<(), AutomationError> {
    if expected != actual {
        return Err(as_error(
            "resources.cache_changed",
            "The installed cache changed; refresh the inventory before removing files.",
            2,
        ));
    }
    Ok(())
}

#[cfg_attr(not(unix), allow(dead_code))]
fn validate_entry_removable(
    entry: &Entry,
    required: &BTreeSet<String>,
    embedded: bool,
) -> Result<(), AutomationError> {
    if !entry.removable || entry.required || required.contains(&entry.path) || embedded {
        return Err(as_error(
            "resources.cache_path_protected",
            "A selected cache file is required by the current project or is embedded.",
            2,
        ));
    }
    Ok(())
}

fn required_paths(plan: &resource_project::ResourcePlan) -> BTreeSet<String> {
    plan.requirements
        .iter()
        .filter(|row| row.provider == "pinned_bundle")
        .filter_map(|row| row.path.clone())
        .collect()
}

fn build_inventory(
    required: &BTreeSet<String>,
    input_digest: &str,
) -> Result<Inventory, AutomationError> {
    let pinned = resource_project::pinned_catalog()?;
    let cache = resources::cache_directory()?;
    build_inventory_at(&cache, required, input_digest, &pinned)
}

fn build_inventory_at(
    cache: &Path,
    required: &BTreeSet<String>,
    input_digest: &str,
    pinned: &resource_project::PinnedCatalog,
) -> Result<Inventory, AutomationError> {
    validate_no_symlink_ancestors(cache)?;
    let root = cache.join("data").join(&pinned.digest);
    let paths = resource_project::pinned_resource_paths()?;
    let mut entries = Vec::new();
    let mut installed_bytes = 0u64;
    let mut embedded_files = 0usize;
    let mut embedded_bytes = 0u64;
    let mut digest = Sha256::new();
    digest.update(b"sciencebatch-cache-inventory-v1\0");
    digest_field(&mut digest, pinned.digest.as_bytes());
    digest_field(&mut digest, input_digest.as_bytes());
    for path in paths {
        let descriptor = resource_project::catalog_resource(&path)?.ok_or_else(|| {
            as_error(
                "resources.catalog_invalid",
                "A pinned cache path is absent from the catalog.",
                4,
            )
        })?;
        let embedded = resource_project::is_starter_resource(&path)?;
        if embedded {
            embedded_files += 1;
            embedded_bytes = embedded_bytes.saturating_add(descriptor.length);
        }
        let target = root.join(&path);
        let Some(metadata) = safe_file_metadata(&root, &target, &path)? else {
            continue;
        };
        let signature = metadata_signature(&metadata);
        let is_required = required.contains(&path);
        digest_field(&mut digest, path.as_bytes());
        digest_field(&mut digest, signature.as_bytes());
        digest_field(&mut digest, &[u8::from(is_required), u8::from(embedded)]);
        let bytes = metadata.len();
        installed_bytes = installed_bytes.saturating_add(bytes);
        #[cfg(unix)]
        let safe_to_remove = validate_owner(&root, &path).is_ok();
        #[cfg(not(unix))]
        let safe_to_remove = false;
        entries.push(Entry {
            path,
            bytes,
            required: is_required,
            removable: !is_required && !embedded && safe_to_remove,
            signature,
        });
    }
    let metadata_bytes = metadata_bytes(cache, &pinned.digest, &pinned.url)?;
    digest_field(&mut digest, pinned.index_sha256.as_bytes());
    digest_field(&mut digest, metadata_bytes.to_string().as_bytes());
    let total_bytes = scan_bytes(cache)?;
    let format_bytes = cache
        .parent()
        .map(|parent| scan_bytes(&parent.join("formats")))
        .transpose()?
        .unwrap_or(0);
    let categorized = installed_bytes.saturating_add(metadata_bytes);
    let other_bytes = total_bytes
        .saturating_sub(categorized)
        .saturating_add(format_bytes);
    Ok(Inventory {
        cache: cache.to_path_buf(),
        bundle_digest: pinned.digest.clone(),
        digest: format!("{:x}", digest.finalize()),
        entries,
        installed_bytes,
        metadata_bytes,
        other_bytes,
        embedded_files,
        embedded_bytes,
    })
}

fn safe_file_metadata(
    root: &Path,
    target: &Path,
    relative: &str,
) -> Result<Option<fs::Metadata>, AutomationError> {
    if !safe_relative_path(relative) {
        return Err(as_error(
            "path.symlink_rejected",
            "Pinned catalog contains an unsafe cache path.",
            2,
        ));
    }
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(as_error(
                "path.symlink_rejected",
                "Pinned bundle cache root is not a real directory.",
                2,
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AutomationError::new(
                "cache.unavailable_offline",
                error.to_string(),
                3,
            ))
        }
    }
    let mut current = root.to_path_buf();
    for (index, part) in relative.split('/').enumerate() {
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ))
            }
        };
        if metadata.file_type().is_symlink()
            || (index + 1 < relative.split('/').count() && !metadata.is_dir())
        {
            return Err(as_error(
                "path.symlink_rejected",
                "Pinned cache path contains a symlink or invalid ancestor.",
                2,
            )
            .with_details(json!({"path":relative})));
        }
    }
    let metadata = fs::symlink_metadata(target)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if !metadata.is_file() {
        return Err(as_error(
            "path.symlink_rejected",
            "Pinned cache entry is not a regular file.",
            2,
        )
        .with_details(json!({"path":relative})));
    }
    Ok(Some(metadata))
}

fn validate_no_symlink_ancestors(path: &Path) -> Result<(), AutomationError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Cache location contains a symbolic link.",
                    2,
                ))
            }
            Ok(metadata) if current != path && !metadata.is_dir() => {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Cache location contains a non-directory ancestor.",
                    2,
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ))
            }
        }
    }
    Ok(())
}

#[cfg_attr(not(unix), allow(dead_code))]
fn validate_removal_target(
    cache: &Path,
    digest: &str,
    relative: &str,
    signature: &str,
) -> Result<(), AutomationError> {
    let root = cache.join("data").join(digest);
    let target = root.join(relative);
    let metadata = safe_file_metadata(&root, &target, relative)?.ok_or_else(|| {
        as_error(
            "resources.cache_changed",
            "A selected cache file disappeared.",
            2,
        )
    })?;
    if metadata_signature(&metadata) != signature {
        return Err(as_error(
            "resources.cache_changed",
            "A selected cache file changed after inventory.",
            2,
        ));
    }
    validate_owner(&root, relative)?;
    Ok(())
}

#[cfg_attr(not(unix), allow(dead_code))]
fn validate_owner(root: &Path, relative: &str) -> Result<(), AutomationError> {
    let mut current = root.to_path_buf();
    for component in relative.split('/') {
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            AutomationError::new("cache.unavailable_offline", error.to_string(), 3)
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(as_error(
                "path.symlink_rejected",
                "Cache removal encountered an unsafe directory.",
                2,
            ));
        }
        ensure_current_owner(&metadata)?;
        current.push(component);
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(as_error(
            "path.symlink_rejected",
            "Cache removal target is not a regular file.",
            2,
        ));
    }
    ensure_current_owner(&metadata)
}

#[cfg(unix)]
fn safe_unlink(
    cache: &Path,
    digest: &str,
    relative: &str,
    expected_signature: &str,
) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    fn open_child(directory: &File, name: &std::ffi::CStr) -> std::io::Result<File> {
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "cache path component is not a directory",
            ));
        }
        ensure_current_owner(&metadata).map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, error.message)
        })?;
        Ok(file)
    }

    let mut directory = File::open("/")?;
    for component in cache.components() {
        match component {
            Component::RootDir | Component::CurDir => continue,
            Component::Normal(name) => {
                let name = CString::new(name.as_bytes()).map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid cache path")
                })?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                directory = unsafe { File::from_raw_fd(fd) };
            }
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "invalid cache path",
                ))
            }
        }
    }
    let cache_metadata = directory.metadata()?;
    ensure_current_owner(&cache_metadata).map_err(|error| {
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, error.message)
    })?;
    for name in ["data", digest] {
        let name = CString::new(name).expect("static cache directory name");
        directory = open_child(&directory, &name)?;
    }
    let mut components = relative.split('/').collect::<Vec<_>>();
    let file_name = components
        .pop()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty cache path"))?;
    for component in components {
        let name = CString::new(component).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid cache path")
        })?;
        directory = open_child(&directory, &name)?;
    }
    let name = CString::new(file_name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid cache path"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata_signature(&metadata) != expected_signature
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cache file changed or is not owned by the current user",
        ));
    }
    let mut current = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            current.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let current = unsafe { current.assume_init() };
    if current.st_mode & libc::S_IFMT != libc::S_IFREG
        || current.st_uid != unsafe { libc::geteuid() }
        || current.st_dev != metadata.dev()
        || current.st_ino != metadata.ino()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cache file changed before unlink",
        ));
    }
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn safe_unlink(
    _cache: &Path,
    _digest: &str,
    _relative: &str,
    _expected_signature: &str,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe directory-relative cache removal is unavailable on this platform",
    ))
}

#[cfg(unix)]
fn ensure_current_owner(metadata: &fs::Metadata) -> Result<(), AutomationError> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(as_error(
            "path.symlink_rejected",
            "Cache removal target is not owned by the current user.",
            2,
        ));
    }
    Ok(())
}
#[cfg(not(unix))]
#[allow(dead_code)]
fn ensure_current_owner(_metadata: &fs::Metadata) -> Result<(), AutomationError> {
    Ok(())
}

fn metadata_bytes(cache: &Path, digest: &str, url: &str) -> Result<u64, AutomationError> {
    let mut total = 0u64;
    let hash = cache
        .join("hashes")
        .join(tectonic_io_base::app_dirs::sanitize(url));
    let index = cache.join("data").join(format!("{digest}.index"));
    for path in [hash, index] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Pinned cache metadata is not a regular file.",
                    2,
                ))
            }
            Ok(metadata) => total = total.saturating_add(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ))
            }
        }
    }
    Ok(total)
}

fn scan_bytes(root: &Path) -> Result<u64, AutomationError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(AutomationError::new(
                "cache.unavailable_offline",
                error.to_string(),
                3,
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Cache summary path is not a real directory.",
            2,
        ));
    }
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut total = 0u64;
    let mut seen = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 64 {
            return Err(as_error(
                "resource.limit_exceeded",
                "Cache summary exceeds the maximum directory depth.",
                3,
            ));
        }
        for item in fs::read_dir(directory).map_err(|error| {
            AutomationError::new("cache.unavailable_offline", error.to_string(), 3)
        })? {
            seen += 1;
            if seen > SCAN_MAX {
                return Err(as_error(
                    "resource.limit_exceeded",
                    "Cache summary exceeds 200,000 entries.",
                    3,
                ));
            }
            let item = item.map_err(|error| {
                AutomationError::new("cache.unavailable_offline", error.to_string(), 3)
            })?;
            let metadata = fs::symlink_metadata(item.path()).map_err(|error| {
                AutomationError::new("cache.unavailable_offline", error.to_string(), 3)
            })?;
            if metadata.file_type().is_symlink() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Compiler cache contains a symbolic link.",
                    2,
                ));
            }
            if metadata.is_dir() {
                stack.push((item.path(), depth + 1));
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

fn metadata_signature(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}",
            metadata.len(),
            modified,
            metadata.dev(),
            metadata.ino(),
            metadata.mode()
        )
    }
    #[cfg(not(unix))]
    {
        format!("{}:{}", metadata.len(), modified)
    }
}

fn digest_field(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value);
}
fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}
fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn encode_cursor(digest: &str, offset: usize) -> String {
    URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&json!({"digest":digest,"offset":offset})).unwrap_or_default())
}
fn decode_cursor(cursor: &str, digest: &str) -> Result<usize, AutomationError> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| {
        as_error(
            "resources.cursor_invalid",
            "Cache inventory cursor is malformed.",
            2,
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        as_error(
            "resources.cursor_invalid",
            "Cache inventory cursor is malformed.",
            2,
        )
    })?;
    if value.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(as_error(
            "resources.cursor_invalid",
            "Cache inventory changed; restart pagination.",
            2,
        ));
    }
    value
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| {
            as_error(
                "resources.cursor_invalid",
                "Cache inventory cursor is malformed.",
                2,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::super::resource_prepare;
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn cursor_is_bound_to_inventory_digest() {
        let cursor = encode_cursor(&"a".repeat(64), 17);
        assert_eq!(decode_cursor(&cursor, &"a".repeat(64)).unwrap(), 17);
        assert!(decode_cursor(&cursor, &"b".repeat(64)).is_err());
    }

    #[test]
    fn cache_paths_reject_traversal_and_windows_separators() {
        assert!(!safe_relative_path("../outside"));
        assert!(!safe_relative_path("a\\b"));
        assert!(safe_relative_path("fonts/example.otf"));
    }

    #[test]
    fn inventory_paginates_installed_catalog_files_in_a_temporary_cache() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let pinned = resource_project::pinned_catalog().unwrap();
        let root = cache.join("data").join(&pinned.digest);
        let paths = resource_project::pinned_resource_paths()
            .unwrap()
            .into_iter()
            .filter(|path| !resource_project::is_starter_resource(path).unwrap())
            .take(2)
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 2);
        for path in &paths {
            let target = root.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, b"isolated cache fixture").unwrap();
        }
        let inventory =
            build_inventory_at(&cache, &BTreeSet::new(), &"1".repeat(64), &pinned).unwrap();
        assert_eq!(inventory.entries.len(), 2);
        assert_eq!(inventory.entries[0].path, paths[0]);
        assert_eq!(inventory.entries[1].path, paths[1]);
        assert_eq!(
            decode_cursor(&encode_cursor(&inventory.digest, 1), &inventory.digest).unwrap(),
            1
        );
    }

    #[test]
    fn current_project_cache_entries_and_stale_digests_are_rejected() {
        let path = "fonts/example.otf".to_owned();
        let entry = Entry {
            path: path.clone(),
            bytes: 4,
            required: true,
            removable: false,
            signature: "sig".into(),
        };
        let required = BTreeSet::from([path]);
        assert!(validate_entry_removable(&entry, &required, false).is_err());
        assert!(validate_entry_removable(
            &Entry {
                required: false,
                removable: true,
                ..entry
            },
            &required,
            true
        )
        .is_err());
        assert!(ensure_expected_cache_digest(&"a".repeat(64), &"b".repeat(64)).is_err());
        assert!(ensure_expected_cache_digest(&"a".repeat(64), &"a".repeat(64)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn removes_an_unrequired_pinned_file_only_from_an_isolated_cache() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let pinned = resource_project::pinned_catalog().unwrap();
        let path = resource_project::pinned_resource_paths()
            .unwrap()
            .into_iter()
            .find(|path| !resource_project::is_starter_resource(path).unwrap())
            .unwrap();
        let root = cache.join("data").join(&pinned.digest);
        let target = root.join(&path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"isolated deletion fixture").unwrap();
        let inventory =
            build_inventory_at(&cache, &BTreeSet::new(), &"2".repeat(64), &pinned).unwrap();
        let entry = inventory
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .unwrap();
        validate_entry_removable(entry, &BTreeSet::new(), false).unwrap();
        validate_removal_target(&cache, &pinned.digest, &path, &entry.signature).unwrap();
        safe_unlink(&cache, &pinned.digest, &path, &entry.signature).unwrap();
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn full_removal_flow_checks_digests_permissions_protection_and_cancellation() {
        use crate::automation::{ProjectSnapshot, SnapshotFile, SnapshotFileKind};
        use std::collections::BTreeMap;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let pinned = resource_project::pinned_catalog().unwrap();
        let source = b"\\documentclass{article}\\begin{document}Hi\\end{document}";
        let snapshot = ProjectSnapshot {
            engine: "latex".into(),
            root: PathBuf::new(),
            main_file: "main.tex".into(),
            files: BTreeMap::from([(
                "main.tex".into(),
                SnapshotFile {
                    bytes: source.to_vec(),
                    kind: SnapshotFileKind::Text,
                },
            )]),
            total_bytes: source.len(),
        };
        let plan = resource_project::resolved_plan_with_cache_root(
            &snapshot,
            &json!({}),
            Some(cache.clone()),
        )
        .unwrap();
        let required = required_paths(&plan);
        let protected_path = required.iter().next().unwrap().clone();
        let removable_path = resource_project::pinned_resource_paths()
            .unwrap()
            .into_iter()
            .find(|path| {
                !required.contains(path) && !resource_project::is_starter_resource(path).unwrap()
            })
            .unwrap();
        let root = cache.join("data").join(&pinned.digest);
        for path in [&protected_path, &removable_path] {
            let target = root.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, format!("isolated:{path}")).unwrap();
        }
        let inventory = build_inventory_at(&cache, &required, &plan.input_digest, &pinned).unwrap();
        let expected_cache = inventory.digest.clone();
        let expected_input = plan.input_digest.clone();
        let args_for = |paths: Vec<String>, cache_digest: String| {
            json!({
                "expectedInputDigest": expected_input,
                "expectedCacheDigest": cache_digest,
                "removePaths": paths,
            })
        };
        let removable_target = root.join(&removable_path);
        let protected_target = root.join(&protected_path);
        let allowed = OperationContext {
            allow_write: true,
            ..OperationContext::default()
        };

        let stale = args_for(vec![removable_path.clone()], "0".repeat(64));
        assert_eq!(
            remove_with_cache(&snapshot, &stale, &allowed, cache.clone())
                .unwrap_err()
                .code,
            "resources.cache_changed"
        );
        assert!(removable_target.exists());

        let mixed = args_for(
            vec![removable_path.clone(), protected_path.clone()],
            expected_cache.clone(),
        );
        assert_eq!(
            remove_with_cache(&snapshot, &mixed, &allowed, cache.clone())
                .unwrap_err()
                .code,
            "resources.cache_path_protected"
        );
        assert!(removable_target.exists());
        assert!(protected_target.exists());

        let read_only = args_for(vec![removable_path.clone()], expected_cache.clone());
        assert_eq!(
            remove_with_cache(
                &snapshot,
                &read_only,
                &OperationContext::default(),
                cache.clone()
            )
            .unwrap_err()
            .code,
            "permission.write_required"
        );
        assert!(removable_target.exists());

        let cancellation = Arc::new(AtomicBool::new(false));
        let reader = resource_prepare::acquire_cache_read_lock(
            &cache,
            &pinned.digest,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let cancel_context = OperationContext {
            allow_write: true,
            cancellation: cancellation.clone(),
            ..OperationContext::default()
        };
        let cancel_args = args_for(vec![removable_path.clone()], expected_cache.clone());
        let cancel_snapshot = snapshot.clone();
        let cancel_cache = cache.clone();
        let task = std::thread::spawn(move || {
            remove_with_cache(
                &cancel_snapshot,
                &cancel_args,
                &cancel_context,
                cancel_cache,
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        cancellation.store(true, std::sync::atomic::Ordering::Release);
        drop(reader);
        assert_eq!(
            task.join().unwrap().unwrap_err().code,
            "operation.interrupted"
        );
        assert!(removable_target.exists());

        let removed = remove_with_cache(
            &snapshot,
            &args_for(vec![removable_path], expected_cache),
            &allowed,
            cache,
        )
        .unwrap();
        assert_eq!(removed["removedFiles"], 1);
        assert!(!removable_target.exists());
        assert!(protected_target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn typst_snapshot_can_remove_unrequired_pinned_cache_file_with_input_guard() {
        use crate::automation::{ProjectSnapshot, SnapshotFile, SnapshotFileKind};
        use std::collections::BTreeMap;

        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let pinned = resource_project::pinned_catalog().unwrap();
        let source = b"#let value = 1\n";
        let snapshot = ProjectSnapshot {
            engine: "typst".into(),
            root: PathBuf::new(),
            main_file: "main.typ".into(),
            files: BTreeMap::from([(
                "main.typ".into(),
                SnapshotFile {
                    bytes: source.to_vec(),
                    kind: SnapshotFileKind::Text,
                },
            )]),
            total_bytes: source.len(),
        };
        let plan = resource_project::resolved_plan_with_cache_root(
            &snapshot,
            &json!({}),
            Some(cache.clone()),
        )
        .unwrap();
        assert!(required_paths(&plan).is_empty());

        let path = resource_project::pinned_resource_paths()
            .unwrap()
            .into_iter()
            .find(|path| !resource_project::is_starter_resource(path).unwrap())
            .unwrap();
        let target = cache.join("data").join(&pinned.digest).join(&path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"typst snapshot isolated fixture").unwrap();
        let inventory =
            build_inventory_at(&cache, &BTreeSet::new(), &plan.input_digest, &pinned).unwrap();
        let context = OperationContext {
            allow_write: true,
            ..OperationContext::default()
        };
        let args = json!({
            "expectedInputDigest": plan.input_digest,
            "expectedCacheDigest": inventory.digest,
            "removePaths": [path],
        });

        let mut stale_snapshot = snapshot.clone();
        stale_snapshot.files.get_mut("main.typ").unwrap().bytes = b"#let value = 2\n".to_vec();
        assert_eq!(
            remove_with_cache(&stale_snapshot, &args, &context, cache.clone())
                .unwrap_err()
                .code,
            "resources.input_changed"
        );
        assert!(target.exists());

        let removed = remove_with_cache(&snapshot, &args, &context, cache.clone()).unwrap();
        assert_eq!(removed["removedFiles"], 1);
        assert!(!target.exists());

        let traversal = json!({
            "expectedInputDigest": plan.input_digest,
            "expectedCacheDigest": args["expectedCacheDigest"],
            "removePaths": ["../outside"],
        });
        assert_eq!(
            remove_with_cache(&snapshot, &traversal, &context, cache)
                .unwrap_err()
                .code,
            "path.symlink_rejected"
        );
    }

    #[test]
    fn compiler_shared_lease_blocks_cache_writer_in_an_isolated_cache() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let pinned = resource_project::pinned_catalog().unwrap();
        let _reader = resource_prepare::acquire_cache_read_lock(
            &cache,
            &pinned.digest,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let result = resource_prepare::acquire_bundle_lock_for_url(
            &cache,
            &pinned.url,
            Instant::now() + Duration::from_millis(100),
        );
        let error = result.err().expect("writer must wait for compiler reader");
        assert_eq!(error.code, "operation.timeout");
    }

    #[cfg(unix)]
    #[test]
    fn unlink_rejects_symlink_cache_targets_without_touching_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let digest = "a".repeat(64);
        let root = cache.join("data").join(&digest);
        fs::create_dir_all(&root).unwrap();
        let outside = temporary.path().join("outside");
        fs::write(&outside, b"preserve").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked.sty")).unwrap();
        let error = safe_unlink(&cache, &digest, "linked.sty", "unused").unwrap_err();
        assert!(
            error.raw_os_error() == Some(libc::ELOOP)
                || error.kind() == std::io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read(outside).unwrap(), b"preserve");
    }

    #[cfg(not(unix))]
    #[test]
    fn non_unix_cache_inventory_is_read_only_and_rejects_removal() {
        use crate::automation::{ProjectSnapshot, SnapshotFile, SnapshotFileKind};
        use std::collections::BTreeMap;

        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("bundles");
        let pinned = resource_project::pinned_catalog().unwrap();
        let path = resource_project::pinned_resource_paths()
            .unwrap()
            .into_iter()
            .find(|path| !resource_project::is_starter_resource(path).unwrap())
            .unwrap();
        let target = cache.join("data").join(&pinned.digest).join(&path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"windows readonly fixture").unwrap();

        let inventory =
            build_inventory_at(&cache, &BTreeSet::new(), &"3".repeat(64), &pinned).unwrap();
        assert_eq!(inventory.entries.len(), 1);
        assert!(!inventory.entries[0].removable);

        let source = b"#let value = 1\n";
        let snapshot = ProjectSnapshot {
            engine: "typst".into(),
            root: PathBuf::new(),
            main_file: "main.typ".into(),
            files: BTreeMap::from([(
                "main.typ".into(),
                SnapshotFile {
                    bytes: source.to_vec(),
                    kind: SnapshotFileKind::Text,
                },
            )]),
            total_bytes: source.len(),
        };
        let plan = resource_project::resolved_plan_with_cache_root(
            &snapshot,
            &json!({}),
            Some(cache.clone()),
        )
        .unwrap();
        let context = OperationContext {
            allow_write: true,
            ..OperationContext::default()
        };
        let args = json!({
            "expectedInputDigest": plan.input_digest,
            "expectedCacheDigest": inventory.digest,
            "removePaths": [path],
        });
        let err = remove_with_cache(&snapshot, &args, &context, cache).unwrap_err();
        assert_eq!(err.code, "resources.cache_read_only");
        assert!(target.exists());
    }
}
