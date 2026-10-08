use sciencebatch_lib::automation::{AutomationService, Envelope, OperationContext};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(exit_code) = sciencebatch_lib::automation::mcp::run_cli_command(&args).await {
        std::process::exit(exit_code);
    }
    if args.first().is_some_and(|a| a == "--automation-worker") {
        sciencebatch_lib::automation::run_automation_worker();
        return;
    }
    if args
        .first()
        .is_some_and(|a| a == "--resource-prepare-worker")
    {
        sciencebatch_lib::automation::run_resource_prepare_worker();
        return;
    }
    let (command, request, context, flag_error) = parse_args(&args);
    if command == "help" || command == "version" {
        let envelope = Envelope {
            schema_version: 1,
            command,
            ok: true,
            data: Some(request),
            diagnostics: vec![],
            error: None,
        };
        emit_envelope(&envelope);
        return;
    }
    let envelope = if let Some(error) = flag_error {
        failure_envelope(&command, error)
    } else {
        let service = AutomationService::new();
        let cancel = context.cancellation.clone();
        let pending = service.dispatch(&command, request, context);
        tokio::pin!(pending);
        tokio::select! {
            result = &mut pending => result,
            signal = tokio::signal::ctrl_c() => {
                if signal.is_ok() { cancel.store(true, std::sync::atomic::Ordering::Relaxed); }
                pending.await
            }
        }
    };
    emit_envelope(&envelope);
    std::process::exit(envelope.exit_code());
}

fn failure_envelope(command: &str, error: (String, String, i32)) -> Envelope {
    let (code, message, exit) = error;
    let mut envelope = sciencebatch_lib::automation::failure_for_cli(command, code, message, exit);
    envelope.schema_version = 1;
    envelope
}

fn emit_envelope(envelope: &Envelope) {
    match serde_json::to_string(envelope) {
        Ok(json) => println!("{json}"),
        Err(_) => println!("{{\"schemaVersion\":1,\"command\":\"internal.unexpected\",\"ok\":false,\"data\":null,\"diagnostics\":[],\"error\":{{\"code\":\"internal.unexpected\",\"message\":\"Could not serialize command result.\"}}}}"),
    }
}

fn parse_args(
    args: &[String],
) -> (
    String,
    Value,
    OperationContext,
    Option<(String, String, i32)>,
) {
    let context = OperationContext {
        cancellation: Arc::new(AtomicBool::new(false)),
        ..OperationContext::local()
    };
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        return (
            "help".into(),
            json!({"usage":"sciencebatch-cli project inspect|create|read|search|apply ... --json; diagnostics --project PATH --json; compile --project PATH --main FILE --output FILE --json; resources status|prepare --json"}),
            context,
            None,
        );
    }
    if args == ["--version"] || args == ["-V"] {
        return (
            "version".into(),
            json!({"version":env!("CARGO_PKG_VERSION")}),
            context,
            None,
        );
    }
    let mut cursor;
    let command = if args.first().is_some_and(|a| a == "project") {
        cursor = 1;
        if args.get(cursor).is_none() {
            return usage("project", "Missing project subcommand.");
        }
        let sub = args[cursor].as_str();
        cursor += 1;
        match sub {
            "inspect" => "project.inspect",
            "create" => "project.create",
            "read" => "project.read",
            "search" => "project.search",
            "apply" => "project.apply",
            _ => return usage("project.inspect", "Unknown project subcommand."),
        }
        .to_owned()
    } else if args.first().is_some_and(|a| a == "resources") {
        cursor = 1;
        let subcommand = match args.get(cursor).map(String::as_str) {
            Some("status") => "resources.status",
            Some("prepare") => "resources.prepare",
            _ => return usage("resources.status", "Expected resources status or prepare."),
        }
        .to_owned();
        cursor += 1;
        subcommand
    } else if args.first().is_some_and(|a| a == "mcp") {
        return usage(
            "mcp.serve",
            "The MCP stdio server is being registered by the MCP adapter.",
        );
    } else {
        cursor = 1;
        match args.first().map(String::as_str) {
            Some("diagnostics") => "diagnostics",
            Some("compile") => "compile",
            Some("read") => "project.read",
            Some("search") => "project.search",
            Some("apply") => "project.apply",
            _ => return usage("help", "Unknown command."),
        }
        .to_owned()
    };
    let mut values = serde_json::Map::new();
    let mut json_mode = false;
    let mut overwrite = false;
    let mut allow_download = false;
    let mut seen = std::collections::HashSet::new();
    while cursor < args.len() {
        let flag = &args[cursor];
        cursor += 1;
        if flag == "--json" {
            if !seen.insert("json".to_owned()) {
                return usage(&command, "Option --json was supplied more than once.");
            }
            json_mode = true;
            continue;
        }
        if flag == "--overwrite" {
            if !seen.insert("overwrite".to_owned()) {
                return usage(&command, "Option --overwrite was supplied more than once.");
            }
            overwrite = true;
            continue;
        }
        if flag == "--allow-resource-download" {
            if !seen.insert("allow-resource-download".to_owned()) {
                return usage(
                    &command,
                    "Option --allow-resource-download was supplied more than once.",
                );
            }
            allow_download = true;
            continue;
        }
        if !flag.starts_with("--") {
            return usage(&command, "Unexpected positional argument.");
        }
        let key = flag.trim_start_matches("--");
        if !seen.insert(key.to_owned()) {
            return usage(
                &command,
                &format!("Option {flag} was supplied more than once."),
            );
        }
        let value = match args.get(cursor) {
            Some(v) if !v.starts_with("--") => {
                cursor += 1;
                v.clone()
            }
            _ => return usage(&command, &format!("Missing value for {flag}.")),
        };
        let field = match key {
            "project" => "project",
            "main" => "main",
            "engine" => "engine",
            "file" => "file",
            "query" => "query",
            "content" => "content",
            "content-file" => "contentFile",
            "expected-sha256" => "expectedSha256",
            "output" => "output",
            "timeout" => "timeout",
            "root" => "root",
            _ => return usage(&command, &format!("Unknown option {flag}.")),
        };
        if field == "timeout" {
            match value.parse::<u64>() {
                Ok(n) => {
                    values.insert(field.into(), json!(n));
                }
                Err(_) => return usage(&command, "Timeout must be an integer."),
            }
        } else {
            values.insert(field.into(), json!(value));
        }
    }
    if !json_mode {
        return usage(&command, "--json is required for command output.");
    }
    let allowed: &[&str] = match command.as_str() {
        "project.inspect" | "diagnostics" => &["project", "main", "engine", "json"],
        "project.create" => &["project", "main", "engine", "json"],
        "project.read" => &["project", "file", "json"],
        "project.search" => &["project", "query", "json"],
        "project.apply" => &[
            "project",
            "file",
            "content",
            "content-file",
            "expected-sha256",
            "json",
        ],
        "compile" => &[
            "project",
            "main",
            "engine",
            "output",
            "overwrite",
            "timeout",
            "json",
        ],
        "resources.status" => &["json"],
        "resources.prepare" => &["engine", "json", "allow-resource-download"],
        _ => &[],
    };
    if seen.iter().any(|key| !allowed.contains(&key.as_str())) {
        return usage(&command, "Option is not valid for this command.");
    }
    if matches!(
        command.as_str(),
        "project.inspect"
            | "project.create"
            | "project.read"
            | "project.search"
            | "project.apply"
            | "diagnostics"
            | "compile"
    ) && values.get("project").is_none()
    {
        return usage(&command, "--project is required.");
    }
    if overwrite && (command != "compile" || values.get("output").is_none()) {
        return usage(&command, "--overwrite requires --output on compile.");
    }
    if command == "project.apply"
        && values.contains_key("content")
        && values.contains_key("contentFile")
    {
        return usage(
            &command,
            "Use either --content or --content-file, not both.",
        );
    }
    if command == "project.apply" && values.get("expectedSha256").is_none() {
        return usage(&command, "--expected-sha256 is required.");
    }
    if overwrite {
        values.insert("overwrite".into(), json!(true));
    }
    if command == "project.apply" {
        if values.get("content").is_none() {
            if let Some(path) = values.get("contentFile").and_then(Value::as_str) {
                let path = std::path::Path::new(path);
                let meta = match std::fs::symlink_metadata(path) {
                    Ok(m) if m.is_file() && !m.file_type().is_symlink() => m,
                    Ok(_) => {
                        return (
                            command,
                            json!(null),
                            context,
                            Some((
                                "path.symlink_rejected".into(),
                                "Replacement content must be a regular file.".into(),
                                2,
                            )),
                        )
                    }
                    Err(e) => {
                        return (
                            command,
                            json!(null),
                            context,
                            Some((
                                "io.project_unavailable".into(),
                                format!("Cannot inspect replacement content file: {e}"),
                                3,
                            )),
                        )
                    }
                };
                if meta.len() > sciencebatch_lib::automation::MAX_TEXT_BYTES as u64 {
                    return (
                        command,
                        json!(null),
                        context,
                        Some((
                            "resource.limit_exceeded".into(),
                            "Replacement content exceeds the text-file limit.".into(),
                            3,
                        )),
                    );
                }
                let file = match std::fs::File::open(path) {
                    Ok(f) => f,
                    Err(e) => {
                        return (
                            command,
                            json!(null),
                            context,
                            Some((
                                "io.project_unavailable".into(),
                                format!("Cannot open replacement content file: {e}"),
                                3,
                            )),
                        )
                    }
                };
                let mut bytes = Vec::new();
                if let Err(e) = file
                    .take((sciencebatch_lib::automation::MAX_TEXT_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                {
                    return (
                        command,
                        json!(null),
                        context,
                        Some((
                            "io.project_unavailable".into(),
                            format!("Cannot read replacement content file: {e}"),
                            3,
                        )),
                    );
                }
                if bytes.len() > sciencebatch_lib::automation::MAX_TEXT_BYTES {
                    return (
                        command,
                        json!(null),
                        context,
                        Some((
                            "resource.limit_exceeded".into(),
                            "Replacement content exceeds the text-file limit.".into(),
                            3,
                        )),
                    );
                }
                match String::from_utf8(bytes) {
                    Ok(content) => {
                        values.insert("content".into(), json!(content));
                    }
                    Err(_) => {
                        return (
                            command,
                            json!(null),
                            context,
                            Some((
                                "usage.invalid_argument".into(),
                                "Replacement content must be UTF-8.".into(),
                                2,
                            )),
                        )
                    }
                }
            }
        }
        values.remove("contentFile");
    }
    let mut context = context;
    context.allow_write = true;
    context.allow_resource_download = allow_download || command == "resources.prepare";
    (command, Value::Object(values), context, None)
}

fn usage(
    command: &str,
    message: &str,
) -> (
    String,
    Value,
    OperationContext,
    Option<(String, String, i32)>,
) {
    (
        command.into(),
        Value::Null,
        OperationContext::local(),
        Some(("usage.invalid_argument".into(), message.into(), 2)),
    )
}
