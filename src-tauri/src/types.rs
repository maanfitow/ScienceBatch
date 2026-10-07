use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiagnosticItem {
    pub severity: String, // "error" | "warning"
    pub message: String,
    pub line: Option<usize>,
    #[serde(default)]
    pub file: Option<String>,
    pub suggestion: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompileResponse {
    pub pdf_bytes: Vec<u8>,
    pub success: bool,
    pub errors: Vec<DiagnosticItem>,
    pub warnings: Vec<DiagnosticItem>,
    pub raw_log: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub status: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkerRequest {
    pub engine: String, // "latex" | "typst"
    pub source: String,
    #[serde(default, alias = "projectDir")]
    pub project_dir: Option<String>,
    #[serde(default, alias = "mainFile")]
    pub main_file: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileItem>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListResult {
    pub branches: Vec<String>,
    pub current_branch: Option<String>,
    pub detached: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSwitchResult {
    pub branch: String,
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub git_available: bool,
    pub git_version: Option<String>,
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub changes: Vec<GitFileChange>,
    pub detached: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub path: String,
    pub diff: String,
    pub is_binary: bool,
    pub oversized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub valid: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryInfo {
    pub repository_root: String,
    pub identity: GitIdentity,
    pub has_commits: bool,
    pub has_staged_changes: bool,
    pub worktree_clean: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub remotes: Vec<GitRemoteInfo>,
    pub upstream: Option<String>,
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub push_refresh_required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationError {
    pub code: String,
    pub message: String,
    pub recovery: Option<String>,
    pub partial_path: Option<String>,
    pub outcome_unknown: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationProgressPayload {
    pub operation_id: String,
    pub repository_root: Option<String>,
    pub operation: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub message: String,
    pub commit_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
    pub project_path: String,
}
