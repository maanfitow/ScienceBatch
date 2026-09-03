use std::io::{Read, Write};
use crate::types::WorkerRequest;
use super::latex::compile_latex_to_pdf;
use super::typst::compile_typst_to_pdf;

/// Standalone entry point executed when the binary is launched with `--compile-worker`.
pub fn run_compiler_worker() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("Error reading compiler worker stdin: {e}");
        std::process::exit(1);
    }

    let response = if let Ok(req) = serde_json::from_str::<WorkerRequest>(&input) {
        if req.engine.to_lowercase() == "typst" {
            compile_typst_to_pdf(&req.source, req.project_dir.as_deref(), req.main_file.as_deref())
        } else {
            compile_latex_to_pdf(&req.source, req.project_dir.as_deref(), req.main_file.as_deref())
        }
    } else {
        compile_latex_to_pdf(&input, None, None)
    };

    match serde_json::to_vec(&response) {
        Ok(json_bytes) => {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(&json_bytes);
            let _ = stdout.flush();
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("Failed to serialize compile response: {e}");
            std::process::exit(1);
        }
    }
}
