use super::{
    AutomationError, ProjectSnapshot, SnapshotFileKind, MAX_ASSET_BYTES, MAX_ENTRIES,
    MAX_LOG_BYTES, MAX_PDF_BYTES, MAX_PROTOCOL_BYTES, MAX_SNAPSHOT_BYTES, MAX_TEXT_BYTES,
};
use crate::types::{CompileResponse, DiagnosticItem};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::OwnedSemaphorePermit;

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct WorkerRequest<'a> {
    schema_version: u32,
    engine: &'a str,
    main_file: &'a str,
    files: Vec<WorkerFile<'a>>,
}
#[derive(Serialize)]
struct WorkerFile<'a> {
    path: &'a str,
    kind: &'a str,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerResponse {
    schema_version: u32,
    success: bool,
    #[serde(default)]
    pdf_base64: String,
    #[serde(default)]
    errors: Vec<DiagnosticItem>,
    #[serde(default)]
    warnings: Vec<DiagnosticItem>,
    #[serde(default)]
    raw_log: String,
    #[serde(default)]
    worker_error: Option<WorkerFailure>,
}

#[derive(Deserialize, Serialize)]
struct WorkerFailure {
    code: String,
    message: String,
    exit_code: i32,
}

pub async fn run_worker(
    snapshot: &ProjectSnapshot,
    timeout: Duration,
    cancellation: Arc<AtomicBool>,
    permit: OwnedSemaphorePermit,
) -> Result<CompileResponse, AutomationError> {
    let request = build_request(snapshot)?;
    let bytes = serde_json::to_vec(&request).map_err(|e| {
        AutomationError::new(
            "worker.protocol_invalid",
            format!("Cannot encode worker request: {e}"),
            4,
        )
    })?;
    ensure_within_limit(
        bytes.len(),
        MAX_PROTOCOL_BYTES,
        "Encoded worker message exceeds 256 MiB.",
    )?;
    let executable = super::worker_executable()?;
    run_worker_request(executable, bytes, timeout, cancellation, permit).await
}

async fn run_worker_request(
    executable: std::path::PathBuf,
    bytes: Vec<u8>,
    timeout: Duration,
    cancellation: Arc<AtomicBool>,
    permit: OwnedSemaphorePermit,
) -> Result<CompileResponse, AutomationError> {
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let mut guard = DropCancel(Some(cancel_sender));
    let task = tokio::spawn(run_worker_process(
        executable,
        bytes,
        timeout,
        cancellation,
        cancel_receiver,
        permit,
    ));
    let result = task.await.map_err(|e| {
        AutomationError::new(
            "worker.crashed",
            format!("Compiler worker supervisor failed: {e}"),
            4,
        )
    })?;
    guard.0.take();
    result
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
    executable: std::path::PathBuf,
    bytes: Vec<u8>,
    timeout: Duration,
    cancellation: Arc<AtomicBool>,
    drop_cancel: tokio::sync::oneshot::Receiver<()>,
    permit: OwnedSemaphorePermit,
) -> Result<CompileResponse, AutomationError> {
    run_worker_process_with_limits(
        executable,
        bytes,
        timeout,
        cancellation,
        drop_cancel,
        Some(permit),
        MAX_PROTOCOL_BYTES,
        MAX_LOG_BYTES,
    )
    .await
}

async fn run_worker_process_with_limits(
    executable: std::path::PathBuf,
    bytes: Vec<u8>,
    timeout: Duration,
    cancellation: Arc<AtomicBool>,
    drop_cancel: tokio::sync::oneshot::Receiver<()>,
    permit: Option<OwnedSemaphorePermit>,
    output_limit: usize,
    log_limit: usize,
) -> Result<CompileResponse, AutomationError> {
    let mut command = Command::new(executable);
    command
        .arg("--automation-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| {
        AutomationError::new(
            "worker.crashed",
            format!("Cannot start isolated compiler worker: {e}"),
            4,
        )
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        AutomationError::new("worker.crashed", "Compiler worker stdin is unavailable.", 4)
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AutomationError::new(
            "worker.crashed",
            "Compiler worker stdout is unavailable.",
            4,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AutomationError::new(
            "worker.crashed",
            "Compiler worker stderr is unavailable.",
            4,
        )
    })?;
    let writer = tokio::spawn(async move {
        let mut stdin = stdin;
        stdin.write_all(&bytes).await?;
        stdin.shutdown().await
    });
    let (overflow_sender, mut overflow_receiver) = tokio::sync::mpsc::unbounded_channel();
    let out_reader = tokio::spawn(read_bounded(stdout, output_limit, overflow_sender.clone()));
    let err_reader = tokio::spawn(read_bounded(stderr, log_limit, overflow_sender));
    let deadline = timeout
        .max(Duration::from_millis(1))
        .min(Duration::from_secs(900));
    let started = tokio::time::Instant::now();
    tokio::pin!(drop_cancel);
    let mut permit = permit;
    let status = loop {
        if cancellation.load(Ordering::Relaxed) {
            stop_and_reap(&mut child).await;
            drop(permit.take());
            let _ = writer.await;
            let _ = out_reader.await;
            let _ = err_reader.await;
            return Err(AutomationError::new(
                "operation.interrupted",
                "Compilation was cancelled and the worker was reaped.",
                130,
            ));
        }
        let remaining = deadline.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            stop_and_reap(&mut child).await;
            drop(permit.take());
            let _ = writer.await;
            let _ = out_reader.await;
            let _ = err_reader.await;
            return Err(AutomationError::new(
                "operation.timeout",
                "Compilation exceeded the requested timeout; the worker was reaped.",
                124,
            ));
        }
        tokio::select! {
            status = child.wait() => match status {
                Ok(status) => {
                    drop(permit.take());
                    break status;
                }
                Err(error) => {
                    stop_and_reap(&mut child).await;
                    drop(permit.take());
                    return Err(AutomationError::new(
                        "worker.crashed",
                        format!("Cannot wait for compiler worker: {error}"),
                        4,
                    ));
                }
            },
            Some(()) = overflow_receiver.recv() => {
                stop_and_reap(&mut child).await;
                drop(permit.take());
                let _ = writer.await;
                let _ = out_reader.await;
                let _ = err_reader.await;
                return Err(AutomationError::new(
                    "resource.limit_exceeded",
                    "Compiler worker output exceeded its protocol or log limit; the worker was reaped.",
                    3,
                ));
            }
            _ = &mut drop_cancel => {
                stop_and_reap(&mut child).await;
                drop(permit.take());
                let _ = writer.await;
                let _ = out_reader.await;
                let _ = err_reader.await;
                return Err(AutomationError::new(
                    "operation.interrupted",
                    "Compilation request was dropped and its worker was reaped.",
                    130,
                ));
            }
            _ = tokio::time::sleep(Duration::from_millis(30)) => {}
        }
    };
    let write_result = writer.await.map_err(|e| {
        AutomationError::new(
            "worker.crashed",
            format!("Worker stdin task failed: {e}"),
            4,
        )
    })?;
    let (stdout, stdout_overflow) = out_reader
        .await
        .map_err(|e| {
            AutomationError::new(
                "worker.crashed",
                format!("Worker stdout task failed: {e}"),
                4,
            )
        })?
        .map_err(|e| {
            AutomationError::new(
                "worker.crashed",
                format!("Cannot read worker response: {e}"),
                4,
            )
        })?;
    let (stderr, stderr_overflow) = err_reader
        .await
        .map_err(|e| {
            AutomationError::new(
                "worker.crashed",
                format!("Worker stderr task failed: {e}"),
                4,
            )
        })?
        .map_err(|e| {
            AutomationError::new(
                "worker.crashed",
                format!("Cannot read worker diagnostics: {e}"),
                4,
            )
        })?;
    if stdout_overflow || stderr_overflow {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Compiler worker output exceeded its protocol or log limit.",
            3,
        ));
    }
    if let Err(e) = write_result {
        return Err(AutomationError::new(
            "worker.crashed",
            format!("Cannot send snapshot to compiler worker: {e}"),
            4,
        ));
    }
    if !status.success() {
        return Err(AutomationError::new(
            "worker.crashed",
            format!(
                "Compiler worker exited with status {}: {}",
                status,
                String::from_utf8_lossy(&stderr)
            ),
            4,
        ));
    }
    let response: WorkerResponse = serde_json::from_slice(&stdout).map_err(|e| {
        AutomationError::new(
            "worker.protocol_invalid",
            format!("Compiler worker returned invalid JSON: {e}"),
            4,
        )
    })?;
    if response.schema_version != 1 {
        return Err(AutomationError::new(
            "worker.protocol_invalid",
            "Compiler worker protocol version is unsupported.",
            4,
        ));
    }
    if let Some(error) = validate_worker_failure(&response)? {
        return Err(error);
    }
    ensure_within_limit(
        response.raw_log.len(),
        MAX_LOG_BYTES,
        "Compiler log exceeds 1 MiB.",
    )?;
    let pdf = base64::engine::general_purpose::STANDARD
        .decode(response.pdf_base64)
        .map_err(|e| {
            AutomationError::new(
                "worker.protocol_invalid",
                format!("Compiler worker returned invalid PDF encoding: {e}"),
                4,
            )
        })?;
    ensure_within_limit(pdf.len(), MAX_PDF_BYTES, "Compiler PDF exceeds 64 MiB.")?;
    if response.success && pdf.is_empty() {
        return Err(AutomationError::new(
            "worker.protocol_invalid",
            "Successful worker response did not contain a PDF.",
            4,
        ));
    }
    if response.success
        && (!pdf.starts_with(b"%PDF-")
            || !pdf
                .windows(5)
                .rev()
                .take(4096)
                .any(|window| window == b"%%EOF"))
    {
        return Err(AutomationError::new(
            "worker.protocol_invalid",
            "Worker PDF failed its structural checks.",
            4,
        ));
    }
    Ok(CompileResponse {
        pdf_bytes: pdf,
        success: response.success,
        errors: response.errors,
        warnings: response.warnings,
        raw_log: response.raw_log,
    })
}

async fn stop_and_reap(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    overflow_sender: tokio::sync::mpsc::UnboundedSender<()>,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(1024 * 1024));
    let mut overflow = false;
    let mut buffer = [0u8; 16384];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        if count > remaining {
            output.extend_from_slice(&buffer[..remaining]);
            overflow = true;
            let _ = overflow_sender.send(());
        } else {
            output.extend_from_slice(&buffer[..count]);
        }
    }
    Ok((output, overflow))
}

fn build_request(snapshot: &ProjectSnapshot) -> Result<WorkerRequest<'_>, AutomationError> {
    if snapshot.files.len() > MAX_ENTRIES || snapshot.total_bytes > MAX_SNAPSHOT_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Snapshot exceeds configured bounds.",
            3,
        ));
    }
    let mut files = Vec::with_capacity(snapshot.files.len());
    let mut total = 0usize;
    for (path, file) in &snapshot.files {
        if super::normalize_project_path(path).is_err() {
            return Err(AutomationError::new(
                "worker.protocol_invalid",
                "Snapshot contains an invalid relative path.",
                4,
            ));
        }
        let kind = match file.kind {
            SnapshotFileKind::Text => "text",
            SnapshotFileKind::Asset => "asset",
        };
        let cap = if kind == "text" {
            MAX_TEXT_BYTES
        } else {
            MAX_ASSET_BYTES
        };
        ensure_within_limit(
            file.bytes.len(),
            cap,
            &format!("Snapshot file '{path}' exceeds its limit."),
        )?;
        total = total.checked_add(file.bytes.len()).ok_or_else(|| {
            AutomationError::new("resource.limit_exceeded", "Snapshot size overflow.", 3)
        })?;
        files.push(WorkerFile {
            path,
            kind,
            data: base64::engine::general_purpose::STANDARD.encode(&file.bytes),
        });
    }
    ensure_within_limit(total, MAX_SNAPSHOT_BYTES, "Snapshot exceeds 128 MiB.")?;
    let request = WorkerRequest {
        schema_version: 1,
        engine: &snapshot.engine,
        main_file: &snapshot.main_file,
        files,
    };
    let encoded = serde_json::to_vec(&request).map_err(|e| {
        AutomationError::new(
            "worker.protocol_invalid",
            format!("Cannot encode worker request: {e}"),
            4,
        )
    })?;
    ensure_within_limit(
        encoded.len(),
        MAX_PROTOCOL_BYTES,
        "Encoded worker message exceeds 256 MiB.",
    )?;
    Ok(request)
}

fn ensure_within_limit(actual: usize, limit: usize, message: &str) -> Result<(), AutomationError> {
    if actual > limit {
        Err(AutomationError::new("resource.limit_exceeded", message, 3))
    } else {
        Ok(())
    }
}

fn validate_worker_failure(
    response: &WorkerResponse,
) -> Result<Option<AutomationError>, AutomationError> {
    let Some(error) = response.worker_error.as_ref() else {
        return Ok(None);
    };
    let (code, expected_exit) = match error.code.as_str() {
        "path.outside_project" => ("path.outside_project", 2),
        "cache.unavailable_offline" => ("cache.unavailable_offline", 3),
        "dependency.external_tool_unsupported" => ("dependency.external_tool_unsupported", 1),
        "resource.limit_exceeded" => ("resource.limit_exceeded", 3),
        "operation.timeout" => ("operation.timeout", 124),
        "operation.interrupted" => ("operation.interrupted", 130),
        "internal.unexpected" => ("internal.unexpected", 4),
        _ => {
            return Err(AutomationError::new(
                "worker.protocol_invalid",
                "Worker returned an unknown structured error code.",
                4,
            ))
        }
    };
    if error.exit_code != expected_exit
        || response.success
        || !response.pdf_base64.is_empty()
        || !response.errors.is_empty()
        || !response.warnings.is_empty()
        || !response.raw_log.is_empty()
    {
        return Err(AutomationError::new(
            "worker.protocol_invalid",
            "Worker returned a contradictory structured error response.",
            4,
        ));
    }
    Ok(Some(AutomationError::new(
        code,
        error.message.clone(),
        expected_exit,
    )))
}

pub fn run_automation_worker() {
    let mut input = Vec::new();
    if let Err(e) = std::io::stdin()
        .take((MAX_PROTOCOL_BYTES + 1) as u64)
        .read_to_end(&mut input)
    {
        eprintln!("Cannot read automation worker request: {e}");
        std::process::exit(4);
    }
    if input.len() > MAX_PROTOCOL_BYTES {
        eprintln!("Automation worker request exceeds 256 MiB.");
        std::process::exit(4);
    }
    let request: IncomingRequest = match serde_json::from_slice(&input) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Invalid automation worker request: {e}");
            std::process::exit(4)
        }
    };
    if request.schema_version != 1 {
        eprintln!("Unsupported automation worker request version.");
        std::process::exit(4);
    }
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    if request.files.len() > MAX_ENTRIES {
        eprintln!("Snapshot entry limit exceeded.");
        std::process::exit(3);
    }
    for f in request.files {
        let path = match super::normalize_project_path(&f.path) {
            Ok(p) => p,
            Err(_) => {
                eprintln!("Snapshot path escapes root.");
                std::process::exit(4)
            }
        };
        if path != f.path {
            eprintln!("Snapshot path is not normalized.");
            std::process::exit(4);
        }
        if path.split('/').count() > super::MAX_DEPTH {
            eprintln!("Snapshot path depth limit exceeded.");
            std::process::exit(3);
        }
        let kind = match f.kind.as_str() {
            "text" => SnapshotFileKind::Text,
            "asset" => SnapshotFileKind::Asset,
            _ => {
                eprintln!("Unknown snapshot file kind.");
                std::process::exit(4)
            }
        };
        if f.data.len() % 4 != 0 {
            eprintln!("Malformed base64 length.");
            std::process::exit(4);
        }
        let padding = f
            .data
            .as_bytes()
            .iter()
            .rev()
            .take_while(|b| **b == b'=')
            .count()
            .min(2);
        let decoded_len = f.data.len().saturating_mul(3) / 4 - padding;
        let cap = if kind == SnapshotFileKind::Text {
            MAX_TEXT_BYTES
        } else {
            MAX_ASSET_BYTES
        };
        if decoded_len > cap {
            eprintln!("Snapshot file limit exceeded.");
            std::process::exit(3);
        }
        let bytes = match base64::engine::general_purpose::STANDARD.decode(f.data) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("Invalid base64 in snapshot: {e}");
                std::process::exit(4)
            }
        };
        if bytes.len() > cap {
            eprintln!("Snapshot file limit exceeded.");
            std::process::exit(3);
        }
        if kind == SnapshotFileKind::Text && std::str::from_utf8(&bytes).is_err() {
            eprintln!("Snapshot text file is not UTF-8.");
            std::process::exit(4);
        }
        total = total.saturating_add(bytes.len());
        if files
            .insert(path, super::SnapshotFile { bytes, kind })
            .is_some()
        {
            eprintln!("Duplicate snapshot path.");
            std::process::exit(4);
        }
    }
    if total > MAX_SNAPSHOT_BYTES {
        eprintln!("Snapshot total limit exceeded.");
        std::process::exit(3);
    }
    let main_file = match super::normalize_project_path(&request.main_file) {
        Ok(p) => p,
        Err(_) => {
            eprintln!("Invalid main path.");
            std::process::exit(4)
        }
    };
    if !files.contains_key(&main_file) {
        eprintln!("Snapshot has no main source.");
        std::process::exit(4);
    }
    let extension = std::path::Path::new(&main_file)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        (request.engine.as_str(), extension.as_str()),
        ("latex", "tex") | ("typst", "typ")
    ) {
        eprintln!("Snapshot engine and main path do not match.");
        std::process::exit(4);
    }
    let snapshot = ProjectSnapshot {
        engine: request.engine,
        root: PathBuf::new(),
        main_file,
        files,
        total_bytes: total,
    };
    let response = match super::compiler::compile_in_memory(&snapshot) {
        Ok(response) => response,
        Err(error) => {
            emit_worker_response(OutgoingResponse {
                schema_version: 1,
                success: false,
                pdf_base64: String::new(),
                errors: vec![],
                warnings: vec![],
                raw_log: String::new(),
                worker_error: Some(WorkerFailure {
                    code: error.code.into(),
                    message: error.message,
                    exit_code: error.exit_code,
                }),
            });
            return;
        }
    };
    if response.raw_log.len() > MAX_LOG_BYTES {
        eprintln!("Compiler log limit exceeded.");
        std::process::exit(3);
    }
    if response.pdf_bytes.len() > MAX_PDF_BYTES {
        eprintln!("Compiler PDF limit exceeded.");
        std::process::exit(3);
    }
    let outgoing = OutgoingResponse {
        schema_version: 1,
        success: response.success,
        pdf_base64: base64::engine::general_purpose::STANDARD.encode(response.pdf_bytes),
        errors: response.errors,
        warnings: response.warnings,
        raw_log: response.raw_log,
        worker_error: None,
    };
    emit_worker_response(outgoing);
}

fn emit_worker_response(outgoing: OutgoingResponse) {
    match serde_json::to_vec(&outgoing) {
        Ok(bytes) if bytes.len() <= MAX_PROTOCOL_BYTES => {
            use std::io::Write;
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(&bytes);
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
        Ok(_) => {
            eprintln!("Automation worker response exceeds 256 MiB.");
            std::process::exit(3);
        }
        Err(e) => {
            eprintln!("Cannot encode automation worker response: {e}");
            std::process::exit(4);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IncomingRequest {
    schema_version: u32,
    engine: String,
    main_file: String,
    files: Vec<IncomingFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IncomingFile {
    path: String,
    kind: String,
    data: String,
}
#[derive(Serialize)]
struct OutgoingResponse {
    schema_version: u32,
    success: bool,
    pdf_base64: String,
    errors: Vec<DiagnosticItem>,
    warnings: Vec<DiagnosticItem>,
    raw_log: String,
    worker_error: Option<WorkerFailure>,
}

#[cfg(all(test, unix))]
mod supervisor_tests {
    use super::*;
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicU64;

    static SCRIPT_ID: AtomicU64 = AtomicU64::new(1);

    struct TestScript {
        directory: PathBuf,
        path: PathBuf,
    }

    impl Drop for TestScript {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn script(body: &str) -> TestScript {
        let directory = loop {
            let id = SCRIPT_ID.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "sciencebatch-worker-test-{}-{id}",
                std::process::id(),
            ));
            match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
                Ok(()) => break directory,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("Cannot create isolated worker test directory: {error}"),
            }
        };

        let temporary_path = directory.join("worker.sh.tmp");
        let path = directory.join("worker.sh");
        std::fs::write(&temporary_path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::rename(&temporary_path, &path).unwrap();
        TestScript { directory, path }
    }

    #[test]
    fn numeric_size_limits_accept_boundary_and_reject_first_overflow_byte() {
        for limit in [
            MAX_TEXT_BYTES,
            MAX_ASSET_BYTES,
            MAX_SNAPSHOT_BYTES,
            MAX_PDF_BYTES,
            MAX_PROTOCOL_BYTES,
            MAX_LOG_BYTES,
        ] {
            assert!(ensure_within_limit(limit, limit, "boundary").is_ok());
            let error = ensure_within_limit(limit + 1, limit, "overflow").unwrap_err();
            assert_eq!(error.code, "resource.limit_exceeded");
            assert_eq!(error.exit_code, 3);
        }
        assert!(MAX_ENTRIES == 10_000);
        assert!(crate::automation::MAX_DEPTH == 64);
    }

    #[test]
    fn strict_worker_errors_reject_unknown_codes_wrong_exits_and_contradictions() {
        let unknown: WorkerResponse = serde_json::from_str(
            r#"{"schema_version":1,"success":false,"worker_error":{"code":"mystery","message":"bad","exit_code":0}}"#,
        )
        .unwrap();
        assert_eq!(
            validate_worker_failure(&unknown).unwrap_err().code,
            "worker.protocol_invalid"
        );

        let wrong_exit: WorkerResponse = serde_json::from_str(
            r#"{"schema_version":1,"success":false,"worker_error":{"code":"path.outside_project","message":"bad","exit_code":0}}"#,
        )
        .unwrap();
        assert_eq!(
            validate_worker_failure(&wrong_exit).unwrap_err().code,
            "worker.protocol_invalid"
        );

        let contradictory: WorkerResponse = serde_json::from_str(
            r#"{"schema_version":1,"success":true,"pdf_base64":"JVBERi0=","worker_error":{"code":"resource.limit_exceeded","message":"bad","exit_code":3}}"#,
        )
        .unwrap();
        assert_eq!(
            validate_worker_failure(&contradictory).unwrap_err().code,
            "worker.protocol_invalid"
        );

        let valid: WorkerResponse = serde_json::from_str(
            r#"{"schema_version":1,"success":false,"worker_error":{"code":"path.outside_project","message":"denied","exit_code":2}}"#,
        )
        .unwrap();
        let error = validate_worker_failure(&valid).unwrap().unwrap();
        assert_eq!(error.code, "path.outside_project");
        assert_eq!(error.exit_code, 2);
    }

    async fn run_fake_response(response: &str) -> Result<CompileResponse, AutomationError> {
        let payload = serde_json::to_string(response).unwrap();
        let fixture = script(&format!("cat >/dev/null; printf '%s\\n' {payload}"));
        let (_sender, receiver) = tokio::sync::oneshot::channel();
        let result = run_worker_process_with_limits(
            fixture.path.clone(),
            b"{}".to_vec(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
            receiver,
            None,
            4096,
            4096,
        )
        .await;
        result
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "current_thread")]
    async fn dropped_compile_request_keeps_its_permit_until_worker_is_reaped() {
        let fixture = script("exec sleep 30");
        let pid_file = fixture.directory.join("worker.pid");
        std::fs::write(
            &fixture.path,
            format!(
                "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec sleep 30\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = semaphore.clone().try_acquire_owned().unwrap();

        let request = tokio::spawn(run_worker_request(
            fixture.path.clone(),
            b"{}".to_vec(),
            Duration::from_secs(60),
            Arc::new(AtomicBool::new(false)),
            permit,
        ));
        let worker_pid = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = pid.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("worker should start and publish its PID");
        assert!(semaphore.clone().try_acquire_owned().is_err());

        request.abort();
        request.await.expect_err("the MCP request future was dropped");
        assert!(
            semaphore.clone().try_acquire_owned().is_err(),
            "the detached supervisor must keep the permit while the child is still running"
        );

        tokio::time::timeout(Duration::from_secs(2), async {
            while std::path::Path::new(&format!("/proc/{worker_pid}")).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled worker should be reaped");
        assert!(
            semaphore.clone().try_acquire_owned().is_ok(),
            "the permit should be released as soon as the worker is reaped"
        );
    }

    #[tokio::test]
    async fn fake_worker_responses_cannot_choose_error_exit_codes() {
        let unknown = r#"{"schema_version":1,"success":false,"worker_error":{"code":"mystery","message":"bad","exit_code":0}}"#;
        let error = run_fake_response(unknown).await.unwrap_err();
        assert_eq!(error.code, "worker.protocol_invalid");
        assert_eq!(error.exit_code, 4);

        let wrong_exit = r#"{"schema_version":1,"success":false,"worker_error":{"code":"path.outside_project","message":"bad","exit_code":0}}"#;
        let error = run_fake_response(wrong_exit).await.unwrap_err();
        assert_eq!(error.code, "worker.protocol_invalid");
        assert_eq!(error.exit_code, 4);
    }

    async fn run_script(
        fixture: TestScript,
        timeout: Duration,
        cancellation: Arc<AtomicBool>,
        output_limit: usize,
        log_limit: usize,
    ) -> Result<CompileResponse, AutomationError> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let result = run_worker_process_with_limits(
            fixture.path.clone(),
            b"{}".to_vec(),
            timeout,
            cancellation,
            receiver,
            None,
            output_limit,
            log_limit,
        )
        .await;
        drop(sender);
        result
    }

    #[tokio::test]
    async fn process_supervisor_reports_crash_protocol_overflow_timeout_and_cancellation() {
        let crash = run_script(
            script("exit 7"),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
            1024,
            1024,
        )
        .await
        .unwrap_err();
        assert_eq!(crash.code, "worker.crashed");
        assert_eq!(crash.exit_code, 4);

        let malformed = run_script(
            script("cat >/dev/null; printf '%s' '{\"schema_version\":1,\"secret\":true}'"),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
            1024,
            1024,
        )
        .await
        .unwrap_err();
        assert_eq!(
            malformed.code, "worker.protocol_invalid",
            "{}",
            malformed.message
        );

        let log_overflow = run_script(
            script("printf '0123456789' >&2; exec sleep 10"),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
            1024,
            4,
        )
        .await
        .unwrap_err();
        assert_eq!(log_overflow.code, "resource.limit_exceeded");

        let timed_out = run_script(
            script("exec sleep 10"),
            Duration::from_millis(200),
            Arc::new(AtomicBool::new(false)),
            1024,
            1024,
        )
        .await
        .unwrap_err();
        assert_eq!(timed_out.exit_code, 124, "{}", timed_out.message);

        let path = script("exec sleep 10");
        let cancellation = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_worker_process_with_limits(
            path.path.clone(),
            b"{}".to_vec(),
            Duration::from_secs(5),
            cancellation.clone(),
            receiver,
            None,
            1024,
            1024,
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancellation.store(true, Ordering::Relaxed);
        let cancelled = task.await.unwrap().unwrap_err();
        drop(sender);
        assert_eq!(cancelled.exit_code, 130);
    }
}
