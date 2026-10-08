use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use rmcp::schemars::JsonSchema;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Implementation, ProtocolVersion, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::bridge_client;
use super::{AutomationService, Envelope, OperationContext};

#[derive(Clone)]
struct McpServer {
    service: AutomationService,
    context: OperationContext,
    bridge_directory: PathBuf,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSelector {
    /// Project directory. Relative paths resolve from the server launch directory.
    project: String,
    /// Optional explicit engine name: `latex` or `typst`.
    #[serde(default)]
    engine: Option<EngineName>,
    /// Optional project-relative main source path.
    #[serde(default)]
    main: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectFile {
    /// Project directory selected by the caller.
    project: String,
    /// Project-relative UTF-8 text file.
    file: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSearch {
    /// Project directory selected by the caller.
    project: String,
    /// Literal text to search for.
    query: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectCreate {
    /// New project destination. It must not already exist.
    project: String,
    /// Starter project engine: `latex` or `typst`.
    engine: EngineName,
    /// Optional project-relative main source name.
    #[serde(default)]
    main: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectApply {
    /// Existing project directory.
    project: String,
    /// One project-relative text file to replace.
    file: String,
    /// Complete replacement UTF-8 content, limited to 8 MiB.
    content: String,
    /// SHA-256 of the exact current file bytes.
    #[schemars(regex(pattern = "^[a-fA-F0-9]{64}$"))]
    expected_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileProject {
    /// Project directory selected for this explicit compile request.
    project: String,
    /// Optional explicit engine name: `latex` or `typst`.
    #[serde(default)]
    engine: Option<EngineName>,
    /// Optional project-relative main source path.
    #[serde(default)]
    main: Option<String>,
    /// Optional PDF destination. Existing files require overwrite=true.
    #[serde(default)]
    output: Option<String>,
    /// Replace a PDF already at output.
    #[serde(default)]
    overwrite: bool,
    /// Worker timeout in seconds, from 1 to 900; defaults to 120.
    #[serde(default)]
    #[schemars(range(min = 1, max = 900))]
    timeout: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourcePrepare {
    #[serde(default)]
    /// Optional resource engine. Preparation downloads only existing bundled resources.
    engine: Option<EngineName>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum EngineName {
    Latex,
    Typst,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceCall {
    /// Exact running editor instance ID from sciencebatch_workspace_instances.
    #[schemars(regex(pattern = "^[a-fA-F0-9]{32}$"))]
    instance_id: String,
    operation: WorkspaceOperation,
    /// Destination path for openProject, or optional selected project root.
    #[serde(default)]
    project_root: Option<String>,
    #[serde(default)]
    expected_project_root: Option<Option<String>>,
    /// Expected active workspace generation, obtained from inspect.
    #[serde(default)]
    workspace_generation: Option<u64>,
    #[serde(default)]
    document_id: Option<String>,
    /// Expected document revision returned by inspect or read.
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    file: Option<String>,
    /// Project-relative path used by read or openFile.
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    content: Option<String>,
    /// Start UTF-16 code-unit offset in the selected buffer.
    #[serde(default)]
    start: Option<usize>,
    /// End UTF-16 code-unit offset in the selected buffer.
    #[serde(default)]
    end: Option<usize>,
    /// Replacement text for one live editor operation.
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    expected_sha256: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 900))]
    timeout_seconds: Option<u64>,
    /// Optional final PDF destination for a workspace compile.
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    output_path: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum WorkspaceOperation {
    Inspect,
    Read,
    OpenProject,
    OpenFile,
    Activate,
    Apply,
    Save,
    Close,
    Compile,
    Cancel,
}

impl WorkspaceOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Inspect => "inspect",
            Self::Read => "read",
            Self::OpenProject => "openProject",
            Self::OpenFile => "openFile",
            Self::Activate => "activate",
            Self::Apply => "apply",
            Self::Save => "save",
            Self::Close => "close",
            Self::Compile => "compile",
            Self::Cancel => "cancel",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}

impl McpServer {
    fn new(
        roots: Vec<PathBuf>,
        allow_write: bool,
        allow_resource_download: bool,
    ) -> Result<Self, String> {
        let app_data = bridge_client::app_local_data_directory()?;
        Ok(Self {
            service: AutomationService::new(),
            context: OperationContext {
                allowed_roots: roots,
                allow_write,
                allow_resource_download,
                cancellation: Arc::new(AtomicBool::new(false)),
            },
            bridge_directory: super::bridge::registry_directory(&app_data),
            tool_router: Self::tool_router(),
        })
    }

    async fn dispatch_tool(
        &self,
        command: &str,
        args: Value,
        request_cancellation: CancellationToken,
    ) -> CallToolResult {
        let cancellation = Arc::new(AtomicBool::new(request_cancellation.is_cancelled()));
        let watcher = AbortOnDrop({
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                request_cancellation.cancelled().await;
                cancellation.store(true, Ordering::Release);
            })
        });
        let mut context = self.context.clone();
        context.cancellation = cancellation;
        let result = self.service.dispatch(command, args, context).await;
        drop(watcher);
        envelope_result(result)
    }

    fn denied(command: &str, code: &'static str, message: &'static str) -> CallToolResult {
        let envelope = super::failure_for_cli(command, code.to_string(), message.to_string(), 2);
        envelope_result(envelope)
    }
}

#[tool_router(router = tool_router)]
impl McpServer {
    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_project_inspect",
        description = "Inspect project metadata and file inventory without reading source contents or compiling.",
        annotations(
            title = "Inspect project",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn project_inspect(
        &self,
        params: Parameters<ProjectSelector>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool(
            "project.inspect",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_project_create",
        description = "Create a new LaTeX or Typst project at the explicit destination. Requires server --allow-write.",
        annotations(
            title = "Create project",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn project_create(
        &self,
        params: Parameters<ProjectCreate>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        if !self.context.allow_write {
            return Self::denied(
                "project.create",
                "permission.write_required",
                "Project creation requires server --allow-write.",
            );
        }
        self.dispatch_tool(
            "project.create",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_read",
        description = "Read one project-relative text file and return its current content and hash.",
        annotations(
            title = "Read source",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn read(
        &self,
        params: Parameters<ProjectFile>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool(
            "project.read",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_search",
        description = "Search project text files for a literal query.",
        annotations(
            title = "Search project",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn search(
        &self,
        params: Parameters<ProjectSearch>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool(
            "project.search",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_apply",
        description = "Replace one project-relative text file if expectedSha256 still matches. Requires server --allow-write.",
        annotations(
            title = "Apply source edit",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn apply(
        &self,
        params: Parameters<ProjectApply>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        if !self.context.allow_write {
            return Self::denied(
                "project.apply",
                "permission.write_required",
                "Source edits require server --allow-write.",
            );
        }
        self.dispatch_tool(
            "project.apply",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_diagnostics",
        description = "Run project preflight checks. This does not claim syntax validation and never compiles.",
        annotations(
            title = "Check project",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn diagnostics(
        &self,
        params: Parameters<ProjectSelector>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool(
            "diagnostics",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_compile",
        description = "Explicitly compile a selected disk project and optionally export its PDF. Compilation is never implicit.",
        annotations(
            title = "Compile project",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn compile(
        &self,
        params: Parameters<CompileProject>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool(
            "compile",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_resources_status",
        description = "Inspect local compiler resource availability without downloads or compilation.",
        annotations(
            title = "Resource status",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn resources_status(
        &self,
        _params: Parameters<EmptyInput>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool("resources.status", json!({}), cancel)
            .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_resources_prepare",
        description = "Explicitly prepare cached compiler resources. Requires server --allow-resource-download and never compiles.",
        annotations(
            title = "Prepare resources",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    pub async fn resources_prepare(
        &self,
        params: Parameters<ResourcePrepare>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        if !self.context.allow_resource_download {
            return Self::denied(
                "resources.prepare",
                "resources.download_denied",
                "Resource preparation requires server --allow-resource-download.",
            );
        }
        self.dispatch_tool(
            "resources.prepare",
            serde_json::to_value(params.0).unwrap_or(Value::Null),
            cancel,
        )
        .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_workspace_instances",
        description = "List running ScienceBatch workspace bridge instances. Authentication tokens are never returned.",
        annotations(
            title = "List workspaces",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    pub async fn workspace_instances(&self, _params: Parameters<EmptyInput>) -> CallToolResult {
        match bridge_client::list_instances(&self.bridge_directory) {
            Ok(instances) => envelope_result(super::success(
                "workspace.instances",
                json!({"instances": instances}),
                vec![],
            )),
            Err(error) => envelope_result(super::failure("workspace.instances", error)),
        }
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_workspace",
        description = "Address one explicitly selected live workspace. Mutations use document revisions and the workspace generation.",
        annotations(
            title = "Control workspace",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    pub async fn workspace(
        &self,
        params: Parameters<WorkspaceCall>,
        cancellation: CancellationToken,
    ) -> CallToolResult {
        let call = params.0;
        if matches!(
            call.operation,
            WorkspaceOperation::Apply
                | WorkspaceOperation::Save
                | WorkspaceOperation::Close
                | WorkspaceOperation::OpenFile
                | WorkspaceOperation::OpenProject
                | WorkspaceOperation::Activate
        ) && !self.context.allow_write
        {
            return Self::denied(
                "workspace",
                "permission.write_required",
                "Workspace changes require server --allow-write.",
            );
        }
        let args = workspace_arguments(&call);
        let allowed_roots = self.context.allowed_roots.clone();
        let operation = format!("workspace.{}", call.operation.as_str());
        let instance_id = call.instance_id.clone();
        let directory = self.bridge_directory.clone();
        let job_id = if call.operation.as_str() == "compile" {
            Some(call.job_id.clone().unwrap_or_else(|| {
                format!(
                    "mcp-{}",
                    bridge_client::new_request_id().unwrap_or_default()
                )
            }))
        } else {
            None
        };
        let mut args = args;
        if let Some(job_id) = &job_id {
            if let Some(object) = args.as_object_mut() {
                object.insert("jobId".into(), json!(job_id));
            }
        }
        let watch = job_id.map(|job_id| {
            let cancellation = cancellation.clone();
            let directory = directory.clone();
            let instance_id = instance_id.clone();
            let roots = allowed_roots.clone();
            tokio::spawn(async move {
                cancellation.cancelled().await;
                let args = json!({"jobId": job_id});
                let _ = tokio::task::spawn_blocking(move || {
                    bridge_client::call_instance(
                        &directory,
                        &instance_id,
                        "workspace.cancel",
                        args,
                        &roots,
                    )
                })
                .await;
            })
        });
        let reply = tokio::task::spawn_blocking(move || {
            bridge_client::call_instance(&directory, &instance_id, &operation, args, &allowed_roots)
        })
        .await;
        if let Some(watch) = watch {
            watch.abort();
        }
        match reply {
            Ok(Ok(envelope)) => envelope_result(envelope),
            Ok(Err(error)) => envelope_result(super::failure("workspace", error)),
            Err(error) => envelope_result(super::failure(
                "workspace",
                super::as_error("worker.crashed", error.to_string(), 4),
            )),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sciencebatch", env!("CARGO_PKG_VERSION")))
            .with_instructions("Project operations are rooted in the configured local directories. Source writes and resource downloads require explicit server flags. Compilation only happens through the explicit compile tool.")
    }

    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        std::borrow::Cow::Borrowed(&[ProtocolVersion::V_2025_11_25])
    }
}

fn workspace_arguments(call: &WorkspaceCall) -> Value {
    let mut args = Map::new();
    for (key, value) in [
        (
            "projectRoot",
            call.project_root.as_ref().map(|value| json!(value)),
        ),
        (
            "expectedProjectRoot",
            call.expected_project_root
                .as_ref()
                .map(|value| value.as_ref().map_or(Value::Null, |root| json!(root))),
        ),
        (
            "workspaceGeneration",
            call.workspace_generation.map(|value| json!(value)),
        ),
        (
            "documentId",
            call.document_id.as_ref().map(|value| json!(value)),
        ),
        (
            "expectedRevision",
            call.expected_revision.map(|value| json!(value)),
        ),
        ("file", call.file.as_ref().map(|value| json!(value))),
        ("path", call.path.as_ref().map(|value| json!(value))),
        ("content", call.content.as_ref().map(|value| json!(value))),
        ("start", call.start.map(|value| json!(value))),
        ("end", call.end.map(|value| json!(value))),
        ("text", call.text.as_ref().map(|value| json!(value))),
        (
            "expectedSha256",
            call.expected_sha256.as_ref().map(|value| json!(value)),
        ),
        ("jobId", call.job_id.as_ref().map(|value| json!(value))),
        (
            "timeoutSeconds",
            call.timeout_seconds.map(|value| json!(value)),
        ),
        ("output", call.output.as_ref().map(|value| json!(value))),
        (
            "outputPath",
            call.output_path.as_ref().map(|value| json!(value)),
        ),
        ("overwrite", Some(json!(call.overwrite))),
    ] {
        if let Some(value) = value {
            args.insert(key.to_owned(), value);
        }
    }
    Value::Object(args)
}

fn envelope_result(envelope: Envelope) -> CallToolResult {
    let is_error = !envelope.ok;
    let value = serde_json::to_value(envelope).unwrap_or_else(|_| {
        json!({"schemaVersion":1,"command":"internal.unexpected","ok":false,"data":null,"diagnostics":[],"error":{"code":"internal.unexpected","message":"Could not serialize operation result."}})
    });
    if is_error {
        CallToolResult::structured_error(value)
    } else {
        CallToolResult::structured(value)
    }
}

pub async fn serve_stdio(
    roots: Vec<PathBuf>,
    allow_write: bool,
    allow_resource_download: bool,
) -> Result<(), String> {
    let server = McpServer::new(roots, allow_write, allow_resource_download)?;
    let running = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|error| format!("Unable to start MCP stdio server: {error}"))?;
    running
        .waiting()
        .await
        .map_err(|error| format!("MCP stdio server failed: {error}"))?;
    Ok(())
}

pub async fn run_cli_command(args: &[String]) -> Option<i32> {
    if args.first().is_some_and(|value| value == "mcp") {
        return Some(run_mcp_cli(args).await);
    }
    if args.first().is_some_and(|value| value == "workspace") {
        return Some(bridge_client::run_workspace_cli(args));
    }
    None
}

async fn run_mcp_cli(args: &[String]) -> i32 {
    if args.get(1).map(String::as_str) != Some("serve") {
        eprintln!("usage.invalid_argument: Expected `mcp serve`.");
        return 2;
    }
    let mut roots = Vec::new();
    let mut allow_write = false;
    let mut allow_resource_download = false;
    let mut cursor = 2;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--root" => {
                cursor += 1;
                let Some(value) = args.get(cursor) else {
                    eprintln!("usage.invalid_argument: --root requires a directory.");
                    return 2;
                };
                match std::fs::canonicalize(value) {
                    Ok(path) if path.is_dir() => roots.push(path),
                    _ => {
                        eprintln!(
                            "io.project_unavailable: MCP root must be an existing directory."
                        );
                        return 3;
                    }
                }
            }
            "--allow-write" => allow_write = true,
            "--allow-resource-download" => allow_resource_download = true,
            "--help" | "-h" => {
                eprintln!("Usage: sciencebatch-cli mcp serve [--root DIR ...] [--allow-write] [--allow-resource-download]");
                return 0;
            }
            flag => {
                eprintln!("usage.invalid_argument: Unknown MCP server option `{flag}`.");
                return 2;
            }
        }
        cursor += 1;
    }
    if roots.is_empty() {
        match std::env::current_dir().and_then(std::fs::canonicalize) {
            Ok(path) => roots.push(path),
            Err(error) => {
                eprintln!(
                    "io.project_unavailable: Cannot resolve the server launch directory: {error}"
                );
                return 3;
            }
        }
    }
    roots.sort();
    roots.dedup();
    match serve_stdio(roots, allow_write, allow_resource_download).await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            4
        }
    }
}
