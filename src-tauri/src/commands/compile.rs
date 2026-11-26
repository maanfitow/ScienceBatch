use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::watch;

use crate::automation::{capture_snapshot, capture_virtual_snapshot, AutomationService};
use crate::types::{CompileResponse, ProgressPayload};

#[derive(Clone)]
pub struct CompilerManager {
    next_id: Arc<AtomicU64>,
    active: Arc<Mutex<Option<ActiveCompile>>>,
    start_lock: Arc<tokio::sync::Mutex<()>>,
    shutting_down: Arc<AtomicBool>,
    shutdown_complete: Arc<AtomicBool>,
}

impl Default for CompilerManager {
    fn default() -> Self {
        Self {
            next_id: Arc::new(AtomicU64::new(1)),
            active: Arc::new(Mutex::new(None)),
            start_lock: Arc::new(tokio::sync::Mutex::new(())),
            shutting_down: Arc::new(AtomicBool::new(false)),
            shutdown_complete: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct ActiveCompile {
    id: u64,
    cancellation: Arc<AtomicBool>,
    completion: watch::Sender<bool>,
}

pub(crate) struct CompileJobGuard {
    manager: CompilerManager,
    id: u64,
}

impl Drop for CompileJobGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.manager.active.lock() {
            if active.as_ref().is_some_and(|job| job.id == self.id) {
                if let Some(job) = active.take() {
                    job.cancellation.store(true, Ordering::Release);
                    let _ = job.completion.send(true);
                }
            }
        }
    }
}

impl CompilerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn start_compilation(
        &self,
    ) -> Result<(u64, Arc<AtomicBool>, CompileJobGuard), String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("operation.shutting_down: The application is shutting down".into());
        }
        let _start_guard = self.start_lock.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("operation.shutting_down: The application is shutting down".into());
        }
        let previous_completion = {
            let active = self
                .active
                .lock()
                .map_err(|_| "Compiler job registry is unavailable".to_string())?;
            active.as_ref().map(|job| {
                job.cancellation.store(true, Ordering::Release);
                job.completion.subscribe()
            })
        };
        if let Some(mut receiver) = previous_completion {
            wait_for_completion(&mut receiver).await;
            crate::automation::AutomationService::new()
                .wait_for_workers_idle()
                .await;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cancellation = Arc::new(AtomicBool::new(false));
        let (completion, _) = watch::channel(false);
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Compiler job registry is unavailable".to_string())?;
        *active = Some(ActiveCompile {
            id,
            cancellation: cancellation.clone(),
            completion,
        });
        Ok((
            id,
            cancellation,
            CompileJobGuard {
                manager: self.clone(),
                id,
            },
        ))
    }

    pub fn cancel_active(&self) {
        if let Ok(active) = self.active.lock() {
            if let Some(job) = active.as_ref() {
                job.cancellation.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn start_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.cancel_active();
    }

    pub(crate) fn is_shutdown_complete(&self) -> bool {
        self.shutdown_complete.load(Ordering::Acquire)
    }

    pub(crate) async fn cancel_and_wait(&self) {
        let mut completion = {
            let active = match self.active.lock() {
                Ok(active) => active,
                Err(_) => return,
            };
            active.as_ref().map(|job| {
                job.cancellation.store(true, Ordering::Release);
                job.completion.subscribe()
            })
        };
        if let Some(receiver) = completion.as_mut() {
            wait_for_completion(receiver).await;
        }
        crate::automation::AutomationService::new()
            .wait_for_workers_idle()
            .await;
        self.shutdown_complete.store(true, Ordering::Release);
    }
}

async fn wait_for_completion(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

#[command]
pub async fn compile_document(
    app_handle: AppHandle,
    state: State<'_, CompilerManager>,
    source: String,
    engine: Option<String>,
    project_dir: Option<String>,
    main_file: Option<String>,
) -> Result<CompileResponse, String> {
    let active_engine = engine.unwrap_or_else(|| "latex".into());
    println!(
        "[IPC compile_document] engine: {}, project_dir: {:?}, main_file: {:?}",
        active_engine, project_dir, main_file
    );

    let (compile_id, cancellation, _job_guard) = state
        .start_compilation()
        .await
        .map_err(|error| format!("worker.busy: {error}"))?;

    let _ = app_handle.emit(
        "compilation-progress",
        ProgressPayload {
            status: "Starting".into(),
            message: format!("Starting in-memory {active_engine} compiler..."),
            code: Some("compiler.starting".into()),
            params: Some(BTreeMap::from([(
                "engine".into(),
                active_engine.clone(),
            )])),
        },
    );

    let _ = app_handle.emit(
        "compilation-progress",
        ProgressPayload {
            status: "Compiling".into(),
            message: format!("Compiling {active_engine} document in RAM (job {compile_id})..."),
            code: Some("compiler.compiling".into()),
            params: Some(BTreeMap::from([
                ("engine".into(), active_engine.clone()),
                ("jobId".into(), compile_id.to_string()),
            ])),
        },
    );

    let engine_name = active_engine.clone();
    let requested_engine = engine_name.clone();
    let main_name = main_file.unwrap_or_else(|| {
        if engine_name.eq_ignore_ascii_case("typst") {
            "main.typ".into()
        } else {
            "main.tex".into()
        }
    });
    let overlay = BTreeMap::from([(main_name.clone(), source.into_bytes())]);
    let snapshot = tokio::task::spawn_blocking(move || {
        let snapshot = if let Some(root) = project_dir {
            capture_snapshot(PathBuf::from(root).as_path(), &main_name, &overlay)
        } else {
            capture_virtual_snapshot(&engine_name, &main_name, &overlay)
        }?;
        if !snapshot.engine.eq_ignore_ascii_case(&requested_engine) {
            return Err(crate::automation::AutomationError::new(
                "project.main_engine_mismatch",
                "The selected engine does not match the workspace main file.",
                2,
            ));
        }
        Ok::<_, crate::automation::AutomationError>(snapshot)
    })
    .await
    .map_err(|error| format!("worker.capture_failed: {error}"))?
    .map_err(|error| format!("{}: {}", error.code, error.message))?;

    if cancellation.load(Ordering::Acquire) {
        return Err("operation.interrupted: Compilation was cancelled".into());
    }
    let result = AutomationService::new()
        .compile_snapshot(&snapshot, Duration::from_secs(120), cancellation)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message));
    match result {
        Ok(response) => {
            let (status, message, code) = if response.success {
                ("Completed", "PDF generated successfully.", "compiler.completed")
            } else {
                ("Error", "Compilation reported errors.", "compiler.error")
            };
            let _ = app_handle.emit(
                "compilation-progress",
                ProgressPayload {
                    status: status.into(),
                    message: message.into(),
                    code: Some(code.into()),
                    params: None,
                },
            );
            Ok(response)
        }
        Err(error) => {
            let (status, code) = if error.starts_with("operation.interrupted:") {
                ("Cancelled", "compiler.cancelled")
            } else {
                ("Error", "compiler.error")
            };
            let _ = app_handle.emit(
                "compilation-progress",
                ProgressPayload {
                    status: status.into(),
                    message: error.clone(),
                    code: Some(code.into()),
                    params: None,
                },
            );
            Err(error)
        }
    }
}

#[command]
pub async fn cancel_compilation(
    app_handle: AppHandle,
    state: State<'_, CompilerManager>,
) -> Result<(), String> {
    println!("[IPC cancel_compilation] Aborting active compilation");
    state.cancel_and_wait().await;
    let _ = app_handle.emit(
        "compilation-progress",
        ProgressPayload {
            status: "Cancelled".into(),
            message: "Compilation cancelled.".into(),
            code: Some("compiler.cancelled".into()),
            params: None,
        },
    );
    Ok(())
}

// Backward compatibility alias for compile_latex
#[command]
pub async fn compile_latex(
    app_handle: AppHandle,
    state: State<'_, CompilerManager>,
    source: String,
) -> Result<CompileResponse, String> {
    compile_document(app_handle, state, source, Some("latex".into()), None, None).await
}

#[command]
pub async fn save_pdf_to_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("Failed to save PDF to '{path}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::CompilerManager;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn cancellation_waits_for_compile_job_and_shutdown_rejects_new_jobs() {
        let manager = CompilerManager::new();
        let (_, cancellation, guard) = manager.start_compilation().await.unwrap();
        let cancel_manager = manager.clone();
        let cancel_task = tokio::spawn(async move {
            cancel_manager.cancel_and_wait().await;
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !cancellation.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel request should reach the active compile");
        drop(guard);
        cancel_task.await.unwrap();

        manager.start_shutdown();
        assert!(manager.start_compilation().await.is_err());
        manager.cancel_and_wait().await;
        assert!(manager.is_shutdown_complete());
    }
}
