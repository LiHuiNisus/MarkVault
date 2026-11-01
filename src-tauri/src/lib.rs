// pub：供 Task 3 的 Tauri command 层调用，同时避免 dead_code 警告
pub mod store;

mod clipboard;
mod commands;
mod config;
mod export;

use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 启动即保证笔记目录存在：首次运行创建 exe 同级 notes 并迁移旧目录，之后尊重用户自选目录
        .setup(|_app| {
            config::init_config().map_err(|e| format!("初始化笔记目录失败: {e}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::pick_vault_dir,
            commands::list_notes,
            commands::get_order,
            commands::save_order,
            commands::read_note,
            commands::save_note,
            commands::search_notes,
            commands::save_asset,
            commands::read_asset,
            commands::pick_image,
            commands::delete_note,
            commands::rename_note,
            commands::import_note,
            commands::list_folders,
            commands::list_tags,
            commands::list_tag_counts,
            commands::rename_tag,
            commands::delete_tag,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::move_note,
            commands::move_notes,
            commands::confirm_dialog,
            commands::close_window,
            clipboard::copy_note_file,
            clipboard::copy_note_path,
            clipboard::reveal_note,
            clipboard::reveal_path,
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
