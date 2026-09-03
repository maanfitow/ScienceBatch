pub mod types;
pub mod diagnostics;
pub mod compiler;
pub mod exporters;
pub mod fs;
pub mod commands;

pub use compiler::run_compiler_worker;
pub use commands::compile::CompilerManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_zoom(1.0);
                #[cfg(target_os = "linux")]
                {
                    use webkit2gtk::WebViewExt;
                    use glib::prelude::ObjectExt;
                    use glib::ObjectType;
                    let _ = window.with_webview(|wv| {
                        let webview = wv.inner();
                        webview.set_zoom_level(1.0);
                        webview.connect_zoom_level_notify(|wv| {
                            if (wv.zoom_level() - 1.0).abs() > 0.001 {
                                wv.set_zoom_level(1.0);
                            }
                        });

                        unsafe {
                            if let Some(gesture) = webview.data::<glib::gobject_ffi::GObject>("wk-view-zoom-gesture") {
                                glib::gobject_ffi::g_signal_handlers_block_matched(
                                    gesture.as_ptr().cast(),
                                    glib::gobject_ffi::G_SIGNAL_MATCH_DATA,
                                    0,
                                    0,
                                    std::ptr::null_mut(),
                                    std::ptr::null_mut(),
                                    webview.as_ptr().cast(),
                                );
                                glib::gobject_ffi::g_signal_handlers_destroy(gesture.as_ptr().cast());
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .manage(CompilerManager::new())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::compile::compile_document,
            commands::compile::compile_latex,
            commands::compile::cancel_compilation,
            commands::compile::save_pdf_to_file,
            commands::files::list_project_files,
            commands::files::read_file_content,
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
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

#[cfg(test)]
mod tests;
