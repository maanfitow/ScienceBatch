use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::bridge::{read_registry, BridgeRegistryRecord};
use super::{
    as_error, failure, success, AutomationError, Envelope, PublicDiagnostic, MAX_PROTOCOL_BYTES,
};

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(45);
const INSTANCE_PROBE_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInstance {
    pub instance_id: String,
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientRequest<'a> {
    schema_version: u8,
    id: &'a str,
    token: &'a str,
    operation: &'a str,
    args: &'a Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientReply {
    schema_version: u8,
    id: String,
    ok: bool,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<BridgeError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeError {
    code: String,
    message: String,
    #[serde(default)]
    details: Option<Value>,
}

pub fn app_local_data_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is not configured")?;
        return Ok(PathBuf::from(base).join("com.sciencebatch.editor"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("HOME is not configured")?;
        return Ok(PathBuf::from(home).join("Library/Application Support/com.sciencebatch.editor"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var_os("HOME").ok_or("HOME is not configured")?;
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".local/share"));
        return Ok(base.join("com.sciencebatch.editor"));
    }
    #[allow(unreachable_code)]
    Err("Workspace bridge discovery is unsupported on this platform".to_string())
}

pub fn list_instances(directory: &Path) -> Result<Vec<WorkspaceInstance>, AutomationError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(as_error(
                "workspace.unavailable",
                format!("Cannot read workspace registry: {error}"),
                3,
            ))
        }
    };
    let mut instances = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            as_error(
                "workspace.unavailable",
                format!("Cannot read workspace registry entry: {error}"),
                3,
            )
        })?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let registry = match read_registry(&entry.path()) {
            Ok(registry) => registry,
            Err(_) => continue,
        };
        if !instance_is_reachable(&registry) {
            continue;
        }
        instances.push(instance_summary(&registry));
    }
    instances.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
    Ok(instances)
}

fn instance_is_reachable(record: &BridgeRegistryRecord) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], record.port));
    TcpStream::connect_timeout(&address, INSTANCE_PROBE_TIMEOUT).is_ok()
}

pub fn call_instance(
    directory: &Path,
    instance_id: &str,
    operation: &str,
    mut args: Value,
    allowed_roots: &[PathBuf],
) -> Result<Envelope, AutomationError> {
    if instance_id.len() != 32 || !instance_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(as_error(
            "workspace.instance_invalid",
            "A valid explicit workspace instanceId is required.",
            2,
        ));
    }
    let registry_path = directory.join(format!("{instance_id}.json"));
    let registry = read_registry(&registry_path).map_err(|error| {
        as_error(
            "workspace.unavailable",
            format!("Workspace instance {instance_id} is not available: {error}"),
            3,
        )
    })?;
    if registry.instance_id != instance_id {
        return Err(as_error(
            "workspace.unavailable",
            "Workspace registry identity does not match the selected instance.",
            3,
        ));
    }
    validate_workspace_roots(operation, &mut args, allowed_roots)?;
    if operation != "workspace.inspect" {
        let current = bridge_rpc(&registry, "workspace.inspect", &json!({}))?;
        if !current.ok {
            let error = current.error.ok_or_else(|| {
                as_error(
                    "worker.protocol_invalid",
                    "Workspace inspection failed without an error.",
                    4,
                )
            })?;
            return Err(as_error(
                "workspace.unavailable",
                format!("Cannot inspect the selected workspace: {}", error.message),
                3,
            ));
        }
        let current_data = current.data.unwrap_or(Value::Null);
        let project_root = current_data
            .get("projectRoot")
            .cloned()
            .unwrap_or(Value::Null);
        if project_root.is_null() && operation != "workspace.openProject" {
            return Err(as_error(
                "path.outside_project",
                "The selected workspace has no project root within the configured MCP roots.",
                2,
            ));
        }
        if let Some(root) = project_root.as_str() {
            validate_root(Path::new(root), allowed_roots)?;
        }
        let generation = current_data
            .get("workspaceGeneration")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                as_error(
                    "worker.protocol_invalid",
                    "Workspace inspection omitted its generation.",
                    4,
                )
            })?;
        let object = args.as_object_mut().ok_or_else(|| {
            as_error(
                "usage.invalid_argument",
                "Workspace arguments must be a JSON object.",
                2,
            )
        })?;
        let expected = object
            .entry("expectedProjectRoot")
            .or_insert(project_root.clone());
        if *expected != project_root {
            return Err(as_error(
                "conflict.project",
                "The selected workspace root changed since it was inspected.",
                2,
            ));
        }
        let expected_generation = object
            .entry("workspaceGeneration")
            .or_insert(json!(generation));
        if expected_generation.as_u64() != Some(generation) {
            return Err(as_error(
                "conflict.project",
                "The selected workspace generation changed since it was inspected.",
                2,
            ));
        }
    }
    validate_workspace_roots(operation, &mut args, allowed_roots)?;
    let reply = bridge_rpc(&registry, operation, &args)?;
    if reply.ok {
        if !allowed_roots.is_empty() {
            if let Some(root) = reply
                .data
                .as_ref()
                .and_then(|data| data.get("projectRoot"))
                .and_then(Value::as_str)
            {
                validate_root(Path::new(root), allowed_roots)?;
            }
        }
        Ok(success(
            operation,
            reply.data.unwrap_or(Value::Null),
            Vec::new(),
        ))
    } else {
        let error = reply.error.ok_or_else(|| {
            as_error(
                "worker.protocol_invalid",
                "Workspace returned an error without a code.",
                4,
            )
        })?;
        let exit_code = exit_for_error_code(&error.code);
        let compile_failed =
            operation == "workspace.compile" && error.code == "compile.document_failed";
        let mut wrapped = super::failure_for_cli(operation, error.code, error.message, exit_code);
        if let Some(public) = wrapped.error.as_mut() {
            public.details = error.details.clone();
        }
        if compile_failed {
            wrapped.diagnostics = workspace_compile_diagnostics(error.details.as_ref());
        }
        Ok(wrapped)
    }
}

fn validate_workspace_roots(
    operation: &str,
    args: &mut Value,
    allowed_roots: &[PathBuf],
) -> Result<(), AutomationError> {
    let Some(object) = args.as_object_mut() else {
        return Err(as_error(
            "usage.invalid_argument",
            "Workspace arguments must be a JSON object.",
            2,
        ));
    };
    object.insert("allowedRoots".to_owned(), json!(allowed_roots));
    let root_key = if operation == "workspace.openProject" {
        "projectRoot"
    } else {
        "expectedProjectRoot"
    };
    if let Some(root) = object.get(root_key).and_then(Value::as_str) {
        validate_root(Path::new(root), allowed_roots)?;
    }
    if operation == "workspace.openProject" {
        let target = object
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| object.get("projectRoot").and_then(Value::as_str))
            .ok_or_else(|| {
                as_error(
                    "usage.invalid_argument",
                    "workspace.openProject requires a project path.",
                    2,
                )
            })?
            .to_owned();
        validate_root(Path::new(&target), allowed_roots)?;
        object.entry("path").or_insert_with(|| json!(target));
    }
    if matches!(
        operation,
        "workspace.apply"
            | "workspace.save"
            | "workspace.close"
            | "workspace.activate"
            | "workspace.openFile"
            | "workspace.openProject"
    ) {
        if object
            .get("workspaceGeneration")
            .and_then(Value::as_u64)
            .is_none()
        {
            return Err(as_error(
                "conflict.revision",
                "Workspace mutations require an expected workspaceGeneration.",
                2,
            ));
        }
    }
    if operation == "workspace.apply"
        && (object.get("documentId").and_then(Value::as_str).is_none()
            || object
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .is_none())
    {
        return Err(as_error(
            "conflict.revision",
            "Live edits require documentId and expectedRevision.",
            2,
        ));
    }
    if let Some(output) = object
        .get("outputPath")
        .or_else(|| object.get("output"))
        .and_then(Value::as_str)
    {
        validate_output(Path::new(output), allowed_roots)?;
    }
    Ok(())
}

fn bridge_rpc(
    record: &BridgeRegistryRecord,
    operation: &str,
    args: &Value,
) -> Result<ClientReply, AutomationError> {
    let request_id = random_request_id()?;
    let request = ClientRequest {
        schema_version: 1,
        id: &request_id,
        token: &record.token,
        operation,
        args,
    };
    let bytes = serde_json::to_vec(&request).map_err(|error| {
        as_error(
            "worker.protocol_invalid",
            format!("Cannot encode workspace request: {error}"),
            4,
        )
    })?;
    if bytes.len().saturating_add(1) > MAX_PROTOCOL_BYTES {
        return Err(as_error(
            "resource.limit_exceeded",
            "Workspace request exceeds the protocol message limit.",
            3,
        ));
    }
    let address = SocketAddr::from(([127, 0, 0, 1], record.port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|error| {
            as_error(
                "workspace.unavailable",
                format!(
                    "Cannot connect to workspace instance {}: {error}",
                    record.instance_id
                ),
                3,
            )
        })?;
    let timeout = operation_timeout(operation, args);
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| as_error("workspace.unavailable", error.to_string(), 3))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| as_error("workspace.unavailable", error.to_string(), 3))?;
    stream
        .write_all(&bytes)
        .and_then(|_| stream.write_all(b"\n"))
        .and_then(|_| stream.flush())
        .map_err(|error| {
            as_error(
                "workspace.unavailable",
                format!("Cannot send workspace request: {error}"),
                3,
            )
        })?;
    read_reply(stream, &request_id)
}

fn read_reply(stream: TcpStream, request_id: &str) -> Result<ClientReply, AutomationError> {
    let mut reader = BufReader::new(stream);
    let mut reply_bytes = Vec::new();
    let read = reader
        .by_ref()
        .take((MAX_PROTOCOL_BYTES + 1) as u64)
        .read_until(b'\n', &mut reply_bytes)
        .map_err(|error| {
            as_error(
                "workspace.unavailable",
                format!("Cannot read workspace response: {error}"),
                3,
            )
        })?;
    if read == 0 || read > MAX_PROTOCOL_BYTES || reply_bytes.last() != Some(&b'\n') {
        return Err(as_error(
            "worker.protocol_invalid",
            "Workspace response is empty, oversized, or not newline terminated.",
            4,
        ));
    }
    let reply: ClientReply = serde_json::from_slice(&reply_bytes[..reply_bytes.len() - 1])
        .map_err(|error| {
            as_error(
                "worker.protocol_invalid",
                format!("Workspace response is invalid: {error}"),
                4,
            )
        })?;
    if reply.schema_version != 1 || reply.id != request_id {
        return Err(as_error(
            "worker.protocol_invalid",
            "Workspace response identifier or version does not match the request.",
            4,
        ));
    }
    Ok(reply)
}

fn operation_timeout(operation: &str, args: &Value) -> Duration {
    if operation == "workspace.compile" {
        let seconds = args
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(120)
            .clamp(1, 900);
        Duration::from_secs(seconds.saturating_add(30))
    } else {
        BRIDGE_TIMEOUT
    }
}

fn validate_root(root: &Path, allowed_roots: &[PathBuf]) -> Result<(), AutomationError> {
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(root)
    };
    let mut checked = PathBuf::new();
    for component in absolute.components() {
        checked.push(component.as_os_str());
        if checked.exists() {
            let metadata = fs::symlink_metadata(&checked).map_err(|error| {
                as_error(
                    "path.outside_project",
                    format!("Cannot inspect workspace path: {error}"),
                    2,
                )
            })?;
            if metadata.file_type().is_symlink() {
                return Err(as_error(
                    "path.symlink_rejected",
                    "Workspace roots cannot pass through symbolic links.",
                    2,
                ));
            }
        }
    }
    let canonical = fs::canonicalize(root).map_err(|error| {
        as_error(
            "path.outside_project",
            format!("Cannot resolve workspace project root: {error}"),
            2,
        )
    })?;
    if !canonical.is_dir()
        || (!allowed_roots.is_empty()
            && !allowed_roots
                .iter()
                .any(|allowed| canonical.starts_with(allowed)))
    {
        return Err(as_error(
            "path.outside_project",
            "Workspace project root is outside the configured MCP roots.",
            2,
        ));
    }
    Ok(())
}

fn validate_output(output: &Path, allowed_roots: &[PathBuf]) -> Result<(), AutomationError> {
    let absolute = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(output)
    };
    let parent = absolute.parent().unwrap_or_else(|| Path::new("."));
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        as_error(
            "path.outside_project",
            format!("Cannot resolve PDF output directory: {error}"),
            2,
        )
    })?;
    if !allowed_roots.is_empty()
        && !allowed_roots
            .iter()
            .any(|allowed| canonical_parent.starts_with(allowed))
    {
        return Err(as_error(
            "path.outside_project",
            "Workspace PDF output is outside the configured MCP roots.",
            2,
        ));
    }
    Ok(())
}

fn instance_summary(record: &BridgeRegistryRecord) -> WorkspaceInstance {
    WorkspaceInstance {
        instance_id: record.instance_id.clone(),
        pid: record.pid,
        host: "127.0.0.1".to_owned(),
        port: record.port,
        status: "registered",
    }
}

fn random_request_id() -> Result<String, AutomationError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        as_error(
            "internal.unexpected",
            format!("Cannot create request ID: {error}"),
            4,
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn new_request_id() -> Result<String, AutomationError> {
    random_request_id()
}

fn exit_for_error_code(code: &str) -> i32 {
    if code == "compile.document_failed" || code == "compile.engine_error" {
        1
    } else if code == "operation.timeout" {
        124
    } else if code == "operation.interrupted" {
        130
    } else if code.starts_with("path.")
        || code.starts_with("permission.")
        || code.starts_with("conflict.")
        || code == "git.locked"
    {
        2
    } else if code.starts_with("io.") || code.starts_with("workspace.") {
        3
    } else {
        4
    }
}

fn workspace_compile_diagnostics(details: Option<&Value>) -> Vec<PublicDiagnostic> {
    let Some(details) = details else {
        return Vec::new();
    };
    [("errors", "error"), ("warnings", "warning")]
        .into_iter()
        .flat_map(|(key, severity)| {
            details
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(move |item| PublicDiagnostic {
                    severity: item
                        .get("severity")
                        .and_then(Value::as_str)
                        .unwrap_or(severity)
                        .to_owned(),
                    code: item
                        .get("code")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            if severity == "error" {
                                "compile.engine_error"
                            } else {
                                "compile.engine_warning"
                            }
                            .to_owned()
                        }),
                    message: item
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("The compiler reported a workspace diagnostic.")
                        .to_owned(),
                    origin: "compiler".to_owned(),
                    file: item.get("file").and_then(Value::as_str).map(str::to_owned),
                    line: item
                        .get("line")
                        .and_then(Value::as_u64)
                        .map(|line| line as usize),
                    column: item
                        .get("column")
                        .and_then(Value::as_u64)
                        .map(|column| column as usize),
                    suggestion: item
                        .get("suggestion")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    fn private_registry_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sciencebatch-bridge-discovery-{}-{}",
            std::process::id(),
            NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("create private registry fixture directory");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .expect("secure private registry fixture directory");
        }
        directory
    }

    fn write_registry(directory: &Path, instance_id: &str, port: u16) {
        let path = directory.join(format!("{instance_id}.json"));
        let contents = serde_json::to_vec(&BridgeRegistryRecord {
            schema_version: 1,
            instance_id: instance_id.to_owned(),
            host: "127.0.0.1".to_owned(),
            port,
            token: "ab".repeat(32),
            pid: std::process::id(),
        })
        .expect("serialize registry fixture");
        fs::write(&path, contents).expect("write registry fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .expect("secure registry fixture");
        }
    }

    #[test]
    fn list_instances_excludes_closed_loopback_endpoints() {
        let directory = private_registry_directory();
        let live_listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind live endpoint");
        let live_port = live_listener
            .local_addr()
            .expect("read live endpoint")
            .port();
        let closed_listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve closed port");
        let closed_port = closed_listener
            .local_addr()
            .expect("read closed endpoint")
            .port();
        drop(closed_listener);

        write_registry(&directory, "11111111111111111111111111111111", live_port);
        write_registry(&directory, "22222222222222222222222222222222", closed_port);

        let instances = list_instances(&directory).expect("list reachable instances");
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].instance_id, "11111111111111111111111111111111");
        assert_eq!(instances[0].port, live_port);

        drop(live_listener);
        fs::remove_dir_all(directory).expect("remove registry fixture");
    }
}

pub fn run_workspace_cli(args: &[String]) -> i32 {
    if args.get(1).map(String::as_str) == Some("--help")
        || args.get(1).map(String::as_str) == Some("-h")
    {
        eprintln!("Usage: sciencebatch-cli workspace instances --json | workspace OPERATION --instance ID [--root DIR ...] [--args JSON] --json");
        return 0;
    }
    let Some(subcommand) = args.get(1).map(String::as_str) else {
        return emit_cli_error(
            "workspace",
            as_error("usage.invalid_argument", "Missing workspace operation.", 2),
        );
    };
    let directory = match app_local_data_directory() {
        Ok(app_data) => super::bridge::registry_directory(&app_data),
        Err(message) => {
            return emit_cli_error("workspace", as_error("workspace.unavailable", message, 3))
        }
    };
    if subcommand == "instances" {
        if args.iter().skip(2).any(|arg| arg != "--json") {
            return emit_cli_error(
                "workspace.instances",
                as_error(
                    "usage.invalid_argument",
                    "Only --json is supported for workspace instances.",
                    2,
                ),
            );
        }
        return match list_instances(&directory) {
            Ok(instances) => emit_cli_envelope(success(
                "workspace.instances",
                json!({"instances": instances}),
                Vec::new(),
            )),
            Err(error) => emit_cli_envelope(failure("workspace.instances", error)),
        };
    }
    let operation = match subcommand {
        "inspect" => "workspace.inspect",
        "read" => "workspace.read",
        "openProject" => "workspace.openProject",
        "openFile" => "workspace.openFile",
        "activate" => "workspace.activate",
        "apply" => "workspace.apply",
        "save" => "workspace.save",
        "close" => "workspace.close",
        "compile" => "workspace.compile",
        "cancel" => "workspace.cancel",
        _ => {
            return emit_cli_error(
                "workspace",
                as_error("usage.invalid_argument", "Unknown workspace operation.", 2),
            )
        }
    };
    let mut instance = None;
    let mut root_args = Vec::new();
    let mut args_value = Value::Object(Map::new());
    let mut json_mode = false;
    let mut cursor = 2;
    while cursor < args.len() {
        let flag = args[cursor].as_str();
        cursor += 1;
        match flag {
            "--json" => json_mode = true,
            "--instance" => {
                let Some(value) = args.get(cursor) else {
                    return emit_cli_error(
                        operation,
                        as_error(
                            "usage.invalid_argument",
                            "--instance requires an instanceId.",
                            2,
                        ),
                    );
                };
                instance = Some(value.clone());
                cursor += 1;
            }
            "--root" => {
                let Some(value) = args.get(cursor) else {
                    return emit_cli_error(
                        operation,
                        as_error("usage.invalid_argument", "--root requires a directory.", 2),
                    );
                };
                root_args.push(PathBuf::from(value));
                cursor += 1;
            }
            "--args" => {
                let Some(value) = args.get(cursor) else {
                    return emit_cli_error(
                        operation,
                        as_error(
                            "usage.invalid_argument",
                            "--args requires a JSON object.",
                            2,
                        ),
                    );
                };
                args_value = match serde_json::from_str(value) {
                    Ok(Value::Object(value)) => Value::Object(value),
                    _ => {
                        return emit_cli_error(
                            operation,
                            as_error("usage.invalid_argument", "--args must be a JSON object.", 2),
                        )
                    }
                };
                cursor += 1;
            }
            _ => {
                return emit_cli_error(
                    operation,
                    as_error(
                        "usage.invalid_argument",
                        format!("Unknown workspace option `{flag}`."),
                        2,
                    ),
                )
            }
        }
    }
    if !json_mode {
        return emit_cli_error(
            operation,
            as_error(
                "usage.invalid_argument",
                "--json is required for workspace command output.",
                2,
            ),
        );
    }
    let Some(instance) = instance else {
        return emit_cli_error(
            operation,
            as_error(
                "usage.invalid_argument",
                "An explicit --instance is required.",
                2,
            ),
        );
    };
    let instance_id = instance;
    let roots = match configured_cli_roots(&root_args) {
        Ok(roots) => roots,
        Err(error) => return emit_cli_error(operation, error),
    };
    match call_instance(&directory, &instance_id, operation, args_value, &roots) {
        Ok(envelope) => emit_cli_envelope(envelope),
        Err(error) => emit_cli_error(operation, error),
    }
}

fn configured_cli_roots(requested: &[PathBuf]) -> Result<Vec<PathBuf>, AutomationError> {
    let roots = if requested.is_empty() {
        vec![std::env::current_dir()
            .map_err(|error| as_error("io.project_unavailable", error.to_string(), 3))?]
    } else {
        requested.to_vec()
    };
    let mut canonical_roots = Vec::with_capacity(roots.len());
    for root in roots {
        let canonical = fs::canonicalize(&root).map_err(|error| {
            as_error(
                "path.outside_project",
                format!("Cannot resolve configured workspace root: {error}"),
                2,
            )
        })?;
        if !canonical.is_dir() {
            return Err(as_error(
                "path.outside_project",
                "Configured workspace roots must be directories.",
                2,
            ));
        }
        if !canonical_roots.contains(&canonical) {
            canonical_roots.push(canonical);
        }
    }
    Ok(canonical_roots)
}

fn emit_cli_error(command: &str, error: AutomationError) -> i32 {
    emit_cli_envelope(failure(command, error))
}

fn emit_cli_envelope(envelope: Envelope) -> i32 {
    let exit = envelope.exit_code();
    match serde_json::to_string(&envelope) {
        Ok(value) => println!("{value}"),
        Err(_) => println!("{{\"schemaVersion\":1,\"command\":\"internal.unexpected\",\"ok\":false,\"data\":null,\"diagnostics\":[],\"error\":{{\"code\":\"internal.unexpected\",\"message\":\"Could not serialize workspace result.\"}}}}"),
    }
    exit
}
