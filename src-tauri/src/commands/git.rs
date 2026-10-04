use std::path::{Component, Path};
use std::process::Stdio;
use tauri::command;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::types::{GitBranchListResult, GitBranchSwitchResult, GitDiffResult, GitFileChange, GitStatusResult};

const MAX_DIFF_FILE_BYTES: u64 = 8 * 1024 * 1024; // 8 MB
const MAX_DIFF_LINES: usize = 2000;

/// Return the installed Git version, or None when the executable is unavailable.
async fn detect_git_version() -> Result<Option<String>, String> {
    let output = match Command::new("git")
        .arg("--version")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .await
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to check Git availability: {error}")),
    };

    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "Git is installed but did not report its version.".to_string()
        } else {
            format!("Git availability check failed: {details}")
        });
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !version.starts_with("git version ") || version.len() <= "git version ".len() {
        return Err("Git is installed but returned an unrecognized version string.".to_string());
    }
    Ok(Some(version))
}

/// Prevent a caller's Git environment from redirecting repo discovery or writes.
fn clear_git_location_overrides(command: &mut Command) {
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_TEMPLATE_DIR",
    ] {
        command.env_remove(key);
    }
}

fn unavailable_git_status() -> GitStatusResult {
    GitStatusResult {
        git_available: false,
        git_version: None,
        is_git_repo: false,
        branch: None,
        changes: Vec::new(),
        detached: false,
        error: None,
    }
}

/// Pure helper to parse git status porcelain v1 output with NUL separation (-z) and branch info (-b).
pub fn parse_git_status_output_nul(bytes: &[u8]) -> (Option<String>, bool, Vec<GitFileChange>) {
    let mut branch: Option<String> = None;
    let mut detached = false;
    let mut changes: Vec<GitFileChange> = Vec::new();

    let chunks: Vec<&[u8]> = bytes.split(|&b| b == 0).collect();
    let mut i = 0;

    while i < chunks.len() {
        let chunk = chunks[i];
        i += 1;

        if chunk.is_empty() {
            continue;
        }

        // Branch header chunk
        if chunk.starts_with(b"## ") {
            let header = String::from_utf8_lossy(&chunk[3..]).trim().to_string();
            if header.starts_with("HEAD (no branch)")
                || header.starts_with("HEAD detached")
                || header.eq_ignore_ascii_case("no branch")
            {
                branch = Some("HEAD (detached)".to_string());
                detached = true;
            } else if let Some(rest) = header.strip_prefix("Initial commit on ") {
                branch = Some(rest.trim().to_string());
                detached = false;
            } else if let Some(rest) = header.strip_prefix("No commits yet on ") {
                branch = Some(rest.trim().to_string());
                detached = false;
            } else {
                let b = header
                    .split("...")
                    .next()
                    .unwrap_or(&header)
                    .split_whitespace()
                    .next()
                    .unwrap_or(&header);
                if !b.is_empty() {
                    branch = Some(b.to_string());
                }
            }
            continue;
        }

        if chunk.len() < 3 {
            continue;
        }

        let x = chunk[0] as char;
        let y = chunk[1] as char;
        // In porcelain -z, byte 2 is a space separator and remaining bytes are the exact path
        let raw_path = String::from_utf8_lossy(&chunk[3..]).to_string();

        let is_rename_or_copy = x == 'R' || y == 'R' || x == 'C' || y == 'C';
        let _old_path = if is_rename_or_copy && i < chunks.len() {
            let old = String::from_utf8_lossy(chunks[i]).to_string();
            i += 1; // Consume rename/copy source path
            Some(old)
        } else {
            None
        };

        let (status, staged) = match (x, y) {
            ('?', '?') => ("untracked", false),
            ('!', '!') => continue, // skip ignored
            ('A', _) => ("added", true),
            (_, 'A') => ("added", false),
            ('D', _) => ("deleted", true),
            (_, 'D') => ("deleted", false),
            ('R', _) => ("renamed", true),
            (_, 'R') => ("renamed", false),
            ('C', _) => ("copied", true),
            (_, 'C') => ("copied", false),
            ('T', _) => ("typechanged", true),
            (_, 'T') => ("typechanged", false),
            ('M', ' ') => ("modified", true),
            (' ', 'M') => ("modified", false),
            ('M', 'M') => ("modified", true),
            (x, _y) if x != ' ' => ("modified", true),
            (_, y) if y != ' ' => ("modified", false),
            _ => ("modified", false),
        };

        changes.push(GitFileChange {
            path: raw_path,
            status: status.to_string(),
            staged,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
        });
    }

    (branch, detached, changes)
}

/// Backward compatible parser helper for newline-separated status (used in legacy unit tests)
pub fn parse_git_status_output(output: &str) -> (Option<String>, bool, Vec<GitFileChange>) {
    let mut nul_bytes = Vec::new();
    for line in output.lines() {
        if line.starts_with("## ") {
            nul_bytes.extend_from_slice(line.as_bytes());
            nul_bytes.push(0);
        } else if line.len() >= 3 {
            nul_bytes.extend_from_slice(line.as_bytes());
            nul_bytes.push(0);
        }
    }
    parse_git_status_output_nul(&nul_bytes)
}

/// Generate a synthetic unified diff for a confirmed untracked text file
pub fn generate_synthetic_diff(file_path: &str, content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let line_count = lines.len();
    let display_count = line_count.min(MAX_DIFF_LINES);

    let mut diff = String::new();
    diff.push_str(&format!("--- /dev/null\n+++ b/{}\n", file_path));
    diff.push_str(&format!("@@ -0,0 +1,{} @@\n", display_count));

    for line in lines.iter().take(display_count) {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }

    if line_count > MAX_DIFF_LINES {
        diff.push_str(&format!("\n... [Diff truncated: showing {} of {} lines]\n", MAX_DIFF_LINES, line_count));
    }

    diff
}

/// Truncate long diffs if they exceed line bounds
pub fn truncate_diff_if_needed(diff: String) -> String {
    let lines: Vec<&str> = diff.lines().collect();
    if lines.len() <= MAX_DIFF_LINES {
        return diff;
    }

    let mut truncated = lines.into_iter().take(MAX_DIFF_LINES).collect::<Vec<&str>>().join("\n");
    truncated.push_str(&format!("\n... [Diff truncated: exceeds {} lines display limit]\n", MAX_DIFF_LINES));
    truncated
}

/// Check if bytes look like binary data (contains NUL byte in the first 8 KB)
pub fn is_binary_buffer(buffer: &[u8]) -> bool {
    let check_len = buffer.len().min(8192);
    buffer[..check_len].contains(&0)
}

/// Run git diff with strict flags and cap stdout buffer before unbounded allocation
async fn run_git_diff_capped(
    proj: &Path,
    args: &[&str],
    max_bytes: usize,
) -> Result<(String, bool, bool), String> {
    let mut cmd = Command::new("git");
    cmd.arg("--no-optional-locks")
        .arg("--literal-pathspecs")
        .arg("diff")
        .arg("--no-ext-diff")
        .arg("--no-textconv");

    for arg in args {
        cmd.arg(arg);
    }

    cmd.current_dir(proj)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    clear_git_location_overrides(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn git diff: {e}"))?;

    let mut stdout_buf = Vec::new();
    let mut oversized = false;

    if let Some(mut stdout) = child.stdout.take() {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            if stdout_buf.len() + n > max_bytes {
                let remaining = max_bytes.saturating_sub(stdout_buf.len());
                stdout_buf.extend_from_slice(&chunk[..remaining]);
                oversized = true;
                // Kill child process to prevent further unbounded output production
                let _ = child.kill().await;
                break;
            } else {
                stdout_buf.extend_from_slice(&chunk[..n]);
            }
        }
    }

    let status = child.wait().await.map_err(|e| format!("Git diff process error: {e}"))?;

    if !status.success() && !oversized && stdout_buf.is_empty() {
        return Err("Git diff command failed".to_string());
    }

    let is_binary = is_binary_buffer(&stdout_buf);
    let stdout_str = String::from_utf8_lossy(&stdout_buf).to_string();

    if is_binary || (stdout_str.contains("Binary files ") && stdout_str.contains(" differ")) {
        return Ok(("Binary file not shown in diff viewer.".to_string(), true, oversized));
    }

    if oversized {
        return Ok((
            format!("Diff output exceeds {} KB display limit.", max_bytes / 1024),
            false,
            true,
        ));
    }

    Ok((stdout_str, false, false))
}

/// Internal helper to query git status using NUL-separated porcelain format
pub async fn get_git_status_internal(path: &Path) -> Result<GitStatusResult, String> {
    let git_version = detect_git_version().await?;
    let Some(git_version) = git_version else {
        return Ok(unavailable_git_status());
    };

    if !path.exists() || !path.is_dir() {
        return Ok(GitStatusResult {
            git_available: true,
            git_version: Some(git_version),
            is_git_repo: false,
            branch: None,
            changes: Vec::new(),
            detached: false,
            error: Some("Project directory does not exist or is not a directory.".to_string()),
        });
    }

    let mut status_command = Command::new("git");
    status_command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("--no-optional-locks")
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .arg("--untracked-files=all")
        .arg("-b")
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    clear_git_location_overrides(&mut status_command);
    let output = match status_command
        .stdin(Stdio::null())
        .output()
        .await
    {
        Ok(out) => out,
        Err(e) => {
            return Err(format!("Git is available, but its status command could not start: {e}"));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("not a git repository") || stderr.contains("Not a git repository") {
            return Ok(GitStatusResult {
                git_available: true,
                git_version: Some(git_version),
                is_git_repo: false,
                branch: None,
                changes: Vec::new(),
                detached: false,
                error: None,
            });
        }

        return Ok(GitStatusResult {
            git_available: true,
            git_version: Some(git_version),
            is_git_repo: false,
            branch: None,
            changes: Vec::new(),
            detached: false,
            error: Some(if stderr.is_empty() {
                "Failed to run git status.".to_string()
            } else {
                stderr
            }),
        });
    }

    let (branch, detached, changes) = parse_git_status_output_nul(&output.stdout);

    Ok(GitStatusResult {
        git_available: true,
        git_version: Some(git_version),
        is_git_repo: true,
        branch,
        changes,
        detached,
        error: None,
    })
}

/// Initialize a repository in exactly the selected project folder after rechecking it.
#[command]
pub async fn initialize_git_repository(project_path: String) -> Result<GitStatusResult, String> {
    let requested_path = Path::new(&project_path);
    if !requested_path.exists() || !requested_path.is_dir() {
        return Err("The selected project folder does not exist or is not a directory.".to_string());
    }
    let project_path = requested_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the selected project folder: {error}"))?;

    let status = get_git_status_internal(&project_path).await?;
    if !status.git_available {
        return Ok(status);
    }
    if status.is_git_repo {
        return Ok(status);
    }
    if let Some(error) = status.error {
        return Err(format!("Cannot initialize Git because repository status failed: {error}"));
    }

    if std::fs::symlink_metadata(project_path.join(".git")).is_ok() {
        return Err("The selected folder already contains Git metadata that is not usable as a repository. Git was not initialized.".to_string());
    }

    let mut init_command = Command::new("git");
    init_command
        .arg("-C")
        .arg(&project_path)
        .arg("init")
        .arg("--quiet")
        .arg("--template=")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    clear_git_location_overrides(&mut init_command);
    let output = init_command.output().await
        .map_err(|error| format!("Failed to start Git initialization: {error}"))?;

    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "Git could not initialize the selected project folder.".to_string()
        } else {
            format!("Git could not initialize the selected project folder: {details}")
        });
    }

    let status = get_git_status_internal(&project_path).await?;
    if !status.is_git_repo {
        return Err(status.error.unwrap_or_else(|| {
            "Git initialization completed, but the selected folder is still not recognized as a repository.".to_string()
        }));
    }
    Ok(status)
}

#[command]
pub async fn get_git_status(project_path: String) -> Result<GitStatusResult, String> {
    get_git_status_internal(Path::new(&project_path)).await
}

fn canonical_project(project_path: &str) -> Result<std::path::PathBuf, String> {
    let path = Path::new(project_path);
    if !path.exists() || !path.is_dir() {
        return Err("Project directory does not exist or is not a directory.".to_string());
    }
    path.canonicalize().map_err(|error| format!("Cannot resolve project directory: {error}"))
}

async fn require_git_project(project_path: &str) -> Result<std::path::PathBuf, String> {
    let project = canonical_project(project_path)?;
    let status = get_git_status_internal(&project).await?;
    if !status.is_git_repo {
        return Err("Project is not a Git repository.".to_string());
    }
    Ok(project)
}

/// Check explicitly supplied paths lexically and through their nearest existing ancestor.
fn validate_git_paths(project: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("At least one file path is required.".to_string());
    }
    for value in paths {
        if value.is_empty() || value.contains('\0') {
            return Err("File paths must be non-empty and cannot contain NUL bytes.".to_string());
        }
        let relative = Path::new(value);
        if relative.is_absolute() || value.starts_with('/') || value.starts_with('\\') {
            return Err("Absolute paths are not allowed.".to_string());
        }
        for component in relative.components() {
            match component {
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err("File paths must stay inside the selected project directory.".to_string());
                }
                _ => {}
            }
        }
        if relative.as_os_str().is_empty() || relative == Path::new(".") {
            return Err("The project directory itself cannot be staged as a file path.".to_string());
        }

        let mut probe = project.join(relative);
        while !probe.exists() && !std::fs::symlink_metadata(&probe).is_ok() {
            if !probe.pop() || !probe.starts_with(project) {
                return Err("File path escapes the selected project directory.".to_string());
            }
        }
        if let Ok(resolved) = probe.canonicalize() {
            if !resolved.starts_with(project) {
                return Err("File path escapes the selected project directory through a symlink.".to_string());
            }
        }
    }
    Ok(())
}

fn git_command(project: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.args(args)
        .current_dir(project)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    clear_git_location_overrides(&mut command);
    command
}

async fn run_git_action(project: &Path, args: &[&str], action: &str) -> Result<(), String> {
    let output = git_command(project, args).output().await
        .map_err(|error| format!("Failed to start Git {action}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if details.is_empty() { format!("Git {action} failed.") } else { format!("Git {action} failed: {details}") })
}

#[command]
pub async fn list_git_branches(project_path: String) -> Result<GitBranchListResult, String> {
    let project = require_git_project(&project_path).await?;
    let status = get_git_status_internal(&project).await?;
    let output = git_command(&project, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .output().await.map_err(|error| format!("Failed to list Git branches: {error}"))?;
    if !output.status.success() {
        return Err("Git could not list local branches.".to_string());
    }
    let mut branches: Vec<String> = String::from_utf8_lossy(&output.stdout).lines()
        .map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect();
    if !status.detached {
        if let Some(current) = status.branch.as_ref().filter(|branch| !branch.is_empty()) {
            if !branches.iter().any(|branch| branch == current) {
                branches.push(current.clone());
            }
        }
    }
    Ok(GitBranchListResult {
        branches,
        current_branch: if status.detached { None } else { status.branch },
        detached: status.detached,
    })
}

#[command]
pub async fn switch_git_branch(project_path: String, branch: String, create: bool) -> Result<GitBranchSwitchResult, String> {
    let project = require_git_project(&project_path).await?;
    if branch.is_empty() || branch.contains('\0') || branch.contains('\n') || branch.contains('\r') {
        return Err("Branch name is invalid.".to_string());
    }
    let check = git_command(&project, &["check-ref-format", "--branch", &branch]).output().await
        .map_err(|error| format!("Failed to validate Git branch name: {error}"))?;
    if !check.status.success() {
        return Err("Branch name is invalid.".to_string());
    }
    if create {
        run_git_action(&project, &["switch", "-c", &branch], "branch switch").await?;
    } else {
        run_git_action(&project, &["switch", "--", &branch], "branch switch").await?;
    }
    Ok(GitBranchSwitchResult { branch, created: create })
}

async fn change_git_index(project_path: String, paths: Vec<String>, stage: bool) -> Result<(), String> {
    let project = require_git_project(&project_path).await?;
    validate_git_paths(&project, &paths)?;
    let mut command = Command::new("git");
    command.arg("--literal-pathspecs").current_dir(&project)
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C").stdin(Stdio::null());
    clear_git_location_overrides(&mut command);
    if stage {
        command.arg("add").arg("--").args(&paths);
    } else {
        let has_head = git_command(&project, &["rev-parse", "--verify", "HEAD"]).output().await
            .map(|output| output.status.success()).unwrap_or(false);
        if has_head {
            command.args(["restore", "--staged", "--source=HEAD", "--"]).args(&paths);
        } else {
            command.args(["rm", "--cached", "-r", "--ignore-unmatch", "--"]).args(&paths);
        }
    }
    let output = command.output().await.map_err(|error| format!("Failed to start Git {}: {error}", if stage { "stage" } else { "unstage" }))?;
    if output.status.success() { return Ok(()); }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() { format!("Git {} failed.", if stage { "stage" } else { "unstage" }) } else { detail })
}

#[command]
pub async fn stage_git_files(project_path: String, paths: Vec<String>) -> Result<(), String> {
    change_git_index(project_path, paths, true).await
}

#[command]
pub async fn unstage_git_files(project_path: String, paths: Vec<String>) -> Result<(), String> {
    change_git_index(project_path, paths, false).await
}

#[command]
pub async fn get_git_diff(project_path: String, file_path: String) -> Result<GitDiffResult, String> {
    if file_path.is_empty() {
        return Err("File path cannot be empty".to_string());
    }

    // Reject absolute paths and leading slashes
    if file_path.starts_with('/') || file_path.starts_with('\\') {
        return Err("Absolute paths are not allowed".to_string());
    }

    let rel_path = Path::new(&file_path);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }

    // Reject parent directory traversal components or prefix/root indicators
    for comp in rel_path.components() {
        match comp {
            Component::ParentDir => {
                return Err("Parent directory traversal ('..') is not allowed".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Absolute paths are not allowed".to_string());
            }
            _ => {}
        }
    }

    // Validate project directory
    let proj = Path::new(&project_path);
    if !proj.exists() || !proj.is_dir() {
        return Err("Project directory does not exist or is not a directory".to_string());
    }

    let proj_canonical = tokio::fs::canonicalize(proj)
        .await
        .map_err(|e| format!("Cannot resolve project directory: {e}"))?;

    // Check symlink safety: the target file cannot escape the project directory
    let target_path = proj_canonical.join(rel_path);
    if let Ok(symlink_meta) = tokio::fs::symlink_metadata(&target_path).await {
        if symlink_meta.file_type().is_symlink() {
            let target_canonical = tokio::fs::canonicalize(&target_path)
                .await
                .map_err(|e| format!("Cannot resolve symlink target: {e}"))?;
            if !target_canonical.starts_with(&proj_canonical) {
                return Err("Path escapes project directory via symlink".to_string());
            }
        } else if target_path.exists() {
            let target_canonical = tokio::fs::canonicalize(&target_path)
                .await
                .map_err(|e| format!("Cannot resolve file path: {e}"))?;
            if !target_canonical.starts_with(&proj_canonical) {
                return Err("Path escapes project directory".to_string());
            }
        }
    }

    // Query current Git status
    let status = get_git_status_internal(&proj_canonical).await?;
    if !status.is_git_repo {
        return Err("Project is not a Git repository".to_string());
    }

    if let Some(err) = status.error {
        return Err(format!("Git error: {err}"));
    }

    // Match file in current Git status
    let change_opt = status.changes.iter().find(|c| c.path == file_path);

    match change_opt {
        Some(change) => {
            if change.status == "untracked" {
                // Confirmed untracked file: generate synthetic added diff without git diff --no-index
                if !target_path.exists() || !target_path.is_file() {
                    return Ok(GitDiffResult {
                        path: file_path,
                        diff: "Untracked file does not exist on disk.".to_string(),
                        is_binary: false,
                        oversized: false,
                    });
                }

                let meta = tokio::fs::metadata(&target_path)
                    .await
                    .map_err(|e| format!("Failed to read file metadata: {e}"))?;

                if meta.len() > MAX_DIFF_FILE_BYTES {
                    return Ok(GitDiffResult {
                        path: file_path,
                        diff: format!(
                            "File is too large to display diff ({} KB, exceeds {} KB limit).",
                            meta.len() / 1024,
                            MAX_DIFF_FILE_BYTES / 1024
                        ),
                        is_binary: false,
                        oversized: true,
                    });
                }

                let bytes = tokio::fs::read(&target_path)
                    .await
                    .map_err(|e| format!("Failed to read file: {e}"))?;

                if is_binary_buffer(&bytes) {
                    return Ok(GitDiffResult {
                        path: file_path,
                        diff: "Binary file not shown in diff viewer.".to_string(),
                        is_binary: true,
                        oversized: false,
                    });
                }

                let content = String::from_utf8_lossy(&bytes);
                let synthetic = generate_synthetic_diff(&file_path, &content);

                return Ok(GitDiffResult {
                    path: file_path,
                    diff: synthetic,
                    is_binary: false,
                    oversized: false,
                });
            }

            if change.status == "deleted" {
                // Deleted file: do NOT read filesystem; query Git tree directly
                let diff_res = run_git_diff_capped(
                    &proj_canonical,
                    &["HEAD", "--", &file_path],
                    MAX_DIFF_FILE_BYTES as usize,
                )
                .await;

                let (diff_output, is_binary, oversized) = match diff_res {
                    Ok(res) => res,
                    Err(_) => {
                        run_git_diff_capped(
                            &proj_canonical,
                            &["--cached", "--", &file_path],
                            MAX_DIFF_FILE_BYTES as usize,
                        )
                        .await
                        .unwrap_or_else(|_| (String::new(), false, false))
                    }
                };

                return Ok(GitDiffResult {
                    path: file_path,
                    diff: if diff_output.trim().is_empty() {
                        "File marked as deleted in repository.".to_string()
                    } else {
                        truncate_diff_if_needed(diff_output)
                    },
                    is_binary,
                    oversized,
                });
            }

            // Tracked modified / added / renamed / copied / typechanged file
            let mut diff_res = run_git_diff_capped(
                &proj_canonical,
                &["HEAD", "--", &file_path],
                MAX_DIFF_FILE_BYTES as usize,
            )
            .await;

            if diff_res.is_err() {
                let wt_res = run_git_diff_capped(
                    &proj_canonical,
                    &["--", &file_path],
                    MAX_DIFF_FILE_BYTES as usize,
                )
                .await;

                diff_res = match wt_res {
                    Ok(r) if !r.0.trim().is_empty() => Ok(r),
                    _ => {
                        run_git_diff_capped(
                            &proj_canonical,
                            &["--cached", "--", &file_path],
                            MAX_DIFF_FILE_BYTES as usize,
                        )
                        .await
                    }
                };
            }

            let (diff_output, is_binary, oversized) = diff_res.unwrap_or_else(|_| (String::new(), false, false));

            if diff_output.trim().is_empty() {
                // Check if changes are staged
                let staged_res = run_git_diff_capped(
                    &proj_canonical,
                    &["--cached", "--", &file_path],
                    MAX_DIFF_FILE_BYTES as usize,
                )
                .await;

                if let Ok((staged_output, staged_bin, staged_over)) = staged_res {
                    if !staged_output.trim().is_empty() {
                        return Ok(GitDiffResult {
                            path: file_path,
                            diff: truncate_diff_if_needed(staged_output),
                            is_binary: staged_bin,
                            oversized: staged_over,
                        });
                    }
                }

                return Ok(GitDiffResult {
                    path: file_path,
                    diff: "No differences found between working file and Git repository.".to_string(),
                    is_binary: false,
                    oversized: false,
                });
            }

            Ok(GitDiffResult {
                path: file_path,
                diff: truncate_diff_if_needed(diff_output),
                is_binary,
                oversized,
            })
        }
        None => {
            // Path is NOT in status.changes. Check if it is a clean tracked file in Git:
            let mut ls_command = Command::new("git");
            ls_command
                .arg("--no-optional-locks")
                .arg("--literal-pathspecs")
                .arg("ls-files")
                .arg("--error-unmatch")
                .arg("--")
                .arg(&file_path)
                .current_dir(&proj_canonical)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_PAGER", "cat")
                .env("GIT_OPTIONAL_LOCKS", "0")
                .env("GIT_LITERAL_PATHSPECS", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            clear_git_location_overrides(&mut ls_command);
            let ls_check = ls_command.status().await;

            if let Ok(st) = ls_check {
                if st.success() {
                    // Confirmed clean tracked file: must show no differences
                    return Ok(GitDiffResult {
                        path: file_path,
                        diff: "No differences found between working file and Git repository.".to_string(),
                        is_binary: false,
                        oversized: false,
                    });
                }
            }

            Err(format!(
                "Path '{file_path}' is not a valid change or tracked file in the Git repository"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_git_status_nul_branch_and_tracking() {
        let mut sample = Vec::new();
        sample.extend_from_slice(b"## feat/git-status-panel...origin/feat/git-status-panel [ahead 1]");
        sample.push(0);
        sample.extend_from_slice(b" M src/App.tsx");
        sample.push(0);
        sample.extend_from_slice(b"?? docs/ROADMAP.md");
        sample.push(0);

        let (branch, detached, changes) = parse_git_status_output_nul(&sample);

        assert_eq!(branch, Some("feat/git-status-panel".to_string()));
        assert!(!detached);
        assert_eq!(changes.len(), 2);

        assert_eq!(changes[0].path, "src/App.tsx");
        assert_eq!(changes[0].status, "modified");
        assert!(!changes[0].staged);

        assert_eq!(changes[1].path, "docs/ROADMAP.md");
        assert_eq!(changes[1].status, "untracked");
        assert!(!changes[1].staged);
    }

    #[test]
    fn test_parse_git_status_nul_exact_names_quotes_spaces_newlines() {
        let mut sample = Vec::new();
        sample.extend_from_slice(b"## main");
        sample.push(0);
        // Filename containing literal quotes, spaces, and newline
        let complex_name = "path with \"quotes\" and\nnewline.tex";
        let mut entry = Vec::new();
        entry.extend_from_slice(b"?? ");
        entry.extend_from_slice(complex_name.as_bytes());
        sample.extend_from_slice(&entry);
        sample.push(0);

        let (branch, detached, changes) = parse_git_status_output_nul(&sample);

        assert_eq!(branch, Some("main".to_string()));
        assert!(!detached);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, complex_name);
        assert_eq!(changes[0].status, "untracked");
    }

    #[test]
    fn test_parse_git_status_nul_renames() {
        let mut sample = Vec::new();
        sample.extend_from_slice(b"## main");
        sample.push(0);
        sample.extend_from_slice(b"R  new name.tex");
        sample.push(0);
        sample.extend_from_slice(b"old name.tex");
        sample.push(0);
        sample.extend_from_slice(b" D deleted.tex");
        sample.push(0);

        let (branch, detached, changes) = parse_git_status_output_nul(&sample);

        assert_eq!(branch, Some("main".to_string()));
        assert!(!detached);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "new name.tex");
        assert_eq!(changes[0].status, "renamed");
        assert!(changes[0].staged);

        assert_eq!(changes[1].path, "deleted.tex");
        assert_eq!(changes[1].status, "deleted");
        assert!(!changes[1].staged);
    }

    #[test]
    fn test_parse_git_status_nul_detached_head() {
        let mut sample = Vec::new();
        sample.extend_from_slice(b"## HEAD (no branch)");
        sample.push(0);
        sample.extend_from_slice(b"?? new_file.typ");
        sample.push(0);

        let (branch, detached, changes) = parse_git_status_output_nul(&sample);

        assert_eq!(branch, Some("HEAD (detached)".to_string()));
        assert!(detached);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "new_file.typ");
        assert_eq!(changes[0].status, "untracked");
    }

    #[test]
    fn test_generate_synthetic_diff() {
        let content = "line 1\nline 2\nline 3";
        let diff = generate_synthetic_diff("test.tex", content);

        assert!(diff.starts_with("--- /dev/null\n+++ b/test.tex\n@@ -0,0 +1,3 @@\n"));
        assert!(diff.contains("+line 1\n"));
        assert!(diff.contains("+line 2\n"));
        assert!(diff.contains("+line 3\n"));
    }

    #[test]
    fn test_diff_display_limit_keeps_two_thousand_lines() {
        let input = (0..MAX_DIFF_LINES + 5).map(|line| format!("line {line}")).collect::<Vec<_>>().join("\n");
        let truncated = truncate_diff_if_needed(input);
        assert!(truncated.contains("line 1999"));
        assert!(!truncated.contains("line 2000"));
        assert!(truncated.contains("exceeds 2000 lines display limit"));
    }

    #[tokio::test]
    async fn test_git_diff_accepts_text_larger_than_previous_limit_and_caps_at_eight_mib() {
        let project_dir = std::env::temp_dir().join(format!(
            "sciencebatch_diff_cap_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&project_dir).unwrap();
        let init = std::process::Command::new("git").args(["init", "--quiet"]).current_dir(&project_dir).status().unwrap();
        assert!(init.success());

        let under_cap = "a".repeat(600 * 1024);
        std::fs::write(project_dir.join("large.txt"), &under_cap).unwrap();
        let shown = get_git_diff(project_dir.to_string_lossy().to_string(), "large.txt".to_string()).await.unwrap();
        assert!(!shown.is_binary && !shown.oversized, "600 KiB text diffs must remain displayable");
        assert!(shown.diff.contains(&under_cap[..64]));

        let over_cap = "b".repeat(MAX_DIFF_FILE_BYTES as usize + 1);
        std::fs::write(project_dir.join("large.txt"), over_cap).unwrap();
        let capped = get_git_diff(project_dir.to_string_lossy().to_string(), "large.txt".to_string()).await.unwrap();
        assert!(capped.oversized, "text over 8 MiB must be reported as capped");
        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[test]
    fn test_is_binary_buffer() {
        let text = b"Hello, this is pure UTF-8 LaTeX source code!";
        assert!(!is_binary_buffer(text));

        let binary = b"PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        assert!(is_binary_buffer(binary));
    }

    #[tokio::test]
    async fn test_diff_rejects_absolute_paths() {
        let temp_dir = std::env::temp_dir();
        let res = get_git_diff(temp_dir.to_str().unwrap().to_string(), "/etc/passwd".to_string()).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Absolute paths are not allowed"));
    }

    #[tokio::test]
    async fn test_diff_rejects_parent_traversal() {
        let temp_dir = std::env::temp_dir();
        let res = get_git_diff(temp_dir.to_str().unwrap().to_string(), "../outside.txt".to_string()).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Parent directory traversal"));

        let res2 = get_git_diff(temp_dir.to_str().unwrap().to_string(), "foo/../../outside.txt".to_string()).await;
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("Parent directory traversal"));
    }

    #[tokio::test]
    async fn test_diff_rejects_symlink_escaping_project() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_symlink_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(format!("{test_id}_proj"));
        let outside_dir = base_temp.join(format!("{test_id}_outside"));

        let _ = std::fs::create_dir_all(&project_dir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let outside_file = outside_dir.join("secret.txt");
        let _ = std::fs::write(&outside_file, "secret contents");

        // Create symlink pointing outside project
        let symlink_path = project_dir.join("link_to_secret.txt");
        #[cfg(unix)]
        let symlink_created = std::os::unix::fs::symlink(&outside_file, &symlink_path).is_ok();
        #[cfg(not(unix))]
        let symlink_created = false;

        if symlink_created {
            let res = get_git_diff(project_dir.to_str().unwrap().to_string(), "link_to_secret.txt".to_string()).await;
            assert!(res.is_err());
            assert!(res.unwrap_err().contains("escapes project directory"));
        }

        let _ = std::fs::remove_dir_all(&project_dir);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[tokio::test]
    async fn test_git_diff_untracked_and_clean_file_lifecycle() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_git_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(test_id);
        let _ = std::fs::create_dir_all(&project_dir);

        // Initialize git repo
        let init_status = std::process::Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&project_dir)
            .status();

        if let Ok(st) = init_status {
            if st.success() {
                // Configure test user for commits
                let _ = std::process::Command::new("git")
                    .args(["config", "user.name", "TestUser"])
                    .current_dir(&project_dir)
                    .status();
                let _ = std::process::Command::new("git")
                    .args(["config", "user.email", "test@example.com"])
                    .current_dir(&project_dir)
                    .status();

                // 1. Create a clean tracked file
                let tracked_file = project_dir.join("tracked.txt");
                let _ = std::fs::write(&tracked_file, "line 1\nline 2\n");
                let _ = std::process::Command::new("git")
                    .args(["add", "tracked.txt"])
                    .current_dir(&project_dir)
                    .status();
                let _ = std::process::Command::new("git")
                    .args(["commit", "-m", "init"])
                    .current_dir(&project_dir)
                    .status();

                // Clean tracked file must show no differences
                let clean_diff = get_git_diff(project_dir.to_str().unwrap().to_string(), "tracked.txt".to_string()).await.unwrap();
                assert_eq!(clean_diff.diff, "No differences found between working file and Git repository.");

                // 2. Create an untracked file
                let untracked_file = project_dir.join("untracked.txt");
                let _ = std::fs::write(&untracked_file, "new line 1\nnew line 2\n");

                let untracked_diff = get_git_diff(project_dir.to_str().unwrap().to_string(), "untracked.txt".to_string()).await.unwrap();
                assert!(untracked_diff.diff.starts_with("--- /dev/null\n+++ b/untracked.txt\n@@ -0,0 +1,2 @@\n"));
                assert!(untracked_diff.diff.contains("+new line 1\n"));
                assert!(untracked_diff.diff.contains("+new line 2\n"));

                // 3. Test deleted tracked file
                let del_file = project_dir.join("to_delete.txt");
                let _ = std::fs::write(&del_file, "content to be deleted\n");
                let _ = std::process::Command::new("git")
                    .args(["add", "to_delete.txt"])
                    .current_dir(&project_dir)
                    .status();
                let _ = std::process::Command::new("git")
                    .args(["commit", "-m", "add to_delete"])
                    .current_dir(&project_dir)
                    .status();

                // Remove from disk (without git rm)
                let _ = std::fs::remove_file(&del_file);
                assert!(!del_file.exists());

                let del_diff = get_git_diff(project_dir.to_str().unwrap().to_string(), "to_delete.txt".to_string()).await.unwrap();
                assert!(del_diff.diff.contains("-content to be deleted"));

                // 4. Test nested untracked directory and file with spaces
                let sub_dir = project_dir.join("subdir");
                let _ = std::fs::create_dir_all(&sub_dir);
                let nested_file = sub_dir.join("nested space.txt");
                let _ = std::fs::write(&nested_file, "nested content\n");

                let st = get_git_status_internal(&project_dir).await.unwrap();
                let has_nested = st.changes.iter().any(|c| c.path == "subdir/nested space.txt" && c.status == "untracked");
                assert!(has_nested, "git status must list individual untracked files instead of collapsing directories");

                let nested_diff = get_git_diff(project_dir.to_str().unwrap().to_string(), "subdir/nested space.txt".to_string()).await.unwrap();
                assert!(nested_diff.diff.contains("+nested content"));

                // 5. Test unrecognized file rejection
                let unrec_res = get_git_diff(project_dir.to_str().unwrap().to_string(), "never_existed.txt".to_string()).await;
                assert!(unrec_res.is_err());
            }
        }

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_git_status_disables_fsmonitor() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_fsmonitor_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(test_id);
        let _ = std::fs::create_dir_all(&project_dir);

        let init_status = std::process::Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&project_dir)
            .status();

        if let Ok(st) = init_status {
            if st.success() {
                let marker_path = project_dir.join("fsmonitor_invoked.marker");
                let hook_path = project_dir.join("dummy_fsmonitor.sh");

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let script = format!("#!/bin/sh\necho invoked >> \"{}\"\nexit 0\n", marker_path.display());
                    let _ = std::fs::write(&hook_path, script);
                    let mut perms = std::fs::metadata(&hook_path).unwrap().permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&hook_path, perms);

                    let _ = std::process::Command::new("git")
                        .args(["config", "core.fsmonitor", hook_path.to_str().unwrap()])
                        .current_dir(&project_dir)
                        .status();

                    let status_res = get_git_status_internal(&project_dir).await;
                    assert!(status_res.is_ok(), "git status must succeed even when fsmonitor hook is configured");
                    assert!(
                        !marker_path.exists(),
                        "git status must not trigger external fsmonitor helper"
                    );
                }
            }
        }

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_git_diff_literal_pathspec_magic() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_magic_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(test_id);
        let _ = std::fs::create_dir_all(&project_dir);

        let init_status = std::process::Command::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(&project_dir)
            .status();

        if let Ok(st) = init_status {
            if st.success() {
                let _ = std::process::Command::new("git")
                    .args(["config", "user.name", "TestUser"])
                    .current_dir(&project_dir)
                    .status();
                let _ = std::process::Command::new("git")
                    .args(["config", "user.email", "test@example.com"])
                    .current_dir(&project_dir)
                    .status();

                let sub_dir = project_dir.join("sub");
                let _ = std::fs::create_dir_all(&sub_dir);

                let root_target = project_dir.join("target.txt");
                let _ = std::fs::write(&root_target, "root target\n");

                let magic_file = sub_dir.join(":(top)target.txt");
                let _ = std::fs::write(&magic_file, "magic target\n");

                let _ = std::process::Command::new("git")
                    .args(["add", "."])
                    .current_dir(&project_dir)
                    .status();
                let _ = std::process::Command::new("git")
                    .args(["commit", "-m", "init"])
                    .current_dir(&project_dir)
                    .status();

                // Modify both files
                let _ = std::fs::write(&root_target, "root target modified\n");
                let _ = std::fs::write(&magic_file, "magic target modified\n");

                // Diff for the magic file must NOT resolve to root target.txt
                let diff_res = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "sub/:(top)target.txt".to_string(),
                )
                .await
                .unwrap();

                assert!(
                    diff_res.diff.contains("magic target modified"),
                    "Diff must target the literal :(top)target.txt file"
                );
                assert!(
                    !diff_res.diff.contains("root target modified"),
                    "Diff must not select root target.txt via pathspec magic"
                );

                // Clean tracked file with pathspec magic in name:
                let clean_magic = sub_dir.join(":(top)clean.txt");
                let _ = std::fs::write(&clean_magic, "clean magic\n");
                let _ = std::process::Command::new("git")
                    .args(["add", "."])
                    .current_dir(&project_dir)
                    .status();
                let _ = std::process::Command::new("git")
                    .args(["commit", "-m", "add clean magic"])
                    .current_dir(&project_dir)
                    .status();

                let clean_diff = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "sub/:(top)clean.txt".to_string(),
                )
                .await
                .unwrap();

                assert_eq!(
                    clean_diff.diff,
                    "No differences found between working file and Git repository."
                );
            }
        }

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_preserves_project_files_without_committing() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_init_test_{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(test_id);
        std::fs::create_dir_all(project_dir.join("figures")).unwrap();
        std::fs::write(project_dir.join("main.tex"), "\\documentclass{article}\n").unwrap();
        std::fs::write(project_dir.join("figures/draft.tex"), "draft\n").unwrap();

        let result = initialize_git_repository(project_dir.to_string_lossy().to_string())
            .await
            .unwrap();

        assert!(result.git_available);
        assert!(result.git_version.as_deref().unwrap().starts_with("git version "));
        assert!(result.is_git_repo);
        assert_eq!(std::fs::read_to_string(project_dir.join("main.tex")).unwrap(), "\\documentclass{article}\n");
        assert_eq!(std::fs::read_to_string(project_dir.join("figures/draft.tex")).unwrap(), "draft\n");
        assert!(result.changes.iter().any(|change| change.path == "main.tex" && change.status == "untracked"));
        assert!(result.changes.iter().any(|change| change.path == "figures/draft.tex" && change.status == "untracked"));

        let local_config = std::fs::read_to_string(project_dir.join(".git/config")).unwrap();
        assert!(!local_config.contains("remote \""));
        assert!(!local_config.contains("user \""));
        let commit_result = std::process::Command::new("git")
            .args(["-C", project_dir.to_str().unwrap(), "rev-parse", "--verify", "HEAD"])
            .output()
            .unwrap();
        assert!(!commit_result.status.success(), "initialization must not create a commit");

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_list_git_branches_includes_unborn_current_branch() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_unborn_branch_test_{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(test_id);
        std::fs::create_dir_all(&project_dir).unwrap();

        initialize_git_repository(project_dir.to_string_lossy().to_string()).await.unwrap();
        let symbolic = git_command(&project_dir, &["symbolic-ref", "--short", "HEAD"]).output().await.unwrap();
        assert!(symbolic.status.success());
        let current_branch = String::from_utf8_lossy(&symbolic.stdout).trim().to_string();

        let branches = list_git_branches(project_dir.to_string_lossy().to_string()).await.unwrap();
        assert_eq!(branches.current_branch.as_deref(), Some(current_branch.as_str()));
        assert!(branches.branches.contains(&current_branch));
        assert!(!project_dir.join(".git/refs/heads").join(&current_branch).exists(), "the test must cover an uncommitted branch without a ref");

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_does_not_create_nested_repository() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_parent_git_test_{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let parent_dir = base_temp.join(test_id);
        let project_dir = parent_dir.join("project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let init = std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg("--template=")
            .current_dir(&parent_dir)
            .status()
            .unwrap();
        assert!(init.success());

        let result = initialize_git_repository(project_dir.to_string_lossy().to_string())
            .await
            .unwrap();

        assert!(result.is_git_repo, "the parent repository should be detected");
        assert!(!project_dir.join(".git").exists(), "initialization must not create a nested .git directory");
        let _ = std::fs::remove_dir_all(&parent_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_rejects_existing_unusable_git_metadata() {
        let base_temp = std::env::temp_dir();
        let test_id = format!("sciencebatch_invalid_git_test_{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let project_dir = base_temp.join(test_id);
        std::fs::create_dir_all(project_dir.join(".git")).unwrap();
        std::fs::write(project_dir.join(".git/invalid"), "user data\n").unwrap();

        let result = initialize_git_repository(project_dir.to_string_lossy().to_string()).await;
        assert!(result.is_err(), "unusable Git metadata must be reported instead of replaced");
        assert!(project_dir.join(".git/invalid").exists(), "existing metadata must be preserved");

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_rejects_invalid_project_path() {
        let missing = std::env::temp_dir().join(format!(
            "sciencebatch_missing_project_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let result = initialize_git_repository(missing.to_string_lossy().to_string()).await;
        assert!(result.is_err());
    }
}
