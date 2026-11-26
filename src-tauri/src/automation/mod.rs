//! Headless automation operations shared by the console client, MCP adapter,
//! and the live desktop workspace bridge.

pub mod bridge;
pub mod bridge_client;
pub(crate) mod compiler;
pub mod mcp;
mod project;
mod resource_cache;
mod resource_prepare;
pub mod resource_project;
mod resources;
mod worker;

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;

pub use compiler::export_pdf_atomic;
pub use compiler::worker_executable;

/// Configure a background child process so Windows GUI builds never flash a console window.
pub(crate) fn configure_background_command(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
pub use project::{
    capture_snapshot, capture_virtual_snapshot, normalize_project_path, ProjectInfo,
};

pub fn run_automation_worker() {
    worker::run_automation_worker();
}
pub fn run_resource_prepare_worker() {
    resources::run_prepare_worker();
}
pub fn run_resource_project_worker() {
    resource_prepare::run_worker();
}
pub fn failure_for_cli(command: &str, code: String, message: String, exit_code: i32) -> Envelope {
    Envelope {
        schema_version: 1,
        command: command.to_owned(),
        ok: false,
        data: None,
        diagnostics: Vec::new(),
        error: Some(PublicError {
            code,
            message,
            details: None,
            exit_code,
        }),
    }
}

pub const MAX_ENTRIES: usize = 10_000;
pub const MAX_DEPTH: usize = 64;
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PROTOCOL_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_LOG_BYTES: usize = 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub schema_version: u32,
    pub command: String,
    pub ok: bool,
    pub data: Option<Value>,
    pub diagnostics: Vec<PublicDiagnostic>,
    pub error: Option<PublicError>,
}

impl Envelope {
    pub fn exit_code(&self) -> i32 {
        self.error.as_ref().map_or(0, |error| error.exit_code)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub origin: String,
    pub file: Option<String>,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub suggestion: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PublicError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(skip)]
    pub exit_code: i32,
}

#[derive(Clone, Debug)]
pub struct AutomationError {
    pub code: &'static str,
    pub message: String,
    pub exit_code: i32,
    pub details: Option<Value>,
    pub diagnostics: Vec<PublicDiagnostic>,
}

impl AutomationError {
    pub fn new(code: &'static str, message: impl Into<String>, exit_code: i32) -> Self {
        Self {
            code,
            message: message.into(),
            exit_code,
            details: None,
            diagnostics: Vec::new(),
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_diagnostics(mut self, diagnostics: Vec<PublicDiagnostic>) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    fn public(&self) -> PublicError {
        PublicError {
            code: self.code.to_owned(),
            message: self.message.clone(),
            details: self.details.clone(),
            exit_code: self.exit_code,
        }
    }
}

impl std::fmt::Display for AutomationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AutomationError {}

#[derive(Clone, Debug, Default)]
pub struct OperationContext {
    /// Canonical allowed project roots. An empty list permits local CLI roots.
    pub allowed_roots: Vec<PathBuf>,
    pub allow_write: bool,
    pub allow_resource_download: bool,
    pub cancellation: Arc<AtomicBool>,
    /// Optional non-blocking progress channel used by desktop adapters.
    pub resource_progress: Option<tokio::sync::broadcast::Sender<ResourceProgress>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProgress {
    pub job_id: String,
    pub bundle_digest: String,
    pub phase: String,
    pub completed_resources: usize,
    pub total_resources: usize,
    pub downloaded_bytes: u64,
    pub max_download_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_path: Option<String>,
}

impl OperationContext {
    pub fn local() -> Self {
        Self {
            allow_write: true,
            allow_resource_download: true,
            ..Self::default()
        }
    }

    pub fn cancelled(&self) -> bool {
        self.cancellation.load(Ordering::Relaxed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotFileKind {
    Text,
    Asset,
}

#[derive(Clone, Debug)]
pub struct SnapshotFile {
    pub bytes: Vec<u8>,
    pub kind: SnapshotFileKind,
}

#[derive(Clone, Debug)]
pub struct ProjectSnapshot {
    pub engine: String,
    pub root: PathBuf,
    pub main_file: String,
    pub files: std::collections::BTreeMap<String, SnapshotFile>,
    pub total_bytes: usize,
}

#[derive(Clone)]
pub struct AutomationService {
    worker_limit: Arc<Semaphore>,
}

impl Default for AutomationService {
    fn default() -> Self {
        Self::new()
    }
}

impl AutomationService {
    pub fn new() -> Self {
        Self {
            worker_limit: worker_semaphore(),
        }
    }

    /// Execute one transport-independent automation operation.
    pub async fn dispatch(
        &self,
        command: &str,
        args: Value,
        context: OperationContext,
    ) -> Envelope {
        let mut envelope = match self.dispatch_inner(command, args, context).await {
            Ok((data, diagnostics)) => Envelope {
                schema_version: 1,
                command: command.to_owned(),
                ok: true,
                data: Some(data),
                diagnostics,
                error: None,
            },
            Err(error) => Envelope {
                schema_version: 1,
                command: command.to_owned(),
                ok: false,
                data: None,
                diagnostics: error.diagnostics.clone(),
                error: Some(error.public()),
            },
        };
        envelope.command = command.to_owned();
        envelope
    }

    async fn dispatch_inner(
        &self,
        command: &str,
        args: Value,
        context: OperationContext,
    ) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
        match command {
            "project.inspect" => project::inspect(&args, &context),
            "project.create" => project::create(&args, &context),
            "project.read" => project::read(&args, &context),
            "project.search" => project::search(&args, &context),
            "project.apply" => project::apply(&args, &context),
            "diagnostics" => {
                let (data, diagnostics) = project::diagnostics(&args, &context)?;
                if diagnostics.iter().any(|d| d.severity == "error") {
                    return Err(AutomationError::new(
                        "project.main_empty",
                        "Preflight found an empty main source.",
                        1,
                    )
                    .with_diagnostics(diagnostics));
                }
                Ok((data, diagnostics))
            }
            "compile" => {
                let mut snapshot = project::resolve_capture(&args, &context)?;
                if let Some(output) = args.get("output").and_then(Value::as_str) {
                    let destination = canonical_allowed_destination(Path::new(output), &context)?;
                    if destination.starts_with(&snapshot.root) {
                        if let Ok(relative) = destination.strip_prefix(&snapshot.root) {
                            let relative = relative.to_string_lossy().replace('\\', "/");
                            if snapshot
                                .files
                                .get(&relative)
                                .is_some_and(|file| file.kind == SnapshotFileKind::Asset)
                            {
                                if let Some(previous) = snapshot.files.remove(&relative) {
                                    snapshot.total_bytes =
                                        snapshot.total_bytes.saturating_sub(previous.bytes.len());
                                }
                            }
                        }
                    }
                }
                let seconds = args.get("timeout").and_then(Value::as_u64).unwrap_or(120);
                if !(1..=900).contains(&seconds) {
                    return Err(AutomationError::new(
                        "usage.invalid_argument",
                        "Timeout must be between 1 and 900 seconds.",
                        2,
                    ));
                }
                let result = self
                    .compile_snapshot(
                        &snapshot,
                        Duration::from_secs(seconds),
                        context.cancellation.clone(),
                    )
                    .await?;
                compiler::export_and_summarize(&snapshot, &args, result, &context)
            }
            "resources.status" => resources::status(),
            "resources.analyze" | "resources.plan" | "resources.list" => {
                let snapshot = project::resolve_capture(&args, &context)?;
                resource_project::dispatch(command, &snapshot, &args)
            }
            "resources.cache_list" | "resources.cache_remove" => {
                if command == "resources.cache_remove" && !context.allow_write {
                    return Err(AutomationError::new(
                        "permission.write_required",
                        "Cache removal requires explicit write permission.",
                        2,
                    ));
                }
                let snapshot = project::resolve_capture(&args, &context)?;
                let operation = command.to_owned();
                let context = context.clone();
                tokio::task::spawn_blocking(move || {
                    resource_cache::dispatch(&operation, &snapshot, &args, &context)
                })
                .await
                .map_err(|error| {
                    AutomationError::new(
                        "internal.unexpected",
                        format!("Resource cache operation task failed: {error}"),
                        4,
                    )
                })?
            }
            "resources.prepare_project" => {
                let permit = self.worker_limit.clone().try_acquire_owned().map_err(|_| {
                    AutomationError::new(
                        "worker.busy",
                        "Another compiler or resource worker is already active in this instance.",
                        3,
                    )
                })?;
                let snapshot = project::resolve_capture(&args, &context)?;
                resource_prepare::prepare_snapshot(&snapshot, &args, &context, permit).await
            }
            "resources.prepare" => {
                let permit = self.worker_limit.clone().try_acquire_owned().map_err(|_| {
                    AutomationError::new(
                        "worker.busy",
                        "Another compiler or resource worker is already active in this instance.",
                        3,
                    )
                })?;
                resources::prepare(&args, &context, permit).await
            }
            _ => Err(AutomationError::new(
                "usage.invalid_argument",
                format!("Unknown operation '{command}'."),
                2,
            )),
        }
    }

    pub async fn compile_snapshot(
        &self,
        snapshot: &ProjectSnapshot,
        timeout: Duration,
        cancellation: Arc<AtomicBool>,
    ) -> Result<crate::types::CompileResponse, AutomationError> {
        if cancellation.load(Ordering::Relaxed) {
            return Err(AutomationError::new(
                "operation.interrupted",
                "Compilation was cancelled.",
                130,
            ));
        }
        let permit = self.worker_limit.clone().try_acquire_owned().map_err(|_| {
            AutomationError::new(
                "worker.busy",
                "Another compiler worker is already active in this instance.",
                3,
            )
        })?;
        worker::run_worker(snapshot, timeout, cancellation, permit).await
    }

    /// Prepare the known resources for an already captured project snapshot.
    /// Tauri workspace adapters use this entrypoint to preserve dirty overlays.
    pub async fn prepare_resources_snapshot(
        &self,
        snapshot: &ProjectSnapshot,
        args: &Value,
        context: &OperationContext,
    ) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
        let permit = self.worker_limit.clone().try_acquire_owned().map_err(|_| {
            AutomationError::new(
                "worker.busy",
                "Another compiler or resource worker is already active in this instance.",
                3,
            )
        })?;
        resource_prepare::prepare_snapshot(snapshot, args, context, permit).await
    }

    /// Run a read-only resource operation against a captured in-memory snapshot.
    /// Snapshot analysis is kept off the async runtime's executor threads.
    pub async fn resources_snapshot_operation(
        &self,
        operation: String,
        snapshot: ProjectSnapshot,
        args: Value,
        context: OperationContext,
    ) -> Result<(Value, Vec<PublicDiagnostic>), AutomationError> {
        tokio::task::spawn_blocking(move || match operation.as_str() {
            "resources.cache_list" => {
                resource_cache::dispatch(&operation, &snapshot, &args, &context)
            }
            "resources.cache_remove" if context.allow_write => {
                resource_cache::dispatch(&operation, &snapshot, &args, &context)
            }
            "resources.cache_remove" => Err(AutomationError::new(
                "permission.write_required",
                "Cache removal requires explicit write permission.",
                2,
            )),
            _ => resource_project::dispatch(&operation, &snapshot, &args),
        })
        .await
        .map_err(|error| {
            AutomationError::new(
                "internal.unexpected",
                format!("Resource analysis task failed: {error}"),
                4,
            )
        })?
    }

    /// Wait until the shared isolated compiler/resource worker slot is free.
    /// Shutdown uses this after cancellation so detached cleanup remains reaped.
    pub async fn wait_for_workers_idle(&self) {
        if let Ok(permit) = self.worker_limit.clone().acquire_owned().await {
            drop(permit);
        }
    }
}

fn worker_semaphore() -> Arc<Semaphore> {
    static LIMIT: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();
    LIMIT.get_or_init(|| Arc::new(Semaphore::new(1))).clone()
}

pub async fn compile_snapshot(
    snapshot: &ProjectSnapshot,
    timeout: Duration,
    cancellation: Arc<AtomicBool>,
) -> Result<crate::types::CompileResponse, AutomationError> {
    AutomationService::new()
        .compile_snapshot(snapshot, timeout, cancellation)
        .await
}

pub(crate) fn failure(command: &str, error: AutomationError) -> Envelope {
    Envelope {
        schema_version: 1,
        command: command.to_owned(),
        ok: false,
        data: None,
        diagnostics: vec![],
        error: Some(error.public()),
    }
}

pub(crate) fn success(command: &str, data: Value, diagnostics: Vec<PublicDiagnostic>) -> Envelope {
    Envelope {
        schema_version: 1,
        command: command.to_owned(),
        ok: true,
        data: Some(data),
        diagnostics,
        error: None,
    }
}

pub(crate) fn as_error(
    code: &'static str,
    message: impl Into<String>,
    exit: i32,
) -> AutomationError {
    AutomationError::new(code, message, exit)
}

pub(crate) fn check_allowed_root(
    path: &Path,
    context: &OperationContext,
) -> Result<(), AutomationError> {
    if context.allowed_roots.is_empty()
        || context
            .allowed_roots
            .iter()
            .any(|root| path.starts_with(root))
    {
        Ok(())
    } else {
        Err(AutomationError::new(
            "path.outside_project",
            "The requested project is outside the configured roots.",
            2,
        ))
    }
}

pub(crate) fn canonical_allowed_destination(
    path: &Path,
    context: &OperationContext,
) -> Result<PathBuf, AutomationError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let parent = absolute.parent().unwrap_or_else(|| Path::new("."));
    let mut checked = PathBuf::new();
    for component in parent.components() {
        checked.push(component.as_os_str());
        if checked.exists() {
            let meta = std::fs::symlink_metadata(&checked)
                .map_err(|e| AutomationError::new("io.output_failed", e.to_string(), 3))?;
            if meta.file_type().is_symlink() {
                return Err(AutomationError::new(
                    "path.symlink_rejected",
                    "Output path cannot pass through symbolic links.",
                    2,
                ));
            }
        }
    }
    let parent = std::fs::canonicalize(parent).map_err(|e| {
        AutomationError::new(
            "io.output_failed",
            format!("Cannot resolve output directory: {e}"),
            3,
        )
    })?;
    check_allowed_root(&parent, context)?;
    let name = absolute.file_name().ok_or_else(|| {
        AutomationError::new("output.invalid", "Output path must include a filename.", 2)
    })?;
    Ok(parent.join(name))
}
