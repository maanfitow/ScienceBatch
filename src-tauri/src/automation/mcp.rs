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
use std::future::Future;
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

struct CancelOnDrop {
    token: CancellationToken,
    armed: bool,
}

struct OperationCancellationOnDrop {
    cancellation: Arc<AtomicBool>,
    armed: bool,
}

impl OperationCancellationOnDrop {
    fn new(cancellation: Arc<AtomicBool>) -> Self {
        Self {
            cancellation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for OperationCancellationOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.store(true, Ordering::Release);
        }
    }
}

async fn cancel_operation_if_dropped<F: Future>(
    cancellation: Arc<AtomicBool>,
    operation: F,
) -> F::Output {
    let mut guard = OperationCancellationOnDrop::new(cancellation);
    let result = operation.await;
    guard.disarm();
    result
}

impl CancelOnDrop {
    fn new(token: CancellationToken) -> Self {
        Self { token, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.token.cancel();
        }
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

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceProjectInput {
    /// Project directory selected by the caller. Relative paths resolve from the server launch directory.
    project: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    engine: Option<EngineName>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    main: Option<String>,
    #[serde(default)]
    selection: Vec<McpResourceSelector>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_input_digest: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_plan_digest: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 200))]
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_download_bytes: Option<u64>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_storage_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpResourceSelector {
    kind: String,
    id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
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
    #[serde(default)]
    engine: Option<EngineName>,
    #[serde(default)]
    main_file: Option<String>,
    #[serde(default)]
    selection: Vec<McpResourceSelector>,
    #[serde(default)]
    expected_input_digest: Option<String>,
    #[serde(default)]
    expected_plan_digest: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 200))]
    limit: Option<usize>,
    #[serde(default)]
    max_download_bytes: Option<u64>,
    #[serde(default)]
    max_storage_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
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
    #[serde(rename = "resources.analyze")]
    ResourcesAnalyze,
    #[serde(rename = "resources.plan")]
    ResourcesPlan,
    #[serde(rename = "resources.list")]
    ResourcesList,
    #[serde(rename = "resources.prepare_project")]
    ResourcesPrepareProject,
    #[serde(rename = "cancel_resources")]
    CancelResources,
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
            Self::ResourcesAnalyze => "resources.analyze",
            Self::ResourcesPlan => "resources.plan",
            Self::ResourcesList => "resources.list",
            Self::ResourcesPrepareProject => "resources.prepare_project",
            Self::CancelResources => "cancel_resources",
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
                resource_progress: None,
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
        context.cancellation = cancellation.clone();
        let result = cancel_operation_if_dropped(
            cancellation.clone(),
            self.service.dispatch(command, args, context),
        )
        .await;
        drop(watcher);
        envelope_result(result)
    }

    fn denied(command: &str, code: &'static str, message: &'static str) -> CallToolResult {
        let envelope = super::failure_for_cli(command, code.to_string(), message.to_string(), 2);
        envelope_result(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::cancel_operation_if_dropped;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn dropping_a_direct_mcp_operation_cancels_its_worker_context() {
        let cancellation = Arc::new(AtomicBool::new(false));
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let operation = tokio::spawn(cancel_operation_if_dropped(cancellation.clone(), async {
            let _ = started_sender.send(());
            std::future::pending::<()>().await
        }));
        started_receiver
            .await
            .expect("operation started before cancellation");

        operation.abort();
        let _ = operation.await;

        assert!(cancellation.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn completed_mcp_operation_does_not_mark_its_context_cancelled() {
        let cancellation = Arc::new(AtomicBool::new(false));
        let result = cancel_operation_if_dropped(cancellation.clone(), async { 7 }).await;

        assert_eq!(result, 7);
        assert!(!cancellation.load(Ordering::Acquire));
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
        name = "sciencebatch_resources_analyze",
        description = "Analyze a project resource snapshot without network access, cache writes, or compilation.",
        annotations(title = "Analyze project resources", read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn resources_analyze(
        &self,
        params: Parameters<ResourceProjectInput>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool("resources.analyze", resource_project_args(params.0), cancel)
            .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_resources_plan",
        description = "Validate an expected input digest and return a project resource plan without network access, cache writes, or compilation.",
        annotations(title = "Plan project resources", read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn resources_plan(
        &self,
        params: Parameters<ResourceProjectInput>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool("resources.plan", resource_project_args(params.0), cancel)
            .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_resources_list",
        description = "List one bounded page of project resource requirements for an expected plan digest.",
        annotations(title = "List project resources", read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn resources_list(
        &self,
        params: Parameters<ResourceProjectInput>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        self.dispatch_tool("resources.list", resource_project_args(params.0), cancel)
            .await
    }

    #[tool(
        output_schema = rmcp::handler::server::tool::schema_for_type::<Envelope>(),
        name = "sciencebatch_resources_prepare_project",
        description = "Explicitly prepare the selected resources for a freshly analyzed project. Requires server --allow-resource-download; never compiles.",
        annotations(title = "Prepare project resources", read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = true)
    )]
    pub async fn resources_prepare_project(
        &self,
        params: Parameters<ResourceProjectInput>,
        cancel: CancellationToken,
    ) -> CallToolResult {
        if !self.context.allow_resource_download {
            return Self::denied(
                "resources.prepare_project",
                "resources.download_denied",
                "Project resource preparation requires server --allow-resource-download.",
            );
        }
        self.dispatch_tool(
            "resources.prepare_project",
            resource_project_args(params.0),
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
        if call.operation == WorkspaceOperation::CancelResources {
            return Self::denied(
                "workspace",
                "usage.invalid_argument",
                "Project resource jobs are cancelled through cancellation of their active request.",
            );
        }
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
        if call.operation == WorkspaceOperation::ResourcesPrepareProject
            && !self.context.allow_resource_download
        {
            return Self::denied(
                "workspace",
                "resources.download_denied",
                "Project resource preparation requires server --allow-resource-download.",
            );
        }
        let mut cancellation_guard = (call.operation
            == WorkspaceOperation::ResourcesPrepareProject)
            .then(|| CancelOnDrop::new(cancellation.clone()));
        let args = workspace_arguments(&call);
        let allowed_roots = self.context.allowed_roots.clone();
        let operation = format!("workspace.{}", call.operation.as_str());
        let instance_id = call.instance_id.clone();
        let directory = self.bridge_directory.clone();
        let cancel_resources = call.operation == WorkspaceOperation::ResourcesPrepareProject;
        let job_id = if matches!(
            call.operation,
            WorkspaceOperation::Compile | WorkspaceOperation::ResourcesPrepareProject
        ) {
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
                let cancel_operation = if cancel_resources {
                    "workspace.cancel_resources"
                } else {
                    "workspace.cancel"
                };
                let _ = tokio::task::spawn_blocking(move || {
                    bridge_client::call_instance(
                        &directory,
                        &instance_id,
                        cancel_operation,
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
            if cancellation.is_cancelled() {
                let _ = watch.await;
            } else {
                watch.abort();
            }
        }
        if let Some(guard) = cancellation_guard.as_mut() {
            guard.disarm();
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
        ("engine", call.engine.map(|value| json!(value))),
        (
            "mainFile",
            call.main_file.as_ref().map(|value| json!(value)),
        ),
        (
            "selection",
            (!call.selection.is_empty()).then(|| json!(call.selection)),
        ),
        (
            "expectedInputDigest",
            call.expected_input_digest
                .as_ref()
                .map(|value| json!(value)),
        ),
        (
            "expectedPlanDigest",
            call.expected_plan_digest.as_ref().map(|value| json!(value)),
        ),
        ("cursor", call.cursor.as_ref().map(|value| json!(value))),
        ("limit", call.limit.map(|value| json!(value))),
        (
            "maxDownloadBytes",
            call.max_download_bytes.map(|value| json!(value)),
        ),
        (
            "maxStorageBytes",
            call.max_storage_bytes.map(|value| json!(value)),
        ),
    ] {
        if let Some(value) = value {
            args.insert(key.to_owned(), value);
        }
    }
    Value::Object(args)
}

fn resource_project_args(input: ResourceProjectInput) -> Value {
    serde_json::to_value(input).unwrap_or(Value::Null)
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
