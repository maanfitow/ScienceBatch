// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Dispatch to isolated compilation worker mode if requested via CLI flag
    if args.len() > 1 && args[1] == "--compile-worker" {
        sciencebatch_lib::run_compiler_worker();
        return;
    }

    // Launch desktop GUI application
    sciencebatch_lib::run();
}
