use crate::{
    config,
    store::{self, Note, NoteMeta},
};
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

fn vault_dir() -> Option<PathBuf> {
    config::load_config().map(|c| PathBuf::from(c.vault_dir))
}

#[tauri::command]
pub fn get_config() -> Option<config::AppConfig> {
    config::load_config()
}

#[tauri::command]
pub fn set_config(dir: String) -> Result<config::AppConfig, String> {
    let cfg = config::AppConfig { vault_dir: dir };
    config::save_config(&cfg)?;
    Ok(cfg)
}

/// 同步命令：Tauri 默认在独立线程池执行同步命令，阻塞式系统对话框可接受。
#[tauri::command]
pub fn pick_vault_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择笔记文件夹")
        .blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}

/// 前端收到 close-requested 并保存完后调用；destroy 绕过 CloseRequested，避免再次触发保存链路。
#[tauri::command]
pub fn close_window(window: tauri::Window) {
    let _ = window.destroy();
}

fn now_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 取 title 前 20 个字符；is_alphanumeric 为 Unicode 感知，天然保留中文。
fn slugify(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(20)
        .collect();
    if cleaned.is_empty() { "untitled".into() } else { cleaned }
}

#[tauri::command]
pub fn list_notes() -> Vec<NoteMeta> {
    match vault_dir() {
        Some(dir) => store::list_notes(&dir),
        None => vec![],
    }
}

#[tauri::command]
pub fn read_note(file_name: String) -> Result<Note, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::read_note(&dir, &file_name)
}

#[tauri::command]
pub fn save_note(
    file_name: String,
    title: String,
    tags: Vec<String>,
    content: String,
) -> Result<NoteMeta, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let name = if file_name.is_empty() {
        format!("{}-{}.md", now_stamp(), slugify(&title))
    } else {
        file_name
    };
    // 旧文档复用 created；新文档 created 取当前时间。modified 由 write_note 自己设置。
    let created = match store::read_note(&dir, &name) {
        Ok(old) => old.meta.created,
        Err(_) => chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
    };
    let meta = NoteMeta {
        file_name: name.clone(),
        title,
        tags,
        created,
        modified: String::new(),
    };
    store::write_note(&dir, &name, &Note { meta, content })?;
    store::read_note(&dir, &name).map(|n| n.meta)
}

/// 标题或正文不区分大小写子串匹配；空查询返回完整列表。
#[tauri::command]
pub fn search_notes(query: String) -> Vec<NoteMeta> {
    let dir = match vault_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return store::list_notes(&dir);
    }
    store::list_notes(&dir)
        .into_iter()
        .filter(|m| {
            if m.title.to_lowercase().contains(&q) {
                return true;
            }
            store::read_note(&dir, &m.file_name)
                .map(|n| n.content.to_lowercase().contains(&q))
                .unwrap_or(false)
        })
        .collect()
}
