use std::collections::HashMap;
use std::io;
use std::path::{Component, Path};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tauri::command;
use tauri::Emitter;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::types::{
    GitBranchListResult, GitBranchSwitchResult, GitCloneResult, GitDiffResult, GitFileChange,
    GitIdentity, GitOperationError, GitOperationProgressPayload, GitOperationResult, GitRemoteInfo,
    GitRepositoryInfo, GitStatusResult,
};

const MAX_DIFF_FILE_BYTES: u64 = 8 * 1024 * 1024; // 8 MB
const MAX_DIFF_LINES: usize = 2000;
const GIT_OPERATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Run a Git subprocess with a hard deadline, including inherited pipes held by hooks or helpers.
async fn bounded_command_output(
    mut command: Command,
    timeout: Duration,
) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn()?;
    let process_id = child.id();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let mut stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });

    let result = tokio::time::timeout(timeout, async {
        let status = child.wait().await?;
        let stdout = (&mut stdout_task)
            .await
            .map_err(|error| io::Error::other(format!("Failed to join stdout reader: {error}")))??;
        let stderr = (&mut stderr_task)
            .await
            .map_err(|error| io::Error::other(format!("Failed to join stderr reader: {error}")))??;
        Ok::<_, io::Error>(Output {
            status,
            stdout,
            stderr,
        })
    })
    .await;

    match result {
        Ok(output) => output,
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = process_id {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            if let Some(pid) = process_id {
                terminate_git_process_tree(pid).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("Git command timed out after {} seconds.", timeout.as_secs()),
            ))
        }
    }
}
static REPOSITORY_LOCKS: OnceLock<StdMutex<HashMap<std::path::PathBuf, Arc<AsyncMutex<()>>>>> =
    OnceLock::new();
static UNKNOWN_PUSH_RESULTS: OnceLock<
    StdMutex<HashMap<std::path::PathBuf, std::collections::HashSet<String>>>,
> = OnceLock::new();

fn operation_error(
    code: &str,
    message: impl Into<String>,
    recovery: Option<&str>,
    partial_path: Option<String>,
    outcome_unknown: bool,
) -> GitOperationError {
    GitOperationError {
        code: code.to_string(),
        message: message.into(),
        recovery: recovery.map(str::to_string),
        partial_path,
        outcome_unknown,
    }
}

async fn repository_lock_key(
    project: &Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let root_output = safe_git_output(project, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|error| format!("Failed to locate the Git repository: {error}"))?;
    if !root_output.status.success() {
        return Err("Project is not a Git repository.".to_string());
    }
    let root = std::path::PathBuf::from(String::from_utf8_lossy(&root_output.stdout).trim())
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the Git repository root: {error}"))?;
    let common_output = safe_git_output(
        project,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await
    .map_err(|error| format!("Failed to locate Git metadata: {error}"))?;
    let common = if common_output.status.success() {
        std::path::PathBuf::from(String::from_utf8_lossy(&common_output.stdout).trim())
            .canonicalize()
            .unwrap_or(root.clone())
    } else {
        root.clone()
    };
    Ok((root, common))
}

async fn try_repository_lock(
    project: &Path,
) -> Result<(std::path::PathBuf, OwnedMutexGuard<()>), GitOperationError> {
    let (root, key) = repository_lock_key(project)
        .await
        .map_err(|message| operation_error("RepositoryUnavailable", message, None, None, false))?;
    let guard = try_lock_key(&key)?;
    Ok((root, guard))
}

pub(crate) async fn workspace_repository_guard(
    project: &Path,
) -> Result<Option<OwnedMutexGuard<()>>, GitOperationError> {
    match repository_lock_key(project).await {
        Ok((_, key)) => try_lock_key(&key).map(Some),
        Err(message) if message == "Project is not a Git repository." => Ok(None),
        Err(message) => Err(operation_error(
            "RepositoryUnavailable",
            message,
            None,
            None,
            false,
        )),
    }
}

fn try_lock_key(key: &Path) -> Result<OwnedMutexGuard<()>, GitOperationError> {
    let locks = REPOSITORY_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let lock = {
        let mut locks = locks.lock().expect("Git lock registry poisoned");
        locks
            .entry(key.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    match lock.try_lock_owned() {
        Ok(guard) => Ok(guard),
        Err(_) => Err(operation_error(
            "Busy",
            "Another Git operation is already running for this repository.",
            Some("Wait for it to finish, then refresh the repository status."),
            None,
            false,
        )),
    }
}

/// Return the installed Git version, or None when the executable is unavailable.
async fn detect_git_version() -> Result<Option<String>, String> {
    let mut command = Command::new("git");
    command.arg("--version").env("LC_ALL", "C").stdin(Stdio::null());
    let output = match bounded_command_output(command, GIT_OPERATION_TIMEOUT).await {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to check Git availability: {error}")),
    };

    if !output.status.success() {
        let details = sanitize_git_output(String::from_utf8_lossy(&output.stderr).trim());
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
        diff.push_str(&format!(
            "\n... [Diff truncated: showing {} of {} lines]\n",
            MAX_DIFF_LINES, line_count
        ));
    }

    diff
}

/// Truncate long diffs if they exceed line bounds
pub fn truncate_diff_if_needed(diff: String) -> String {
    let lines: Vec<&str> = diff.lines().collect();
    if lines.len() <= MAX_DIFF_LINES {
        return diff;
    }

    let mut truncated = lines
        .into_iter()
        .take(MAX_DIFF_LINES)
        .collect::<Vec<&str>>()
        .join("\n");
    truncated.push_str(&format!(
        "\n... [Diff truncated: exceeds {} lines display limit]\n",
        MAX_DIFF_LINES
    ));
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
    cmd.arg("-c")
        .arg("core.fsmonitor=false")
        .arg("--no-optional-locks")
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
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    clear_git_location_overrides(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn git diff: {e}"))?;
    let process_id = child.id();

    let mut stdout = child.stdout.take().expect("piped Git diff stdout");
    let result = tokio::time::timeout(GIT_OPERATION_TIMEOUT, async {
        let mut stdout_buf = Vec::new();
        let mut oversized = false;
        let mut chunk = [0u8; 8192];
        loop {
            let n = match stdout.read(&mut chunk).await {
                Ok(n) => n,
                Err(_) => break,
            };
            if n == 0 {
                break;
            }
            if stdout_buf.len() + n > max_bytes {
                let remaining = max_bytes.saturating_sub(stdout_buf.len());
                stdout_buf.extend_from_slice(&chunk[..remaining]);
                oversized = true;
                let _ = child.kill().await;
                break;
            }
            stdout_buf.extend_from_slice(&chunk[..n]);
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, stdout_buf, oversized))
    })
    .await;
    let (status, stdout_buf, oversized) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => return Err(format!("Git diff process error: {error}")),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = process_id {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            if let Some(pid) = process_id {
                terminate_git_process_tree(pid).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("Git diff command timed out after five minutes.".to_string());
        }
    };

    if !status.success() && !oversized && stdout_buf.is_empty() {
        return Err("Git diff command failed".to_string());
    }

    let is_binary = is_binary_buffer(&stdout_buf);
    let stdout_str = String::from_utf8_lossy(&stdout_buf).to_string();

    if is_binary || (stdout_str.contains("Binary files ") && stdout_str.contains(" differ")) {
        return Ok((
            "Binary file not shown in diff viewer.".to_string(),
            true,
            oversized,
        ));
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
    let output = match bounded_command_output(status_command, GIT_OPERATION_TIMEOUT).await {
        Ok(out) => out,
        Err(e) => {
            return Err(format!(
                "Git is available, but its status command could not start: {e}"
            ));
        }
    };

    if !output.status.success() {
        let stderr = sanitize_git_output(String::from_utf8_lossy(&output.stderr).trim());
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
        return Err(
            "The selected project folder does not exist or is not a directory.".to_string(),
        );
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
        return Err(format!(
            "Cannot initialize Git because repository status failed: {error}"
        ));
    }

    if std::fs::symlink_metadata(project_path.join(".git")).is_ok() {
        return Err("The selected folder already contains Git metadata that is not usable as a repository. Git was not initialized.".to_string());
    }

    let _repository_guard = try_lock_key(&project_path).map_err(|error| error.message)?;

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
    let output = bounded_command_output(init_command, GIT_OPERATION_TIMEOUT)
        .await
        .map_err(|error| format!("Failed to start Git initialization: {error}"))?;

    if !output.status.success() {
        let details = sanitize_git_output(String::from_utf8_lossy(&output.stderr).trim());
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
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve project directory: {error}"))
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
                    return Err(
                        "File paths must stay inside the selected project directory.".to_string(),
                    );
                }
                _ => {}
            }
        }
        if relative.as_os_str().is_empty() || relative == Path::new(".") {
            return Err(
                "The project directory itself cannot be staged as a file path.".to_string(),
            );
        }

        let mut probe = project.join(relative);
        while !probe.exists() && !std::fs::symlink_metadata(&probe).is_ok() {
            if !probe.pop() || !probe.starts_with(project) {
                return Err("File path escapes the selected project directory.".to_string());
            }
        }
        if let Ok(resolved) = probe.canonicalize() {
            if !resolved.starts_with(project) {
                return Err(
                    "File path escapes the selected project directory through a symlink."
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn git_command(project: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args(args)
        .current_dir(project)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    command.kill_on_drop(true);
    clear_git_location_overrides(&mut command);
    command
}

async fn safe_git_output(project: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    bounded_command_output(git_command(project, args), GIT_OPERATION_TIMEOUT)
        .await
        .map_err(|error| format!("Failed to start Git: {error}"))
}

async fn safe_git_action(
    project: &Path,
    args: &[&str],
    action: &str,
) -> Result<(), GitOperationError> {
    let output = safe_git_output(project, args)
        .await
        .map_err(|message| operation_error("GitFailed", message, None, None, false))?;
    if output.status.success() {
        return Ok(());
    }
    let details = sanitize_git_output(String::from_utf8_lossy(&output.stderr).trim());
    Err(operation_error(
        "GitFailed",
        if details.is_empty() {
            format!("Git {action} failed.")
        } else {
            format!("Git {action} failed: {details}")
        },
        None,
        None,
        false,
    ))
}

fn emit_git_progress(
    app: Option<&tauri::AppHandle>,
    operation_id: &str,
    root: Option<&Path>,
    operation: &str,
    status: &str,
    message: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "git-operation-progress",
            GitOperationProgressPayload {
                operation_id: operation_id.to_string(),
                repository_root: root.map(|path| path.to_string_lossy().into_owned()),
                operation: operation.to_string(),
                status: status.to_string(),
                message: sanitize_git_output(message),
            },
        );
    }
}

fn sanitize_git_output(value: &str) -> String {
    let words: Vec<&str> = value.split_whitespace().collect();
    let mut safe_words = Vec::new();
    let mut index = 0;
    while index < words.len() {
        let token = words[index];
        if token
            .trim_end_matches(':')
            .eq_ignore_ascii_case("authorization")
            && words
                .get(index + 1)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
        {
            safe_words.push("Authorization: Bearer [redacted]".to_string());
            index = (index + 3).min(words.len());
            continue;
        }
        let marker = token.find("://");
        let has_url = marker.is_some();
        let prefix = marker
            .map(|index| token[..index].to_ascii_lowercase())
            .unwrap_or_default();
        let is_http = prefix.contains("https") || prefix.contains("http");
        let is_ssh = prefix.contains("ssh");
        let userinfo = marker.and_then(|marker| {
            let authority_start = marker + 3;
            let authority_end = token[authority_start..]
                .find(&['/', '?', '#'][..])
                .map(|offset| authority_start + offset)
                .unwrap_or(token.len());
            let authority = &token[authority_start..authority_end];
            authority
                .rfind('@')
                .filter(|at| is_http || (is_ssh && authority[..*at].contains(':')))
        });
        let sensitive_query = token
            .split_once('?')
            .map(|(_, query)| {
                query.split('&').any(|pair| {
                    let key = pair
                        .split('=')
                        .next()
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    ["token", "access_token", "private_token", "auth"].contains(&key.as_str())
                })
            })
            .unwrap_or(false);
        let safe = if has_url
            && (userinfo.is_some() || sensitive_query || (is_http && token.contains(['?', '#'])))
        {
            "[redacted-url]".to_string()
        } else if !has_url {
            let lowered = token.to_ascii_lowercase();
            let has_sensitive_key = lowered.split('&').any(|pair| {
                let key = pair.split('=').next().unwrap_or_default();
                ["token", "access_token", "private_token", "auth"].contains(&key)
            });
            if has_sensitive_key {
                "[redacted]".to_string()
            } else {
                token.to_string()
            }
        } else {
            token.to_string()
        };
        safe_words.push(safe);
        index += 1;
    }
    safe_words.join(" ")
}

async fn run_git_operation(
    app: Option<tauri::AppHandle>,
    project: &Path,
    operation_id: &str,
    operation: &str,
    args: &[String],
    push_timeout_unknown: bool,
    push_destination: Option<String>,
) -> Result<String, GitOperationError> {
    run_git_operation_with_timeout(
        app,
        project,
        operation_id,
        operation,
        args,
        push_timeout_unknown,
        push_destination,
        GIT_OPERATION_TIMEOUT,
    )
    .await
}

async fn run_git_operation_with_timeout(
    app: Option<tauri::AppHandle>,
    project: &Path,
    operation_id: &str,
    operation: &str,
    args: &[String],
    push_timeout_unknown: bool,
    push_destination: Option<String>,
    timeout: Duration,
) -> Result<String, GitOperationError> {
    let ssh_required = operation_uses_ssh(project, operation, args).await;
    let configured_ssh = if !ssh_required {
        None
    } else if let Ok(command) = std::env::var("GIT_SSH_COMMAND") {
        Some(command)
    } else {
        safe_git_output(project, &["config", "--get", "core.sshCommand"])
            .await
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|command| !command.is_empty())
    };
    let ssh_command = if let Some(configured) = configured_ssh {
        let (program, options) = configured
            .split_once(char::is_whitespace)
            .unwrap_or((&configured, ""));
        if !Path::new(program)
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("ssh"))
        {
            return Err(operation_error("UnsupportedSSHCommand", "The configured SSH command cannot enforce non-interactive authentication and strict host verification.", Some("Configure OpenSSH as the Git SSH command or use a credential manager."), None, false));
        }
        format!("{program} -o BatchMode=yes -o StrictHostKeyChecking=yes {options}")
            .trim()
            .to_string()
    } else if ssh_required {
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes".to_string()
    } else {
        String::new()
    };
    emit_git_progress(
        app.as_ref(),
        operation_id,
        Some(project),
        operation,
        "started",
        "Starting Git operation.",
    );
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args(args)
        .current_dir(project)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "false")
        .env("SSH_ASKPASS", "false")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    clear_git_location_overrides(&mut command);
    if !ssh_command.is_empty() {
        command.env("GIT_SSH_COMMAND", ssh_command);
    }
    let mut child = command.spawn().map_err(|error| {
        operation_error(
            "GitUnavailable",
            format!("Failed to start Git {operation}: {error}"),
            None,
            None,
            false,
        )
    })?;
    let process_id = child.id();
    let mut stdout = child.stdout.take().expect("piped Git stdout");
    let mut stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr = child.stderr.take().expect("piped Git stderr");
    let app_for_stderr = app.clone();
    let op_id = operation_id.to_string();
    let operation_name = operation.to_string();
    let project_root = project.to_path_buf();
    let mut stderr_task = tokio::spawn(async move {
        let mut reader = stderr;
        let mut saved = String::new();
        let mut pending = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = match reader.read(&mut chunk).await {
                Ok(read) => read,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }
            for &byte in &chunk[..read] {
                if byte == b'\n' || byte == b'\r' {
                    if pending.is_empty() {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&pending).to_string();
                    if saved.len() < 64 * 1024 {
                        saved.push_str(&line);
                        saved.push('\n');
                    }
                    emit_git_progress(
                        app_for_stderr.as_ref(),
                        &op_id,
                        Some(&project_root),
                        &operation_name,
                        "progress",
                        &line,
                    );
                    pending.clear();
                } else if pending.len() < 4096 {
                    pending.push(byte);
                }
            }
        }
        if !pending.is_empty() {
            let line = String::from_utf8_lossy(&pending).to_string();
            if saved.len() < 64 * 1024 {
                saved.push_str(&line);
            }
            emit_git_progress(
                app_for_stderr.as_ref(),
                &op_id,
                Some(&project_root),
                &operation_name,
                "progress",
                &line,
            );
        }
        saved
    });
    let joined = tokio::time::timeout(timeout, async {
        let (status, stdout_bytes, stderr_text) =
            tokio::join!(child.wait(), &mut stdout_task, &mut stderr_task);
        (status, stdout_bytes, stderr_text)
    })
    .await;
    let (status, stdout_bytes, stderr_text) = match joined {
        Ok((status, stdout_bytes, stderr_text)) => (
            status.map_err(|error| {
                operation_error(
                    "GitFailed",
                    format!("Failed while waiting for Git {operation}: {error}"),
                    None,
                    None,
                    false,
                )
            })?,
            stdout_bytes
                .map_err(|error| {
                    operation_error(
                        "GitFailed",
                        format!("Failed to read Git {operation} output: {error}"),
                        None,
                        None,
                        false,
                    )
                })?
                .map_err(|error| {
                    operation_error(
                        "GitFailed",
                        format!("Failed to read Git {operation} output: {error}"),
                        None,
                        None,
                        false,
                    )
                })?,
            stderr_text.unwrap_or_default(),
        ),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = process_id {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            if let Some(pid) = process_id {
                terminate_git_process_tree(pid).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            let unknown = push_timeout_unknown && operation == "push";
            if unknown {
                if let Ok((_, key)) = repository_lock_key(project).await {
                    if let Some(destination) = push_destination.clone() {
                        UNKNOWN_PUSH_RESULTS
                            .get_or_init(|| StdMutex::new(HashMap::new()))
                            .lock()
                            .unwrap()
                            .entry(key)
                            .or_default()
                            .insert(destination);
                    }
                }
            }
            return Err(operation_error(
                "Timeout",
                format!("Git {operation} timed out after five minutes."),
                Some(if unknown {
                    "The remote may have received the push. Run Fetch to reconcile repository status before retrying."
                } else {
                    "Retry after checking repository and network status."
                }),
                None,
                unknown,
            ));
        }
    };
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    if status.success() {
        emit_git_progress(
            app.as_ref(),
            operation_id,
            Some(project),
            operation,
            "completed",
            "Git operation completed.",
        );
        return Ok(sanitize_git_output(&stdout));
    }
    let details = sanitize_git_output(stderr_text.trim());
    emit_git_progress(
        app.as_ref(),
        operation_id,
        Some(project),
        operation,
        "failed",
        &details,
    );
    let lower_details = details.to_ascii_lowercase();
    if operation == "pull"
        && (lower_details.contains("fast-forward") || lower_details.contains("divergent branches"))
    {
        return Err(operation_error(
            "Diverged",
            "Local and upstream histories have diverged and Git cannot fast-forward this branch.",
            Some("Resolve the history with Git outside ScienceBatch, then fetch and retry."),
            None,
            false,
        ));
    }
    if [
        "authentication failed",
        "could not read username",
        "permission denied (publickey)",
        "host key verification failed",
        "terminal prompts disabled",
    ]
    .iter()
    .any(|detail| lower_details.contains(detail))
    {
        return Err(operation_error(
            "AuthenticationFailed",
            "Git could not authenticate to the remote service.",
            Some("Configure an HTTPS credential manager or SSH keys and known hosts outside ScienceBatch, then retry."),
            None,
            false,
        ));
    }
    let message = if details.is_empty() {
        format!("Git {operation} failed.")
    } else {
        format!("Git {operation} failed: {details}")
    };
    Err(operation_error(
        "GitFailed",
        message,
        Some("Check the repository status and configured credentials, then retry."),
        None,
        false,
    ))
}

async fn operation_uses_ssh(project: &Path, operation: &str, args: &[String]) -> bool {
    let mut urls = Vec::new();
    if operation == "clone" {
        if let Some(url) = args
            .iter()
            .position(|arg| arg == "--")
            .and_then(|position| args.get(position + 1))
        {
            urls.push(url.clone());
        }
    } else if operation == "fetch" || operation == "push" {
        if let Some(remote) = args
            .iter()
            .position(|arg| arg == "--")
            .and_then(|position| args.get(position + 1))
        {
            if let Ok((fetch, push)) = remote_raw_urls(project, remote).await {
                if operation == "fetch" {
                    urls.extend(fetch);
                } else if push.is_empty() {
                    urls.extend(fetch);
                } else {
                    urls.extend(push);
                }
            }
        }
    } else if operation == "pull" {
        if let Ok((info, _)) = repository_info_for(project.to_string_lossy().as_ref()).await {
            if let Some(remote) = info.upstream_remote {
                if let Ok((fetch, _)) = remote_raw_urls(project, &remote).await {
                    urls.extend(fetch);
                }
            }
        }
    }
    urls.iter()
        .any(|url| url.starts_with("ssh://") || (url.contains(':') && !url.contains("://")))
}

#[cfg(windows)]
async fn terminate_git_process_tree(pid: u32) {
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), command.output()).await;
}

async fn run_git_action(project: &Path, args: &[&str], action: &str) -> Result<(), String> {
    let output = bounded_command_output(git_command(project, args), GIT_OPERATION_TIMEOUT)
        .await
        .map_err(|error| format!("Failed to start Git {action}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let details = sanitize_git_output(String::from_utf8_lossy(&output.stderr).trim());
    Err(if details.is_empty() {
        format!("Git {action} failed.")
    } else {
        format!("Git {action} failed: {details}")
    })
}

#[command]
pub async fn list_git_branches(project_path: String) -> Result<GitBranchListResult, String> {
    let project = require_git_project(&project_path).await?;
    let status = get_git_status_internal(&project).await?;
    let output = bounded_command_output(git_command(
        &project,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    ), GIT_OPERATION_TIMEOUT)
    .await
    .map_err(|error| format!("Failed to list Git branches: {error}"))?;
    if !output.status.success() {
        return Err("Git could not list local branches.".to_string());
    }
    let mut branches: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
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
pub async fn switch_git_branch(
    project_path: String,
    branch: String,
    create: bool,
) -> Result<GitBranchSwitchResult, String> {
    let project = require_git_project(&project_path).await?;
    let _repository_guard = try_repository_lock(&project)
        .await
        .map_err(|error| error.message)?;
    if branch.is_empty() || branch.contains('\0') || branch.contains('\n') || branch.contains('\r')
    {
        return Err("Branch name is invalid.".to_string());
    }
    let check = bounded_command_output(
        git_command(&project, &["check-ref-format", "--branch", &branch]),
        GIT_OPERATION_TIMEOUT,
    )
        .await
        .map_err(|error| format!("Failed to validate Git branch name: {error}"))?;
    if !check.status.success() {
        return Err("Branch name is invalid.".to_string());
    }
    if create {
        run_git_action(&project, &["switch", "-c", &branch], "branch switch").await?;
    } else {
        run_git_action(&project, &["switch", "--", &branch], "branch switch").await?;
    }
    Ok(GitBranchSwitchResult {
        branch,
        created: create,
    })
}

async fn change_git_index(
    project_path: String,
    paths: Vec<String>,
    stage: bool,
) -> Result<(), String> {
    let project = require_git_project(&project_path).await?;
    let _repository_guard = try_repository_lock(&project)
        .await
        .map_err(|error| error.message)?;
    validate_git_paths(&project, &paths)?;
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("--literal-pathspecs")
        .current_dir(&project)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    clear_git_location_overrides(&mut command);
    if stage {
        command.arg("add").arg("--").args(&paths);
    } else {
        let has_head = bounded_command_output(
            git_command(&project, &["rev-parse", "--verify", "HEAD"]),
            GIT_OPERATION_TIMEOUT,
        )
            .await
            .map(|output| output.status.success())
            .unwrap_or(false);
        if has_head {
            command
                .args(["restore", "--staged", "--source=HEAD", "--"])
                .args(&paths);
        } else {
            command
                .args(["rm", "--cached", "-r", "--ignore-unmatch", "--"])
                .args(&paths);
        }
    }
    let output = bounded_command_output(command, GIT_OPERATION_TIMEOUT).await.map_err(|error| {
        format!(
            "Failed to start Git {}: {error}",
            if stage { "stage" } else { "unstage" }
        )
    })?;
    if output.status.success() {
        return Ok(());
    }
    let detail = sanitize_git_output(String::from_utf8_lossy(&output.stderr).trim());
    Err(if detail.is_empty() {
        format!("Git {} failed.", if stage { "stage" } else { "unstage" })
    } else {
        detail
    })
}

#[command]
pub async fn stage_git_files(project_path: String, paths: Vec<String>) -> Result<(), String> {
    change_git_index(project_path, paths, true).await
}

#[command]
pub async fn unstage_git_files(project_path: String, paths: Vec<String>) -> Result<(), String> {
    change_git_index(project_path, paths, false).await
}

async fn git_config_value(project: &Path, scope: &[&str], key: &str) -> Option<String> {
    let mut args = vec!["config"];
    args.extend_from_slice(scope);
    args.extend(["--get", key]);
    let output = safe_git_output(project, &args).await.ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn valid_identity(name: Option<&str>, email: Option<&str>) -> bool {
    matches!((name, email), (Some(name), Some(email)) if !name.trim().is_empty() && !name.chars().any(|character| character.is_control() || matches!(character, '<' | '>')) && !email.chars().any(|character| character.is_control() || character.is_whitespace() || matches!(character, '<' | '>')) && email.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty() && !domain.contains('@') && domain.contains('.')))
}

async fn git_marker_exists(root: &Path, marker: &str) -> bool {
    let output = match safe_git_output(root, &["rev-parse", "--git-path", marker]).await {
        Ok(output) if output.status.success() => output,
        _ => return false,
    };
    let path_text = String::from_utf8_lossy(&output.stdout);
    let path = Path::new(path_text.trim());
    if path.is_absolute() {
        path.exists()
    } else {
        root.join(path).exists()
    }
}

async fn repository_info_for(
    project_path: &str,
) -> Result<(GitRepositoryInfo, std::path::PathBuf), GitOperationError> {
    let project = canonical_project(project_path)
        .map_err(|message| operation_error("RepositoryUnavailable", message, None, None, false))?;
    let (root, key) = repository_lock_key(&project)
        .await
        .map_err(|message| operation_error("RepositoryUnavailable", message, None, None, false))?;
    let head = safe_git_output(&root, &["rev-parse", "--verify", "HEAD"])
        .await
        .map_err(|error| {
            operation_error(
                "GitFailed",
                format!("Failed to inspect Git history: {error}"),
                None,
                None,
                false,
            )
        })?;
    let has_commits = head.status.success();
    let (branch, detached) = if has_commits {
        let branch_output = safe_git_output(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .map_err(|error| {
                operation_error(
                    "GitFailed",
                    format!("Failed to inspect the current branch: {error}"),
                    None,
                    None,
                    false,
                )
            })?;
        if branch_output.status.success() {
            (
                Some(
                    String::from_utf8_lossy(&branch_output.stdout)
                        .trim()
                        .to_string(),
                ),
                false,
            )
        } else {
            (None, true)
        }
    } else {
        let branch_output = safe_git_output(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .ok();
        (
            branch_output
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string()),
            false,
        )
    };
    let status = safe_git_output(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await
    .map_err(|error| {
        operation_error(
            "GitFailed",
            format!("Failed to inspect Git changes: {error}"),
            None,
            None,
            false,
        )
    })?;
    if !status.status.success() {
        return Err(operation_error(
            "GitFailed",
            "Git could not inspect repository changes.",
            None,
            None,
            false,
        ));
    }
    let (_, _, changes) = parse_git_status_output_nul(&status.stdout);
    let has_staged_changes = changes.iter().any(|change| change.staged);
    let worktree_clean = changes.is_empty();
    let configured_name = std::env::var("GIT_AUTHOR_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or(git_config_value(&root, &[], "user.name").await);
    let configured_email = std::env::var("GIT_AUTHOR_EMAIL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or(git_config_value(&root, &[], "user.email").await);
    let identity = GitIdentity {
        valid: valid_identity(configured_name.as_deref(), configured_email.as_deref()),
        name: configured_name,
        email: configured_email,
    };

    let remote_names = safe_git_output(&root, &["remote"]).await.map_err(|error| {
        operation_error(
            "GitFailed",
            format!("Failed to list Git remotes: {error}"),
            None,
            None,
            false,
        )
    })?;
    let mut remotes = Vec::new();
    if remote_names.status.success() {
        for name in String::from_utf8_lossy(&remote_names.stdout)
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            let fetch_output = safe_git_output(&root, &["remote", "get-url", "--all", name])
                .await
                .ok();
            let push_output =
                safe_git_output(&root, &["remote", "get-url", "--push", "--all", name])
                    .await
                    .ok();
            let fetch_url = fetch_output
                .filter(|output| output.status.success())
                .map(|output| sanitize_git_output(String::from_utf8_lossy(&output.stdout).trim()))
                .unwrap_or_default();
            let push_url = push_output
                .filter(|output| output.status.success())
                .map(|output| sanitize_git_output(String::from_utf8_lossy(&output.stdout).trim()))
                .unwrap_or_else(|| fetch_url.clone());
            remotes.push(GitRemoteInfo {
                name: name.to_string(),
                fetch_url,
                push_url,
            });
        }
    }
    let upstream_output = if has_commits {
        safe_git_output(
            &root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .await
        .ok()
    } else {
        None
    };
    let upstream = upstream_output
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let upstream_remote = if let Some(branch) = branch.as_deref() {
        git_config_value(&root, &[], &format!("branch.{branch}.remote")).await
    } else {
        None
    };
    let upstream_branch = if let Some(branch) = branch.as_deref() {
        git_config_value(&root, &[], &format!("branch.{branch}.merge"))
            .await
            .map(|value| {
                value
                    .strip_prefix("refs/heads/")
                    .unwrap_or(&value)
                    .to_string()
            })
    } else {
        None
    };
    let (ahead, behind) = if upstream.is_some() {
        let counts = safe_git_output(
            &root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )
        .await
        .ok();
        counts
            .filter(|output| output.status.success())
            .and_then(|output| {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut parts = text.split_whitespace();
                Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
            })
            .map(|(ahead, behind)| (Some(ahead), Some(behind)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    let push_refresh_required = UNKNOWN_PUSH_RESULTS
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .get(&key)
        .is_some_and(|destinations| !destinations.is_empty());
    Ok((
        GitRepositoryInfo {
            repository_root: root.to_string_lossy().into_owned(),
            identity,
            has_commits,
            has_staged_changes,
            worktree_clean,
            branch,
            detached,
            remotes,
            upstream,
            upstream_remote,
            upstream_branch,
            ahead,
            behind,
            push_refresh_required,
        },
        key,
    ))
}

#[command]
pub async fn get_git_repository_info(
    project_path: String,
) -> Result<GitRepositoryInfo, GitOperationError> {
    repository_info_for(&project_path)
        .await
        .map(|(info, _)| info)
}

#[command]
pub async fn set_git_identity(
    project_path: String,
    name: String,
    email: String,
) -> Result<GitIdentity, GitOperationError> {
    let (info, _) = repository_info_for(&project_path).await?;
    if !valid_identity(Some(&name), Some(&email)) {
        return Err(operation_error(
            "InvalidIdentity",
            "Enter a non-empty name and a valid email address.",
            None,
            None,
            false,
        ));
    }
    let root = Path::new(&info.repository_root);
    let _guard = try_repository_lock(root).await?;
    safe_git_action(
        root,
        &["config", "--local", "user.name", &name],
        "identity update",
    )
    .await?;
    safe_git_action(
        root,
        &["config", "--local", "user.email", &email],
        "identity update",
    )
    .await?;
    Ok(GitIdentity {
        name: Some(name),
        email: Some(email),
        valid: true,
    })
}

#[command]
pub async fn commit_git_changes(
    app: tauri::AppHandle,
    project_path: String,
    message: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    commit_git_changes_inner(Some(app), project_path, message, operation_id).await
}

async fn commit_git_changes_inner(
    app: Option<tauri::AppHandle>,
    project_path: String,
    message: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    let (info, _) = repository_info_for(&project_path).await?;
    let root = Path::new(&info.repository_root).to_path_buf();
    let (root, _guard) = try_repository_lock(&root).await?;
    if message.trim().is_empty() {
        return Err(operation_error(
            "EmptyMessage",
            "Enter a commit message.",
            None,
            None,
            false,
        ));
    }
    let current = repository_info_for(root.to_str().unwrap_or_default())
        .await?
        .0;
    if current.detached {
        return Err(operation_error(
            "DetachedHead",
            "Commits are disabled while HEAD is detached.",
            Some("Switch to a branch before committing."),
            None,
            false,
        ));
    }
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
        "rebase-merge",
        "rebase-apply",
    ] {
        if git_marker_exists(&root, marker).await {
            return Err(operation_error(
                "OperationInProgress",
                "A Git operation is in progress.",
                Some("Complete or abort the active operation in Git before committing."),
                None,
                false,
            ));
        }
    }
    let author = safe_git_output(&root, &["var", "GIT_AUTHOR_IDENT"])
        .await
        .ok()
        .is_some_and(|output| output.status.success());
    let committer = safe_git_output(&root, &["var", "GIT_COMMITTER_IDENT"])
        .await
        .ok()
        .is_some_and(|output| output.status.success());
    if !author || !committer || !current.identity.valid {
        return Err(operation_error(
            "InvalidIdentity",
            "Git author and committer name and email must be valid.",
            Some("Configure valid name and email values in this repository."),
            None,
            false,
        ));
    }
    if !current.has_staged_changes {
        return Err(operation_error(
            "NothingStaged",
            "There are no staged changes to commit.",
            Some("Stage the files you want to include, then try again."),
            None,
            false,
        ));
    }
    let result = run_git_operation(
        app,
        &root,
        &operation_id,
        "commit",
        &["commit".into(), "--message".into(), message]
            .into_iter()
            .collect::<Vec<_>>(),
        false,
        None,
    )
    .await?;
    let commit_id = safe_git_output(&root, &["rev-parse", "--short", "HEAD"])
        .await
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    Ok(GitOperationResult {
        message: sanitize_git_output(result.trim()),
        commit_id,
    })
}

fn validate_remote_name(name: &str) -> Result<(), GitOperationError> {
    if name.is_empty()
        || name.starts_with(['-', '.'])
        || name.ends_with('.')
        || name.contains("..")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(operation_error(
            "InvalidRemote",
            "Remote name is invalid.",
            None,
            None,
            false,
        ));
    }
    Ok(())
}

fn validate_remote_url(url: &str) -> Result<(), GitOperationError> {
    if url.is_empty()
        || url.starts_with('-')
        || url.chars().any(char::is_whitespace)
        || url.contains('\0')
    {
        return Err(operation_error(
            "InvalidRemoteUrl",
            "Enter a valid HTTPS or SSH repository URL.",
            None,
            None,
            false,
        ));
    }
    if let Some(rest) = url.strip_prefix("https://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.is_empty()
            || authority.contains('@')
            || rest.contains('?')
            || rest.contains('#')
        {
            return Err(operation_error("CredentialsInUrl", "HTTPS repository URLs must not contain user information, query parameters, or fragments.", Some("Use an HTTPS credential manager or configure SSH authentication outside ScienceBatch."), None, false));
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let (host, valid_user) = if let Some((user, host)) = authority.rsplit_once('@') {
            (
                host,
                !user.is_empty()
                    && !user.contains(':')
                    && user.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    }),
            )
        } else {
            (authority, true)
        };
        let path = rest
            .split_once('/')
            .map(|(_, path)| path)
            .unwrap_or_default();
        if host.is_empty()
            || !valid_user
            || path.is_empty()
            || rest.contains('?')
            || rest.contains('#')
        {
            return Err(operation_error(
                "InvalidRemoteUrl",
                "Enter a valid SSH repository URL without a password.",
                None,
                None,
                false,
            ));
        }
        return Ok(());
    }
    if url.contains("://") {
        return Err(operation_error(
            "InvalidRemoteUrl",
            "Only HTTPS and SSH repository URLs are supported.",
            None,
            None,
            false,
        ));
    }
    if let Some((authority, path)) = url.split_once(':') {
        let host = authority
            .rsplit_once('@')
            .map(|(_, host)| host)
            .unwrap_or(authority);
        let valid_host = host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        let valid_user = authority.rsplit_once('@').is_none_or(|(user, _)| {
            !user.is_empty()
                && user
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        });
        if valid_host
            && !host.is_empty()
            && !path.is_empty()
            && !path.starts_with(':')
            && !authority.contains('/')
            && valid_user
        {
            return Ok(());
        }
    }
    Err(operation_error(
        "InvalidRemoteUrl",
        "Enter a valid HTTPS or SSH repository URL.",
        None,
        None,
        false,
    ))
}

async fn remote_raw_urls(
    root: &Path,
    remote: &str,
) -> Result<(Vec<String>, Vec<String>), GitOperationError> {
    let fetch = safe_git_output(root, &["remote", "get-url", "--all", remote])
        .await
        .map_err(|error| {
            operation_error(
                "GitFailed",
                format!("Failed to read remote URL: {error}"),
                None,
                None,
                false,
            )
        })?;
    if !fetch.status.success() {
        return Err(operation_error(
            "UnknownRemote",
            format!("Git remote '{remote}' does not exist."),
            None,
            None,
            false,
        ));
    }
    let push = safe_git_output(root, &["remote", "get-url", "--push", "--all", remote])
        .await
        .map_err(|error| {
            operation_error(
                "GitFailed",
                format!("Failed to read remote push URL: {error}"),
                None,
                None,
                false,
            )
        })?;
    let parse = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    Ok((
        parse(&fetch.stdout),
        if push.status.success() {
            parse(&push.stdout)
        } else {
            Vec::new()
        },
    ))
}

#[command]
pub async fn set_git_remote(
    app: tauri::AppHandle,
    project_path: String,
    name: String,
    url: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    set_git_remote_inner(Some(app), project_path, name, url, operation_id).await
}

async fn set_git_remote_inner(
    app: Option<tauri::AppHandle>,
    project_path: String,
    name: String,
    url: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    validate_remote_name(&name)?;
    #[cfg(test)]
    if Path::new(&url).is_absolute() || url.starts_with("file://") {
        // Local URLs are available only to isolated Rust integration tests.
    } else {
        validate_remote_url(&url)?;
    }
    #[cfg(not(test))]
    validate_remote_url(&url)?;
    let (info, _) = repository_info_for(&project_path).await?;
    let root = Path::new(&info.repository_root).to_path_buf();
    let (_root, _guard) = try_repository_lock(&root).await?;
    let exists = safe_git_output(&root, &["remote", "get-url", &name])
        .await
        .ok()
        .is_some_and(|output| output.status.success());
    let args = if exists {
        vec!["remote".to_string(), "set-url".to_string(), name, url]
    } else {
        vec!["remote".to_string(), "add".to_string(), name, url]
    };
    let output = run_git_operation(app, &root, &operation_id, "remote", &args, false, None).await?;
    Ok(GitOperationResult {
        message: sanitize_git_output(output.trim()),
        commit_id: None,
    })
}

#[command]
pub async fn fetch_git_remote(
    app: tauri::AppHandle,
    project_path: String,
    remote: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    fetch_git_remote_inner(Some(app), project_path, remote, operation_id).await
}

async fn fetch_git_remote_inner(
    app: Option<tauri::AppHandle>,
    project_path: String,
    remote: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    validate_remote_name(&remote)?;
    let (info, _) = repository_info_for(&project_path).await?;
    let root = Path::new(&info.repository_root).to_path_buf();
    let (_root, guard) = try_repository_lock(&root).await?;
    let (fetch_urls, _push_urls) = remote_raw_urls(&root, &remote).await?;
    let args = vec![
        "-c".to_string(),
        "fetch.recurseSubmodules=false".to_string(),
        "fetch".to_string(),
        "--progress".to_string(),
        "--no-recurse-submodules".to_string(),
        "--".to_string(),
        remote.clone(),
    ];
    let output = run_git_operation(app, &root, &operation_id, "fetch", &args, false, None).await?;
    if let Ok((_, key)) = repository_lock_key(&root).await {
        let mut unknown = UNKNOWN_PUSH_RESULTS
            .get_or_init(|| StdMutex::new(HashMap::new()))
            .lock()
            .unwrap();
        if let Some(destinations) = unknown.get_mut(&key) {
            destinations
                .retain(|destination| !fetch_urls.iter().any(|fetch_url| fetch_url == destination));
            if destinations.is_empty() {
                unknown.remove(&key);
            }
        }
    }
    drop(guard);
    Ok(GitOperationResult {
        message: if output.trim().is_empty() {
            "Fetch completed.".to_string()
        } else {
            sanitize_git_output(output.trim())
        },
        commit_id: None,
    })
}

fn validate_branch_shape(branch: &str) -> Result<(), GitOperationError> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains('\n')
        || branch.contains('\r')
        || branch.contains('\0')
    {
        return Err(operation_error(
            "InvalidBranch",
            "Branch name is invalid.",
            None,
            None,
            false,
        ));
    }
    Ok(())
}

#[command]
pub async fn pull_git_remote(
    app: tauri::AppHandle,
    project_path: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    pull_git_remote_inner(Some(app), project_path, operation_id).await
}

async fn pull_git_remote_inner(
    app: Option<tauri::AppHandle>,
    project_path: String,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    let (info, _) = repository_info_for(&project_path).await?;
    let root = Path::new(&info.repository_root).to_path_buf();
    let (_root, _guard) = try_repository_lock(&root).await?;
    let current = repository_info_for(root.to_str().unwrap_or_default())
        .await?
        .0;
    if current.detached || current.branch.is_none() {
        return Err(operation_error(
            "DetachedHead",
            "Pull requires the current branch to be checked out.",
            Some("Switch to a branch with an upstream before pulling."),
            None,
            false,
        ));
    }
    if !current.worktree_clean {
        return Err(operation_error(
            "DirtyWorktree",
            "Pull requires a clean working tree, including staged changes.",
            Some("Commit or discard local changes before pulling."),
            None,
            false,
        ));
    }
    if current.upstream.is_none() {
        return Err(operation_error(
            "NoUpstream",
            "The current branch has no configured upstream.",
            Some("Configure an upstream branch before pulling."),
            None,
            false,
        ));
    }
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
        "rebase-merge",
        "rebase-apply",
    ] {
        if git_marker_exists(&root, marker).await {
            return Err(operation_error(
                "OperationInProgress",
                "A Git operation is in progress.",
                Some("Complete or abort the active operation in Git before pulling."),
                None,
                false,
            ));
        }
    }
    let args = vec![
        "-c".into(),
        "pull.rebase=false".into(),
        "-c".into(),
        "pull.autostash=false".into(),
        "-c".into(),
        "merge.autostash=false".into(),
        "-c".into(),
        "fetch.recurseSubmodules=false".into(),
        "pull".into(),
        "--progress".into(),
        "--no-rebase".into(),
        "--no-autostash".into(),
        "--ff-only".into(),
        "--no-recurse-submodules".into(),
    ];
    run_git_operation(app, &root, &operation_id, "pull", &args, false, None).await?;
    Ok(GitOperationResult {
        message: "Pull completed.".to_string(),
        commit_id: None,
    })
}

#[command]
pub async fn push_git_remote(
    app: tauri::AppHandle,
    project_path: String,
    remote: String,
    branch: String,
    set_upstream: bool,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    push_git_remote_inner(
        Some(app),
        project_path,
        remote,
        branch,
        set_upstream,
        operation_id,
    )
    .await
}

async fn push_git_remote_inner(
    app: Option<tauri::AppHandle>,
    project_path: String,
    remote: String,
    branch: String,
    set_upstream: bool,
    operation_id: String,
) -> Result<GitOperationResult, GitOperationError> {
    validate_remote_name(&remote)?;
    let (info, key) = repository_info_for(&project_path).await?;
    let root = Path::new(&info.repository_root).to_path_buf();
    let (_root, _guard) = try_repository_lock(&root).await?;
    if UNKNOWN_PUSH_RESULTS
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .get(&key)
        .is_some_and(|destinations| !destinations.is_empty())
    {
        return Err(operation_error("PushRefreshRequired", "The last push timed out and its result is unknown.", Some("Fetch from the same remote push destination to reconcile the result before retrying."), None, true));
    }
    validate_branch_shape(&branch)?;
    let check = safe_git_output(&root, &["check-ref-format", "--branch", &branch])
        .await
        .map_err(|error| {
            operation_error(
                "GitFailed",
                format!("Failed to validate branch: {error}"),
                None,
                None,
                false,
            )
        })?;
    if !check.status.success() {
        return Err(operation_error(
            "InvalidBranch",
            "Branch name is invalid.",
            None,
            None,
            false,
        ));
    }
    let current = repository_info_for(root.to_str().unwrap_or_default())
        .await?
        .0;
    if current.detached || current.branch.is_none() {
        return Err(operation_error(
            "DetachedHead",
            "Push requires a local branch to be checked out.",
            Some("Switch to a local branch before publishing commits."),
            None,
            false,
        ));
    }
    if !current.has_commits {
        return Err(operation_error(
            "NoCommits",
            "There are no commits to push.",
            None,
            None,
            false,
        ));
    }
    if current.upstream.is_none() && !set_upstream {
        return Err(operation_error(
            "NoUpstream",
            "The current branch has no upstream configured.",
            Some("Enable Set upstream on the first push."),
            None,
            false,
        ));
    }
    let (fetch_urls, push_urls) = remote_raw_urls(&root, &remote).await?;
    if fetch_urls.is_empty() {
        return Err(operation_error(
            "UnknownRemote",
            "Git remote does not have a fetch URL.",
            None,
            None,
            false,
        ));
    }
    if push_urls.len() > 1 {
        return Err(operation_error(
            "MultiplePushUrls",
            "This remote has multiple push URLs, so Git would publish to multiple destinations.",
            Some("Configure one push URL for this remote, then retry."),
            None,
            false,
        ));
    }
    let mut args = vec![
        "-c".into(),
        format!("remote.{remote}.mirror=false"),
        "-c".into(),
        "push.followTags=false".into(),
        "-c".into(),
        "push.default=nothing".into(),
        "push".into(),
        "--progress".into(),
        "--no-follow-tags".into(),
        "--no-recurse-submodules".into(),
    ];
    if set_upstream {
        args.push("--set-upstream".into());
    }
    args.extend(["--".into(), remote, format!("HEAD:refs/heads/{branch}")]);
    let destination = push_urls.first().or_else(|| fetch_urls.first()).cloned();
    let output =
        run_git_operation(app, &root, &operation_id, "push", &args, true, destination).await?;
    Ok(GitOperationResult {
        message: if output.trim().is_empty() {
            "Push completed.".to_string()
        } else {
            sanitize_git_output(output.trim())
        },
        commit_id: None,
    })
}

#[command]
pub async fn clone_git_repository(
    app: tauri::AppHandle,
    url: String,
    parent_dir: String,
    directory_name: String,
    operation_id: String,
) -> Result<GitCloneResult, GitOperationError> {
    clone_git_repository_inner(Some(app), url, parent_dir, directory_name, operation_id).await
}

async fn clone_git_repository_inner(
    app: Option<tauri::AppHandle>,
    url: String,
    parent_dir: String,
    directory_name: String,
    operation_id: String,
) -> Result<GitCloneResult, GitOperationError> {
    #[cfg(test)]
    if Path::new(&url).is_absolute() || url.starts_with("file://") {
        // Local URLs are available only to isolated Rust integration tests.
    } else {
        validate_remote_url(&url)?;
    }
    #[cfg(not(test))]
    validate_remote_url(&url)?;
    if directory_name.is_empty()
        || directory_name == "."
        || directory_name == ".."
        || directory_name.contains(['/', '\\', '\0'])
        || directory_name.starts_with('.')
    {
        return Err(operation_error(
            "InvalidDestination",
            "Folder name must be a new folder name without path separators.",
            None,
            None,
            false,
        ));
    }
    let parent = Path::new(&parent_dir);
    if !parent.exists() || !parent.is_dir() {
        return Err(operation_error(
            "InvalidDestination",
            "The selected parent folder does not exist or is not a directory.",
            None,
            None,
            false,
        ));
    }
    let parent = parent.canonicalize().map_err(|error| {
        operation_error(
            "InvalidDestination",
            format!("Could not resolve the selected parent folder: {error}"),
            None,
            None,
            false,
        )
    })?;
    let destination = parent.join(&directory_name);
    std::fs::create_dir(&destination).map_err(|error| {
        operation_error(
            "DestinationUnavailable",
            format!("Could not reserve the new destination folder: {error}"),
            None,
            None,
            false,
        )
    })?;
    let _guard = try_lock_key(&destination).map_err(|error| error)?;
    let args = vec![
        "clone".to_string(),
        "--progress".to_string(),
        "--".to_string(),
        url,
        destination.to_string_lossy().into_owned(),
    ];
    match run_git_operation(
        app,
        &destination,
        &operation_id,
        "clone",
        &args,
        false,
        None,
    )
    .await
    {
        Ok(_) => Ok(GitCloneResult {
            project_path: destination.to_string_lossy().into_owned(),
        }),
        Err(mut error) => {
            error.partial_path = Some(destination.to_string_lossy().into_owned());
            Err(error)
        }
    }
}

#[command]
pub async fn get_git_diff(
    project_path: String,
    file_path: String,
) -> Result<GitDiffResult, String> {
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
                    Err(_) => run_git_diff_capped(
                        &proj_canonical,
                        &["--cached", "--", &file_path],
                        MAX_DIFF_FILE_BYTES as usize,
                    )
                    .await
                    .unwrap_or_else(|_| (String::new(), false, false)),
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

            let (diff_output, is_binary, oversized) =
                diff_res.unwrap_or_else(|_| (String::new(), false, false));

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
                    diff: "No differences found between working file and Git repository."
                        .to_string(),
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
                        diff: "No differences found between working file and Git repository."
                            .to_string(),
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

    #[cfg(unix)]
    #[tokio::test]
    async fn test_bounded_command_output_times_out_and_kills_process_group() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 10 & wait"]);

        let result = bounded_command_output(command, Duration::from_millis(100)).await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn test_parse_git_status_nul_branch_and_tracking() {
        let mut sample = Vec::new();
        sample.extend_from_slice(
            b"## feat/git-status-panel...origin/feat/git-status-panel [ahead 1]",
        );
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
        let input = (0..MAX_DIFF_LINES + 5)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
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
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&project_dir).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&project_dir)
            .status()
            .unwrap();
        assert!(init.success());

        let under_cap = "a".repeat(600 * 1024);
        std::fs::write(project_dir.join("large.txt"), &under_cap).unwrap();
        let shown = get_git_diff(
            project_dir.to_string_lossy().to_string(),
            "large.txt".to_string(),
        )
        .await
        .unwrap();
        assert!(
            !shown.is_binary && !shown.oversized,
            "600 KiB text diffs must remain displayable"
        );
        assert!(shown.diff.contains(&under_cap[..64]));

        let over_cap = "b".repeat(MAX_DIFF_FILE_BYTES as usize + 1);
        std::fs::write(project_dir.join("large.txt"), over_cap).unwrap();
        let capped = get_git_diff(
            project_dir.to_string_lossy().to_string(),
            "large.txt".to_string(),
        )
        .await
        .unwrap();
        assert!(
            capped.oversized,
            "text over 8 MiB must be reported as capped"
        );
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
        let res = get_git_diff(
            temp_dir.to_str().unwrap().to_string(),
            "/etc/passwd".to_string(),
        )
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Absolute paths are not allowed"));
    }

    #[tokio::test]
    async fn test_diff_rejects_parent_traversal() {
        let temp_dir = std::env::temp_dir();
        let res = get_git_diff(
            temp_dir.to_str().unwrap().to_string(),
            "../outside.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Parent directory traversal"));

        let res2 = get_git_diff(
            temp_dir.to_str().unwrap().to_string(),
            "foo/../../outside.txt".to_string(),
        )
        .await;
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("Parent directory traversal"));
    }

    #[tokio::test]
    async fn test_diff_rejects_symlink_escaping_project() {
        let base_temp = std::env::temp_dir();
        let test_id = format!(
            "sciencebatch_symlink_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
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
            let res = get_git_diff(
                project_dir.to_str().unwrap().to_string(),
                "link_to_secret.txt".to_string(),
            )
            .await;
            assert!(res.is_err());
            assert!(res.unwrap_err().contains("escapes project directory"));
        }

        let _ = std::fs::remove_dir_all(&project_dir);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[tokio::test]
    async fn test_git_diff_untracked_and_clean_file_lifecycle() {
        let base_temp = std::env::temp_dir();
        let test_id = format!(
            "sciencebatch_git_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
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
                let clean_diff = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "tracked.txt".to_string(),
                )
                .await
                .unwrap();
                assert_eq!(
                    clean_diff.diff,
                    "No differences found between working file and Git repository."
                );

                // 2. Create an untracked file
                let untracked_file = project_dir.join("untracked.txt");
                let _ = std::fs::write(&untracked_file, "new line 1\nnew line 2\n");

                let untracked_diff = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "untracked.txt".to_string(),
                )
                .await
                .unwrap();
                assert!(untracked_diff
                    .diff
                    .starts_with("--- /dev/null\n+++ b/untracked.txt\n@@ -0,0 +1,2 @@\n"));
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

                let del_diff = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "to_delete.txt".to_string(),
                )
                .await
                .unwrap();
                assert!(del_diff.diff.contains("-content to be deleted"));

                // 4. Test nested untracked directory and file with spaces
                let sub_dir = project_dir.join("subdir");
                let _ = std::fs::create_dir_all(&sub_dir);
                let nested_file = sub_dir.join("nested space.txt");
                let _ = std::fs::write(&nested_file, "nested content\n");

                let st = get_git_status_internal(&project_dir).await.unwrap();
                let has_nested = st
                    .changes
                    .iter()
                    .any(|c| c.path == "subdir/nested space.txt" && c.status == "untracked");
                assert!(has_nested, "git status must list individual untracked files instead of collapsing directories");

                let nested_diff = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "subdir/nested space.txt".to_string(),
                )
                .await
                .unwrap();
                assert!(nested_diff.diff.contains("+nested content"));

                // 5. Test unrecognized file rejection
                let unrec_res = get_git_diff(
                    project_dir.to_str().unwrap().to_string(),
                    "never_existed.txt".to_string(),
                )
                .await;
                assert!(unrec_res.is_err());
            }
        }

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_git_status_disables_fsmonitor() {
        let base_temp = std::env::temp_dir();
        let test_id = format!(
            "sciencebatch_fsmonitor_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
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
                    let script = format!(
                        "#!/bin/sh\necho invoked >> \"{}\"\nexit 0\n",
                        marker_path.display()
                    );
                    let _ = std::fs::write(&hook_path, script);
                    let mut perms = std::fs::metadata(&hook_path).unwrap().permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&hook_path, perms);

                    let _ = std::process::Command::new("git")
                        .args(["config", "core.fsmonitor", hook_path.to_str().unwrap()])
                        .current_dir(&project_dir)
                        .status();

                    let status_res = get_git_status_internal(&project_dir).await;
                    assert!(
                        status_res.is_ok(),
                        "git status must succeed even when fsmonitor hook is configured"
                    );
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
        let test_id = format!(
            "sciencebatch_magic_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
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
        let test_id = format!(
            "sciencebatch_init_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let project_dir = base_temp.join(test_id);
        std::fs::create_dir_all(project_dir.join("figures")).unwrap();
        std::fs::write(project_dir.join("main.tex"), "\\documentclass{article}\n").unwrap();
        std::fs::write(project_dir.join("figures/draft.tex"), "draft\n").unwrap();

        let result = initialize_git_repository(project_dir.to_string_lossy().to_string())
            .await
            .unwrap();

        assert!(result.git_available);
        assert!(result
            .git_version
            .as_deref()
            .unwrap()
            .starts_with("git version "));
        assert!(result.is_git_repo);
        assert_eq!(
            std::fs::read_to_string(project_dir.join("main.tex")).unwrap(),
            "\\documentclass{article}\n"
        );
        assert_eq!(
            std::fs::read_to_string(project_dir.join("figures/draft.tex")).unwrap(),
            "draft\n"
        );
        assert!(result
            .changes
            .iter()
            .any(|change| change.path == "main.tex" && change.status == "untracked"));
        assert!(result
            .changes
            .iter()
            .any(|change| change.path == "figures/draft.tex" && change.status == "untracked"));

        let local_config = std::fs::read_to_string(project_dir.join(".git/config")).unwrap();
        assert!(!local_config.contains("remote \""));
        assert!(!local_config.contains("user \""));
        let commit_result = std::process::Command::new("git")
            .args([
                "-C",
                project_dir.to_str().unwrap(),
                "rev-parse",
                "--verify",
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(
            !commit_result.status.success(),
            "initialization must not create a commit"
        );

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_list_git_branches_includes_unborn_current_branch() {
        let base_temp = std::env::temp_dir();
        let test_id = format!(
            "sciencebatch_unborn_branch_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let project_dir = base_temp.join(test_id);
        std::fs::create_dir_all(&project_dir).unwrap();

        initialize_git_repository(project_dir.to_string_lossy().to_string())
            .await
            .unwrap();
        let symbolic = git_command(&project_dir, &["symbolic-ref", "--short", "HEAD"])
            .output()
            .await
            .unwrap();
        assert!(symbolic.status.success());
        let current_branch = String::from_utf8_lossy(&symbolic.stdout).trim().to_string();

        let branches = list_git_branches(project_dir.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(
            branches.current_branch.as_deref(),
            Some(current_branch.as_str())
        );
        assert!(branches.branches.contains(&current_branch));
        assert!(
            !project_dir
                .join(".git/refs/heads")
                .join(&current_branch)
                .exists(),
            "the test must cover an uncommitted branch without a ref"
        );

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_does_not_create_nested_repository() {
        let base_temp = std::env::temp_dir();
        let test_id = format!(
            "sciencebatch_parent_git_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
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

        assert!(
            result.is_git_repo,
            "the parent repository should be detected"
        );
        assert!(
            !project_dir.join(".git").exists(),
            "initialization must not create a nested .git directory"
        );
        let _ = std::fs::remove_dir_all(&parent_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_rejects_existing_unusable_git_metadata() {
        let base_temp = std::env::temp_dir();
        let test_id = format!(
            "sciencebatch_invalid_git_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let project_dir = base_temp.join(test_id);
        std::fs::create_dir_all(project_dir.join(".git")).unwrap();
        std::fs::write(project_dir.join(".git/invalid"), "user data\n").unwrap();

        let result = initialize_git_repository(project_dir.to_string_lossy().to_string()).await;
        assert!(
            result.is_err(),
            "unusable Git metadata must be reported instead of replaced"
        );
        assert!(
            project_dir.join(".git/invalid").exists(),
            "existing metadata must be preserved"
        );

        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn test_initialize_git_repository_rejects_invalid_project_path() {
        let missing = std::env::temp_dir().join(format!(
            "sciencebatch_missing_project_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let result = initialize_git_repository(missing.to_string_lossy().to_string()).await;
        assert!(result.is_err());
    }

    fn test_repository_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "sciencebatch_{label}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn initialize_test_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        let output = std::process::Command::new("git")
            .args(["init", "--quiet", "-b", "main"])
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        for (key, value) in [
            ("user.name", "ScienceBatch Test"),
            ("user.email", "sciencebatch@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            let output = std::process::Command::new("git")
                .args(["config", "--local", key, value])
                .current_dir(path)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
    }

    #[test]
    fn test_remote_url_validation_and_diagnostic_redaction() {
        for url in [
            "https://github.com/example/project.git",
            "ssh://git@github.com:2222/example/project.git",
            "git@gitlab.example:group/project.git",
        ] {
            assert!(validate_remote_url(url).is_ok(), "{url}");
        }
        for url in [
            "https://user:password@github.com/example/project.git",
            "https://github.com/example/project.git?access_token=secret",
            "https://github.com/example/project.git?%74oken=secret",
            "https://ghp_secret@github.com/example/project.git",
            "ssh://git:password@github.com/example/project.git",
            "file:///tmp/repository",
            "ext::sh -c unsafe",
        ] {
            assert!(validate_remote_url(url).is_err(), "{url}");
        }
        let diagnostics = sanitize_git_output(
            "🙂 https://user:pass@host/a token=one&private_token=two http://second:secret@host/b Authorization: Bearer secret-value next error:https://ghp_secret@host/repo",
        );
        assert!(!diagnostics.contains("pass"));
        assert!(!diagnostics.contains("secret"));
        assert!(!diagnostics.contains("token=one"));
        assert!(!diagnostics.contains("private_token=two"));
        assert!(!diagnostics.contains("secret-value"));
        assert!(!diagnostics.contains("ghp_secret"));
        assert_eq!(diagnostics.matches("[redacted-url]").count(), 3);
    }

    #[test]
    fn test_git_identity_rejects_unusable_name_and_email_characters() {
        assert!(valid_identity(
            Some("ScienceBatch Author"),
            Some("author@example.invalid")
        ));
        assert!(!valid_identity(
            Some("<>"),
            Some("author@example.invalid")
        ));
        assert!(!valid_identity(
            Some("Author\nName"),
            Some("author@example.invalid")
        ));
        assert!(!valid_identity(
            Some("ScienceBatch Author"),
            Some("author name@example.invalid")
        ));
        assert!(!valid_identity(
            Some("ScienceBatch Author"),
            Some("<author@example.invalid>")
        ));
    }

    #[tokio::test]
    async fn test_repository_info_and_staging_use_actual_root_for_nested_project() {
        let root = test_repository_path("nested_info");
        let nested = root.join("chapter");
        initialize_test_repo(&root);
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("nested.tex"), "draft\n").unwrap();
        std::fs::write(root.join("root.tex"), "root\n").unwrap();

        stage_git_files(
            nested.to_string_lossy().to_string(),
            vec!["nested.tex".to_string()],
        )
        .await
        .unwrap();
        let info = get_git_repository_info(nested.to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(
            Path::new(&info.repository_root),
            root.canonicalize().unwrap()
        );
        assert!(info.has_staged_changes);
        assert!(!info.worktree_clean);
        assert!(info.identity.valid);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn test_commit_uses_only_index_and_keeps_unstaged_worktree_file() {
        let root = test_repository_path("partial_commit");
        initialize_test_repo(&root);
        safe_git_action(
            &root,
            &["config", "--local", "core.sshCommand", "plink"],
            "test setup",
        )
        .await
        .unwrap();
        std::fs::write(root.join("staged.tex"), "staged\n").unwrap();
        std::fs::write(root.join("unstaged.tex"), "keep local\n").unwrap();
        stage_git_files(
            root.to_string_lossy().to_string(),
            vec!["staged.tex".to_string()],
        )
        .await
        .unwrap();

        let committed = commit_git_changes_inner(
            None,
            root.to_string_lossy().to_string(),
            "Initial staged commit".to_string(),
            "test-commit".to_string(),
        )
        .await
        .unwrap();
        let tree = safe_git_output(&root, &["ls-tree", "-r", "--name-only", "HEAD"])
            .await
            .unwrap();
        let files = String::from_utf8_lossy(&tree.stdout);
        assert!(files.lines().any(|file| file == "staged.tex"));
        assert!(!files.lines().any(|file| file == "unstaged.tex"));
        assert!(committed.commit_id.is_some());
        assert_eq!(
            std::fs::read_to_string(root.join("unstaged.tex")).unwrap(),
            "keep local\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn test_commit_validation_preserves_staged_and_unstaged_files() {
        let root = test_repository_path("commit_validation");
        initialize_test_repo(&root);
        for (key, value) in [("user.name", ""), ("user.email", "")] {
            safe_git_action(&root, &["config", "--local", key, value], "test setup")
                .await
                .unwrap();
        }
        std::fs::write(root.join("draft.tex"), "keep me\n").unwrap();
        stage_git_files(root.to_string_lossy().to_string(), vec!["draft.tex".into()])
            .await
            .unwrap();

        let blank_message = commit_git_changes_inner(
            None,
            root.to_string_lossy().to_string(),
            "  \n".into(),
            "blank-message".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(blank_message.code, "EmptyMessage");
        let missing_identity = commit_git_changes_inner(
            None,
            root.to_string_lossy().to_string(),
            "first commit".into(),
            "missing-identity".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(missing_identity.code, "InvalidIdentity");
        assert!(
            get_git_repository_info(root.to_string_lossy().to_string())
                .await
                .unwrap()
                .has_staged_changes
        );
        assert_eq!(
            std::fs::read_to_string(root.join("draft.tex")).unwrap(),
            "keep me\n"
        );
        assert!(!safe_git_output(&root, &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap()
            .status
            .success());

        safe_git_action(
            &root,
            &["config", "--local", "user.name", "Test Author"],
            "test setup",
        )
        .await
        .unwrap();
        safe_git_action(
            &root,
            &["config", "--local", "user.email", "invalid-email"],
            "test setup",
        )
        .await
        .unwrap();
        let invalid_identity = commit_git_changes_inner(
            None,
            root.to_string_lossy().to_string(),
            "first commit".into(),
            "invalid-identity".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(invalid_identity.code, "InvalidIdentity");
        unstage_git_files(root.to_string_lossy().to_string(), vec!["draft.tex".into()])
            .await
            .unwrap();
        safe_git_action(
            &root,
            &["config", "--local", "user.email", "author@example.invalid"],
            "test setup",
        )
        .await
        .unwrap();
        let nothing_staged = commit_git_changes_inner(
            None,
            root.to_string_lossy().to_string(),
            "first commit".into(),
            "nothing-staged".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(nothing_staged.code, "NothingStaged");
        assert_eq!(
            std::fs::read_to_string(root.join("draft.tex")).unwrap(),
            "keep me\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn test_repository_lock_rejects_concurrent_mutations() {
        let key = test_repository_path("lock");
        let guard = try_lock_key(&key).unwrap();
        let error = try_lock_key(&key).unwrap_err();
        assert_eq!(error.code, "Busy");
        drop(guard);
        assert!(try_lock_key(&key).is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_push_timeout_kills_hook_descendants_and_records_uncertain_destination() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_repository_path("push_timeout");
        let bare = test_repository_path("push_timeout_bare");
        initialize_test_repo(&root);
        std::fs::create_dir_all(&bare).unwrap();
        let bare_init = std::process::Command::new("git")
            .args(["init", "--bare", "--quiet"])
            .current_dir(&bare)
            .output()
            .unwrap();
        assert!(bare_init.status.success());
        safe_git_action(
            &root,
            &["remote", "add", "origin", bare.to_str().unwrap()],
            "test setup",
        )
        .await
        .unwrap();
        std::fs::write(root.join("tracked.tex"), "content\n").unwrap();
        stage_git_files(
            root.to_string_lossy().to_string(),
            vec!["tracked.tex".to_string()],
        )
        .await
        .unwrap();
        commit_git_changes_inner(
            None,
            root.to_string_lossy().to_string(),
            "initial".into(),
            "timeout-setup".into(),
        )
        .await
        .unwrap();
        let hooks = root.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let marker = root.join("late-hook-write");
        let hook = hooks.join("pre-push");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\nsleep 4\nprintf late > '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        safe_git_action(
            &root,
            &["config", "--local", "core.hooksPath", "hooks"],
            "test setup",
        )
        .await
        .unwrap();

        let destination = bare.to_string_lossy().into_owned();
        let result = run_git_operation_with_timeout(
            None,
            &root,
            "timeout-operation",
            "push",
            &[
                "push".into(),
                "origin".into(),
                "HEAD:refs/heads/main".into(),
            ],
            true,
            Some(destination.clone()),
            Duration::from_millis(200),
        )
        .await;
        let error = result.unwrap_err();
        assert!(error.outcome_unknown);
        let (_, key) = repository_lock_key(&root).await.unwrap();
        assert!(UNKNOWN_PUSH_RESULTS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .contains(&destination));
        let retry = push_git_remote_inner(
            None,
            root.to_string_lossy().into_owned(),
            "origin".into(),
            "main".into(),
            false,
            "timeout-retry".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(retry.code, "PushRefreshRequired");
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            !marker.exists(),
            "timed-out hook descendants must not keep writing"
        );

        UNKNOWN_PUSH_RESULTS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .remove(&key);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(bare);
    }
}

#[cfg(test)]
#[path = "git_workflow_tests.rs"]
mod workflow_tests;
