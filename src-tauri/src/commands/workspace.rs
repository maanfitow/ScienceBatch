use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, OwnedMutexGuard};

use crate::automation::bridge::{BridgeReply, WorkspaceBridge};
use crate::automation::{
    capture_snapshot, capture_virtual_snapshot, compile_snapshot, export_pdf_atomic,
    AutomationError, AutomationService, OperationContext, ProjectSnapshot, PublicDiagnostic,
    PublicError, SnapshotFile, SnapshotFileKind, MAX_ASSET_BYTES, MAX_SNAPSHOT_BYTES,
};
use crate::types::CompileResponse;

#[derive(Clone, Default)]
pub struct WorkspaceCompileJobs {
    active: Arc<Mutex<HashMap<String, WorkspaceJob>>>,
    leases: Arc<Mutex<HashMap<String, Option<OwnedMutexGuard<()>>>>>,
    shutting_down: Arc<AtomicBool>,
    shutdown_complete: Arc<AtomicBool>,
}

struct WorkspaceJob {
    kind: WorkspaceJobKind,
    cancellation: Arc<AtomicBool>,
    completion: watch::Sender<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceJobKind {
    Compile,
    Resource,
}

pub(crate) struct ActiveWorkspaceJob {
    active: Arc<Mutex<HashMap<String, WorkspaceJob>>>,
    job_id: String,
    cancellation: Arc<AtomicBool>,
}

impl Drop for ActiveWorkspaceJob {
    fn drop(&mut self) {
        self.cancellation.store(true, Ordering::Release);
        if let Ok(mut active) = self.active.lock() {
            if let Some(job) = active.remove(&self.job_id) {
                let _ = job.completion.send(true);
            }
        }
    }
}

impl WorkspaceCompileJobs {
    pub(crate) fn register(
        &self,
        job_id: &str,
        kind: WorkspaceJobKind,
    ) -> Result<(Arc<AtomicBool>, ActiveWorkspaceJob), String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("operation.shutting_down: The application is shutting down".into());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Workspace operation registry is unavailable".to_string())?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("operation.shutting_down: The application is shutting down".into());
        }
        if active.contains_key(job_id) {
            return Err("Workspace operation identifier is already active".into());
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        let (completion, _) = watch::channel(false);
        active.insert(
            job_id.to_owned(),
            WorkspaceJob {
                kind,
                cancellation: cancellation.clone(),
                completion,
            },
        );
        Ok((
            cancellation.clone(),
            ActiveWorkspaceJob {
                active: self.active.clone(),
                job_id: job_id.to_owned(),
                cancellation,
            },
        ))
    }

    pub(crate) async fn cancel_and_wait(&self, job_id: &str) -> Result<bool, String> {
        let mut completion = {
            let active = self
                .active
                .lock()
                .map_err(|_| "Workspace operation registry is unavailable".to_string())?;
            let Some(job) = active.get(job_id) else {
                return Ok(false);
            };
            if job.kind != WorkspaceJobKind::Resource {
                return Err("operation.kind_mismatch: Job is not a resource preparation".into());
            }
            job.cancellation.store(true, Ordering::Release);
            job.completion.subscribe()
        };
        await_job_completion(&mut completion).await;
        AutomationService::new().wait_for_workers_idle().await;
        Ok(true)
    }

    pub(crate) fn start_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn is_shutdown_complete(&self) -> bool {
        self.shutdown_complete.load(Ordering::Acquire)
    }

    pub(crate) async fn cancel_all_and_wait(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let mut completions = match self.active.lock() {
            Ok(active) => active
                .values()
                .map(|job| {
                    job.cancellation.store(true, Ordering::Release);
                    job.completion.subscribe()
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for completion in &mut completions {
            await_job_completion(completion).await;
        }
        AutomationService::new().wait_for_workers_idle().await;
        self.shutdown_complete.store(true, Ordering::Release);
    }
}

async fn await_job_completion(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCompileRequest {
    pub job_id: String,
    pub engine: String,
    pub project_root: Option<String>,
    pub main_file: String,
    #[serde(default)]
    pub overlays: BTreeMap<String, String>,
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub workspace_identity: Value,
    #[serde(default)]
    pub template_assets: Option<TemplateAssetGrant>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateAssetGrant {
    StarterLatex,
    StarterTypst,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperationError {
    pub error: PublicError,
    pub diagnostics: Vec<PublicDiagnostic>,
}

impl From<AutomationError> for WorkspaceOperationError {
    fn from(error: AutomationError) -> Self {
        Self {
            error: PublicError {
                code: error.code.to_owned(),
                message: error.message,
                details: error.details,
                exit_code: error.exit_code,
            },
            diagnostics: error.diagnostics,
        }
    }
}

pub(crate) fn legacy_error(error: String) -> AutomationError {
    let (code, message) = error
        .split_once(": ")
        .unwrap_or(("io.project_unavailable", error.as_str()));
    let code = match code {
        "path.outside_roots" => "path.outside_roots",
        "path.symlink_rejected" => "path.symlink_rejected",
        "git.locked" => "git.locked",
        "project.main_missing" => "project.main_missing",
        "project.main_engine_mismatch" => "project.main_engine_mismatch",
        "engine.unsupported" => "engine.unsupported",
        _ => "io.project_unavailable",
    };
    AutomationError::new(code, message.to_owned(), 2)
}

pub(crate) fn capture_workspace_snapshot(
    engine: &str,
    project_root: Option<&str>,
    main_file: &str,
    overlays: &BTreeMap<String, String>,
    allowed_roots: &[String],
    template_assets: Option<TemplateAssetGrant>,
) -> Result<ProjectSnapshot, AutomationError> {
    let overlays = overlays
        .iter()
        .map(|(path, source)| (path.clone(), source.as_bytes().to_vec()))
        .collect::<BTreeMap<_, _>>();
    let snapshot = if let Some(root) = project_root {
        if template_assets.is_some() {
            return Err(AutomationError::new(
                "resources.template_grant_invalid",
                "Template assets can only be granted to a rootless in-memory project.",
                2,
            ));
        }
        let canonical =
            canonical_authorized_project_root(root, allowed_roots).map_err(legacy_error)?;
        let snapshot = capture_snapshot(&canonical, main_file, &overlays)?;
        if !snapshot.engine.eq_ignore_ascii_case(engine) {
            return Err(AutomationError::new(
                "project.main_engine_mismatch",
                "The selected engine does not match the workspace main file.",
                2,
            ));
        }
        snapshot
    } else {
        let mut snapshot = capture_virtual_snapshot(engine, main_file, &overlays)?;
        if let Some(grant) = template_assets {
            let required_engine = match grant {
                TemplateAssetGrant::StarterLatex => "latex",
                TemplateAssetGrant::StarterTypst => "typst",
            };
            if !snapshot.engine.eq_ignore_ascii_case(required_engine) {
                return Err(AutomationError::new(
                    "resources.template_grant_invalid",
                    "The template asset grant does not match the selected engine.",
                    2,
                ));
            }
            add_template_asset(
                &mut snapshot,
                "references.bib",
                crate::compiler::embedded::SAMPLE_BIB,
            )?;
            add_template_asset(
                &mut snapshot,
                "assets/sample.png",
                crate::compiler::embedded::SAMPLE_PNG,
            )?;
            add_template_asset(
                &mut snapshot,
                "assets/sample.gif",
                crate::compiler::embedded::SAMPLE_GIF,
            )?;
        }
        snapshot
    };
    if snapshot.total_bytes > MAX_SNAPSHOT_BYTES {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Project snapshot exceeds 128 MiB.",
            3,
        ));
    }
    Ok(snapshot)
}

fn add_template_asset(
    snapshot: &mut ProjectSnapshot,
    path: &str,
    bytes: &[u8],
) -> Result<(), AutomationError> {
    if snapshot.files.contains_key(path) {
        return Ok(());
    }
    if bytes.len() > MAX_ASSET_BYTES
        || snapshot.total_bytes.saturating_add(bytes.len()) > MAX_SNAPSHOT_BYTES
    {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Granted template assets exceed the project snapshot limit.",
            3,
        ));
    }
    snapshot.total_bytes += bytes.len();
    snapshot.files.insert(
        path.to_owned(),
        SnapshotFile {
            bytes: bytes.to_vec(),
            kind: SnapshotFileKind::Asset,
        },
    );
    Ok(())
}

pub(crate) fn canonical_allowed_roots(roots: &[String]) -> Result<Vec<std::path::PathBuf>, String> {
    if roots.is_empty() {
        return Err(
            "path.outside_roots: At least one authorized workspace root is required".to_string(),
        );
    }
    roots
        .iter()
        .map(|value| {
            let path = Path::new(value);
            let metadata = std::fs::symlink_metadata(path).map_err(|error| {
                format!("path.outside_roots: Cannot inspect authorized root: {error}")
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(
                    "path.symlink_rejected: Authorized roots must be real directories".to_string(),
                );
            }
            path.canonicalize().map_err(|error| {
                format!("path.outside_roots: Cannot resolve authorized root: {error}")
            })
        })
        .collect()
}

fn canonical_authorized_project_root(
    project_root: &str,
    allowed_roots: &[String],
) -> Result<std::path::PathBuf, String> {
    let path = Path::new(project_root);
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("io.project_unavailable: Cannot inspect project root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("path.symlink_rejected: Project root must be a real directory".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("io.project_unavailable: Cannot resolve project root: {error}"))?;
    let roots = canonical_allowed_roots(allowed_roots)?;
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("path.outside_roots: Project is outside the authorized roots".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
pub fn workspace_validate_root(
    project_root: String,
    allowed_roots: Vec<String>,
) -> Result<String, String> {
    canonical_authorized_project_root(&project_root, &allowed_roots)
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn workspace_automation_ready(bridge: State<'_, WorkspaceBridge>) {
    bridge.state.set_handler_ready();
}

#[tauri::command]
pub fn workspace_automation_reply(
    bridge: State<'_, WorkspaceBridge>,
    id: String,
    reply: BridgeReply,
) -> Result<(), String> {
    if reply.id != id || reply.schema_version != 1 {
        return Err(
            "Workspace response identifier or version does not match the request".to_string(),
        );
    }
    bridge.state.reply(&id, reply)
}

#[tauri::command]
pub async fn acquire_workspace_repository_lock(
    jobs: State<'_, WorkspaceCompileJobs>,
    project_root: Option<String>,
    lease_id: String,
) -> Result<(), String> {
    if lease_id.is_empty() || lease_id.len() > 256 {
        return Err("Workspace operation identifier is invalid".to_string());
    }
    {
        let leases = jobs
            .leases
            .lock()
            .map_err(|_| "Workspace operation registry is unavailable".to_string())?;
        if leases.contains_key(&lease_id) {
            return Err("Workspace operation identifier is already active".to_string());
        }
    }
    let guard = if let Some(root) = project_root {
        crate::commands::git::workspace_repository_guard(Path::new(&root))
            .await
            .map_err(|error| {
                if error.code == "Busy" {
                    format!("git.locked: {}", error.message)
                } else {
                    error.message
                }
            })?
    } else {
        None
    };
    let mut leases = jobs
        .leases
        .lock()
        .map_err(|_| "Workspace operation registry is unavailable".to_string())?;
    if leases.contains_key(&lease_id) {
        return Err("Workspace operation identifier is already active".to_string());
    }
    leases.insert(lease_id, guard);
    Ok(())
}

#[tauri::command]
pub fn release_workspace_repository_lock(
    jobs: State<'_, WorkspaceCompileJobs>,
    lease_id: String,
) -> bool {
    jobs.leases
        .lock()
        .ok()
        .and_then(|mut leases| leases.remove(&lease_id))
        .is_some()
}

#[tauri::command]
pub async fn workspace_apply_disk(
    project_root: String,
    file: String,
    content: String,
    expected_sha256: String,
    allowed_roots: Vec<String>,
) -> Result<serde_json::Value, String> {
    let canonical_root = canonical_authorized_project_root(&project_root, &allowed_roots)?;
    let _repository_guard = crate::commands::git::workspace_repository_guard(&canonical_root)
        .await
        .map_err(|error| {
            if error.code == "Busy" {
                format!("git.locked: {}", error.message)
            } else {
                error.message
            }
        })?;
    let service = AutomationService::new();
    let result = service
        .dispatch(
            "project.apply",
            json!({
                "project": canonical_root.to_string_lossy(),
                "file": file,
                "content": content,
                "expectedSha256": expected_sha256,
            }),
            OperationContext {
                allowed_roots: canonical_allowed_roots(&allowed_roots)?,
                ..OperationContext::local()
            },
        )
        .await;
    if result.ok {
        Ok(result.data.unwrap_or(serde_json::Value::Null))
    } else {
        Err(result
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| "Source update failed".to_string()))
    }
}

#[tauri::command]
pub async fn workspace_read_disk(
    project_root: String,
    file: String,
    allowed_roots: Vec<String>,
) -> Result<serde_json::Value, String> {
    let canonical_root = canonical_authorized_project_root(&project_root, &allowed_roots)?;
    let service = AutomationService::new();
    let result = service
        .dispatch(
            "project.read",
            json!({ "project": canonical_root.to_string_lossy(), "file": file }),
            OperationContext {
                allowed_roots: canonical_allowed_roots(&allowed_roots)?,
                ..OperationContext::local()
            },
        )
        .await;
    if result.ok {
        Ok(result.data.unwrap_or(serde_json::Value::Null))
    } else {
        Err(result
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| "File read failed".to_string()))
    }
}

#[tauri::command]
pub fn workspace_export_pdf(
    output_path: String,
    pdf_bytes: Vec<u8>,
    overwrite: bool,
    allowed_roots: Vec<String>,
) -> Result<(), String> {
    let roots = canonical_allowed_roots(&allowed_roots)?;
    export_pdf_atomic(Path::new(&output_path), &pdf_bytes, overwrite, &roots)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn compile_workspace_snapshot(
    app: AppHandle,
    jobs: State<'_, WorkspaceCompileJobs>,
    mut request: WorkspaceCompileRequest,
) -> Result<CompileResponse, WorkspaceOperationError> {
    if request.job_id.is_empty() || request.job_id.len() > 128 {
        return Err(AutomationError::new(
            "usage.invalid_argument",
            "Workspace compilation job identifier is invalid.",
            2,
        )
        .into());
    }
    let timeout_seconds = request.timeout_seconds.unwrap_or(120);
    if !(1..=900).contains(&timeout_seconds) {
        return Err(AutomationError::new(
            "usage.invalid_argument",
            "Compilation timeout must be between 1 and 900 seconds.",
            2,
        )
        .into());
    }
    let identity_bytes = serde_json::to_vec(&request.workspace_identity)
        .map_err(|error| AutomationError::new("usage.invalid_argument", error.to_string(), 2))?;
    if identity_bytes.len() > 64 * 1024 {
        return Err(AutomationError::new(
            "resource.limit_exceeded",
            "Workspace identity exceeds 64 KiB.",
            3,
        )
        .into());
    }
    let (cancellation, _job_guard) = jobs
        .register(&request.job_id, WorkspaceJobKind::Compile)
        .map_err(|message| {
            let code = if message.starts_with("operation.shutting_down:") {
                "operation.shutting_down"
            } else {
                "worker.busy"
            };
            AutomationError::new(code, message, 3)
        })?;
    let _repository_guard = if let Some(root) = request.project_root.as_deref() {
        let canonical_root = canonical_authorized_project_root(root, &request.allowed_roots)
            .map_err(legacy_error)?;
        crate::commands::git::workspace_repository_guard(&canonical_root)
            .await
            .map_err(|error| {
                if error.code == "Busy" {
                    format!("git.locked: {}", error.message)
                } else {
                    error.message
                }
            })
            .map_err(legacy_error)?
    } else {
        None
    };
    if cancellation.load(Ordering::Acquire) {
        return Err(AutomationError::new(
            "operation.interrupted",
            "Workspace compilation was cancelled.",
            130,
        )
        .into());
    }
    let engine = request.engine.clone();
    let project_root = request.project_root.clone();
    let main_file = request.main_file.clone();
    let overlays = std::mem::take(&mut request.overlays);
    let allowed_roots = std::mem::take(&mut request.allowed_roots);
    let template_assets = request.template_assets;
    let snapshot = tokio::task::spawn_blocking(move || {
        capture_workspace_snapshot(
            &engine,
            project_root.as_deref(),
            &main_file,
            &overlays,
            &allowed_roots,
            template_assets,
        )
    })
    .await
    .map_err(|error| {
        AutomationError::new(
            "internal.unexpected",
            format!("Snapshot capture task failed: {error}"),
            4,
        )
    })??;
    let _ = app.emit(
        "workspace-compilation-progress",
        serde_json::json!({
            "jobId": request.job_id,
            "workspaceIdentity": request.workspace_identity.clone(),
            "status": "Started",
            "message": format!("Compiling current workspace snapshot ({})", request.job_id),
            "code": "compiler.workspace_started",
            "params": {
                "jobId": request.job_id,
            },
        }),
    );
    let result = compile_snapshot(
        &snapshot,
        Duration::from_secs(timeout_seconds),
        cancellation.clone(),
    )
    .await
    .map_err(WorkspaceOperationError::from);
    let status = if cancellation.load(Ordering::Acquire) {
        "Cancelled"
    } else if result.is_ok() {
        "Finished"
    } else {
        "Error"
    };
    let _ = app.emit("workspace-compilation-progress", serde_json::json!({
        "jobId": request.job_id,
        "workspaceIdentity": request.workspace_identity,
        "status": status,
        "message": format!("Workspace compilation {} ({})", status.to_lowercase(), request.job_id),
        "code": "compiler.workspace_finished",
        "params": {
            "status": status,
            "jobId": request.job_id,
        },
    }));
    result
}

#[tauri::command]
pub fn cancel_workspace_compilation(
    jobs: State<'_, WorkspaceCompileJobs>,
    job_id: String,
) -> Result<bool, String> {
    let active = jobs
        .active
        .lock()
        .map_err(|_| "Workspace operation registry is unavailable".to_string())?;
    if let Some(job) = active.get(&job_id) {
        if job.kind != WorkspaceJobKind::Compile {
            return Err("operation.kind_mismatch: Job is not a workspace compilation".into());
        }
        job.cancellation.store(true, Ordering::Release);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_workspace_snapshot, workspace_apply_disk, TemplateAssetGrant, WorkspaceCompileJobs,
        WorkspaceJobKind,
    };
    use crate::automation::resource_project;
    use crate::commands::git::workspace_repository_guard;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::process::Command;

    #[tokio::test]
    async fn workspace_save_reuses_git_repository_lock() {
        let root = std::env::temp_dir().join(format!(
            "sciencebatch-workspace-lock-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let initialized = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(initialized.success(), "Git fixture initialization failed");
        let source_path = root.join("draft.tex");
        std::fs::write(&source_path, "original source\n").unwrap();
        let original = std::fs::read(&source_path).unwrap();
        let expected_hash = format!("{:x}", Sha256::digest(&original));
        let root_string = root.to_string_lossy().into_owned();

        let guard = workspace_repository_guard(&root).await.unwrap().unwrap();
        let result = workspace_apply_disk(
            root_string.clone(),
            "draft.tex".to_string(),
            "replacement source\n".to_string(),
            expected_hash,
            vec![root_string],
        )
        .await;
        assert!(result.unwrap_err().starts_with("git.locked:"));
        assert_eq!(std::fs::read(&source_path).unwrap(), original);
        drop(guard);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn capture_applies_dirty_main_secondary_and_manifest_overlays_and_binds_identity() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.tex"), "disk main").unwrap();
        std::fs::write(root.join("chapter.tex"), "disk chapter").unwrap();
        std::fs::write(root.join("sciencebatch.resources.json"), "disk manifest").unwrap();
        let mut overlays = BTreeMap::new();
        overlays.insert(
            "main.tex".into(),
            "\\documentclass{article}\n\\input{chapter}\n".into(),
        );
        overlays.insert("chapter.tex".into(), "dirty chapter".into());
        overlays.insert(
            "sciencebatch.resources.json".into(),
            r#"{"schemaVersion":1,"requirements":[{"kind":"pack","id":"latex-basic"}]}"#.into(),
        );
        let root_text = root.to_string_lossy().into_owned();
        let roots = vec![parent.path().to_string_lossy().into_owned()];
        let snapshot = capture_workspace_snapshot(
            "latex",
            Some(&root_text),
            "main.tex",
            &overlays,
            &roots,
            None,
        )
        .unwrap();
        assert_eq!(snapshot.files["chapter.tex"].bytes, b"dirty chapter");
        assert_eq!(
            snapshot.files["sciencebatch.resources.json"].bytes,
            overlays["sciencebatch.resources.json"].as_bytes()
        );
        assert_eq!(
            snapshot.files["main.tex"].bytes,
            overlays["main.tex"].as_bytes()
        );

        let first =
            resource_project::resolved_plan(&snapshot, &json!({"workspaceIdentity":{"id":"one"}}))
                .unwrap();
        let second =
            resource_project::resolved_plan(&snapshot, &json!({"workspaceIdentity":{"id":"two"}}))
                .unwrap();
        assert_ne!(first.input_digest, second.input_digest);
    }

    #[test]
    fn template_grants_are_rootless_engine_matched_and_explicit() {
        let mut overlays = BTreeMap::new();
        overlays.insert(
            "main.tex".into(),
            "\\includegraphics{assets/sample.png}".into(),
        );
        let snapshot = capture_workspace_snapshot(
            "latex",
            None,
            "main.tex",
            &overlays,
            &[],
            Some(TemplateAssetGrant::StarterLatex),
        )
        .unwrap();
        assert!(snapshot.files.contains_key("assets/sample.png"));
        assert!(snapshot.files.contains_key("assets/sample.gif"));
        assert!(snapshot.files.contains_key("references.bib"));

        assert!(capture_workspace_snapshot(
            "typst",
            None,
            "main.typ",
            &BTreeMap::from([("main.typ".into(), "#image(\"assets/sample.png\")".into())]),
            &[],
            Some(TemplateAssetGrant::StarterLatex),
        )
        .is_err());

        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("existing");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.tex"), "\\documentclass{article}").unwrap();
        assert!(capture_workspace_snapshot(
            "latex",
            Some(root.to_str().unwrap()),
            "main.tex",
            &BTreeMap::new(),
            &[parent.path().to_string_lossy().into_owned()],
            Some(TemplateAssetGrant::StarterLatex),
        )
        .is_err());
    }

    #[tokio::test]
    async fn cancellation_waits_for_registered_worker_and_shutdown_blocks_new_jobs() {
        let jobs = WorkspaceCompileJobs::default();
        let (_cancel, guard) = jobs
            .register("resource-job", WorkspaceJobKind::Resource)
            .unwrap();
        let (_compile_cancel, compile_guard) = jobs
            .register("compile-job", WorkspaceJobKind::Compile)
            .unwrap();
        assert!(jobs
            .cancel_and_wait("compile-job")
            .await
            .unwrap_err()
            .contains("not a resource"));
        drop(compile_guard);
        let cancel_jobs = jobs.clone();
        let cancellation =
            tokio::spawn(async move { cancel_jobs.cancel_and_wait("resource-job").await.unwrap() });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !job_is_cancelled(&jobs, "resource-job") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel request should reach the active workspace job");
        drop(guard);
        assert!(cancellation.await.unwrap());

        assert!(jobs.start_shutdown());
        assert!(jobs
            .register("after-shutdown", WorkspaceJobKind::Resource)
            .err()
            .unwrap()
            .starts_with("operation.shutting_down:"));
        jobs.cancel_all_and_wait().await;
        assert!(jobs.is_shutdown_complete());
    }

    fn job_is_cancelled(jobs: &WorkspaceCompileJobs, job_id: &str) -> bool {
        jobs.active
            .lock()
            .unwrap()
            .get(job_id)
            .is_some_and(|job| job.cancellation.load(std::sync::atomic::Ordering::Acquire))
    }
}
