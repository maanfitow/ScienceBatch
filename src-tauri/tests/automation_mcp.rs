use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Map, Value};
use tokio::process::Command;

fn temp_dir(label: &str) -> PathBuf {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).expect("random temporary directory suffix");
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let directory = std::env::temp_dir().join(format!("sciencebatch-{label}-{suffix}"));
    fs::create_dir_all(&directory).expect("create temporary directory");
    directory
}

fn map(value: Value) -> Map<String, Value> {
    value.as_object().expect("object arguments").clone()
}

#[tokio::test]
async fn stdio_mcp_initializes_lists_tools_and_enforces_project_root_and_write_permission() {
    let root = temp_dir("mcp-root");
    let outside = temp_dir("mcp-outside");
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\\begin{document}ok\\end{document}\n",
    )
    .expect("write fixture");

    let mut command = Command::new(env!("CARGO_BIN_EXE_sciencebatch-cli"));
    command
        .arg("mcp")
        .arg("serve")
        .arg("--root")
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let transport =
        rmcp::transport::TokioChildProcess::new(command).expect("spawn MCP stdio server");
    let client = ().serve(transport).await.expect("initialize MCP client");
    let tools = client.peer().list_all_tools().await.expect("list tools");
    let names = tools
        .iter()
        .map(|tool| tool.name.as_ref())
        .collect::<Vec<_>>();
    for expected in [
        "sciencebatch_project_inspect",
        "sciencebatch_project_create",
        "sciencebatch_read",
        "sciencebatch_search",
        "sciencebatch_apply",
        "sciencebatch_diagnostics",
        "sciencebatch_compile",
        "sciencebatch_resources_status",
        "sciencebatch_resources_prepare",
        "sciencebatch_workspace_instances",
        "sciencebatch_workspace",
    ] {
        assert!(names.contains(&expected), "missing MCP tool {expected}");
    }
    let read_tool = tools
        .iter()
        .find(|tool| tool.name == "sciencebatch_read")
        .expect("read tool");
    assert_eq!(
        read_tool
            .annotations
            .as_ref()
            .and_then(|annotation| annotation.read_only_hint),
        Some(true)
    );
    let output_schema = serde_json::to_value(
        read_tool
            .output_schema
            .as_ref()
            .expect("shared envelope output schema"),
    )
    .expect("serialize output schema");
    for field in [
        "schemaVersion",
        "command",
        "ok",
        "data",
        "diagnostics",
        "error",
    ] {
        assert!(
            output_schema["properties"].get(field).is_some(),
            "output schema must describe serialized Envelope field {field}"
        );
    }

    let read = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_read").with_arguments(map(json!({
                "project": root,
                "file": "main.tex"
            }))),
        )
        .await
        .expect("call read tool");
    assert_eq!(read.is_error, Some(false));
    let read_envelope = read.structured_content.expect("structured read envelope");
    assert_eq!(read_envelope["ok"], true);
    assert_eq!(
        read_envelope["data"]["content"],
        "\\documentclass{article}\n\\begin{document}ok\\end{document}\n"
    );
    assert!(read.content.iter().any(|block| matches!(block, rmcp::model::ContentBlock::Text(text) if text.text.contains("schemaVersion"))));

    let denied = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_apply").with_arguments(map(json!({
                "project": root,
                "file": "main.tex",
                "content": "replacement",
                "expectedSha256": "0000000000000000000000000000000000000000000000000000000000000000"
            }))),
        )
        .await
        .expect("call denied write tool");
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(
        denied.structured_content.unwrap()["error"]["code"],
        "permission.write_required"
    );

    let download_denied = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_resources_prepare").with_arguments(Map::new()),
        )
        .await
        .expect("call denied resource preparation tool");
    assert_eq!(download_denied.is_error, Some(true));
    assert_eq!(
        download_denied.structured_content.unwrap()["error"]["code"],
        "resources.download_denied"
    );

    client.cancel().await.expect("stop read-only MCP server");
    let mut writable_command = Command::new(env!("CARGO_BIN_EXE_sciencebatch-cli"));
    writable_command
        .arg("mcp")
        .arg("serve")
        .arg("--root")
        .arg(&root)
        .arg("--allow-write")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let writable_transport = rmcp::transport::TokioChildProcess::new(writable_command)
        .expect("spawn writable MCP stdio server");
    let client = ().serve(writable_transport).await.expect("initialize writable MCP client");

    let created_root = root.join("created-typst");
    let created = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_project_create").with_arguments(map(json!({
                "project": created_root,
                "engine": "typst",
                "main": "main.typ"
            }))),
        )
        .await
        .expect("create Typst project");
    assert_eq!(created.is_error, Some(false));

    let read_created = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_read").with_arguments(map(json!({
                "project": created_root,
                "file": "main.typ"
            }))),
        )
        .await
        .expect("read created Typst source");
    let initial_hash = read_created.structured_content.unwrap()["data"]["sha256"]
        .as_str()
        .expect("source hash")
        .to_string();
    let replacement = "A revised paragraph for the MCP integration test.\n";
    let applied = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_apply").with_arguments(map(json!({
                "project": created_root,
                "file": "main.typ",
                "content": replacement,
                "expectedSha256": initial_hash
            }))),
        )
        .await
        .expect("apply hash-checked source edit");
    assert_eq!(applied.is_error, Some(false));

    let conflict = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_apply").with_arguments(map(json!({
                "project": created_root,
                "file": "main.typ",
                "content": "stale update",
                "expectedSha256": initial_hash
            }))),
        )
        .await
        .expect("reject stale source hash");
    assert_eq!(conflict.is_error, Some(true));
    assert_eq!(
        conflict.structured_content.unwrap()["error"]["code"],
        "edit.hash_conflict"
    );

    let searched = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_search").with_arguments(map(json!({
                "project": created_root,
                "query": "revised paragraph"
            }))),
        )
        .await
        .expect("search updated project");
    assert_eq!(searched.is_error, Some(false));
    assert_eq!(
        searched.structured_content.unwrap()["data"]["matches"][0]["file"],
        "main.typ"
    );

    for (project, main, output) in [
        (&root, "main.tex", root.join("paper.pdf")),
        (&created_root, "main.typ", created_root.join("paper.pdf")),
    ] {
        let compiled = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("sciencebatch_compile").with_arguments(map(json!({
                    "project": project,
                    "main": main,
                    "output": output,
                    "timeout": 120
                }))),
            )
            .await
            .expect("explicitly compile project");
        assert_eq!(
            compiled.is_error,
            Some(false),
            "compile response: {compiled:?}"
        );
    }

    let outside_result = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_project_inspect").with_arguments(map(json!({
                "project": outside
            }))),
        )
        .await
        .expect("call out-of-root tool");
    assert_eq!(outside_result.is_error, Some(true));
    assert_eq!(
        outside_result.structured_content.unwrap()["error"]["code"],
        "path.outside_project"
    );

    client.cancel().await.expect("stop writable MCP server");
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}

#[tokio::test]
async fn real_mcp_request_cancellation_reaches_only_the_selected_workspace_job() {
    let project = temp_dir("mcp-cancel-project");
    let app_data = temp_dir("mcp-cancel-app-data");
    fs::write(
        project.join("main.tex"),
        "\\documentclass{article}\n\\begin{document}ok\\end{document}\n",
    )
    .expect("write workspace fixture");

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake workspace bridge");
    listener
        .set_nonblocking(true)
        .expect("configure bridge listener");
    let port = listener.local_addr().expect("read bridge address").port();
    let instance_id = "0123456789abcdef0123456789abcdef";
    let bridge_directory = app_data.join("com.sciencebatch.editor/workspace-bridge");
    fs::create_dir_all(&bridge_directory).expect("create private bridge registry directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bridge_directory, fs::Permissions::from_mode(0o700))
            .expect("secure bridge registry directory");
    }
    let registry_path = bridge_directory.join(format!("{instance_id}.json"));
    fs::write(
        &registry_path,
        json!({
            "schemaVersion": 1,
            "instanceId": instance_id,
            "host": "127.0.0.1",
            "port": port,
            "token": "ab".repeat(32),
            "pid": std::process::id()
        })
        .to_string(),
    )
    .expect("write fake bridge registry");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&registry_path, fs::Permissions::from_mode(0o600))
            .expect("secure bridge registry");
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_cancelled = cancelled.clone();
    let worker_stopping = stopping.clone();
    let bridge_project = project.clone();
    let (compile_started_tx, compile_started_rx) = std::sync::mpsc::channel();
    let (cancel_seen_tx, cancel_seen_rx) = std::sync::mpsc::channel();
    let bridge_thread = thread::spawn(move || {
        while !worker_stopping.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let cancelled = worker_cancelled.clone();
                    let compile_started = compile_started_tx.clone();
                    let cancel_seen = cancel_seen_tx.clone();
                    let project = bridge_project.clone();
                    thread::spawn(move || {
                        serve_fake_workspace_request(
                            stream,
                            &project,
                            cancelled,
                            compile_started,
                            cancel_seen,
                        );
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });

    let mut command = Command::new(env!("CARGO_BIN_EXE_sciencebatch-cli"));
    command
        .arg("mcp")
        .arg("serve")
        .arg("--root")
        .arg(&project)
        .env("XDG_DATA_HOME", &app_data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let transport = rmcp::transport::TokioChildProcess::new(command)
        .expect("spawn MCP server with fake workspace bridge");
    let client = ().serve(transport).await.expect("initialize MCP client");
    let completed_failure = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_workspace").with_arguments(map(json!({
                "instanceId": instance_id,
                "operation": "compile",
                "jobId": "fake-compile-failure",
                "expectedProjectRoot": project,
                "workspaceGeneration": 9,
                "timeoutSeconds": 120
            }))),
        )
        .await
        .expect("receive completed workspace compile failure");
    assert_eq!(completed_failure.is_error, Some(true));
    let failed_envelope = completed_failure
        .structured_content
        .expect("structured workspace compile error envelope");
    assert_eq!(failed_envelope["error"]["code"], "compile.document_failed");
    assert_eq!(failed_envelope["diagnostics"][0]["file"], "main.tex");
    assert_eq!(failed_envelope["diagnostics"][0]["origin"], "compiler");

    let call = rmcp::model::CallToolRequest::new(
        CallToolRequestParams::new("sciencebatch_workspace").with_arguments(map(json!({
            "instanceId": instance_id,
            "operation": "compile",
            "expectedProjectRoot": project,
            "workspaceGeneration": 9,
            "timeoutSeconds": 120
        }))),
    );
    let request = client
        .peer()
        .send_cancellable_request(
            rmcp::model::ClientRequest::CallToolRequest(call),
            rmcp::service::PeerRequestOptions::no_options(),
        )
        .await
        .expect("send cancellable MCP tool request");
    let job_id = tokio::task::spawn_blocking(move || {
        compile_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("workspace compile request reached bridge")
    })
    .await
    .expect("wait for compile notification");
    request
        .cancel(Some("integration test cancellation".to_string()))
        .await
        .expect("send MCP cancellation notification");
    let cancelled_job = tokio::task::spawn_blocking(move || {
        cancel_seen_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("workspace cancellation reached bridge")
    })
    .await
    .expect("wait for workspace cancellation");
    assert_eq!(cancelled_job, job_id);
    assert!(cancelled.load(Ordering::Acquire));

    client
        .cancel()
        .await
        .expect("stop cancellation test MCP server");
    stopping.store(true, Ordering::Release);
    bridge_thread.join().expect("stop fake workspace bridge");
    let _ = fs::remove_dir_all(project);
    let _ = fs::remove_dir_all(app_data);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn mcp_compile_cancellation_reaps_the_worker_and_keeps_server_usable() {
    let project = temp_dir("mcp-worker-cancel");
    fs::write(
        project.join("infinite.tex"),
        "\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}\n",
    )
    .expect("write infinite compile fixture");
    fs::write(
        project.join("good.tex"),
        "\\documentclass{article}\n\\begin{document}second compile succeeds\\end{document}\n",
    )
    .expect("write valid compile fixture");

    let mut command = Command::new(env!("CARGO_BIN_EXE_sciencebatch-cli"));
    command
        .arg("mcp")
        .arg("serve")
        .arg("--root")
        .arg(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let transport = rmcp::transport::TokioChildProcess::new(command)
        .expect("spawn MCP server for compile cancellation");
    let server_pid = transport.id().expect("read MCP server PID");
    let client = ().serve(transport).await.expect("initialize MCP client");
    let request = client
        .peer()
        .send_cancellable_request(
            rmcp::model::ClientRequest::CallToolRequest(rmcp::model::CallToolRequest::new(
                CallToolRequestParams::new("sciencebatch_compile").with_arguments(map(json!({
                    "project": project,
                    "main": "infinite.tex",
                    "timeout": 120
                }))),
            )),
            rmcp::service::PeerRequestOptions::no_options(),
        )
        .await
        .expect("send cancellable MCP compile request");
    let worker_pids = tokio::task::spawn_blocking(move || wait_for_workers(server_pid))
        .await
        .expect("wait for compile worker");
    assert!(
        !worker_pids.is_empty(),
        "MCP compile should launch an isolated worker"
    );
    request
        .cancel(Some("integration test cancellation".to_string()))
        .await
        .expect("send MCP cancellation notification");

    let worker_reaped =
        tokio::task::spawn_blocking(move || wait_for_workers_to_exit(server_pid, &worker_pids))
            .await
            .expect("wait for worker reaping");
    assert!(
        worker_reaped,
        "cancelled MCP compile worker must be killed and reaped"
    );

    let subsequent = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("sciencebatch_compile").with_arguments(map(json!({
                "project": project,
                "main": "good.tex",
                "timeout": 120
            }))),
        )
        .await
        .expect("issue a second compile through the same MCP server");
    assert_eq!(
        subsequent.is_error,
        Some(false),
        "subsequent compile: {subsequent:?}"
    );
    assert_eq!(subsequent.structured_content.unwrap()["ok"], true);

    client
        .cancel()
        .await
        .expect("stop MCP compile cancellation server");
    let _ = fs::remove_dir_all(project);
}

#[cfg(target_os = "linux")]
fn wait_for_workers(server_pid: u32) -> Vec<u32> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let workers = workers_for_parent(server_pid);
        if !workers.is_empty() {
            return workers;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Vec::new()
}

#[cfg(target_os = "linux")]
fn wait_for_workers_to_exit(server_pid: u32, pids: &[u32]) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if workers_for_parent(server_pid)
            .iter()
            .all(|pid| !pids.contains(pid))
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[cfg(target_os = "linux")]
fn workers_for_parent(server_pid: u32) -> Vec<u32> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
            let command = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
            let command = String::from_utf8_lossy(&command);
            if !command.contains("--automation-worker") {
                return None;
            }
            let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
            let parent = status
                .lines()
                .find_map(|line| line.strip_prefix("PPid:")?.trim().parse::<u32>().ok())?;
            (parent == server_pid).then_some(pid)
        })
        .collect()
}

fn serve_fake_workspace_request(
    stream: TcpStream,
    project: &std::path::Path,
    cancelled: Arc<AtomicBool>,
    compile_started: std::sync::mpsc::Sender<String>,
    cancel_seen: std::sync::mpsc::Sender<String>,
) {
    let mut line = Vec::new();
    let mut reader = BufReader::new(stream.try_clone().expect("clone bridge stream"));
    if reader.read_until(b'\n', &mut line).is_err() {
        return;
    }
    let request: Value = match serde_json::from_slice(&line) {
        Ok(request) => request,
        Err(_) => return,
    };
    let id = request["id"].as_str().unwrap_or_default().to_string();
    let operation = request["operation"].as_str().unwrap_or_default();
    let job_id = request["args"]["jobId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let simulated_failure = operation == "workspace.compile" && job_id == "fake-compile-failure";
    let data = match operation {
        "workspace.inspect" => json!({
            "projectRoot": project,
            "workspaceGeneration": 9,
            "documents": []
        }),
        "workspace.compile" => {
            if !simulated_failure {
                let _ = compile_started.send(job_id.clone());
                while !cancelled.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(5));
                }
                json!({"status":"cancelled"})
            } else {
                json!({"status":"failed"})
            }
        }
        "workspace.cancel" => {
            cancelled.store(true, Ordering::Release);
            let _ = cancel_seen.send(job_id.clone());
            json!({"jobId":job_id,"cancelled":true})
        }
        _ => json!({}),
    };
    let response = if simulated_failure {
        json!({
            "schemaVersion":1,
            "id":id,
            "ok":false,
            "error":{
                "code":"compile.document_failed",
                "message":"Workspace document compilation failed.",
                "details":{
                    "jobId":job_id,
                    "errors":[{
                        "severity":"error",
                        "message":"Undefined control sequence.",
                        "file":"main.tex",
                        "line":2
                    }],
                    "warnings":[]
                }
            }
        })
    } else {
        json!({"schemaVersion":1,"id":id,"ok":true,"data":data})
    };
    let mut stream = stream;
    let _ = stream.write_all(response.to_string().as_bytes());
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}
