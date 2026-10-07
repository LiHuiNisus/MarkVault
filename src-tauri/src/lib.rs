// pub：供 Task 3 的 Tauri command 层调用，同时避免 dead_code 警告
pub mod store;

mod commands;
mod config;
mod export;

use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::pick_vault_dir,
            commands::list_notes,
            commands::read_note,
            commands::save_note,
            commands::search_notes,
            commands::delete_note,
            commands::rename_note,
            commands::import_note,
            commands::confirm_dialog,
            commands::close_window,
            export::export_note
        ])
        // 关闭窗口时拦截：通知前端先保存（若有脏数据），前端保存完后调用 close_window 真正关闭
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.emit("close-requested", ());
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
