use super::*;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sciencebatch_git_workflow_{label}_{}_{}_{}",
            std::process::id(),
            nonce,
            id
        ));
        std::fs::create_dir_all(&path).expect("temporary test directory should be created");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str]) -> Output {
    let mut command = StdCommand::new("git");
    command
        .args(["-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    command
        .output()
        .expect("Git should run in the test fixture")
}

fn git_ok(cwd: &Path, args: &[&str]) -> String {
    let output = git(cwd, args);
    assert!(
        output.status.success(),
        "git {} failed in {}:\n{}",
        args.join(" "),
        cwd.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn global_config_value(key: &str) -> Output {
    let mut command = StdCommand::new("git");
    command
        .args([
            "-c",
            "protocol.file.allow=always",
            "config",
            "--global",
            "--get",
            key,
        ])
        .env("GIT_CONFIG_NOSYSTEM", "1");
    command.output().expect("Git config should run")
}

fn init_repo(path: &Path, branch: &str, with_identity: bool) {
    std::fs::create_dir_all(path).expect("repository directory should be created");
    git_ok(path, &["init", "--quiet", "--initial-branch", branch]);
    for (key, value) in [("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")] {
        git_ok(path, &["config", "--local", key, value]);
    }
    if with_identity {
        set_identity(path);
    } else {
        // Empty local values mask any developer-level identity for deterministic
        // repository-info assertions without touching global Git configuration.
        git_ok(path, &["config", "--local", "user.name", ""]);
        git_ok(path, &["config", "--local", "user.email", ""]);
    }
}

fn set_identity(path: &Path) {
    git_ok(
        path,
        &["config", "--local", "user.name", "Workflow Test Author"],
    );
    git_ok(
        path,
        &[
            "config",
            "--local",
            "user.email",
            "workflow@example.invalid",
        ],
    );
}

fn init_bare(path: &Path) {
    std::fs::create_dir_all(path).expect("bare repository directory should be created");
    git_ok(
        path,
        &["init", "--quiet", "--bare", "--initial-branch", "main"],
    );
}

fn commit_file(path: &Path, relative_path: &str, contents: &str, message: &str) {
    let target = path.join(relative_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).expect("file parent should be created");
    }
    std::fs::write(target, contents).expect("fixture file should be written");
    git_ok(path, &["add", "--", relative_path]);
    git_ok(path, &["commit", "--quiet", "-m", message]);
}

fn head(path: &Path) -> String {
    git_ok(path, &["rev-parse", "HEAD"])
}

async fn add_remote(repo: &Path, name: &str, url: &Path) {
    set_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        name.to_string(),
        url.to_string_lossy().into_owned(),
        format!("test-remote-{name}"),
    )
    .await
    .expect("remote should be added");
}

async fn first_push(repo: &Path, remote: &str, branch: &str, set_upstream: bool) {
    push_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        remote.to_string(),
        branch.to_string(),
        set_upstream,
        format!("test-push-{remote}-{branch}"),
    )
    .await
    .expect("push should succeed");
}

async fn repository_info(repo: &Path) -> GitRepositoryInfo {
    get_git_repository_info(repo.to_string_lossy().into_owned())
        .await
        .expect("repository info should be available")
}

async fn setup_upstream(label: &str) -> (TestDirectory, PathBuf, PathBuf) {
    let temp = TestDirectory::new(label);
    let repo = temp.path().join("working");
    let remote = temp.path().join("remote.git");
    init_repo(&repo, "main", true);
    init_bare(&remote);
    add_remote(&repo, "origin", &remote).await;
    commit_file(&repo, "nested/tracked.txt", "base\n", "base commit");
    first_push(&repo, "origin", "main", true).await;
    (temp, repo, remote)
}

#[tokio::test]
async fn remote_add_edit_and_multiple_remotes_are_reflected_in_repository_info() {
    let temp = TestDirectory::new("remotes");
    let repo = temp.path().join("repo");
    let first = temp.path().join("first.git");
    let second = temp.path().join("second.git");
    let push_only = temp.path().join("push-only.git");
    init_repo(&repo, "main", false);
    init_bare(&first);
    init_bare(&second);
    init_bare(&push_only);

    add_remote(&repo, "origin", &first).await;
    set_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "origin".into(),
        second.to_string_lossy().into_owned(),
        "test-edit-origin".into(),
    )
    .await
    .expect("existing remote should be edited");
    git_ok(
        &repo,
        &[
            "config",
            "--local",
            "remote.origin.pushurl",
            push_only.to_str().unwrap(),
        ],
    );
    set_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "origin".into(),
        first.to_string_lossy().into_owned(),
        "test-edit-origin-fetch-preserves-push".into(),
    )
    .await
    .expect("editing the fetch URL should succeed");
    add_remote(&repo, "backup", &first).await;

    let info = repository_info(&repo).await;
    assert_eq!(info.remotes.len(), 2);
    let origin = info
        .remotes
        .iter()
        .find(|remote| remote.name == "origin")
        .unwrap();
    let backup = info
        .remotes
        .iter()
        .find(|remote| remote.name == "backup")
        .unwrap();
    assert_eq!(Path::new(&origin.fetch_url), first.canonicalize().unwrap());
    assert_eq!(
        Path::new(&origin.push_url),
        push_only.canonicalize().unwrap()
    );
    assert_eq!(Path::new(&backup.fetch_url), first.canonicalize().unwrap());
}

#[tokio::test]
async fn empty_repository_has_no_commit_or_author_until_local_identity_is_set() {
    let temp = TestDirectory::new("identity");
    let repo = temp.path().join("repo");
    init_repo(&repo, "main", false);

    let initial = repository_info(&repo).await;
    assert!(!initial.has_commits);
    assert!(!initial.identity.valid);
    assert!(initial.identity.name.is_none());
    assert!(initial.identity.email.is_none());

    let global_name_before = global_config_value("user.name");
    let global_email_before = global_config_value("user.email");
    let identity = set_git_identity(
        repo.to_string_lossy().into_owned(),
        "Repository Author".into(),
        "repo-author@example.invalid".into(),
    )
    .await
    .expect("identity should be saved in local repository config");
    assert!(identity.valid);
    assert_eq!(
        git_ok(&repo, &["config", "--local", "--get", "user.name"]),
        "Repository Author"
    );
    assert_eq!(
        git_ok(&repo, &["config", "--local", "--get", "user.email"]),
        "repo-author@example.invalid"
    );
    let global_name_after = global_config_value("user.name");
    let global_email_after = global_config_value("user.email");
    assert_eq!(
        global_name_after.status.success(),
        global_name_before.status.success()
    );
    assert_eq!(global_name_after.stdout, global_name_before.stdout);
    assert_eq!(
        global_email_after.status.success(),
        global_email_before.status.success()
    );
    assert_eq!(global_email_after.stdout, global_email_before.stdout);
}

#[tokio::test]
async fn clone_creates_a_new_repository_and_refuses_existing_destinations() {
    let temp = TestDirectory::new("clone");
    let source = temp.path().join("source");
    let parent = temp.path().join("clones");
    let destination = parent.join("fresh-copy");
    init_repo(&source, "main", true);
    commit_file(
        &source,
        "paper.tex",
        "\\documentclass{article}\n",
        "initial",
    );
    std::fs::create_dir_all(&parent).unwrap();

    let cloned = clone_git_repository_inner(
        None,
        source.to_string_lossy().into_owned(),
        parent.to_string_lossy().into_owned(),
        "fresh-copy".into(),
        "test-clone".into(),
    )
    .await
    .expect("clone should succeed for a local fixture");
    assert_eq!(
        Path::new(&cloned.project_path),
        destination.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("paper.tex")).unwrap(),
        "\\documentclass{article}\n"
    );
    assert_eq!(
        repository_info(&destination).await.branch.as_deref(),
        Some("main")
    );

    let existing = parent.join("occupied");
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::write(existing.join("keep.txt"), "preserve me\n").unwrap();
    let refused = clone_git_repository_inner(
        None,
        source.to_string_lossy().into_owned(),
        parent.to_string_lossy().into_owned(),
        "occupied".into(),
        "test-clone-existing".into(),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "DestinationUnavailable");
    assert_eq!(
        std::fs::read_to_string(existing.join("keep.txt")).unwrap(),
        "preserve me\n"
    );
}

#[tokio::test]
async fn clone_failure_reports_and_retains_the_partial_destination() {
    let temp = TestDirectory::new("clone_partial");
    let parent = temp.path().join("clones");
    let destination = parent.join("partial-copy");
    std::fs::create_dir_all(&parent).unwrap();
    let missing_source = temp.path().join("missing.git");

    let error = clone_git_repository_inner(
        None,
        missing_source.to_string_lossy().into_owned(),
        parent.to_string_lossy().into_owned(),
        "partial-copy".into(),
        "test-clone-partial".into(),
    )
    .await
    .expect_err("clone from a missing local repository should fail");
    assert_eq!(
        error.partial_path.as_deref(),
        Some(destination.to_string_lossy().as_ref())
    );
    assert!(
        destination.exists(),
        "failed clone destination must be retained for inspection"
    );
}

#[tokio::test]
async fn fetch_updates_ahead_and_behind_counts_for_the_configured_upstream() {
    let temp = TestDirectory::new("fetch_counts");
    let repo = temp.path().join("consumer");
    let remote = temp.path().join("remote.git");
    let producer = temp.path().join("producer");
    init_repo(&repo, "main", true);
    init_bare(&remote);
    add_remote(&repo, "origin", &remote).await;
    commit_file(&repo, "base.txt", "base\n", "base");
    first_push(&repo, "origin", "main", true).await;
    git_ok(
        temp.path(),
        &[
            "clone",
            "--quiet",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            producer.to_str().unwrap(),
        ],
    );
    set_identity(&producer);

    commit_file(&repo, "local.txt", "local\n", "local ahead commit");
    commit_file(&producer, "remote.txt", "remote\n", "remote behind commit");
    git_ok(
        &producer,
        &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
    );

    fetch_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "origin".into(),
        "test-fetch-counts".into(),
    )
    .await
    .expect("fetch should update remote-tracking refs");

    let info = repository_info(&repo).await;
    assert_eq!(info.ahead, Some(1));
    assert_eq!(info.behind, Some(1));
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
}

#[tokio::test]
async fn pull_fast_forwards_despite_user_rebase_and_autostash_preferences() {
    let (temp, repo, remote) = setup_upstream("pull_ff_only").await;
    let producer = temp.path().join("producer");
    git_ok(
        temp.path(),
        &[
            "clone",
            "--quiet",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            producer.to_str().unwrap(),
        ],
    );
    set_identity(&producer);
    commit_file(
        &producer,
        "remote.txt",
        "remote update\n",
        "upstream update",
    );
    git_ok(
        &producer,
        &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
    );

    git_ok(&repo, &["config", "--local", "pull.rebase", "true"]);
    git_ok(&repo, &["config", "--local", "merge.autostash", "true"]);
    let previous_head = head(&repo);
    pull_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "test-pull-ff".into(),
    )
    .await
    .expect("fast-forward pull should succeed");

    assert_ne!(head(&repo), previous_head);
    assert_eq!(
        std::fs::read_to_string(repo.join("remote.txt")).unwrap(),
        "remote update\n"
    );
    assert!(repository_info(&repo).await.worktree_clean);
}

#[tokio::test]
async fn divergent_pull_fails_without_changing_head_or_working_tree() {
    let (temp, repo, remote) = setup_upstream("pull_divergent").await;
    let producer = temp.path().join("producer");
    git_ok(
        temp.path(),
        &[
            "clone",
            "--quiet",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            producer.to_str().unwrap(),
        ],
    );
    set_identity(&producer);

    commit_file(&repo, "local.txt", "local\n", "local divergent commit");
    commit_file(
        &producer,
        "remote.txt",
        "remote\n",
        "remote divergent commit",
    );
    git_ok(
        &producer,
        &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
    );
    let previous_head = head(&repo);
    let previous_local_file = std::fs::read_to_string(repo.join("local.txt")).unwrap();

    let error = pull_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "test-pull-divergent".into(),
    )
    .await
    .expect_err("divergent histories must be rejected by fast-forward-only pull");

    assert_eq!(head(&repo), previous_head);
    assert_eq!(
        std::fs::read_to_string(repo.join("local.txt")).unwrap(),
        previous_local_file
    );
    assert!(!repo.join("remote.txt").exists());
    assert!(!error.outcome_unknown);
}

#[tokio::test]
async fn pull_rejects_staged_unstaged_and_untracked_changes_from_nested_project_paths() {
    for (label, state) in [
        ("pull_dirty_staged", "staged"),
        ("pull_dirty_unstaged", "unstaged"),
        ("pull_dirty_untracked", "untracked"),
    ] {
        let (_temp, repo, _) = setup_upstream(label).await;
        let nested = repo.join("nested");
        let target = nested.join("tracked.txt");
        if state == "untracked" {
            std::fs::write(nested.join("new-file.txt"), "keep\n").unwrap();
        } else {
            std::fs::write(&target, format!("{state} local change\n")).unwrap();
            if state == "staged" {
                git_ok(&repo, &["add", "--", "nested/tracked.txt"]);
            }
        }
        let previous_head = head(&repo);
        let local_contents = std::fs::read_to_string(&target).unwrap();

        let error = pull_git_remote_inner(
            None,
            nested.to_string_lossy().into_owned(),
            format!("test-{state}-pull"),
        )
        .await
        .expect_err("dirty or untracked worktree should block pull");

        assert_eq!(error.code, "DirtyWorktree", "state: {state}");
        assert_eq!(head(&repo), previous_head, "state: {state}");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            local_contents,
            "state: {state}"
        );
        if state == "untracked" {
            assert_eq!(
                std::fs::read_to_string(nested.join("new-file.txt")).unwrap(),
                "keep\n"
            );
        }
    }
}

#[tokio::test]
async fn first_push_tracks_a_separately_named_remote_branch_and_never_mirrors_or_pushes_tags() {
    let temp = TestDirectory::new("push_target");
    let repo = temp.path().join("repo");
    let remote = temp.path().join("remote.git");
    init_repo(&repo, "feature/source-with/slash", true);
    init_bare(&remote);
    add_remote(&repo, "origin", &remote).await;
    commit_file(&repo, "source.txt", "source\n", "source branch commit");
    git_ok(&repo, &["branch", "extra/local-branch"]);
    git_ok(&repo, &["tag", "v1.0.0"]);
    git_ok(
        &repo,
        &["config", "--local", "remote.origin.mirror", "true"],
    );
    git_ok(&repo, &["config", "--local", "push.followTags", "true"]);
    let current_branch = git_ok(&repo, &["branch", "--show-current"]);
    let target_branch = "published/first-push/target";

    first_push(&repo, "origin", target_branch, true).await;

    assert_eq!(git_ok(&repo, &["branch", "--show-current"]), current_branch);
    assert_eq!(
        git_ok(
            &repo,
            &[
                "for-each-ref",
                "--format=%(upstream:short)",
                &format!("refs/heads/{current_branch}")
            ]
        ),
        format!("origin/{target_branch}")
    );
    assert_eq!(
        git_ok(
            &remote,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads",
                "refs/tags"
            ]
        ),
        format!("refs/heads/{target_branch}")
    );
}

#[tokio::test]
async fn push_rejects_non_fast_forward_and_leaves_remote_head_unchanged() {
    let (temp, repo, remote) = setup_upstream("push_non_ff").await;
    let producer = temp.path().join("producer");
    git_ok(
        temp.path(),
        &[
            "clone",
            "--quiet",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            producer.to_str().unwrap(),
        ],
    );
    set_identity(&producer);

    commit_file(&repo, "local.txt", "local\n", "local commit");
    commit_file(&producer, "remote.txt", "remote\n", "remote commit");
    git_ok(
        &producer,
        &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
    );
    let remote_head = git_ok(&remote, &["rev-parse", "refs/heads/main"]);

    let result = push_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "origin".into(),
        "main".into(),
        false,
        "test-push-non-ff".into(),
    )
    .await;

    assert!(result.is_err(), "non-fast-forward push should be refused");
    assert_eq!(
        git_ok(&remote, &["rev-parse", "refs/heads/main"]),
        remote_head
    );
}

struct UnknownPushMarker {
    key: PathBuf,
    destination: String,
}

impl UnknownPushMarker {
    async fn add(repo: &Path, destination: &Path) -> Self {
        let (_, key) = repository_info_for(repo.to_string_lossy().as_ref())
            .await
            .expect("repository lock key should be available");
        let destination = destination.to_string_lossy().into_owned();
        UNKNOWN_PUSH_RESULTS
            .get_or_init(|| StdMutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_default()
            .insert(destination.clone());
        Self { key, destination }
    }
}

impl Drop for UnknownPushMarker {
    fn drop(&mut self) {
        if let Some(results) = UNKNOWN_PUSH_RESULTS.get() {
            let mut results = results.lock().unwrap();
            if let Some(destinations) = results.get_mut(&self.key) {
                destinations.remove(&self.destination);
                if destinations.is_empty() {
                    results.remove(&self.key);
                }
            }
        }
    }
}

#[tokio::test]
async fn unrelated_fetch_and_mismatched_fetch_url_do_not_clear_uncertain_push_state() {
    let temp = TestDirectory::new("push_uncertain");
    let repo = temp.path().join("repo");
    let fetch_remote = temp.path().join("fetch.git");
    let push_remote = temp.path().join("push.git");
    let unrelated_remote = temp.path().join("unrelated.git");
    init_repo(&repo, "main", true);
    init_bare(&fetch_remote);
    init_bare(&push_remote);
    init_bare(&unrelated_remote);
    add_remote(&repo, "origin", &fetch_remote).await;
    add_remote(&repo, "backup", &unrelated_remote).await;
    commit_file(&repo, "base.txt", "base\n", "base");
    first_push(&repo, "origin", "main", true).await;
    git_ok(
        &repo,
        &[
            "config",
            "--local",
            "remote.origin.pushurl",
            push_remote.to_str().unwrap(),
        ],
    );
    let _marker = UnknownPushMarker::add(&repo, &push_remote).await;
    assert!(repository_info(&repo).await.push_refresh_required);

    fetch_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "backup".into(),
        "test-fetch-unrelated".into(),
    )
    .await
    .expect("fetch from unrelated remote should succeed");
    assert!(repository_info(&repo).await.push_refresh_required);

    fetch_git_remote_inner(
        None,
        repo.to_string_lossy().into_owned(),
        "origin".into(),
        "test-fetch-mismatched-origin".into(),
    )
    .await
    .expect("fetch from origin should succeed");
    assert!(
        repository_info(&repo).await.push_refresh_required,
        "fetch URL must not reconcile an uncertain push sent to a distinct push URL"
    );
}
