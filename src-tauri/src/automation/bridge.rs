use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const MAX_REPLY_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub schema_version: u8,
    pub id: String,
    pub token: String,
    pub operation: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeReply {
    pub schema_version: u8,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRegistryRecord {
    pub schema_version: u8,
    pub instance_id: String,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Default)]
pub struct WorkspaceBridgeState {
    pending: Mutex<HashMap<String, oneshot::Sender<BridgeReply>>>,
    handler_ready: AtomicBool,
}

impl WorkspaceBridgeState {
    pub fn reply(&self, id: &str, reply: BridgeReply) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "Workspace request registry is unavailable".to_string())?
            .remove(id)
            .ok_or_else(|| "Workspace request is no longer active".to_string())?;
        sender
            .send(reply)
            .map_err(|_| "Workspace client disconnected".to_string())
    }

    pub fn set_handler_ready(&self) {
        self.handler_ready.store(true, Ordering::Release);
    }
}

pub struct WorkspaceBridge {
    pub state: Arc<WorkspaceBridgeState>,
    registry_path: PathBuf,
    stopping: Arc<AtomicBool>,
    listener_thread: Option<JoinHandle<()>>,
}

impl WorkspaceBridge {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .map_err(|error| format!("Unable to start the workspace bridge: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Unable to configure the workspace bridge: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Unable to inspect the workspace bridge: {error}"))?;
        let app_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("Unable to locate private app data: {error}"))?;
        let bridge_dir = registry_directory(&app_dir);
        fs::create_dir_all(&bridge_dir)
            .map_err(|error| format!("Unable to create private app data directory: {error}"))?;
        set_private_directory_permissions(&bridge_dir)?;

        let token = random_hex_32()?;
        let instance_id = random_hex_16()?;
        let registry_path = bridge_dir.join(format!("{instance_id}.json"));
        let record = BridgeRegistryRecord {
            schema_version: 1,
            instance_id,
            host: "127.0.0.1".to_string(),
            port: address.port(),
            token: token.clone(),
            pid: std::process::id(),
        };
        write_private_registry(&registry_path, &record)?;

        let state = Arc::new(WorkspaceBridgeState::default());
        let stopping = Arc::new(AtomicBool::new(false));
        let thread_state = state.clone();
        let thread_stopping = stopping.clone();
        let listener_thread = thread::Builder::new()
            .name("sciencebatch-workspace-bridge".into())
            .spawn(move || {
                while !thread_stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let app = app.clone();
                            let state = thread_state.clone();
                            let token = token.clone();
                            let stopping = thread_stopping.clone();
                            let _ = thread::Builder::new()
                                .name("sciencebatch-workspace-client".into())
                                .spawn(move || {
                                    serve_client(stream, app, state, token, stopping);
                                });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(25))
                        }
                        Err(_) => thread::sleep(Duration::from_millis(100)),
                    }
                }
            })
            .map_err(|error| format!("Unable to launch the workspace bridge: {error}"))?;

        Ok(Self {
            state,
            registry_path,
            stopping,
            listener_thread: Some(listener_thread),
        })
    }
}

impl Drop for WorkspaceBridge {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(handle) = self.listener_thread.take() {
            let _ = handle.join();
        }
        let _ = fs::remove_file(&self.registry_path);
    }
}

fn serve_client(
    mut stream: TcpStream,
    app: AppHandle,
    state: Arc<WorkspaceBridgeState>,
    token: String,
    stopping: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let cloned = match stream.try_clone() {
        Ok(value) => value,
        Err(_) => return,
    };
    let reader = BufReader::new(cloned);
    let mut bytes = Vec::new();
    match reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
    {
        Ok(count) if count > 0 && count <= MAX_REQUEST_BYTES && bytes.last() == Some(&b'\n') => {}
        _ => {
            let _ = write_reply(
                &mut stream,
                error_reply(
                    "",
                    "request.invalid",
                    "Request was empty, oversized, or not newline terminated.",
                ),
            );
            return;
        }
    }
    let request: BridgeRequest = match serde_json::from_slice(&bytes[..bytes.len() - 1]) {
        Ok(request) => request,
        Err(_) => {
            let _ = write_reply(
                &mut stream,
                error_reply("", "request.invalid", "Request JSON is invalid."),
            );
            return;
        }
    };
    if request.schema_version != 1 || request.id.is_empty() || request.id.len() > 128 {
        let _ = write_reply(
            &mut stream,
            error_reply(
                &request.id,
                "request.invalid",
                "Request version or identifier is invalid.",
            ),
        );
        return;
    }
    if !constant_time_eq(request.token.as_bytes(), token.as_bytes()) {
        let _ = write_reply(
            &mut stream,
            error_reply(
                &request.id,
                "auth.invalid",
                "Workspace bridge authentication failed.",
            ),
        );
        return;
    }

    let ready_deadline = Instant::now() + Duration::from_secs(10);
    while !state.handler_ready.load(Ordering::Acquire)
        && Instant::now() < ready_deadline
        && !stopping.load(Ordering::Acquire)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if !state.handler_ready.load(Ordering::Acquire) {
        let _ = write_reply(
            &mut stream,
            error_reply(
                &request.id,
                "workspace.unavailable",
                "The workspace interface is not ready.",
            ),
        );
        return;
    }

    let (sender, mut receiver) = oneshot::channel();
    if let Ok(mut pending) = state.pending.lock() {
        if pending.contains_key(&request.id) {
            let _ = write_reply(
                &mut stream,
                error_reply(
                    &request.id,
                    "request.duplicate",
                    "Request identifier is already active.",
                ),
            );
            return;
        }
        pending.insert(request.id.clone(), sender);
    } else {
        let _ = write_reply(
            &mut stream,
            error_reply(
                &request.id,
                "workspace.unavailable",
                "The workspace request registry is unavailable.",
            ),
        );
        return;
    }

    let event = serde_json::json!({
        "schemaVersion": request.schema_version,
        "id": request.id,
        "operation": request.operation,
        "args": request.args,
    });
    if app.emit("workspace-automation-request", event).is_err() {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&request.id);
        }
        let _ = write_reply(
            &mut stream,
            error_reply(
                &request.id,
                "workspace.unavailable",
                "Unable to deliver the workspace request.",
            ),
        );
        return;
    }
    let monitor = match stream.try_clone() {
        Ok(socket) => socket,
        Err(_) => return,
    };
    let _ = monitor.set_nonblocking(true);
    let deadline = Instant::now() + Duration::from_secs(30 * 60 + 5);
    loop {
        match receiver.try_recv() {
            Ok(reply) => {
                let _ = write_reply(&mut stream, reply);
                return;
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                let _ = write_reply(
                    &mut stream,
                    error_reply(
                        &request.id,
                        "workspace.unavailable",
                        "The workspace request ended before a reply was produced.",
                    ),
                );
                return;
            }
        }
        let mut probe = [0u8; 1];
        match monitor.peek(&mut probe) {
            Ok(0) => {
                if request.operation == "workspace.compile" {
                    let job_id = request
                        .args
                        .get("jobId")
                        .and_then(Value::as_str)
                        .unwrap_or(&request.id);
                    let _ = app.emit(
                        "workspace-automation-disconnected",
                        serde_json::json!({ "id": request.id, "jobId": job_id }),
                    );
                }
                if let Ok(mut pending) = state.pending.lock() {
                    pending.remove(&request.id);
                }
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return,
            Ok(_) => {}
        }
        if stopping.load(Ordering::Acquire) || Instant::now() >= deadline {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&request.id);
            }
            let _ = write_reply(
                &mut stream,
                error_reply(
                    &request.id,
                    "operation.timeout",
                    "The workspace request timed out.",
                ),
            );
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn write_reply(stream: &mut TcpStream, reply: BridgeReply) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(&reply).unwrap_or_else(|_| b"{}".to_vec());
    if bytes.len() > MAX_REPLY_BYTES {
        bytes = serde_json::to_vec(&error_reply(
            &reply.id,
            "response.too_large",
            "Workspace response exceeded the protocol limit.",
        ))
        .unwrap_or_default();
    }
    stream.write_all(&bytes)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub fn error_reply(id: &str, code: &str, message: &str) -> BridgeReply {
    BridgeReply {
        schema_version: 1,
        id: id.to_string(),
        ok: false,
        data: None,
        error: Some(BridgeError {
            code: code.to_string(),
            message: message.to_string(),
            details: None,
        }),
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn random_hex_32() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to generate bridge credentials: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn random_hex_16() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to generate bridge instance ID: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn registry_directory(app_local_data_dir: &std::path::Path) -> PathBuf {
    app_local_data_dir.join("workspace-bridge")
}

pub fn read_registry(path: &std::path::Path) -> Result<BridgeRegistryRecord, String> {
    validate_private_registry_parent(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Unable to inspect workspace registry: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4096 {
        return Err("Workspace registry is not a small regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("Workspace registry is not private to the current user".to_string());
        }
    }
    #[cfg(windows)]
    set_private_windows_acl(path)?;
    let bytes =
        fs::read(path).map_err(|error| format!("Unable to read workspace registry: {error}"))?;
    let record: BridgeRegistryRecord =
        serde_json::from_slice(&bytes).map_err(|_| "Workspace registry is invalid".to_string())?;
    if record.schema_version != 1
        || record.host != "127.0.0.1"
        || record.port == 0
        || record.token.len() != 64
    {
        return Err("Workspace registry has unsupported values".to_string());
    }
    Ok(record)
}

fn write_private_registry(path: &PathBuf, record: &BridgeRegistryRecord) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Unable to create private bridge registry: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Unable to write private bridge registry: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Unable to persist private bridge registry: {error}"))?;
    #[cfg(windows)]
    set_private_windows_acl(path)?;
    Ok(())
}

fn set_private_directory_permissions(path: &PathBuf) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Unable to inspect the bridge registry directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Workspace bridge registry path must be a real directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(
                "Workspace bridge registry directory is not owned by the current user".to_string(),
            );
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Unable to protect the bridge registry directory: {error}"))?;
    }
    #[cfg(windows)]
    {
        set_private_windows_acl(path)?;
    }
    Ok(())
}

fn validate_private_registry_parent(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Workspace registry has no parent directory".to_string())?;
    let mut ancestor = Some(parent);
    while let Some(current) = ancestor {
        let metadata = fs::symlink_metadata(current)
            .map_err(|error| format!("Unable to inspect workspace registry directory: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                "Workspace registry directory contains a symbolic link or non-directory"
                    .to_string(),
            );
        }
        ancestor = current.parent();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(parent)
            .map_err(|error| format!("Unable to inspect workspace registry directory: {error}"))?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(
                "Workspace registry directory is not private to the current user".to_string(),
            );
        }
    }
    #[cfg(windows)]
    set_private_windows_acl(parent)?;
    Ok(())
}

#[cfg(windows)]
fn set_private_windows_acl(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
    use windows_sys::Win32::Security::{
        AddAccessAllowedAceEx, GetTokenInformation, InitializeAcl, TokenUser, ACL, ACL_REVISION,
        DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("Unable to inspect the current Windows user token".to_string());
    }
    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }
    let mut token_data = vec![0u64; (needed as usize + 7) / 8];
    let read_token = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            token_data.as_mut_ptr().cast(),
            (token_data.len() * 8) as u32,
            &mut needed,
        )
    };
    unsafe {
        CloseHandle(token);
    }
    if read_token == 0 {
        return Err("Unable to read the current Windows user identity".to_string());
    }
    let user = unsafe { &*(token_data.as_ptr().cast::<TOKEN_USER>()) };
    let mut acl_storage = vec![0u64; 64];
    let acl = acl_storage.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(acl, (acl_storage.len() * 8) as u32, ACL_REVISION) } == 0
        || unsafe {
            AddAccessAllowedAceEx(
                acl,
                ACL_REVISION,
                OBJECT_INHERIT_ACE,
                0x10000000,
                user.User.Sid,
            )
        } == 0
    {
        return Err("Unable to create a private Windows workspace ACL".to_string());
    }
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null_mut(),
        )
    };
    if result != 0 {
        return Err(format!(
            "Unable to protect workspace registry ACL (Windows error {result})"
        ));
    }
    // A protected empty DACL would deny the owner too, so use an explicit owner-only ACL below.
    let _ = &mut wide;
    Ok(())
}
