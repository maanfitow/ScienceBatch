use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;

use crate::types::{CompileResponse, DiagnosticItem, ProgressPayload, WorkerRequest};

#[derive(Default)]
pub struct CompilerManager {
    next_id: AtomicU64,
    active_cancel_tx: Mutex<Option<watch::Sender<bool>>>,
}

impl CompilerManager {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            active_cancel_tx: Mutex::new(None),
        }
    }

    pub fn cancel_active(&self) {
        if let Ok(mut lock) = self.active_cancel_tx.lock() {
            if let Some(tx) = lock.take() {
                let _ = tx.send(true);
            }
        }
    }

    pub fn start_compilation(&self) -> (u64, watch::Receiver<bool>) {
        self.cancel_active();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = watch::channel(false);
        if let Ok(mut lock) = self.active_cancel_tx.lock() {
            *lock = Some(tx);
        }
        (id, rx)
    }
}

pub async fn wait_for_cancellation(mut rx: watch::Receiver<bool>) {
    loop {
        let is_cancelled = *rx.borrow_and_update();
        if is_cancelled {
            return;
        }
        if rx.changed().await.is_err() {
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

    let (compile_id, cancel_rx) = state.start_compilation();

    let _ = app_handle.emit(
        "compilation-progress",
        ProgressPayload {
            status: "Starting".into(),
            message: format!("Starting in-memory {active_engine} compiler..."),
        },
    );

    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to locate binary path: {e}"))?;

    let _ = app_handle.emit(
        "compilation-progress",
        ProgressPayload {
            status: "Compiling".into(),
            message: format!("Compiling {active_engine} document in RAM..."),
        },
    );

    let mut cmd = Command::new(&exe);
    cmd.arg("--compile-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(ref dir) = project_dir {
        let p = Path::new(dir);
        if p.is_dir() {
            cmd.current_dir(p);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn compiler worker: {e}"))?;

    let req = WorkerRequest {
        engine: active_engine,
        source,
        project_dir,
        main_file,
    };
    let req_json = serde_json::to_string(&req)
        .map_err(|e| format!("Failed to serialize worker request: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let cancel_rx_stdin = cancel_rx.clone();
        tokio::select! {
            write_res = async {
                stdin.write_all(req_json.as_bytes()).await?;
                stdin.flush().await?;
                drop(stdin);
                Ok::<(), std::io::Error>(())
            } => {
                if let Err(e) = write_res {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(format!("Failed to write to compiler worker: {e}"));
                }
            }
            _ = wait_for_cancellation(cancel_rx_stdin) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                println!("[compile_document] Compilation #{} aborted during stdin write", compile_id);
                return Err("Compilation cancelled".into());
            }
        }
    }

    let mut stdout = child.stdout.take().ok_or_else(|| "Failed to capture worker stdout".to_string())?;
    let mut stderr = child.stderr.take().ok_or_else(|| "Failed to capture worker stderr".to_string())?;
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();

    let exit_status = tokio::select! {
        status_res = async {
            let (out_res, err_res, wait_res) = tokio::join!(
                stdout.read_to_end(&mut stdout_bytes),
                stderr.read_to_end(&mut stderr_bytes),
                child.wait()
            );
            out_res?;
            err_res?;
            wait_res
        } => {
            match status_res {
                Ok(status) => status,
                Err(e) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(format!("Worker execution error: {e}"));
                }
            }
        }
        _ = wait_for_cancellation(cancel_rx) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            println!("[compile_document] Compilation #{} actively aborted and killed", compile_id);
            let _ = app_handle.emit(
                "compilation-progress",
                ProgressPayload {
                    status: "Cancelled".into(),
                    message: "Compilation cancelled.".into(),
                },
            );
            return Err("Compilation cancelled".into());
        }
    };

    if exit_status.success() {
        let resp: CompileResponse = serde_json::from_slice(&stdout_bytes)
            .map_err(|e| format!("Failed to deserialize compiler response: {e}"))?;

        if resp.success {
            let _ = app_handle.emit(
                "compilation-progress",
                ProgressPayload {
                    status: "Completed".into(),
                    message: "PDF generated successfully.".into(),
                },
            );
        } else {
            let _ = app_handle.emit(
                "compilation-progress",
                ProgressPayload {
                    status: "Error".into(),
                    message: "Compilation reported errors.".into(),
                },
            );
        }

        Ok(resp)
    } else {
        let stderr_msg = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
        let err_msg = if stderr_msg.is_empty() {
            "Compiler worker process exited unexpectedly.".to_string()
        } else {
            stderr_msg
        };

        let _ = app_handle.emit(
            "compilation-progress",
            ProgressPayload {
                status: "Error".into(),
                message: err_msg.clone(),
            },
        );

        Ok(CompileResponse {
            pdf_bytes: Vec::new(),
            success: false,
            errors: vec![DiagnosticItem {
                severity: "error".into(),
                message: err_msg,
                line: None,
                file: None,
                suggestion: Some("Check document structure or recompile.".into()),
            }],
            warnings: Vec::new(),
            raw_log: String::new(),
        })
    }
}

#[command]
pub async fn cancel_compilation(
    app_handle: AppHandle,
    state: State<'_, CompilerManager>,
) -> Result<(), String> {
    println!("[IPC cancel_compilation] Aborting active compilation");
    state.cancel_active();
    let _ = app_handle.emit(
        "compilation-progress",
        ProgressPayload {
            status: "Cancelled".into(),
            message: "Compilation cancelled.".into(),
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
