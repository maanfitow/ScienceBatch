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
