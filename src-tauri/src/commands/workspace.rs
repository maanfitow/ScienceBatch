use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::OwnedMutexGuard;

use crate::automation::bridge::{BridgeReply, WorkspaceBridge};
use crate::automation::{
    capture_snapshot, capture_virtual_snapshot, compile_snapshot, export_pdf_atomic,
    AutomationService, OperationContext,
};
use crate::types::CompileResponse;

#[derive(Default)]
pub struct WorkspaceCompileJobs {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    leases: Mutex<HashMap<String, Option<OwnedMutexGuard<()>>>>,
}

struct ActiveWorkspaceJob {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    job_id: String,
    cancellation: Arc<AtomicBool>,
}

impl Drop for ActiveWorkspaceJob {
    fn drop(&mut self) {
        self.cancellation.store(true, Ordering::Release);
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.job_id);
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
}

fn canonical_allowed_roots(roots: &[String]) -> Result<Vec<std::path::PathBuf>, String> {
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
    request: WorkspaceCompileRequest,
) -> Result<CompileResponse, String> {
    if request.job_id.is_empty() || request.job_id.len() > 128 {
        return Err("Workspace compilation job identifier is invalid".to_string());
    }
    let timeout_seconds = request.timeout_seconds.unwrap_or(120);
    if !(1..=900).contains(&timeout_seconds) {
        return Err("Compilation timeout must be between 1 and 900 seconds".to_string());
    }
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut active = jobs
            .active
            .lock()
            .map_err(|_| "Workspace compilation registry is unavailable".to_string())?;
        if active.contains_key(&request.job_id) {
            return Err("Workspace compilation job identifier is already active".to_string());
        }
        active.insert(request.job_id.clone(), cancellation.clone());
    }
    let _job_guard = ActiveWorkspaceJob {
        active: jobs.active.clone(),
        job_id: request.job_id.clone(),
        cancellation: cancellation.clone(),
    };
    let _repository_guard = if let Some(root) = request.project_root.as_deref() {
        let canonical_root = canonical_authorized_project_root(root, &request.allowed_roots)?;
        crate::commands::git::workspace_repository_guard(&canonical_root)
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
    if cancellation.load(Ordering::Acquire) {
        return Err("operation.interrupted: Workspace compilation was cancelled".to_string());
    }
    let overlays = request
        .overlays
        .into_iter()
        .map(|(path, source)| (path, source.into_bytes()))
        .collect::<BTreeMap<_, _>>();
    let snapshot = match request.project_root.as_deref() {
        Some(root) => {
            canonical_authorized_project_root(root, &request.allowed_roots).and_then(|canonical| {
                capture_snapshot(&canonical, &request.main_file, &overlays)
                    .map_err(|error| error.to_string())
            })
        }
        None => capture_virtual_snapshot(&request.engine, &request.main_file, &overlays)
            .map_err(|error| error.to_string()),
    }
    .map_err(|error| error.to_string());
    let result =
        match snapshot {
            Ok(snapshot) => {
                let _ = app.emit("workspace-compilation-progress", serde_json::json!({
                "jobId": request.job_id,
                "status": "Started",
                "message": format!("Compiling current workspace snapshot ({})", request.job_id),
            }));
                compile_snapshot(
                    &snapshot,
                    Duration::from_secs(timeout_seconds),
                    cancellation.clone(),
                )
                .await
                .map_err(|error| error.to_string())
            }
            Err(error) => Err(error),
        };
    let status = if cancellation.load(Ordering::Acquire) {
        "Cancelled"
    } else if result.is_ok() {
        "Finished"
    } else {
        "Error"
    };
    let _ = app.emit("workspace-compilation-progress", serde_json::json!({
        "jobId": request.job_id,
        "status": status,
        "message": format!("Workspace compilation {} ({})", status.to_lowercase(), request.job_id),
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
        .map_err(|_| "Workspace compilation registry is unavailable".to_string())?;
    match active.get(&job_id) {
        Some(cancellation) => {
            cancellation.store(true, Ordering::Release);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::workspace_apply_disk;
    use crate::commands::git::workspace_repository_guard;
    use sha2::{Digest, Sha256};
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
}
