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

/// 同步对话框命令：Tauri v2 默认在主线程执行，blocking 对话框必须 async 化移到线程池。
#[tauri::command(async)]
pub fn pick_vault_dir(app: tauri::AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择笔记文件夹")
        .set_parent(&window)
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

/// 同秒重名防覆盖：文件已存在时追加 -2、-3…直到可用。
fn dedup_name(dir: &std::path::Path, name: String) -> String {
    if name.is_empty() || !dir.join(&name).exists() {
        return name;
    }
    let stem = name.trim_end_matches(".md").to_string();
    for n in 2..1000 {
        let candidate = format!("{}-{}.md", stem, n);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{}-{}.md", stem, chrono::Utc::now().timestamp_millis())
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
        dedup_name(&dir, format!("{}-{}.md", now_stamp(), slugify(&title)))
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

/// 排序方式：modified（默认，修改时间倒序）/ created（创建时间倒序）/ title（标题字典序）。
#[tauri::command]
pub fn list_notes(sort: Option<String>) -> Vec<NoteMeta> {
    list_notes_sorted(vault_dir(), sort.as_deref())
}

#[tauri::command]
pub fn search_notes(query: String, sort: Option<String>) -> Vec<NoteMeta> {
    let dir = match vault_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return list_notes_sorted(Some(dir), sort.as_deref());
    }
    let mut metas: Vec<NoteMeta> = store::list_notes(&dir)
        .into_iter()
        .filter(|m| {
            if m.title.to_lowercase().contains(&q) {
                return true;
            }
            if m.tags.iter().any(|t| t.to_lowercase().contains(&q)) {
                return true;
            }
            store::read_note(&dir, &m.file_name)
                .map(|n| n.content.to_lowercase().contains(&q))
                .unwrap_or(false)
        })
        .collect();
    sort_metas(&mut metas, sort.as_deref());
    metas
}

fn list_notes_sorted(dir: Option<std::path::PathBuf>, sort: Option<&str>) -> Vec<NoteMeta> {
    let mut metas = match dir {
        Some(d) => store::list_notes(&d),
        None => return vec![],
    };
    sort_metas(&mut metas, sort);
    metas
}

fn sort_metas(metas: &mut [NoteMeta], sort: Option<&str>) {
    match sort {
        Some("created") => metas.sort_by(|a, b| b.created.cmp(&a.created)),
        Some("title") => metas.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase())),
        _ => metas.sort_by(|a, b| b.modified.cmp(&a.modified)),
    }
}

/// 删除笔记：前端已确认文件名，此处仅删除（保留给已有流程复用）。
#[tauri::command]
pub fn delete_note(file_name: String) -> Result<(), String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::delete_note(&dir, &file_name)
}

/// 原生确认弹窗（Windows 消息框）：返回 true=确认。async 命令在线程池执行，阻塞安全。
#[tauri::command(async)]
pub fn confirm_dialog(
    app: tauri::AppHandle,
    window: tauri::Window,
    title: String,
    message: String,
    ok_label: String,
    cancel_label: String,
) -> bool {
    use tauri_plugin_dialog::MessageDialogButtons;
    app.dialog()
        .message(message)
        .title(title)
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label))
        .blocking_show()
}

/// 仅改 frontmatter 中的 title，文件名保持不变。
#[tauri::command]
pub fn rename_note(file_name: String, title: String) -> Result<NoteMeta, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::rename_note(&dir, &file_name, &title)
}

/// 打开本地 .md 文件：复制进笔记库（新文件名），返回新笔记元数据。含文件对话框，async 化。
#[tauri::command(async)]
pub fn import_note(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Option<NoteMeta>, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹，请先在顶栏设置文件夹")?;
    let picked = app
        .dialog()
        .file()
        .set_title("打开 Markdown 文档")
        .set_parent(&window)
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    let path = match picked {
        Some(p) => p.to_string(),
        None => return Ok(None),
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let (mut meta, content) = store::parse_frontmatter(&raw);
    let src_name = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名".into());
    if meta.title.is_empty() {
        meta.title = src_name.clone();
    }
    meta.tags = Vec::new();
    let now = chrono::Local::now();
    meta.created = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    meta.modified = String::new();
    let file_name = dedup_name(
        &dir,
        format!("{}-{}.md", now.format("%Y%m%d-%H%M%S"), slugify(&meta.title)),
    );
    meta.file_name = file_name.clone();
    store::write_note(&dir, &file_name, &store::Note { meta, content })?;
    Ok(Some(store::read_note(&dir, &file_name).map(|n| n.meta)?))
}
