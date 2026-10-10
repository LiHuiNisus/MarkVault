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
    // 标记已初始化：用户自选目录优先于 exe 同级默认目录，后续启动不再覆盖
    let cfg = config::AppConfig { vault_dir: dir, initialized: true };
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
    folder: Option<String>,
) -> Result<NoteMeta, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    // 新笔记：生成文件名，并落到指定文件夹（folder 为空表示根目录）
    let name = if file_name.is_empty() {
        let sub = match folder.as_deref().filter(|f| !f.is_empty()) {
            Some(f) => {
                store::create_folder(&dir, f)?;
                dir.join(f)
            }
            None => dir.clone(),
        };
        let base = dedup_name(&sub, format!("{}-{}.md", now_stamp(), slugify(&title)));
        match folder.as_deref().filter(|f| !f.is_empty()) {
            Some(f) => format!("{}/{}", f, base),
            None => base,
        }
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
        folder: name.split_once('/').map(|(f, _)| f.to_string()).unwrap_or_default(),
        title,
        tags,
        created,
        modified: String::new(),
    };
    store::write_note(&dir, &name, &Note { meta, content })?;
    store::read_note(&dir, &name).map(|n| n.meta)
}

#[tauri::command]
pub fn list_folders() -> Vec<String> {
    match vault_dir() {
        Some(d) => store::list_folders(&d),
        None => vec![],
    }
}

#[tauri::command]
pub fn create_folder(name: String) -> Result<(), String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::create_folder(&dir, &name)
}

#[tauri::command]
pub fn rename_folder(old_name: String, new_name: String) -> Result<(), String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::rename_folder(&dir, &old_name, &new_name)
}

#[tauri::command]
pub fn delete_folder(name: String) -> Result<(), String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::delete_folder(&dir, &name)
}

/// 移动笔记：target_folder 为 None/空表示移到根目录。
/// 目标重名时自动追加 -2、-3，返回移动后的新相对路径供前端更新当前文档状态。
#[tauri::command]
pub fn move_note(file_name: String, target_folder: Option<String>) -> Result<String, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    move_one(&dir, &file_name, target_folder.as_deref())
}

/// 选一张本地图片并读成 base64，供前端转存进库内 .assets/。含文件对话框，async 化。
/// 返回 (base64 数据, 扩展名)，取消时返回 None。
#[tauri::command(async)]
pub fn pick_image(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Option<PickedImage>, String> {
    use base64::Engine;
    let picked = app
        .dialog()
        .file()
        .set_title("选择图片")
        .set_parent(&window)
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "svg"])
        .blocking_pick_file();
    let path = match picked {
        Some(p) => p.to_string(),
        None => return Ok(None),
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    Ok(Some(PickedImage {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        ext,
    }))
}

#[derive(serde::Serialize)]
pub struct PickedImage {
    pub data: String,
    pub ext: String,
}

/// 资源子目录：粘贴/插入的图片落在这里。以点开头，会被 list_folders 当隐藏项跳过，
/// 因此不会作为笔记文件夹出现在侧栏。
pub const ASSETS_DIR: &str = ".assets";

/// 保存一张图片进库内 .assets/，返回可写进 Markdown 的相对路径（如 ".assets/paste-1.png"）。
/// 前端粘贴图片、插入截图都走这条；文件名带时间去重前缀，避免覆盖。
#[tauri::command]
pub fn save_asset(data_base64: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let ext = match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "svg" => "svg",
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("图片数据无效: {e}"))?;
    let assets = dir.join(ASSETS_DIR);
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let base = format!("img-{}.{}", now_stamp(), ext);
    let name = dedup_name(&assets, base);
    std::fs::write(assets.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(format!("{}/{}", ASSETS_DIR, name))
}

/// 读取库内相对路径的图片，返回 data URL 供预览直接显示。
/// 预览是 innerHTML 注入，file:// 相对路径在 WebView2 里加载不到，故统一转 data URL。
#[tauri::command]
pub fn read_asset(rel: String) -> Result<String, String> {
    use base64::Engine;
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() != 2 || parts[0] != ASSETS_DIR {
        return Err("非法资源路径".into());
    }
    store::validate_rel_path(&rel)?;
    let path = dir.join(ASSETS_DIR).join(parts[1]);
    if !path.is_file() {
        return Err("资源不存在".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 排序方式：modified（默认，修改时间倒序）/ created（创建时间倒序）/ title（标题字典序）。
#[tauri::command]
pub fn list_notes(sort: Option<String>) -> Vec<NoteMeta> {
    list_notes_sorted(vault_dir(), sort.as_deref())
}

/// 搜索：query 走标题/标签/正文全文；tags 与 folder 是结构化筛选（AND 组合，与 query 叠加）。
/// tags 只比对 frontmatter 的标签，避免把"正文里恰好出现该词"的笔记带出来。
#[tauri::command]
pub fn search_notes(
    query: String,
    sort: Option<String>,
    tags: Option<Vec<String>>,
    folder: Option<String>,
) -> Vec<NoteMeta> {
    let dir = match vault_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let q = query.trim().to_lowercase();
    let tag_filter: Vec<String> = tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    // None = 不按文件夹筛选；Some("") = 只看根目录
    let folder_filter = folder;
    let mut metas: Vec<NoteMeta> = store::list_notes(&dir)
        .into_iter()
        .filter(|m| {
            if let Some(f) = &folder_filter {
                if &m.folder != f {
                    return false;
                }
            }
            if !tag_filter.is_empty() {
                let have: Vec<String> = m.tags.iter().map(|t| t.to_lowercase()).collect();
                if !tag_filter.iter().all(|t| have.contains(t)) {
                    return false;
                }
            }
            if q.is_empty() {
                return true;
            }
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

/// 列出所有已用标签（去重、排序）。不受搜索筛选影响，供标签栏展示完整集合。
#[tauri::command]
pub fn list_tags() -> Vec<String> {
    let dir = match vault_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let mut set = std::collections::BTreeSet::new();
    for m in store::list_notes(&dir) {
        for t in m.tags {
            let t = t.trim().to_string();
            if !t.is_empty() {
                set.insert(t);
            }
        }
    }
    set.into_iter().collect()
}

/// 批量改写标签：把 from 标签在所有笔记里换成 to（to 为空表示删除该标签）。
/// 返回被改动的笔记数。
#[tauri::command]
pub fn rename_tag(from: String, to: String) -> Result<usize, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let from = from.trim().to_string();
    if from.is_empty() {
        return Err("原标签不能为空".into());
    }
    let to = to.trim().to_string();
    let mut changed = 0usize;
    for m in store::list_notes(&dir) {
        if !m.tags.iter().any(|t| t == &from) {
            continue;
        }
        let mut tags: Vec<String> = m
            .tags
            .iter()
            .map(|t| if t == &from { to.clone() } else { t.clone() })
            .filter(|t| !t.is_empty())
            .collect();
        // 合并去重，保留首次出现顺序
        let mut seen = std::collections::HashSet::new();
        tags.retain(|t| seen.insert(t.clone()));
        store::set_tags(&dir, &m.file_name, tags)?;
        changed += 1;
    }
    Ok(changed)
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

/// 把单个外部 .md 复制进笔记库。dest_dir/target 决定落到根目录还是某文件夹。
/// 文件名沿用原名（非法字符/重名由 dedup_name 兜底），不再强加时间戳前缀。
fn import_one(
    dir: &std::path::Path,
    dest_dir: &std::path::Path,
    target: Option<&str>,
    path: &std::path::Path,
) -> Result<NoteMeta, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取失败: {}", e))?;
    let (mut meta, content) = store::parse_frontmatter(&raw);
    let src_stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名".into());
    if meta.title.is_empty() {
        meta.title = src_stem.clone();
    }
    meta.tags = Vec::new();
    meta.created = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    meta.modified = String::new();
    // 优先保留原文件名（用户自己起的名更有意义），非法字符逐步丢弃后仍空则回退 slug
    let safe_stem = sanitize_stem(&src_stem);
    let desired = if safe_stem.is_empty() {
        format!("{}.md", slugify(&meta.title))
    } else {
        format!("{}.md", safe_stem)
    };
    let base = dedup_name(dest_dir, desired);
    let file_name = match target {
        Some(f) => format!("{}/{}", f, base),
        None => base,
    };
    meta.file_name = file_name.clone();
    meta.folder = target.unwrap_or("").to_string();
    store::write_note(dir, &file_name, &store::Note { meta, content })?;
    store::read_note(dir, &file_name).map(|n| n.meta)
}

/// 清洗文件名主干：替换 Windows 非法字符为 `-`，跳过纯空白，去掉首尾空格与点。
fn sanitize_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    cleaned.trim().trim_matches('.').trim().to_string()
}

/// 打开本地 .md 文件（可多选）：复制进笔记库，返回新笔记元数据列表。含文件对话框，async 化。
#[tauri::command(async)]
pub fn import_note(
    app: tauri::AppHandle,
    window: tauri::Window,
    folder: Option<String>,
) -> Result<Vec<NoteMeta>, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹，请先在顶栏设置文件夹")?;
    // 导入目标：folder 为空/缺省则落到库根目录
    let target = folder.as_deref().filter(|f| !f.is_empty()).map(|f| f.to_string());
    let dest_dir = match &target {
        Some(f) => {
            store::create_folder(&dir, f)?;
            dir.join(f)
        }
        None => dir.clone(),
    };
    let picked = app
        .dialog()
        .file()
        .set_title("打开 Markdown 文档")
        .set_parent(&window)
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_files();
    let paths = match picked {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for p in paths {
        // 单个文件失败不打断整批，跳过继续
        if let Ok(meta) = import_one(&dir, &dest_dir, target.as_deref(), std::path::Path::new(&p.to_string())) {
            out.push(meta);
        }
    }
    Ok(out)
}

/// 批量移动：逐个移到目标文件夹，重名自动改名。返回 (原路径, 新路径) 列表供前端更新状态。
#[tauri::command]
pub fn move_notes(
    file_names: Vec<String>,
    target_folder: Option<String>,
) -> Result<Vec<(String, String)>, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let mut out = Vec::new();
    for file_name in file_names {
        let dst = move_one(&dir, &file_name, target_folder.as_deref())?;
        out.push((file_name, dst));
    }
    Ok(out)
}

/// 单篇移动的核心：把 file_name 移到 target_folder（None/空 = 根目录），返回新相对路径。
fn move_one(dir: &std::path::Path, file_name: &str, target_folder: Option<&str>) -> Result<String, String> {
    let target = target_folder.filter(|f| !f.is_empty());
    let bare = file_name.rsplit('/').next().unwrap_or(file_name).to_string();
    let sub = match target {
        Some(f) => {
            store::create_folder(dir, f)?;
            dir.join(f)
        }
        None => dir.to_path_buf(),
    };
    let deduped = dedup_name(&sub, bare);
    let dst = match target {
        Some(f) => format!("{}/{}", f, deduped),
        None => deduped,
    };
    if dst == file_name {
        return Ok(dst);
    }
    store::move_note(dir, file_name, &dst)?;
    Ok(dst)
}
