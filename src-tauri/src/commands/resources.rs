use std::collections::BTreeMap;
use tauri::{command, AppHandle, Emitter, State};

use crate::automation::resource_project::ResourceSelector;
use crate::automation::{AutomationError, AutomationService, OperationContext, ResourceProgress};
use crate::commands::workspace::{
    capture_workspace_snapshot, TemplateAssetGrant, WorkspaceCompileJobs, WorkspaceJobKind,
    WorkspaceOperationError,
};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResourcesWorkspaceRequest {
    pub operation: String,
    pub job_id: String,
    pub engine: String,
    pub project_root: Option<String>,
    pub main_file: String,
    #[serde(default)]
    pub overlays: BTreeMap<String, String>,
    #[serde(default)]
    pub allowed_roots: Vec<String>,
    pub workspace_identity: serde_json::Value,
    #[serde(default)]
    pub selection: Option<Vec<ResourceSelector>>,
    #[serde(default)]
    pub expected_input_digest: Option<String>,
    #[serde(default)]
    pub expected_plan_digest: Option<String>,
    #[serde(default)]
    pub expected_cache_digest: Option<String>,
    #[serde(default)]
    pub remove_paths: Option<Vec<String>>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub max_download_bytes: Option<u64>,
    #[serde(default)]
    pub max_storage_bytes: Option<u64>,
    #[serde(default)]
    pub template_assets: Option<TemplateAssetGrant>,
}

#[command]
pub async fn resources_workspace_operation(
    app: AppHandle,
    jobs: State<'_, WorkspaceCompileJobs>,
    mut request: ResourcesWorkspaceRequest,
) -> Result<serde_json::Value, WorkspaceOperationError> {
    if request.job_id.is_empty() || request.job_id.len() > 128 {
        return Err(AutomationError::new(
            "usage.invalid_argument",
            "Workspace resource job identifier is invalid.",
            2,
        )
        .into());
    }
    if !matches!(
        request.operation.as_str(),
        "resources.analyze"
            | "resources.plan"
            | "resources.list"
            | "resources.prepare_project"
            | "resources.cache_list"
            | "resources.cache_remove"
    ) {
        return Err(AutomationError::new(
            "usage.invalid_argument",
            "Unsupported workspace resource operation.",
            2,
        )
        .into());
    }
    let (cancellation, _job_guard) = jobs
        .register(&request.job_id, WorkspaceJobKind::Resource)
        .map_err(|message| {
            let code = if message.starts_with("operation.shutting_down:") {
                "operation.shutting_down"
            } else {
                "worker.busy"
            };
            AutomationError::new(code, message, 3)
        })?;
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
    let engine = request.engine.clone();
    let root = request.project_root.clone();
    let main_file = request.main_file.clone();
    let overlays = std::mem::take(&mut request.overlays);
    let roots = request.allowed_roots.clone();
    let template_assets = request.template_assets;
    let snapshot = tokio::task::spawn_blocking(move || {
        capture_workspace_snapshot(
            &engine,
            root.as_deref(),
            &main_file,
            &overlays,
            &roots,
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
    if cancellation.load(std::sync::atomic::Ordering::Acquire) {
        return Err(AutomationError::new(
            "operation.interrupted",
            "Workspace resource operation was cancelled.",
            130,
        )
        .into());
    }

    let mut args = serde_json::json!({
        "project": snapshot.root.to_string_lossy(),
        "engine": snapshot.engine,
        "mainFile": snapshot.main_file,
        "workspaceIdentity": request.workspace_identity,
    });
    let object = args.as_object_mut().expect("resource args object");
    if let Some(selection) = request.selection {
        object.insert(
            "selection".into(),
            serde_json::to_value(selection).map_err(|error| {
                AutomationError::new("usage.invalid_argument", error.to_string(), 2)
            })?,
        );
    }
    if let Some(value) = request.expected_input_digest {
        object.insert("expectedInputDigest".into(), value.into());
    }
    if let Some(value) = request.expected_plan_digest {
        object.insert("expectedPlanDigest".into(), value.into());
    }
    if let Some(value) = request.expected_cache_digest {
        object.insert("expectedCacheDigest".into(), value.into());
    }
    if let Some(value) = request.remove_paths {
        object.insert(
            "removePaths".into(),
            serde_json::to_value(value).map_err(|error| {
                AutomationError::new("usage.invalid_argument", error.to_string(), 2)
            })?,
        );
    }
    if let Some(value) = request.cursor {
        object.insert("cursor".into(), value.into());
    }
    if let Some(value) = request.limit {
        object.insert("limit".into(), value.into());
    }
    if let Some(value) = request.max_download_bytes {
        object.insert("maxDownloadBytes".into(), value.into());
    }
    if let Some(value) = request.max_storage_bytes {
        object.insert("maxStorageBytes".into(), value.into());
    }

    let allowed_roots = if request.allowed_roots.is_empty() {
        Vec::new()
    } else {
        super::workspace::canonical_allowed_roots(&request.allowed_roots)
            .map_err(super::workspace::legacy_error)?
    };
    let mut context = OperationContext {
        allowed_roots,
        allow_write: request.operation == "resources.cache_remove",
        allow_resource_download: request.operation == "resources.prepare_project",
        cancellation,
        ..OperationContext::default()
    };
    let progress_task = if request.operation == "resources.prepare_project" {
        let (sender, mut receiver) = tokio::sync::broadcast::channel::<ResourceProgress>(16);
        context.resource_progress = Some(sender.clone());
        let app = app.clone();
        let external_job_id = request.job_id.clone();
        Some((
            sender,
            tokio::spawn(async move {
                loop {
                    match receiver.recv().await {
                        Ok(mut progress) => {
                            progress.job_id = external_job_id.clone();
                            let _ = app.emit("project-resources-progress", progress);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }),
        ))
    } else {
        None
    };

    let service = AutomationService::new();
    let result = if request.operation == "resources.prepare_project" {
        service
            .prepare_resources_snapshot(&snapshot, &args, &context)
            .await
    } else {
        service
            .resources_snapshot_operation(request.operation, snapshot, args, context.clone())
            .await
    };
    if let Some((sender, task)) = progress_task {
        drop(sender);
        drop(context);
        let _ = task.await;
    }
    let (mut data, _diagnostics) = result.map_err(WorkspaceOperationError::from)?;
    if let Some(object) = data.as_object_mut() {
        if object.contains_key("jobId") {
            object.insert("jobId".into(), request.job_id.into());
        }
    }
    Ok(data)
}

#[command]
pub async fn cancel_project_resources(
    jobs: State<'_, WorkspaceCompileJobs>,
    job_id: String,
) -> Result<bool, String> {
    jobs.cancel_and_wait(&job_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_request_rejects_unknown_fields_and_untyped_selectors() {
        let unknown = serde_json::json!({
            "operation":"resources.analyze","jobId":"job","engine":"latex",
            "projectRoot":null,"mainFile":"main.tex","workspaceIdentity":{},
            "surprise":true
        });
        assert!(serde_json::from_value::<ResourcesWorkspaceRequest>(unknown).is_err());

        let invalid_selector = serde_json::json!({
            "operation":"resources.analyze","jobId":"job","engine":"latex",
            "projectRoot":null,"mainFile":"main.tex","workspaceIdentity":{},
            "selection":[{"kind":"pack","id":"latex-basic","url":"https://example.invalid"}]
        });
        assert!(serde_json::from_value::<ResourcesWorkspaceRequest>(invalid_selector).is_err());
    }
}
