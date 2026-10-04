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
