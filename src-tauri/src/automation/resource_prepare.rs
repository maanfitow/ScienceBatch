//! Explicit selective preparation for a freshly analyzed project plan.
use super::resource_project::{self, CacheState};
use super::{as_error, AutomationError, OperationContext, ProjectSnapshot, ResourceProgress};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tectonic_bundles::{CachableBundle, FileInfo};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const WORKER_INPUT_LIMIT: usize = 1024 * 1024;
const WORKER_FRAME_LIMIT: usize = 64 * 1024;
const WORKER_TERMINAL_LIMIT: usize = 1024 * 1024;
const WORKER_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_TRANSFER_LIMIT: u64 = 512 * 1024 * 1024;
const DEFAULT_STORAGE_LIMIT: u64 = 512 * 1024 * 1024;
const MAX_BUDGET: u64 = 8 * 1024 * 1024 * 1024;
const CACHE_LIMIT: u64 = 8 * 1024 * 1024 * 1024;
const WORKER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
static TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkerRequest {
    schema_version: u32,
    job_id: String,
    bundle_digest: String,
    index_sha256: String,
    plan_digest: String,
    max_download_bytes: u64,
    max_storage_bytes: u64,
    paths: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkerFrame {
    schema_version: u32,
    kind: String,
    job_id: String,
    bundle_digest: String,
    #[serde(default)]
    phase: String,
    #[serde(default)]
    completed_resources: usize,
    #[serde(default)]
    total_resources: usize,
    #[serde(default)]
    downloaded_bytes: u64,
    #[serde(default)]
    max_download_bytes: u64,
    #[serde(default)]
    resource_path: Option<String>,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

pub(super) async fn prepare_snapshot(
    snapshot: &ProjectSnapshot,
    args: &Value,
    context: &OperationContext,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(Value, Vec<super::PublicDiagnostic>), AutomationError> {
    if !context.allow_resource_download {
        return Err(as_error(
            "permission.resource_download_required",
            "Selective resource preparation requires explicit download permission.",
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
    let expected_plan = args
        .get("expectedPlanDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "expectedPlanDigest is required.",
                2,
            )
        })?;
    let plan = resource_project::resolved_plan(snapshot, args)?;
    if expected_plan != plan.plan_digest {
        return Err(as_error(
            "resources.plan_changed",
            "The resource plan changed; analyze the project again before preparing it.",
            2,
        ));
    }
    if plan.engine == "typst" {
        return Ok((
            json!({"resourceSchemaVersion":1,"planDigest":plan.plan_digest,"inputDigest":plan.input_digest,"engine":"typst","projectState":"prepared_known_set","prepared":true,"files":0,"bytesDownloaded":0,"plan":resource_project::plan_summary_for_external(&plan)?}),
            vec![],
        ));
    }
    let pinned = resource_project::pinned_catalog()?;
    let paths = plan
        .requirements
        .iter()
        .filter(|row| row.provider == "pinned_bundle" && row.availability != "embedded")
        .filter_map(|row| row.path.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if paths.len() > 20_000 {
        return Err(as_error(
            "resource.limit_exceeded",
            "Resource selection exceeds 20,000 paths.",
            3,
        ));
    }
    let max_download_bytes = budget_arg(args, "maxDownloadBytes", DEFAULT_TRANSFER_LIMIT)?;
    let max_storage_bytes = budget_arg(args, "maxStorageBytes", DEFAULT_STORAGE_LIMIT)?;
    if plan.estimated_transfer_bytes > max_download_bytes {
        return Err(as_error("resource.limit_exceeded", "Estimated transfer exceeds maxDownloadBytes.", 3)
            .with_details(json!({"estimatedTransferBytes":plan.estimated_transfer_bytes,"maxDownloadBytes":max_download_bytes})));
    }
    if plan.incremental_storage_bytes > max_storage_bytes {
        return Err(as_error("resource.limit_exceeded", "Estimated storage exceeds maxStorageBytes.", 3)
            .with_details(json!({"incrementalStorageBytes":plan.incremental_storage_bytes,"maxStorageBytes":max_storage_bytes})));
    }
    if paths.is_empty() {
        let output = prepared_without_download(snapshot, args, &plan, &pinned)?;
        return Ok((output, vec![]));
    }
    let job_id = format!(
        "{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let request = WorkerRequest {
        schema_version: 1,
        job_id: job_id.clone(),
        bundle_digest: pinned.digest.clone(),
        index_sha256: pinned.index_sha256.clone(),
        plan_digest: plan.plan_digest.clone(),
        max_download_bytes,
        max_storage_bytes,
        paths,
    };
    let request_bytes = serde_json::to_vec(&request)
        .map_err(|error| AutomationError::new("worker.protocol_invalid", error.to_string(), 4))?;
    if request_bytes.len() > WORKER_INPUT_LIMIT {
        return Err(as_error(
            "resource.limit_exceeded",
            "Resource worker request exceeds 1 MiB.",
            3,
        ));
    }
    let executable = super::worker_executable()?;
    let cache_location = super::resources::cache_directory()?
        .to_string_lossy()
        .into_owned();
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let mut drop_guard = DropCancel(Some(cancel_sender));
    let cancellation = context.cancellation.clone();
    let progress = context.resource_progress.clone();
    let task = tokio::spawn(run_worker_process(
        executable,
        request_bytes,
        job_id,
        pinned.digest,
        cancellation,
        progress,
        cancel_receiver,
        permit,
    ));
    let output = task.await.map_err(|error| {
        AutomationError::new(
            "worker.crashed",
            format!("Resource worker supervisor failed: {error}"),
            4,
        )
    })??;
    drop_guard.0.take();
    let final_plan = resource_project::resolved_plan(snapshot, args)?;
    validate_prepared_plan(&plan, &final_plan)?;
    let mut output = output;
    if let Some(object) = output.as_object_mut() {
        object.insert("cacheLocation".into(), Value::String(cache_location));
        object.insert(
            "plan".into(),
            resource_project::plan_summary_for_external(&final_plan)?,
        );
        object.insert(
            "planDigest".into(),
            Value::String(final_plan.plan_digest.clone()),
        );
        object.insert(
            "inputDigest".into(),
            Value::String(final_plan.input_digest.clone()),
        );
    }
    if serde_json::to_vec(&output)
        .map_or(true, |encoded| encoded.len() > WORKER_TERMINAL_LIMIT - 4096)
    {
        return Err(as_error(
            "resource.limit_exceeded",
            "Resource preparation summary exceeds 1 MiB.",
            3,
        ));
    }
    Ok((output, vec![]))
}

fn prepared_without_download(
    snapshot: &ProjectSnapshot,
    args: &Value,
    expected_plan: &resource_project::ResourcePlan,
    pinned: &resource_project::PinnedCatalog,
) -> Result<Value, AutomationError> {
    let final_plan = resource_project::resolved_plan(snapshot, args)?;
    validate_prepared_plan(expected_plan, &final_plan)?;
    let cache_location = super::resources::cache_directory()?
        .to_string_lossy()
        .into_owned();
    let output = json!({
        "resourceSchemaVersion": 1,
        "prepared": true,
        "files": 0,
        "cachedFiles": final_plan.cached_verified_resources,
        "bytesDownloaded": 0,
        "budgetChargedBytes": 0,
        "firstAttemptTransferEstimateBytes": 0,
        "incrementalStorageBytes": 0,
        "reservedStorageBytes": 0,
        "bundleDigest": pinned.digest,
        "indexSha256": pinned.index_sha256,
        "catalogSha256": pinned.catalog_sha256,
        "planDigest": final_plan.plan_digest,
        "inputDigest": final_plan.input_digest,
        "provenance": "locally captured QA cache; not upstream authentication",
        "cacheLocation": cache_location,
        "projectState": "prepared_known_set",
        "plan": resource_project::plan_summary_for_external(&final_plan)?,
    });
    if serde_json::to_vec(&output)
        .map_or(true, |encoded| encoded.len() > WORKER_TERMINAL_LIMIT - 4096)
    {
        return Err(as_error(
            "resource.limit_exceeded",
            "Resource preparation summary exceeds 1 MiB.",
            3,
        ));
    }
    Ok(output)
}

fn validate_prepared_plan(
    expected_plan: &resource_project::ResourcePlan,
    final_plan: &resource_project::ResourcePlan,
) -> Result<(), AutomationError> {
    if final_plan.plan_digest != expected_plan.plan_digest
        || final_plan.input_digest != expected_plan.input_digest
    {
        return Err(as_error(
            "resources.plan_changed",
            "The project snapshot changed while resources were being prepared.",
            2,
        ));
    }
    if final_plan.project_state != "prepared_known_set"
        || final_plan.missing_resources > 0
        || final_plan.invalid_resources > 0
        || !matches!(
            final_plan.bundle_metadata_state.as_str(),
            "cached_verified" | "embedded"
        )
    {
        return Err(as_error(
            "cache.integrity_failed",
            "Resource preparation finished without a complete verified known set.",
            3,
        ));
    }
    Ok(())
}

fn budget_arg(args: &Value, field: &str, default: u64) -> Result<u64, AutomationError> {
    let value = match args.get(field) {
        None => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                format!("{field} must be a non-negative integer."),
                2,
            )
        })?,
    };
    if value == 0 || value > MAX_BUDGET {
        return Err(as_error(
            "usage.invalid_argument",
            format!("{field} must be between 1 and 8 GiB."),
            2,
        ));
    }
    Ok(value)
}

struct DropCancel(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for DropCancel {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

async fn run_worker_process(
    executable: PathBuf,
    bytes: Vec<u8>,
    job_id: String,
    bundle_digest: String,
    cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    progress: Option<tokio::sync::broadcast::Sender<ResourceProgress>>,
    drop_cancel: tokio::sync::oneshot::Receiver<()>,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Value, AutomationError> {
    run_worker_process_with_timeout(
        executable,
        bytes,
        job_id,
        bundle_digest,
        cancellation,
        progress,
        drop_cancel,
        permit,
        WORKER_TIMEOUT,
    )
    .await
}

async fn run_worker_process_with_timeout(
    executable: PathBuf,
    bytes: Vec<u8>,
    job_id: String,
    bundle_digest: String,
    cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    progress: Option<tokio::sync::broadcast::Sender<ResourceProgress>>,
    drop_cancel: tokio::sync::oneshot::Receiver<()>,
    permit: tokio::sync::OwnedSemaphorePermit,
    timeout: Duration,
) -> Result<Value, AutomationError> {
    let mut child = Command::new(executable)
        .arg("--resource-project-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AutomationError::new(
                "worker.crashed",
                format!("Cannot start selective resource worker: {error}"),
                4,
            )
        })?;
    let (stdin, stdout, stderr) =
        match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                drop(permit);
                return Err(as_error(
                    "worker.crashed",
                    "Selective resource worker pipes are unavailable; the child was reaped.",
                    4,
                ));
            }
        };
    let writer = tokio::spawn(async move {
        let mut stdin = stdin;
        stdin.write_all(&bytes).await?;
        stdin.shutdown().await
    });
    let (frame_tx, mut frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Vec<u8>, String>>();
    let stdout_task = tokio::spawn(read_frames(stdout, frame_tx));
    let mut stderr_task = tokio::spawn(read_bounded(stderr, super::MAX_LOG_BYTES));
    let mut writer = writer;
    let deadline = tokio::time::Instant::now() + timeout;
    tokio::pin!(drop_cancel);
    let mut terminal: Option<WorkerFrame> = None;
    let mut output_bytes = 0usize;
    let mut child_status = None;
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut stderr_result: Option<Result<Vec<u8>, std::io::Error>> = None;
    let mut writer_done = false;
    let mut fatal: Option<AutomationError> = None;
    loop {
        if child_status.is_some() && stdout_done && stderr_done && writer_done {
            break;
        }
        if cancellation.load(std::sync::atomic::Ordering::Relaxed) {
            fatal = Some(as_error(
                "operation.interrupted",
                "Resource preparation was cancelled and reaped.",
                130,
            ));
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            fatal = Some(as_error(
                "operation.timeout",
                "Resource preparation exceeded 30 minutes and was reaped.",
                124,
            ));
            break;
        }
        tokio::select! {
            status = child.wait(), if child_status.is_none() => match status { Ok(status)=>child_status=Some(status),Err(error)=>{fatal=Some(AutomationError::new("worker.crashed",format!("Cannot wait for resource worker: {error}"),4));break;} },
            frame = frame_rx.recv(), if !stdout_done => match frame {
                Some(Ok(line)) => {
                    output_bytes=output_bytes.saturating_add(line.len());
                    if output_bytes>WORKER_OUTPUT_LIMIT {fatal=Some(as_error("resource.limit_exceeded","Resource worker protocol exceeded 16 MiB; the worker was reaped.",3));break;}
                    let frame:WorkerFrame=match serde_json::from_slice(&line){Ok(frame)=>frame,Err(error)=>{fatal=Some(AutomationError::new("worker.protocol_invalid",format!("Malformed resource worker frame: {error}"),4));break;}};
                    let frame_limit = if frame.kind == "progress" { WORKER_FRAME_LIMIT } else { WORKER_TERMINAL_LIMIT };
                    if line.len() > frame_limit { fatal=Some(as_error("worker.protocol_invalid","Resource worker frame exceeded its kind-specific size limit.",4));break; }
                    if frame.schema_version!=1 || (frame.kind!="error"&&(frame.job_id!=job_id||frame.bundle_digest!=bundle_digest)) {fatal=Some(as_error("worker.protocol_invalid","Resource worker frame identity did not match its request.",4));break;}
                    if terminal.is_some(){fatal=Some(as_error("worker.protocol_invalid","Resource worker emitted a frame after its terminal result.",4));break;}
                    match frame.kind.as_str(){
                        "progress"=>{if frame.completed_resources>frame.total_resources||frame.downloaded_bytes>frame.max_download_bytes {fatal=Some(as_error("worker.protocol_invalid","Resource worker progress exceeded its declared bounds.",4));break;}if frame.resource_path.as_ref().is_some_and(|path| !resource_project::safe_bundle_path_for_cache(path)) {fatal=Some(as_error("worker.protocol_invalid","Resource worker progress contained an unsafe resource path.",4));break;}if let Some(sender)=&progress{let _=sender.send(ResourceProgress{job_id:frame.job_id,bundle_digest:frame.bundle_digest,phase:frame.phase,completed_resources:frame.completed_resources,total_resources:frame.total_resources,downloaded_bytes:frame.downloaded_bytes,max_download_bytes:frame.max_download_bytes,resource_path:frame.resource_path});}},
                        "result"|"error"=>terminal=Some(frame),
                        _=>{fatal=Some(as_error("worker.protocol_invalid","Unknown resource worker frame kind.",4));break;}
                    }
                }
                Some(Err(message))=>{fatal=Some(as_error("worker.protocol_invalid",message,4));break;}
                None=>stdout_done=true,
            },
            result = &mut stderr_task, if !stderr_done => {stderr_done=true;stderr_result=Some(match result{Ok(result)=>result,Err(error)=>Err(std::io::Error::other(error.to_string()))});if stderr_result.as_ref().is_some_and(Result::is_err){fatal=Some(as_error("resource.limit_exceeded","Resource worker stderr exceeded 1 MiB; the worker was reaped.",3));break;}},
            result = &mut writer, if !writer_done => {writer_done=true;match result{Ok(Ok(()))=>{},Ok(Err(error))=>{fatal=Some(AutomationError::new("worker.crashed",format!("Cannot send resource worker request: {error}"),4));break;},Err(error)=>{fatal=Some(AutomationError::new("worker.crashed",format!("Cannot send resource worker request: {error}"),4));break;}}},
            _ = &mut drop_cancel => {fatal=Some(as_error("operation.interrupted","Resource request was dropped and its worker was reaped.",130));break;},
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
    if let Some(error) = fatal {
        let _ = child.kill().await;
        let _ = child.wait().await;
        cleanup_staging_for_job(&bundle_digest, &job_id);
        if !writer_done {
            let _ = writer.await;
        }
        let _ = stdout_task.await;
        if !stderr_done {
            let _ = stderr_task.await;
        }
        drop(permit);
        return Err(error);
    }
    let status = child_status
        .ok_or_else(|| as_error("worker.crashed", "Resource worker did not exit.", 4))?;
    cleanup_staging_for_job(&bundle_digest, &job_id);
    let stderr = stderr_result
        .unwrap_or_else(|| Ok(Vec::new()))
        .map_err(|error| AutomationError::new("worker.crashed", error.to_string(), 4))?;
    if !writer_done {
        let _ = writer.await;
    }
    let _ = stdout_task.await;
    drop(permit);
    if !status.success() {
        return Err(AutomationError::new(
            "worker.crashed",
            format!(
                "Selective resource worker failed: {}",
                String::from_utf8_lossy(&stderr)
            ),
            4,
        ));
    }
    let frame = terminal.ok_or_else(|| {
        as_error(
            "worker.protocol_invalid",
            "Resource worker exited without a terminal frame.",
            4,
        )
    })?;
    if frame.kind == "error" {
        let code = match frame.code.as_deref() {
            Some("resource.limit_exceeded") => "resource.limit_exceeded",
            Some("resources.bundle_identity_mismatch") => "resources.bundle_identity_mismatch",
            Some("resources.selector_unknown") => "resources.selector_unknown",
            Some("resources.selector_invalid") => "resources.selector_invalid",
            Some("resources.catalog_invalid") => "resources.catalog_invalid",
            Some("path.symlink_rejected") => "path.symlink_rejected",
            Some("cache.integrity_failed") => "cache.integrity_failed",
            Some("operation.timeout") => "operation.timeout",
            Some("worker.crashed") => "worker.crashed",
            _ => "cache.unavailable_offline",
        };
        return Err(AutomationError::new(
            code,
            frame
                .message
                .unwrap_or_else(|| "Selective preparation failed.".into()),
            if code == "operation.timeout" {
                124
            } else if code == "worker.crashed" {
                4
            } else {
                3
            },
        )
        .with_details(frame.data.unwrap_or(Value::Null)));
    }
    let data = frame.data.ok_or_else(|| {
        as_error(
            "worker.protocol_invalid",
            "Resource worker result has no data.",
            4,
        )
    })?;
    if serde_json::to_vec(&data).map_or(true, |encoded| encoded.len() > 1024 * 1024) {
        return Err(as_error(
            "resource.limit_exceeded",
            "Resource worker terminal data exceeds 1 MiB.",
            3,
        ));
    }
    Ok(data)
}

async fn read_frames<R: AsyncRead + Unpin>(
    mut reader: R,
    sender: tokio::sync::mpsc::UnboundedSender<Result<Vec<u8>, String>>,
) {
    let mut buffer = [0u8; 8192];
    let mut current = Vec::new();
    let mut total = 0usize;
    let mut frame_count = 0usize;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                if !current.is_empty() {
                    let _ =
                        sender.send(Err("Resource worker ended with an incomplete frame.".into()));
                }
                break;
            }
            Ok(n) => {
                total = total.saturating_add(n);
                if total > WORKER_OUTPUT_LIMIT {
                    let _ = sender.send(Err("Resource worker output exceeded 16 MiB.".into()));
                    break;
                }
                for byte in &buffer[..n] {
                    if *byte == b'\n' {
                        frame_count = frame_count.saturating_add(1);
                        if current.is_empty()
                            || current.len() > WORKER_TERMINAL_LIMIT
                            || frame_count > 40_100
                        {
                            let _ = sender.send(Err(
                                "Resource worker frame count or size exceeded its bound.".into(),
                            ));
                            return;
                        }
                        if sender.send(Ok(std::mem::take(&mut current))).is_err() {
                            return;
                        }
                    } else {
                        current.push(*byte);
                        if current.len() > WORKER_FRAME_LIMIT {
                            let _ =
                                sender.send(Err("Resource worker frame exceeded 64 KiB.".into()));
                            return;
                        }
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error.to_string()));
                break;
            }
        }
    }
}
async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let mut out = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        if out.len().saturating_add(n) > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "worker stderr exceeded 1 MiB",
            ));
        }
        out.extend_from_slice(&buffer[..n]);
    }
    Ok(out)
}

pub fn run_worker() {
    let mut input = Vec::new();
    if std::io::stdin()
        .take((WORKER_INPUT_LIMIT + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
        || input.len() > WORKER_INPUT_LIMIT
    {
        emit_error(
            "resource.limit_exceeded",
            "Selective worker request exceeds 1 MiB.",
            Value::Null,
        );
        return;
    }
    let request: WorkerRequest = match serde_json::from_slice(&input) {
        Ok(request) => request,
        Err(error) => {
            emit_error(
                "worker.protocol_invalid",
                format!("Invalid selective worker request: {error}"),
                Value::Null,
            );
            return;
        }
    };
    emit_progress(
        &request.job_id,
        &request.bundle_digest,
        "validating",
        0,
        request.paths.len(),
        0,
        request.max_download_bytes,
        None,
    );
    let result = std::thread::Builder::new()
        .name("resource-project-preparation".into())
        .spawn(move || run_worker_blocking(request));
    match result {
        Ok(thread) => match thread.join() {
            Ok(Ok(data)) => emit_result(data),
            Ok(Err(error)) => emit_error(
                error.code,
                &error.message,
                error.details.unwrap_or(Value::Null),
            ),
            Err(_) => emit_error(
                "worker.crashed",
                "Selective resource worker panicked.",
                Value::Null,
            ),
        },
        Err(error) => emit_error(
            "worker.crashed",
            format!("Cannot start selective preparation thread: {error}"),
            Value::Null,
        ),
    }
}

fn run_worker_blocking(request: WorkerRequest) -> Result<Value, AutomationError> {
    use tectonic_status_base::NoopStatusBackend;
    if request.schema_version != 1
        || request.paths.len() > 20_000
        || request.bundle_digest.len() != 64
        || !request
            .bundle_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.index_sha256.len() != 64
        || !request
            .index_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.plan_digest.len() != 64
        || !request
            .plan_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.job_id.len() > 128
        || request.max_download_bytes == 0
        || request.max_storage_bytes == 0
        || request.max_download_bytes > MAX_BUDGET
        || request.max_storage_bytes > MAX_BUDGET
    {
        return Err(as_error(
            "worker.protocol_invalid",
            "Selective worker request violates schema or limits.",
            4,
        ));
    }
    let pinned = resource_project::pinned_catalog()?;
    if request.bundle_digest != pinned.digest || request.index_sha256 != pinned.index_sha256 {
        return Err(as_error(
            "resources.bundle_identity_mismatch",
            "Selective worker bundle identity does not match the pinned catalog.",
            3,
        ));
    }
    for path in &request.paths {
        if resource_project::is_starter_resource(path)? {
            return Err(as_error(
                "resources.selector_invalid",
                "Embedded starter resources are already available and cannot be downloaded.",
                2,
            ));
        }
    }
    let descriptors = resource_project::pinned_descriptors(&request.paths)?;
    let config = tectonic::config::PersistentConfig::open(false)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if config.default_bundle_loc() != pinned.url {
        return Err(as_error(
            "resources.bundle_identity_mismatch",
            "The configured default bundle URL does not match the pinned resource catalog.",
            3,
        ));
    }
    let cache = super::resources::cache_directory()?;
    ensure_safe_directory(&cache)?;
    let root = cache.join("data").join(&pinned.digest);
    if !request
        .job_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(as_error(
            "worker.protocol_invalid",
            "Resource job ID contains invalid characters.",
            4,
        ));
    }
    let _lock = acquire_bundle_lock(&cache, &pinned.digest, Instant::now() + WORKER_TIMEOUT)?;
    let mut missing = Vec::new();
    let mut storage = 0u64;
    let mut reserved_storage = 0u64;
    let mut resource_directories = BTreeSet::new();
    let mut cached = 0usize;
    for descriptor in &descriptors {
        let indexed = resource_project::IndexedResource {
            offset: descriptor.offset,
            length: descriptor.length,
            sha256: descriptor.sha256.clone(),
        };
        match resource_project::verify_cached_resource(&root, &descriptor.path, &indexed) {
            CacheState::Verified => cached += 1,
            CacheState::Missing | CacheState::Invalid => {
                missing.push(descriptor.path.clone());
                storage = storage.saturating_add(descriptor.length);
                reserved_storage =
                    reserved_storage.saturating_add(allocated_reservation(descriptor.length));
                let parent = Path::new(&descriptor.path)
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .to_string_lossy()
                    .into_owned();
                if !parent.is_empty() {
                    let mut current = PathBuf::new();
                    for component in Path::new(&parent).components() {
                        current.push(component.as_os_str());
                        resource_directories.insert(current.clone());
                    }
                }
            }
        }
    }
    if storage > request.max_storage_bytes {
        return Err(as_error(
            "resource.limit_exceeded",
            "Incremental resource storage exceeds the requested storage budget.",
            3,
        ));
    }
    let estimate = resource_project::estimate_pinned_transfer_bytes(&missing)?;
    if estimate > request.max_download_bytes {
        return Err(as_error("resource.limit_exceeded","First-attempt transfer estimate exceeds the requested download budget.",3).with_details(json!({"estimatedTransferBytes":estimate,"maxDownloadBytes":request.max_download_bytes})));
    }
    let pinned_bytes = pinned.index_bytes.as_slice();
    let hash_path = cache
        .join("hashes")
        .join(tectonic_io_base::app_dirs::sanitize(&pinned.url));
    let index_path = cache.join("data").join(format!("{}.index", pinned.digest));
    let metadata_storage = if hash_path.exists() {
        0
    } else {
        pinned.digest.len() as u64
    }
    .saturating_add(if index_path.exists() {
        0
    } else {
        pinned_bytes.len() as u64
    });
    let resource_reservation =
        reserved_storage.saturating_add((resource_directories.len() as u64).saturating_mul(4096));
    if resource_reservation > request.max_storage_bytes {
        return Err(as_error(
            "resource.limit_exceeded",
            "Conservative allocated storage estimate exceeds maxStorageBytes.",
            3,
        )
        .with_details(json!({"incrementalStorageBytes":storage,"reservedStorageBytes":resource_reservation,"maxStorageBytes":request.max_storage_bytes})));
    }
    reserved_storage = resource_reservation
        .saturating_add(allocated_reservation(metadata_storage))
        .saturating_add(32 * 1024 * 1024);
    enforce_cache_limit(&cache, &root, reserved_storage)?;
    ensure_safe_directory(&root)?;
    ensure_managed_directory(&cache.join("data"))?;
    ensure_managed_directory(&root)?;
    let staging = root.join(format!(".sciencebatch-staging-{}", request.job_id));
    ensure_safe_directory(&staging)?;
    ensure_managed_directory(&staging)?;
    let _staging_cleanup = RemoveDirectory(staging.clone());
    seed_pinned_metadata(&cache, &pinned)?;
    let mut bundle = tectonic_bundles::itar::ItarBundle::new(pinned.url.clone())
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    bundle
        .initialize_index(&mut std::io::Cursor::new(pinned_bytes))
        .map_err(|e| AutomationError::new("resources.catalog_invalid", e.to_string(), 4))?;
    let infos = missing
        .iter()
        .map(|path| {
            bundle.search(path).ok_or_else(|| {
                AutomationError::new(
                    "resources.catalog_invalid",
                    format!("Pinned index is missing '{path}'."),
                    4,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    tectonic_bundles::cache::set_network_download_limit(request.max_download_bytes);
    let mut status = NoopStatusBackend::default();
    let mut prepared = 0usize;
    let job_id = request.job_id.clone();
    let bundle_digest = request.bundle_digest.clone();
    let max_download_bytes = request.max_download_bytes;
    let total_resources = descriptors.len();
    let mut remaining_resource_reservation = missing
        .iter()
        .try_fold(0u64, |total, path| {
            let descriptor = descriptors.iter().find(|item| item.path == *path)?;
            Some(total.saturating_add(allocated_reservation(descriptor.length)))
        })
        .ok_or_else(|| {
            as_error(
                "resources.catalog_invalid",
                "A selected resource is absent from the pinned catalog.",
                4,
            )
        })?;
    let mut remaining_directories = resource_directories;
    let cached_resources = cached;
    emit_progress(
        &job_id,
        &bundle_digest,
        "downloading",
        cached_resources,
        total_resources,
        0,
        max_download_bytes,
        None,
    );
    let mut writer =
        |info: &tectonic_bundles::itar::ItarFileInfo, bytes: &[u8]| -> anyhow::Result<()> {
            let path = info.path();
            let descriptor = descriptors
                .iter()
                .find(|item| item.path == path)
                .ok_or_else(|| anyhow::anyhow!("worker returned an unrequested resource"))?;
            if bytes.len() as u64 != descriptor.length
                || format!("{:x}", Sha256::digest(bytes)) != descriptor.sha256
            {
                return Err(anyhow::anyhow!(
                    "resource integrity verification failed for {path}"
                ));
            }
            let directory_reservation = (remaining_directories.len() as u64).saturating_mul(4096);
            enforce_cache_limit(
                &cache,
                &root,
                remaining_resource_reservation
                    .saturating_add(directory_reservation)
                    .saturating_add(32 * 1024 * 1024),
            )
            .map_err(anyhow::Error::new)?;
            atomic_write(&root, &staging, path, bytes)?;
            remaining_resource_reservation = remaining_resource_reservation
                .saturating_sub(allocated_reservation(descriptor.length));
            let parent = Path::new(path).parent().unwrap_or_else(|| Path::new(""));
            let mut current = PathBuf::new();
            for component in parent.components() {
                current.push(component.as_os_str());
                if fs::symlink_metadata(root.join(&current)).is_ok() {
                    remaining_directories.remove(&current);
                }
            }
            prepared += 1;
            emit_progress(
                &job_id,
                &bundle_digest,
                "publishing",
                cached_resources + prepared,
                total_resources,
                tectonic_bundles::cache::downloaded_bytes(),
                max_download_bytes,
                Some(path),
            );
            Ok(())
        };
    bundle
        .prepare_resources(&infos, &mut status, &mut writer)
        .map_err(|error| {
            AutomationError::new(
                "cache.unavailable_offline",
                format!("Cannot prepare selected resources: {error}"),
                3,
            )
            .with_details(json!({"budgetChargedBytes":tectonic_bundles::cache::downloaded_bytes()}))
        })?;
    let downloaded = tectonic_bundles::cache::downloaded_bytes();
    let bytes_downloaded = if downloaded == estimate {
        Value::from(downloaded)
    } else {
        Value::Null
    };
    for descriptor in &descriptors {
        let indexed = resource_project::IndexedResource {
            offset: descriptor.offset,
            length: descriptor.length,
            sha256: descriptor.sha256.clone(),
        };
        if resource_project::verify_cached_resource(&root, &descriptor.path, &indexed)
            != CacheState::Verified
        {
            return Err(as_error(
                "cache.integrity_failed",
                format!(
                    "Prepared resource '{}' failed final verification.",
                    descriptor.path
                ),
                3,
            ));
        }
    }
    drop(writer);
    Ok(
        json!({"resourceSchemaVersion":1,"prepared":true,"files":prepared,"cachedFiles":cached,"bytesDownloaded":bytes_downloaded,"budgetChargedBytes":downloaded,"firstAttemptTransferEstimateBytes":estimate,"incrementalStorageBytes":storage,"reservedStorageBytes":resource_reservation,"bundleDigest":pinned.digest,"indexSha256":pinned.index_sha256,"catalogSha256":pinned.catalog_sha256,"planDigest":request.plan_digest,"jobId":request.job_id,"provenance":"locally captured QA cache; not upstream authentication","cacheLocation":cache,"projectState":"prepared_known_set"}),
    )
}

fn ensure_safe_directory(path: &Path) -> Result<(), AutomationError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut current = PathBuf::new();
    for c in absolute.components() {
        current.push(c.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err(as_error(
                        "path.symlink_rejected",
                        "Resource cache path contains a symlink or non-directory component.",
                        2,
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => set_created_directory_private(&current)?,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let meta = fs::symlink_metadata(&current).map_err(|e| {
                            AutomationError::new("cache.unavailable_offline", e.to_string(), 3)
                        })?;
                        if meta.file_type().is_symlink() || !meta.is_dir() {
                            return Err(as_error(
                                "path.symlink_rejected",
                                "Resource cache path contains a symlink or non-directory component.",
                                2,
                            ));
                        }
                    }
                    Err(error) => {
                        return Err(AutomationError::new(
                            "cache.unavailable_offline",
                            error.to_string(),
                            3,
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_created_directory_private(path: &Path) -> Result<(), AutomationError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let before = fs::symlink_metadata(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "New resource cache directory changed before it could be secured.",
            2,
        ));
    }
    let directory = open_directory_nofollow(path)?;
    let opened = directory
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if !same_directory(&before, &opened) || opened.uid() != unsafe { libc::geteuid() } {
        return Err(as_error(
            "path.symlink_rejected",
            "New resource cache directory ownership or identity changed before it could be secured.",
            2,
        ));
    }
    if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
        return Err(AutomationError::new(
            "cache.unavailable_offline",
            std::io::Error::last_os_error().to_string(),
            3,
        ));
    }
    verify_directory_path(path, &directory, Some(0o700))
}

#[cfg(not(unix))]
fn set_created_directory_private(_path: &Path) -> Result<(), AutomationError> {
    Ok(())
}
pub(super) fn acquire_bundle_lock_for_url(
    cache: &Path,
    bundle_url: &str,
    deadline: Instant,
) -> Result<CacheWriterLock, AutomationError> {
    let pinned = resource_project::pinned_catalog()?;
    let identity = if bundle_url == pinned.url {
        pinned.digest
    } else {
        format!("{:x}", Sha256::digest(bundle_url.as_bytes()))
    };
    acquire_bundle_lock(cache, &identity, deadline)
}

/// Hold a cross-process shared lease while an isolated compiler child reads the
/// pinned cache. The lease belongs to the supervisor so cancellation cannot
/// release it before the child process has been reaped.
pub(super) fn acquire_cache_read_lock(
    cache: &Path,
    digest: &str,
    deadline: Instant,
) -> Result<CacheReadLock, AutomationError> {
    ensure_safe_directory(cache)?;
    #[cfg(unix)]
    let bootstrap = {
        let bootstrap = open_directory_nofollow(cache)?;
        verify_directory_owner(cache, &bootstrap)?;
        lock_directory_until(&bootstrap, deadline)?;
        ensure_managed_directory_handle(cache, &bootstrap)?;
        bootstrap
    };
    #[cfg(not(unix))]
    ensure_managed_directory(cache)?;
    let locks = cache.join("locks");
    ensure_safe_directory(&locks)?;
    ensure_managed_directory(&locks)?;
    #[cfg(unix)]
    drop(bootstrap);
    let quota = acquire_lock_file_shared(&locks.join("cache-quota.lock"), deadline)?;
    let bundle = acquire_lock_file_shared(&locks.join(format!("{digest}.lock")), deadline)?;
    Ok(CacheReadLock {
        _quota: quota,
        _bundle: bundle,
    })
}

pub(super) struct CacheReadLock {
    _quota: File,
    _bundle: File,
}

fn acquire_lock_file_shared(path: &Path, deadline: Instant) -> Result<File, AutomationError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(as_error(
                "path.symlink_rejected",
                "Bundle cache lock is not a regular file.",
                2,
            ));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    loop {
        match FileExt::try_lock_shared(&file) {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(as_error(
                        "worker.busy",
                        "The shared compiler cache is in use by a writer.",
                        3,
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ))
            }
        }
    }
}

fn acquire_bundle_lock(
    cache: &Path,
    digest: &str,
    deadline: Instant,
) -> Result<CacheWriterLock, AutomationError> {
    ensure_safe_directory(cache)?;
    #[cfg(unix)]
    let bootstrap = {
        let bootstrap = open_directory_nofollow(cache)?;
        verify_directory_owner(cache, &bootstrap)?;
        lock_directory_until(&bootstrap, deadline)?;
        ensure_managed_directory_handle(cache, &bootstrap)?;
        bootstrap
    };
    #[cfg(not(unix))]
    ensure_managed_directory(cache)?;

    let locks = cache.join("locks");
    ensure_safe_directory(&locks)?;
    ensure_managed_directory(&locks)?;
    #[cfg(unix)]
    drop(bootstrap);

    let quota = acquire_lock_file(&locks.join("cache-quota.lock"), deadline)?;
    let path = locks.join(format!("{digest}.lock"));
    let bundle = acquire_lock_file(&path, deadline)?;
    Ok(CacheWriterLock {
        _quota: quota,
        _bundle: bundle,
    })
}

pub(super) struct CacheWriterLock {
    _quota: File,
    _bundle: File,
}

fn acquire_lock_file(path: &Path, deadline: Instant) -> Result<File, AutomationError> {
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(as_error(
                "path.symlink_rejected",
                "Bundle writer lock is not a regular file.",
                2,
            ));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(as_error(
                        "operation.timeout",
                        "Timed out waiting for the bundle cache writer lock.",
                        124,
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    error.to_string(),
                    3,
                ))
            }
        }
    }
}

#[cfg(unix)]
fn ensure_managed_directory(path: &Path) -> Result<(), AutomationError> {
    let directory = open_directory_nofollow(path)?;
    ensure_managed_directory_handle(path, &directory)
}

#[cfg(unix)]
fn open_directory_nofollow(path: &Path) -> Result<File, AutomationError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options.open(path).map_err(|error| {
        if matches!(
            error.raw_os_error(),
            Some(libc::ELOOP) | Some(libc::ENOTDIR)
        ) {
            as_error(
                "path.symlink_rejected",
                "Managed cache path must not contain a symlink.",
                2,
            )
        } else {
            AutomationError::new("cache.unavailable_offline", error.to_string(), 3)
        }
    })
}

#[cfg(unix)]
fn ensure_managed_directory_handle(path: &Path, directory: &File) -> Result<(), AutomationError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    verify_directory_owner(path, directory)?;
    let metadata = directory
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if metadata.mode() & 0o022 != 0 {
        let safe_mode = metadata.mode() & 0o7777 & !0o022;
        if unsafe { libc::fchmod(directory.as_raw_fd(), safe_mode as libc::mode_t) } != 0 {
            return Err(AutomationError::new(
                "cache.unavailable_offline",
                format!(
                    "Cannot secure managed cache directory permissions: {}",
                    std::io::Error::last_os_error()
                ),
                3,
            ));
        }
        verify_directory_path(path, directory, Some(safe_mode))?;
    } else {
        verify_directory_path(path, directory, None)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_managed_directory(path: &Path) -> Result<(), AutomationError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Managed cache path must be a real directory.",
            2,
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn verify_directory_owner(path: &Path, directory: &File) -> Result<(), AutomationError> {
    use std::os::unix::fs::MetadataExt;
    let opened = directory
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let current = fs::symlink_metadata(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if current.file_type().is_symlink()
        || !current.is_dir()
        || !same_directory(&opened, &current)
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.mode() & 0o7777 != current.mode() & 0o7777
    {
        return Err(as_error(
            "path.symlink_rejected",
            "Managed cache directories must be stable directories owned by the current user.",
            2,
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_directory_owner(path: &Path, _directory: &File) -> Result<(), AutomationError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(as_error(
            "path.symlink_rejected",
            "Managed cache path must be a real directory.",
            2,
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn verify_directory_path(
    path: &Path,
    directory: &File,
    expected_mode: Option<u32>,
) -> Result<(), AutomationError> {
    use std::os::unix::fs::MetadataExt;
    let opened = directory
        .metadata()
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    let current = fs::symlink_metadata(path)
        .map_err(|error| AutomationError::new("cache.unavailable_offline", error.to_string(), 3))?;
    if current.file_type().is_symlink()
        || !current.is_dir()
        || !same_directory(&opened, &current)
        || opened.uid() != unsafe { libc::geteuid() }
        || expected_mode.is_some_and(|mode| opened.mode() & 0o7777 != mode)
        || (expected_mode.is_none() && current.mode() & 0o022 != 0)
    {
        return Err(as_error(
            "path.symlink_rejected",
            "Managed cache directory identity or permissions changed during validation.",
            2,
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn same_directory(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn lock_directory_until(directory: &File, deadline: Instant) -> Result<(), AutomationError> {
    loop {
        match directory.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(as_error(
                        "operation.timeout",
                        "Timed out waiting for the cache permission bootstrap lock.",
                        124,
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    format!("Cannot lock the managed cache directory: {error}"),
                    3,
                ));
            }
        }
    }
}
fn seed_pinned_metadata(
    cache: &Path,
    pinned: &resource_project::PinnedCatalog,
) -> Result<(), AutomationError> {
    let hash_path = cache
        .join("hashes")
        .join(tectonic_io_base::app_dirs::sanitize(&pinned.url));
    ensure_safe_directory(hash_path.parent().unwrap())?;
    ensure_managed_directory(hash_path.parent().unwrap())?;
    let index_path = cache.join("data").join(format!("{}.index", pinned.digest));
    ensure_safe_directory(index_path.parent().unwrap())?;
    ensure_managed_directory(index_path.parent().unwrap())?;
    let index = pinned.index_bytes.as_slice();
    if format!("{:x}", Sha256::digest(index)) != pinned.index_sha256 {
        return Err(as_error(
            "resources.catalog_invalid",
            "Embedded index hash does not match its pinned identity.",
            4,
        ));
    }
    for (path, expected, is_index) in [
        (&hash_path, pinned.digest.as_bytes(), false),
        (&index_path, index, true),
    ] {
        if path.exists() {
            let current = read_bounded_file(path, 32 * 1024 * 1024)?;
            let valid = if is_index {
                current == index && format!("{:x}", Sha256::digest(&current)) == pinned.index_sha256
            } else {
                String::from_utf8_lossy(&current).trim() == pinned.digest
            };
            if !valid {
                return Err(as_error(
                    "resources.bundle_identity_mismatch",
                    "Existing compiler cache metadata belongs to a different bundle identity.",
                    3,
                ));
            }
        } else {
            atomic_write_absolute(path, expected)?;
        }
    }
    Ok(())
}

fn read_bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, AutomationError> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() as usize > limit {
        return Err(as_error(
            "path.symlink_rejected",
            "Cached metadata is not a bounded regular file.",
            2,
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    let before = file
        .metadata()
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    let mut out = Vec::new();
    (&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    let after = file
        .metadata()
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    if out.len() > limit
        || before.len() != out.len() as u64
        || file_signature(&before) != file_signature(&after)
    {
        return Err(as_error(
            "cache.integrity_failed",
            "Cached metadata changed while being read.",
            3,
        ));
    }
    Ok(out)
}
fn atomic_write(
    root: &Path,
    staging: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<(), anyhow::Error> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        anyhow::bail!("unsafe bundle path");
    }
    let mut parent = root.to_path_buf();
    for component in path.parent().unwrap_or(Path::new("")).components() {
        parent.push(component.as_os_str());
        if parent.exists() {
            let metadata = fs::symlink_metadata(&parent)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                anyhow::bail!("unsafe cache directory");
            }
        } else {
            fs::create_dir(&parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    let destination = root.join(path);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            anyhow::bail!("cache destination is not a regular file");
        }
    }
    let temp = staging.join(format!(
        "resource-{}.tmp",
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = atomic_replace(&temp, &destination) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct RemoveDirectory(PathBuf);
impl Drop for RemoveDirectory {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.0) {
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }
}

fn cleanup_job_staging(root: &Path, job_id: &str) {
    if !job_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return;
    }
    let staging = root.join(format!(".sciencebatch-staging-{job_id}"));
    if let Ok(metadata) = fs::symlink_metadata(&staging) {
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let _ = fs::remove_dir_all(staging);
        }
    }
}

fn cleanup_staging_for_job(bundle_digest: &str, job_id: &str) {
    if let Ok(cache) = super::resources::cache_directory() {
        cleanup_job_staging(&cache.join("data").join(bundle_digest), job_id);
    }
}

fn atomic_write_absolute(path: &Path, bytes: &[u8]) -> Result<(), AutomationError> {
    let parent = path.parent().ok_or_else(|| {
        as_error(
            "cache.unavailable_offline",
            "Cache file has no parent directory.",
            3,
        )
    })?;
    ensure_safe_directory(parent)?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(as_error(
                "path.symlink_rejected",
                "Cache metadata destination is not a regular file.",
                2,
            ));
        }
    }
    let temp = parent.join(format!(
        ".sciencebatch-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(AutomationError::new(
            "cache.unavailable_offline",
            e.to_string(),
            3,
        ));
    }
    if let Err(e) = atomic_replace(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(AutomationError::new(
            "cache.unavailable_offline",
            e.to_string(),
            3,
        ));
    }
    Ok(())
}
fn enforce_cache_limit(cache: &Path, root: &Path, incoming: u64) -> Result<(), AutomationError> {
    let mut total = incoming;
    let mut count = 0usize;
    fn walk(
        path: &Path,
        total: &mut u64,
        count: &mut usize,
        depth: usize,
    ) -> Result<(), AutomationError> {
        if depth > 64 {
            return Err(as_error(
                "resource.limit_exceeded",
                "Cache directory depth exceeds 64.",
                3,
            ));
        }
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(AutomationError::new(
                    "cache.unavailable_offline",
                    e.to_string(),
                    3,
                ))
            }
        };
        for entry in entries {
            let entry = entry
                .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|e| AutomationError::new("cache.unavailable_offline", e.to_string(), 3))?;
            if metadata.file_type().is_symlink() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Cache contains a symlink.",
                    2,
                ));
            }
            if metadata.is_dir() {
                *total = total.saturating_add(4096);
                if *total > CACHE_LIMIT {
                    return Err(as_error(
                        "resource.limit_exceeded",
                        "Bundle cache exceeds the 8 GiB storage cap.",
                        3,
                    ));
                }
                walk(&entry.path(), total, count, depth + 1)?;
            } else if metadata.is_file() {
                *count = count.saturating_add(1);
                if *count > 200_000 {
                    return Err(as_error(
                        "resource.limit_exceeded",
                        "Cache file count exceeds 200,000 entries.",
                        3,
                    ));
                }
                *total = total.saturating_add(allocated_bytes(&metadata));
                if *total > CACHE_LIMIT {
                    return Err(as_error(
                        "resource.limit_exceeded",
                        "Bundle cache exceeds the 8 GiB storage cap.",
                        3,
                    ));
                }
            }
        }
        Ok(())
    }
    walk(cache, &mut total, &mut count, 0)?;
    if total > CACHE_LIMIT {
        return Err(as_error(
            "resource.limit_exceeded",
            "Bundle cache and reserved temporary storage exceed the 8 GiB cap.",
            3,
        ));
    }
    let _ = root;
    let available = fs2::available_space(cache).map_err(|error| {
        AutomationError::new(
            "cache.unavailable_offline",
            format!("Cannot determine free disk space: {error}"),
            3,
        )
    })?;
    if incoming > available {
        return Err(as_error(
            "resource.limit_exceeded",
            "Insufficient free disk space for selected resources.",
            3,
        ));
    }
    Ok(())
}

fn allocated_reservation(length: u64) -> u64 {
    const BLOCK: u64 = 4096;
    length
        .saturating_add(BLOCK - 1)
        .checked_div(BLOCK)
        .unwrap_or(u64::MAX)
        .saturating_mul(BLOCK)
        .saturating_add(BLOCK) // inode and directory-entry allowance
}

#[cfg(unix)]
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    metadata.len()
}

fn file_signature(metadata: &fs::Metadata) -> (u64, u128, u64, u64) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.len(), modified, metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        (metadata.len(), modified, 0, 0)
    }
}

fn emit_frame(value: Value) {
    if let Ok(bytes) = serde_json::to_vec(&value) {
        let limit = if value.get("kind").and_then(Value::as_str) == Some("progress") {
            WORKER_FRAME_LIMIT
        } else {
            WORKER_TERMINAL_LIMIT
        };
        if bytes.len() <= limit {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(&bytes);
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }
}
fn emit_result(data: Value) {
    emit_frame(
        json!({"schemaVersion":1,"kind":"result","jobId":data.get("jobId"),"bundleDigest":data.get("bundleDigest"),"data":data}),
    );
}
fn emit_progress(
    job_id: &str,
    bundle_digest: &str,
    phase: &str,
    completed_resources: usize,
    total_resources: usize,
    downloaded_bytes: u64,
    max_download_bytes: u64,
    resource_path: Option<&str>,
) {
    emit_frame(
        json!({"schemaVersion":1,"kind":"progress","jobId":job_id,"bundleDigest":bundle_digest,"phase":phase,"completedResources":completed_resources,"totalResources":total_resources,"downloadedBytes":downloaded_bytes,"maxDownloadBytes":max_download_bytes,"resourcePath":resource_path}),
    );
}
fn emit_error(code: &str, message: impl Into<String>, data: Value) {
    let value = json!({"schemaVersion":1,"kind":"error","jobId":"","bundleDigest":"","code":code,"message":message.into(),"data":data});
    emit_frame(value);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    fn fake_worker(script: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sciencebatch-resource-worker-test-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let temporary = path.with_extension("pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .unwrap();
        file.write_all(format!("#!/bin/sh\n{script}\n").as_bytes())
            .unwrap();
        file.sync_all().unwrap();
        drop(file);
        fs::rename(&temporary, &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[tokio::test]
    async fn supervisor_drains_many_frames_before_terminal_result() {
        let job = format!(
            "test-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        );
        let digest = "a".repeat(64);
        let worker = fake_worker(&format!(
            "i=0; while [ $i -lt 45 ]; do printf '%s\\n' '{{\"schemaVersion\":1,\"kind\":\"progress\",\"jobId\":\"{job}\",\"bundleDigest\":\"{digest}\",\"phase\":\"download\",\"completedResources\":0,\"totalResources\":1,\"downloadedBytes\":0,\"maxDownloadBytes\":100}}'; i=$((i+1)); done; printf '%s\\n' '{{\"schemaVersion\":1,\"kind\":\"result\",\"jobId\":\"{job}\",\"bundleDigest\":\"{digest}\",\"data\":{{\"ok\":true}}}}'"
        ));
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.clone().try_acquire_owned().unwrap();
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let result = run_worker_process(
            worker.clone(),
            b"{}".to_vec(),
            job,
            digest,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
            cancel_rx,
            permit,
        )
        .await
        .unwrap();
        assert_eq!(result["ok"], true);
        assert!(semaphore.try_acquire().is_ok());
        let _ = fs::remove_file(worker);
    }

    #[tokio::test]
    async fn malformed_frame_kills_and_reaps_before_releasing_permit() {
        let worker = fake_worker("cat >/dev/null; printf '{bad}\\n'; exec sleep 10");
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.clone().try_acquire_owned().unwrap();
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let error = run_worker_process(
            worker.clone(),
            b"{}".to_vec(),
            "job-test".into(),
            "a".repeat(64),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
            cancel_rx,
            permit,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "worker.protocol_invalid");
        assert!(semaphore.try_acquire().is_ok());
        let _ = fs::remove_file(worker);
    }

    #[tokio::test]
    async fn stderr_overflow_kills_worker_promptly() {
        let worker = fake_worker("cat >/dev/null; printf '%*s' 1048577 '' >&2; exec sleep 10");
        let started = Instant::now();
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let error = run_worker_process(
            worker.clone(),
            b"{}".to_vec(),
            "job-stderr".into(),
            "b".repeat(64),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
            cancel_rx,
            Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "resource.limit_exceeded", "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = fs::remove_file(worker);
    }

    #[tokio::test]
    async fn cancellation_drop_and_timeout_reap_worker_before_permit_release() {
        let semaphore = Arc::new(Semaphore::new(1));
        let worker = fake_worker("cat >/dev/null; exec sleep 10");
        let permit = semaphore.clone().try_acquire_owned().unwrap();
        let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let error = run_worker_process(
            worker.clone(),
            b"{}".to_vec(),
            "cancel-job".into(),
            "c".repeat(64),
            cancellation,
            None,
            cancel_rx,
            permit,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "operation.interrupted");
        assert!(semaphore.try_acquire().is_ok());

        let permit = semaphore.clone().try_acquire_owned().unwrap();
        let (drop_tx, drop_rx) = tokio::sync::oneshot::channel();
        drop(drop_tx);
        let error = run_worker_process(
            worker.clone(),
            b"{}".to_vec(),
            "drop-job".into(),
            "d".repeat(64),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
            drop_rx,
            permit,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "operation.interrupted");
        assert!(semaphore.try_acquire().is_ok());

        let permit = semaphore.clone().try_acquire_owned().unwrap();
        let (_timeout_tx, timeout_rx) = tokio::sync::oneshot::channel();
        let pid_file = std::env::temp_dir().join(format!(
            "sciencebatch-resource-worker-pid-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let worker_with_pid = fake_worker(&format!(
            "printf '%s' \"$$\" > '{}'; cat >/dev/null; exec sleep 10",
            pid_file.display()
        ));
        let error = run_worker_process_with_timeout(
            worker_with_pid.clone(),
            b"{}".to_vec(),
            "timeout-job".into(),
            "e".repeat(64),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
            timeout_rx,
            permit,
            Duration::from_millis(100),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "operation.timeout");
        assert!(semaphore.try_acquire().is_ok());
        let pid: i32 = fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        let _ = fs::remove_file(pid_file);
        let _ = fs::remove_file(worker_with_pid);
        let _ = fs::remove_file(worker);
    }

    #[tokio::test]
    async fn staging_publication_rejects_symlink_destinations_and_cache_quota() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("bundle");
        let staging = root.join(".sciencebatch-staging-test");
        fs::create_dir_all(&staging).unwrap();
        let external = temporary.path().join("external.sty");
        fs::write(&external, b"safe").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, root.join("linked.sty")).unwrap();
        #[cfg(unix)]
        assert!(atomic_write(&root, &staging, "linked.sty", b"payload").is_err());
        assert_eq!(fs::read(&external).unwrap(), b"safe");
        let quota_cache = temporary.path().join("quota-cache");
        fs::create_dir(&quota_cache).unwrap();
        assert_eq!(
            enforce_cache_limit(&quota_cache, &root, CACHE_LIMIT + 1)
                .unwrap_err()
                .code,
            "resource.limit_exceeded"
        );
        fs::write(staging.join("complete.tmp"), b"complete").unwrap();
        atomic_replace(&staging.join("complete.tmp"), &root.join("complete.sty")).unwrap();
        assert_eq!(fs::read(root.join("complete.sty")).unwrap(), b"complete");
    }

    #[test]
    fn owned_legacy_cache_directory_is_repaired_without_changing_other_bits() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("legacy-cache");
        fs::create_dir(&cache).unwrap();
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o775)).unwrap();

        ensure_managed_directory(&cache).unwrap();

        assert_eq!(
            fs::symlink_metadata(&cache).unwrap().permissions().mode() & 0o777,
            0o755,
            "repair should remove only group/world write bits"
        );
    }

    #[test]
    fn managed_cache_directory_rejects_symlinks() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("target");
        let link = temporary.path().join("cache-link");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = ensure_managed_directory(&link).unwrap_err();
        assert_eq!(error.code, "path.symlink_rejected");
    }

    #[test]
    fn managed_cache_directory_rejects_foreign_owner_even_when_writable() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        use std::os::fd::AsRawFd;
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("foreign-cache");
        fs::create_dir(&cache).unwrap();
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o775)).unwrap();
        let directory = File::open(&cache).unwrap();
        assert_eq!(unsafe { libc::fchown(directory.as_raw_fd(), 1, 1) }, 0);
        drop(directory);

        let error = ensure_managed_directory(&cache).unwrap_err();
        assert_eq!(error.code, "path.symlink_rejected");
        assert_eq!(
            fs::symlink_metadata(&cache).unwrap().permissions().mode() & 0o777,
            0o775,
            "a foreign-owned directory must never be repaired"
        );
    }

    #[test]
    fn newly_created_cache_directories_are_private_without_chmodding_existing_parent() {
        let temporary = tempfile::tempdir().unwrap();
        let parent = temporary.path().join("existing-parent");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        let cache = parent.join("cache");

        ensure_safe_directory(&cache).unwrap();

        assert_eq!(
            fs::symlink_metadata(&cache).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::symlink_metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn bundle_writer_lock_is_exclusive_across_processes() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("cache");
        ensure_safe_directory(&cache).unwrap();
        let digest = "lock-probe";
        let lock =
            acquire_bundle_lock(&cache, digest, Instant::now() + Duration::from_secs(1)).unwrap();
        let path = cache.join("locks").join(format!("{digest}.lock"));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("automation::resource_prepare::tests::bundle_lock_child_probe")
            .arg("--nocapture")
            .env("SCIENCEBATCH_LOCK_PROBE", path)
            .status()
            .unwrap();
        assert!(status.success());
        drop(lock);
    }

    #[test]
    fn bundle_writer_bootstrap_repairs_user_owned_legacy_cache_before_locking() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = temporary.path().join("cache");
        fs::create_dir(&cache).unwrap();
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o775)).unwrap();

        let lock = acquire_bundle_lock(
            &cache,
            "legacy-probe",
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(
            fs::symlink_metadata(&cache).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(cache.join("locks/legacy-probe.lock").is_file());
        drop(lock);
    }

    #[test]
    fn bundle_lock_child_probe() {
        let Some(path) = std::env::var_os("SCIENCEBATCH_LOCK_PROBE") else {
            return;
        };
        let file = File::open(path).unwrap();
        assert!(
            file.try_lock_exclusive().is_err(),
            "second process acquired an active bundle writer lock"
        );
    }

    #[tokio::test]
    async fn stale_plan_is_rejected_before_worker_launch() {
        let mut files = BTreeMap::new();
        files.insert(
            "main.tex".to_owned(),
            b"\\documentclass{article}\\begin{document}Hi\\end{document}".to_vec(),
        );
        let snapshot = super::super::capture_virtual_snapshot("latex", "main.tex", &files).unwrap();
        let context = OperationContext {
            allow_resource_download: true,
            ..OperationContext::default()
        };
        let error = prepare_snapshot(
            &snapshot,
            &json!({"expectedPlanDigest":"stale"}),
            &context,
            Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "resources.plan_changed");
    }

    #[test]
    fn worker_path_resolution_rejects_client_supplied_non_catalog_paths() {
        assert_eq!(
            resource_project::pinned_descriptors(&["https://example.invalid/file".into()])
                .unwrap_err()
                .code,
            "resources.selector_invalid"
        );
    }

    #[test]
    fn fully_embedded_starter_plan_returns_prepared_without_worker_transfer() {
        let source = r#"\documentclass{article}
\begin{document}
Starter
\end{document}
"#;
        let mut overlays = BTreeMap::new();
        overlays.insert("main.tex".to_owned(), source.to_owned());
        let snapshot = crate::commands::workspace::capture_workspace_snapshot(
            "latex",
            None,
            "main.tex",
            &overlays,
            &[],
            Some(crate::commands::workspace::TemplateAssetGrant::StarterLatex),
        )
        .unwrap();
        let args = json!({"engine":"latex","mainFile":"main.tex"});
        let plan = resource_project::resolved_plan(&snapshot, &args).unwrap();
        let downloadable_paths = plan
            .requirements
            .iter()
            .filter(|row| row.provider == "pinned_bundle" && row.availability != "embedded")
            .filter_map(|row| row.path.as_deref())
            .collect::<Vec<_>>();
        assert!(downloadable_paths.is_empty());
        assert_eq!(plan.project_state, "prepared_known_set");
        assert_eq!(plan.missing_resources, 0);

        let pinned = resource_project::pinned_catalog().unwrap();
        let result = prepared_without_download(&snapshot, &args, &plan, &pinned).unwrap();

        assert_eq!(result["prepared"], true);
        assert_eq!(result["projectState"], "prepared_known_set");
        assert_eq!(result["bytesDownloaded"], 0);
        assert_eq!(result["files"], 0);
        assert_eq!(result["planDigest"], plan.plan_digest);
    }
}
