// pub：供 Task 3 的 Tauri command 层调用，同时避免 dead_code 警告
pub mod store;

mod commands;
mod config;
mod export;

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
            export::export_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
