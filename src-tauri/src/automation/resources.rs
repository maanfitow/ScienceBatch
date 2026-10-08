use super::{as_error, AutomationError, OperationContext};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const PREPARE_LIMIT: u64 = 8 * 1024 * 1024 * 1024;
const PREPARE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PREPARE_PROTOCOL_LIMIT: usize = 1024 * 1024;

pub(super) fn status() -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    let cache = cache_directory()?;
    let mut file_count = 0u64;
    let mut byte_count = 0u64;
    let config = tectonic::config::PersistentConfig::open(false).map_err(|e| {
        AutomationError::new(
            "cache.unavailable_offline",
            format!("Cannot read compiler resource configuration: {e}"),
            3,
        )
    })?;
    let bundle_name = tectonic_io_base::app_dirs::sanitize(config.default_bundle_loc());
    let hash_path = cache.join("hashes").join(bundle_name);
    let digest = match fs::symlink_metadata(&hash_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Cached bundle digest must be a regular file.",
                    2,
                ));
            }
            if metadata.len() > 256 {
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Cached bundle digest file exceeds 256 bytes.",
                    3,
                ));
            }
            let file = fs::File::open(&hash_path)
                .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
            let mut value = String::new();
            file.take(257)
                .read_to_string(&mut value)
                .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
            let value = value.trim().to_owned();
            if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    "Cached compiler bundle digest is malformed.",
                    3,
                ));
            }
            Some(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(AutomationError::new(
                "cache.unavailable_offline",
                format!("Cannot inspect cached bundle digest: {error}"),
                3,
            ))
        }
    };
    let index = digest
        .as_ref()
        .map(|value| cache.join("data").join(format!("{value}.index")));
    let expected = if let Some(index_path) = index.as_ref() {
        if index_path.exists() {
            let metadata = fs::symlink_metadata(index_path).map_err(|e| {
                AutomationError::new(
                    "cache.unavailable_offline",
                    format!("Cannot inspect cached bundle index: {e}"),
                    3,
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Cached bundle index must be a regular file.",
                    2,
                ));
            }
            const INDEX_LIMIT: u64 = 32 * 1024 * 1024;
            if metadata.len() > INDEX_LIMIT {
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Cached bundle index exceeds 32 MiB.",
                    3,
                ));
            }
            let file = fs::File::open(index_path)
                .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
            let mut bytes = Vec::new();
            file.take(INDEX_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
            if bytes.len() as u64 > INDEX_LIMIT {
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Cached bundle index exceeds 32 MiB.",
                    3,
                ));
            }
            Some(
                bytes
                    .split(|b| *b == b'\n')
                    .filter(|line| !line.is_empty())
                    .count() as u64,
            )
        } else {
            None
        }
    } else {
        None
    };
    let data = digest.as_ref().map(|value| cache.join("data").join(value));
    if let Some(root) = data.as_ref() {
        count_cache(root, &mut file_count, &mut byte_count, 0)?;
    }
    let ready = expected.is_some_and(|count| file_count >= count);
    Ok((
        json!({"engines":[{"engine":"latex","available":true,"cached":ready,"cacheLocation":cache},{"engine":"typst","available":true,"cached":true,"cacheLocation":"bundled"}],"cacheLocation":cache,"cacheDirectory":cache,"digestCached":digest.is_some(),"indexCached":index.as_ref().is_some_and(|path|path.is_file()),"cachedFiles":file_count,"expectedFiles":expected,"cachedBytes":byte_count,"ready":ready}),
        vec![],
    ))
}

fn cache_directory() -> Result<std::path::PathBuf, AutomationError> {
    if let Some(root) = std::env::var_os("TECTONIC_CACHE_DIR") {
        return Ok(std::path::PathBuf::from(root).join("bundles"));
    }
    let dirs = tectonic_io_base::app_dirs::directories::ProjectDirs::from(
        "",
        "TectonicProject",
        "Tectonic",
    )
    .ok_or_else(|| {
        AutomationError::new(
            "io.project_unavailable",
            "Cannot determine compiler cache directory.",
            3,
        )
    })?;
    Ok(dirs.cache_dir().join("bundles"))
}

fn count_cache(
    path: &std::path::Path,
    files: &mut u64,
    bytes: &mut u64,
    depth: usize,
) -> Result<(), AutomationError> {
    if depth > 64 {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Compiler resource cache exceeds traversal depth.",
            3,
        ));
    }
    let root_meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(AutomationError::new(
                "cache.unavailable_offline",
                format!("Cannot inspect compiler resource cache: {error}"),
                3,
            ))
        }
    };
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Compiler cache entries must be real directories.",
            2,
        ));
    }
    for entry in fs::read_dir(path).map_err(|e| {
        AutomationError::new(
            "cache.unavailable_offline",
            format!("Cannot enumerate compiler resource cache: {e}"),
            3,
        )
    })? {
        let entry = entry.map_err(|e| {
            AutomationError::new(
                "cache.unavailable_offline",
                format!("Cannot read compiler cache entry: {e}"),
                3,
            )
        })?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| {
            AutomationError::new(
                "cache.unavailable_offline",
                format!("Cannot inspect compiler cache entry: {e}"),
                3,
            )
        })?;
        if meta.file_type().is_symlink() {
            return Err(as_error(
                "path.symlink_rejected",
                "Compiler cache contains a symbolic link.",
                2,
            ));
        }
        if meta.is_dir() {
            count_cache(&entry.path(), files, bytes, depth + 1)?;
        } else if meta.is_file() && !entry.file_name().to_string_lossy().contains("-tmp-pid") {
            *files += 1;
            *bytes = bytes.saturating_add(meta.len());
        }
    }
    Ok(())
}

pub(super) async fn prepare(
    args: &Value,
    context: &OperationContext,
) -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    let engine = args
        .get("engine")
        .and_then(Value::as_str)
        .unwrap_or("latex")
        .to_ascii_lowercase();
    if engine == "typst" {
        return Ok((
            json!({"engine":"typst","prepared":true,"files":0,"bytesDownloaded":0,"resumable":false,"cacheLocation":"bundled"}),
            vec![],
        ));
    }
    if engine != "latex" {
        return Err(as_error(
            "engine.unsupported",
            "Resource preparation engine must be latex or typst.",
            2,
        ));
    }
    if !context.allow_resource_download {
        return Err(as_error(
            "permission.resource_download_required",
            "Resource preparation requires --allow-resource-download.",
            2,
        ));
    }
    if context.cancelled() {
        return Err(as_error(
            "operation.interrupted",
            "Resource preparation was cancelled.",
            130,
        ));
    }
    let executable = super::worker_executable()?;
    let cache_location = cache_directory()?.to_string_lossy().into_owned();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut guard = PrepareDropCancel(Some(sender));
    let cancellation = context.cancellation.clone();
    let task = tokio::spawn(run_prepare_process(executable, cancellation, receiver));
    let (value, diagnostics) = task.await.map_err(|e| {
        AutomationError::new(
            "worker.crashed",
            format!("Resource worker supervisor failed: {e}"),
            4,
        )
    })??;
    guard.0.take();
    let mut value = value;
    if let Some(object) = value.as_object_mut() {
        object.insert("cacheLocation".into(), Value::String(cache_location));
    }
    Ok((value, diagnostics))
}

struct PrepareDropCancel(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for PrepareDropCancel {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

async fn run_prepare_process(
    executable: std::path::PathBuf,
    cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    drop_cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    run_prepare_process_with_timeout(executable, cancellation, drop_cancel, PREPARE_TIMEOUT).await
}

async fn run_prepare_process_with_timeout(
    executable: std::path::PathBuf,
    cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    drop_cancel: tokio::sync::oneshot::Receiver<()>,
    timeout: Duration,
) -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    let mut child = Command::new(executable)
        .arg("--resource-prepare-worker")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            AutomationError::new(
                "worker.crashed",
                format!("Cannot start resource preparation worker: {e}"),
                4,
            )
        })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        as_error(
            "worker.crashed",
            "Resource worker stdout is unavailable.",
            4,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        as_error(
            "worker.crashed",
            "Resource worker stderr is unavailable.",
            4,
        )
    })?;
    let (overflow_sender, mut overflow_receiver) = tokio::sync::mpsc::unbounded_channel();
    let out = tokio::spawn(read_bounded(
        stdout,
        PREPARE_PROTOCOL_LIMIT,
        overflow_sender.clone(),
    ));
    let err = tokio::spawn(read_bounded(stderr, super::MAX_LOG_BYTES, overflow_sender));
    let deadline = tokio::time::Instant::now() + timeout;
    tokio::pin!(drop_cancel);
    let status = loop {
        if cancellation.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = out.await;
            let _ = err.await;
            return Err(as_error(
                "operation.interrupted",
                "Resource preparation was cancelled and reaped.",
                130,
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = out.await;
            let _ = err.await;
            return Err(as_error(
                "operation.timeout",
                "Resource preparation exceeded 30 minutes and was reaped.",
                124,
            ));
        }
        tokio::select! {s=child.wait()=>break s.map_err(|e|AutomationError::new("worker.crashed",format!("Cannot wait for resource worker: {e}"),4))?,Some(())=overflow_receiver.recv()=>{let _=child.kill().await;let _=child.wait().await;let _=out.await;let _=err.await;return Err(as_error("resource.limit_exceeded","Resource worker output exceeded its protocol or log limit; the worker was reaped.",3));},_= &mut drop_cancel=>{let _=child.kill().await;let _=child.wait().await;let _=out.await;let _=err.await;return Err(as_error("operation.interrupted","Resource preparation request was dropped and its worker was reaped.",130));},_=tokio::time::sleep(Duration::from_millis(100))=>{}}
    };
    let (stdout, overflow) = out
        .await
        .map_err(|e| AutomationError::new("worker.crashed", e.to_string(), 4))?
        .map_err(|e| AutomationError::new("worker.crashed", e.to_string(), 4))?;
    let (stderr, log_overflow) = err
        .await
        .map_err(|e| AutomationError::new("worker.crashed", e.to_string(), 4))?
        .map_err(|e| AutomationError::new("worker.crashed", e.to_string(), 4))?;
    if overflow || log_overflow {
        return Err(as_error(
            "resource.limit_exceeded",
            "Resource worker response exceeded its limit.",
            3,
        ));
    }
    if !status.success() {
        return Err(AutomationError::new(
            "worker.crashed",
            format!(
                "Resource worker failed: {}",
                String::from_utf8_lossy(&stderr)
            ),
            4,
        ));
    }
    let response: PrepareResponse = serde_json::from_slice(&stdout).map_err(|e| {
        AutomationError::new(
            "worker.protocol_invalid",
            format!("Invalid resource worker response: {e}"),
            4,
        )
    })?;
    if !response.ok {
        let code = match response.code.as_deref() {
            Some("resource.limit_exceeded") => "resource.limit_exceeded",
            Some("operation.timeout") => "operation.timeout",
            _ => "cache.unavailable_offline",
        };
        return Err(AutomationError::new(
            code,
            response
                .message
                .unwrap_or_else(|| "Resource preparation failed.".into()),
            if code == "operation.timeout" { 124 } else { 3 },
        ));
    }
    Ok((
        json!({"engine":"latex","prepared":true,"files":response.files,"bytesDownloaded":response.downloaded_bytes,"resumable":true}),
        vec![],
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicU64;

    static SCRIPT_ID: AtomicU64 = AtomicU64::new(1);

    #[tokio::test]
    async fn resource_preparation_timeout_kills_and_reaps_the_worker() {
        let path = std::env::temp_dir().join(format!(
            "sciencebatch-resource-prepare-test-{}-{}.sh",
            std::process::id(),
            SCRIPT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::write(&path, "#!/bin/sh\nexec sleep 10\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let result = run_prepare_process_with_timeout(
            path.clone(),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            receiver,
            Duration::from_millis(40),
        )
        .await
        .unwrap_err();
        drop(sender);
        let _ = fs::remove_file(path);
        assert_eq!(result.code, "operation.timeout", "{}", result.message);
        assert_eq!(result.exit_code, 124, "{}", result.message);
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    overflow_sender: tokio::sync::mpsc::UnboundedSender<()>,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut over = false;
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let rest = limit.saturating_sub(out.len());
        if n > rest {
            out.extend_from_slice(&buf[..rest]);
            over = true;
            let _ = overflow_sender.send(());
        } else {
            out.extend_from_slice(&buf[..n]);
        }
    }
    Ok((out, over))
}

#[derive(Deserialize)]
struct PrepareResponse {
    ok: bool,
    files: Option<usize>,
    downloaded_bytes: Option<u64>,
    code: Option<String>,
    message: Option<String>,
}

pub fn run_prepare_worker() {
    use tectonic::status::NoopStatusBackend;
    use tectonic_bundles::{detect_bundle, Bundle};
    use tectonic_io_base::OpenResult;
    tectonic_bundles::cache::set_network_download_limit(PREPARE_LIMIT);
    let config = match tectonic::config::PersistentConfig::open(false) {
        Ok(c) => c,
        Err(e) => emit_prepare_error(
            "cache.unavailable_offline",
            format!("Cannot open compiler resource config: {e}"),
        ),
    };
    let mut bundle = match detect_bundle(config.default_bundle_loc().to_owned(), false, None) {
        Ok(Some(b)) => b,
        Ok(None) => emit_prepare_error(
            "cache.unavailable_offline",
            "The default compiler bundle is unavailable.".into(),
        ),
        Err(e) => emit_prepare_error(
            "cache.unavailable_offline",
            format!("Cannot open the default compiler bundle: {e}"),
        ),
    };
    let mut status = NoopStatusBackend::default();
    // Trigger lazy index initialization before enumerating the current bundle.
    match bundle.input_open_name("latex.ltx", &mut status) {
        OpenResult::Err(e) => emit_prepare_error(
            "cache.unavailable_offline",
            format!("Cannot prepare compiler bundle index: {e}"),
        ),
        OpenResult::Ok(mut h) => {
            let mut sink = std::io::sink();
            let _ = std::io::copy(&mut h, &mut sink);
        }
        OpenResult::NotAvailable => {}
    }
    let names = bundle.all_files();
    let mut completed = 0usize;
    for name in names {
        match bundle.input_open_name(&name, &mut status) {
            OpenResult::Ok(mut handle) => {
                let mut sink = std::io::sink();
                if let Err(e) = std::io::copy(&mut handle, &mut sink) {
                    emit_prepare_error(
                        "resource.limit_exceeded",
                        format!(
                            "Resource preparation stopped at the configured transfer limit: {e}"
                        ),
                    );
                }
                completed += 1;
            }
            OpenResult::Err(e) => emit_prepare_error(
                if e.to_string().contains("byte limit") {
                    "resource.limit_exceeded"
                } else {
                    "cache.unavailable_offline"
                },
                format!("Cannot cache compiler resource '{name}': {e}"),
            ),
            OpenResult::NotAvailable => emit_prepare_error(
                "cache.unavailable_offline",
                format!("Compiler resource '{name}' is unavailable."),
            ),
        }
    }
    let downloaded = tectonic_bundles::cache::downloaded_bytes();
    emit_prepare_success(completed, downloaded);
}

fn emit_prepare_success(files: usize, downloaded: u64) {
    let value = json!({"ok":true,"files":files,"downloaded_bytes":downloaded});
    let _ = serde_json::to_writer(std::io::stdout().lock(), &value);
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(b"\n");
    std::process::exit(0);
}
fn emit_prepare_error(code: &str, message: String) -> ! {
    let value = json!({"ok":false,"code":code,"message":message});
    let _ = serde_json::to_writer(std::io::stdout().lock(), &value);
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(b"\n");
    std::process::exit(0);
}
