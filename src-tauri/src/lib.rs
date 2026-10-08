pub mod automation;
pub mod commands;
pub mod compiler;
pub mod diagnostics;
pub mod exporters;
pub mod fs;
pub mod types;

pub use commands::compile::CompilerManager;
pub use compiler::run_compiler_worker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let workspace_bridge =
                crate::automation::bridge::WorkspaceBridge::start(app.handle().clone())
                    .map_err(std::io::Error::other)?;
            app.manage(workspace_bridge);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_zoom(1.0);
                #[cfg(target_os = "linux")]
                {
                    use glib::prelude::ObjectExt;
                    use glib::ObjectType;
                    use webkit2gtk::WebViewExt;
                    let _ = window.with_webview(|wv| {
                        let webview = wv.inner();
                        webview.set_zoom_level(1.0);
                        webview.connect_zoom_level_notify(|wv| {
                            if (wv.zoom_level() - 1.0).abs() > 0.001 {
                                wv.set_zoom_level(1.0);
                            }
                        });

                        unsafe {
                            if let Some(gesture) =
                                webview.data::<glib::gobject_ffi::GObject>("wk-view-zoom-gesture")
                            {
                                glib::gobject_ffi::g_signal_handlers_block_matched(
                                    gesture.as_ptr().cast(),
                                    glib::gobject_ffi::G_SIGNAL_MATCH_DATA,
                                    0,
                                    0,
                                    std::ptr::null_mut(),
                                    std::ptr::null_mut(),
                                    webview.as_ptr().cast(),
                                );
                                glib::gobject_ffi::g_signal_handlers_destroy(
                                    gesture.as_ptr().cast(),
                                );
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .manage(CompilerManager::new())
        .manage(commands::workspace::WorkspaceCompileJobs::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::compile::compile_document,
            commands::compile::compile_latex,
            commands::compile::cancel_compilation,
            commands::compile::save_pdf_to_file,
            commands::workspace::workspace_automation_ready,
            commands::workspace::workspace_automation_reply,
            commands::workspace::workspace_validate_root,
            commands::workspace::acquire_workspace_repository_lock,
            commands::workspace::release_workspace_repository_lock,
            commands::workspace::workspace_apply_disk,
            commands::workspace::workspace_read_disk,
            commands::workspace::workspace_export_pdf,
            commands::workspace::compile_workspace_snapshot,
            commands::workspace::cancel_workspace_compilation,
            commands::files::list_project_files,
            commands::files::read_file_content,
            commands::files::existing_file_paths,
            commands::files::read_binary_file,
            commands::files::write_file_content,
            commands::files::create_project_folder,
            commands::files::import_file_to_project,
            commands::files::validate_recent_paths,
            commands::files::open_external_url,
            commands::files::reset_webview_zoom,
            commands::export::import_project_from_zip,
            commands::export::export_project_to_zip,
            commands::export::export_document_to_markdown,
            commands::export::export_document_to_html,
            commands::git::get_git_status,
            commands::git::get_git_diff,
            commands::git::initialize_git_repository,
            commands::git::list_git_branches,
            commands::git::switch_git_branch,
            commands::git::stage_git_files,
            commands::git::unstage_git_files,
            commands::git::get_git_repository_info,
            commands::git::set_git_identity,
            commands::git::commit_git_changes,
            commands::git::set_git_remote,
            commands::git::clone_git_repository,
            commands::git::fetch_git_remote,
            commands::git::pull_git_remote,
            commands::git::push_git_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

#[cfg(test)]
mod tests;
