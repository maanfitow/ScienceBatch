use tauri::command;

use crate::fs::archive::{
    export_project_to_zip as fs_export_zip,
    import_project_from_zip as fs_import_zip,
};

#[command]
pub async fn export_project_to_zip(
    dest_path: String,
    project_dir: Option<String>,
    source_content: Option<String>,
    engine: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        fs_export_zip(
            &dest_path,
            project_dir.as_deref(),
            source_content.as_deref(),
            engine.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("export.task_failed: {e}"))?
}

#[command]
pub async fn import_project_from_zip(
    zip_path: String,
    parent_dir: String,
    project_name: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        fs_import_zip(&zip_path, &parent_dir, project_name.as_deref())
    })
    .await
    .map_err(|e| format!("export.task_failed: {e}"))?
}
