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
/// 文件名格式是 `<创建时间戳>-<标题>.<扩展名>`：时间戳在前，所以按名字排序天然
/// 是"新建的在前"，排序规则切到「按标题」时同标题的新笔记也不会插进旧笔记中间。
/// 保留原扩展名：富文本笔记是 .html，不能被改回 .md。
fn dedup_name(dir: &std::path::Path, name: String) -> String {
    if name.is_empty() || !dir.join(&name).exists() {
        return name;
    }
    let ext = match name.rsplit_once('.') {
        Some((_, e)) if !e.is_empty() && e.len() <= 8 && !e.contains('/') => format!(".{}", e),
        _ => ".md".to_string(),
    };
    let stem = name[..name.len() - ext.len()].to_string();
    for n in 2..1000 {
        let candidate = format!("{}-{}{}", stem, n, ext);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{}-{}{}", stem, chrono::Utc::now().timestamp_millis(), ext)
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
    kind: Option<String>,
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
        // 类型只在创建时生效：扩展名据此确定，之后改名/移动都保留
        let kind = kind.as_deref().unwrap_or(store::KIND_MD);
        let ext = store::ext_for_kind(kind);
        let base = dedup_name(&sub, format!("{}-{}.{}", now_stamp(), slugify(&title), ext));
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
        kind: store::kind_of_name(&name).unwrap_or(store::KIND_MD).to_string(),
        tags,
        created,
        modified: String::new(),
        excerpt: String::new(),
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

/// 库里出现过的全部标签（去重、排序）：给标签输入框做候选。
/// 没有候选时同一个标签会被写成几种写法，而标签一旦写歪，筛选就对不上。
#[tauri::command]
pub fn list_tags() -> Vec<String> {
    let dir = match vault_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let mut set = std::collections::BTreeSet::new();
    for m in store::list_notes(&dir) {
        for t in m.tags {
            let t = t.trim();
            if !t.is_empty() {
                set.insert(t.to_string());
            }
        }
    }
    set.into_iter().collect()
}

/// 标签 + 使用篇数，供标签管理面板列出。
#[derive(serde::Serialize)]
pub struct TagCount {
    pub name: String,
    pub count: usize,
}

#[tauri::command]
pub fn list_tag_counts() -> Vec<TagCount> {
    let dir = match vault_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let mut map: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for m in store::list_notes(&dir) {
        for t in m.tags {
            let t = t.trim();
            if !t.is_empty() {
                *map.entry(t.to_string()).or_insert(0) += 1;
            }
        }
    }
    map.into_iter().map(|(name, count)| TagCount { name, count }).collect()
}

/// 标签改名的核心：把某个标签在所有笔记里换成 `to`（目标已存在即合并）。
/// 只改 frontmatter 的 tags，保留 modified；返回被改动的笔记数。
fn retag(dir: &std::path::Path, from: &str, to: Option<&str>) -> Result<usize, String> {
    let from_lc = from.to_lowercase();
    let mut changed = 0;
    for m in store::list_notes(dir) {
        let hit = m.tags.iter().any(|t| t.to_lowercase() == from_lc);
        if !hit {
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        let mut tags = Vec::new();
        for t in m.tags.iter() {
            let next = match to {
                Some(to) if t.to_lowercase() == from_lc => to.to_string(),
                Some(_) => t.clone(),
                None if t.to_lowercase() == from_lc => continue,
                None => t.clone(),
            };
            // 合并后可能出现重名（原笔记同时有 from 与 to）：按小写去重
            if seen.insert(next.to_lowercase()) {
                tags.push(next);
            }
        }
        store::rewrite_tags(dir, &m.file_name, tags)?;
        changed += 1;
    }
    Ok(changed)
}

/// 改名 / 合并：`to` 已存在时就是合并。返回被改动的笔记数。
#[tauri::command]
pub fn rename_tag(from: String, to: String) -> Result<usize, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let from = from.trim().to_string();
    let to = to.trim().trim_start_matches('#').trim().to_string();
    if from.is_empty() {
        return Err("原标签为空".into());
    }
    if to.is_empty() {
        return Err("新标签不能为空（要删除请用「删除标签」）".into());
    }
    if to.contains(',') || to.contains('，') {
        return Err("标签里不能包含逗号".into());
    }
    retag(&dir, &from, Some(&to))
}

/// 从所有笔记里摘掉某个标签（笔记本身保留）。返回被改动的笔记数。
#[tauri::command]
pub fn delete_tag(tag: String) -> Result<usize, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let tag = tag.trim().to_string();
    if tag.is_empty() {
        return Err("标签为空".into());
    }
    retag(&dir, &tag, None)
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

/// 图片上限：10 MB。超过则拒绝，避免把巨图塞进笔记库。
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// 支持的图片扩展名（其他格式一律拒绝，提示用户）。
pub fn normalize_image_ext(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        _ => None,
    }
}

/// 选一张本地图片并读成 base64，供前端转存进库内 .assets/。含文件对话框，async 化。
/// 只接受 png/jpg/jpeg 且不超过 10 MB，其余给出明确提示。
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
        .add_filter("图片", &["png", "jpg", "jpeg"])
        .blocking_pick_file();
    let path = match picked {
        Some(p) => p.to_string(),
        None => return Ok(None),
    };
    let raw_ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let ext = normalize_image_ext(&raw_ext)
        .ok_or("仅支持JPG、PNG、JPEG格式的图片")?
        .to_string();
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片大小不能超过10M".into());
    }
    Ok(Some(PickedImage {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        ext,
        name: std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
    }))
}

#[derive(serde::Serialize)]
pub struct PickedImage {
    pub data: String,
    pub ext: String,
    /// 原始文件名（含扩展名）。前端拿它当图片的 alt：alt 固定成"图片"时，
    /// 图片加载失败或者导出的 PDF 只剩一个空框，读者完全不知道那是什么。
    pub name: String,
}

/// 资源子目录：粘贴/插入的图片落在这里。以点开头，会被 list_folders 当隐藏项跳过，
/// 因此不会作为笔记文件夹出现在侧栏。
pub const ASSETS_DIR: &str = ".assets";

/// 保存一张图片进库内 .assets/，返回可写进 Markdown 的相对路径（如 ".assets/img-1.png"）。
/// 只接受 png/jpg/jpeg 且不超过 10 MB，其余拒绝；文件名带时间去重前缀，避免覆盖。
#[tauri::command]
pub fn save_asset(data_base64: String, ext: String) -> Result<String, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    save_asset_in(&dir, &data_base64, &ext)
}

/// save_asset 的核心：目录由调用方给定，便于测试。
pub fn save_asset_in(dir: &std::path::Path, data_base64: &str, ext: &str) -> Result<String, String> {
    use base64::Engine;
    let ext = normalize_image_ext(ext).ok_or("仅支持JPG、PNG、JPEG格式的图片")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("图片数据无效: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片大小不能超过10M".into());
    }
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
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    read_asset_in(&dir, &rel)
}

/// read_asset 的核心：目录由调用方给定，便于测试。
/// 读取不做格式白名单——写入端已经卡死了，这里只需保证历史文件的 MIME 正确以便预览显示。
pub fn read_asset_in(dir: &std::path::Path, rel: &str) -> Result<String, String> {
    use base64::Engine;
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() != 2 || parts[0] != ASSETS_DIR {
        return Err("非法资源路径".into());
    }
    store::validate_rel_path(rel)?;
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

/// 搜索：query 一次覆盖标题、标签与正文（模糊）。tags 与 folder 是结构化筛选
/// （AND 组合，与 query 叠加）。tags 只比对 frontmatter 的标签，避免把"正文里恰好出现该词"的笔记带出来。
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
    // 空格分隔多个关键词（与前端高亮的分词一致）：每个词都必须在标题/标签/正文里出现（AND）。
    // 单个词时与整串子串匹配完全相同。
    let terms = split_terms(&q);
    let tag_filter: Vec<String> = tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    // None = 不按文件夹筛选；Some("") = 只看根目录
    let folder_filter = folder;
    let mut metas: Vec<NoteMeta> = Vec::new();
    for mut m in store::list_notes(&dir) {
        if let Some(f) = &folder_filter {
            if &m.folder != f {
                continue;
            }
        }
        if !tag_filter.is_empty() {
            let have: Vec<String> = m.tags.iter().map(|t| t.to_lowercase()).collect();
            if !tag_filter.iter().all(|t| have.contains(t)) {
                continue;
            }
        }
        if terms.is_empty() {
            metas.push(m);
            continue;
        }
        // 正文只读一次：先按类型压成纯文本，再小写做匹配，最后用原文截命中片段。
        // 富文本正文是 HTML，不剥标签的话搜 "strong" 会命中所有加粗的笔记。
        let plain = store::read_note(&dir, &m.file_name)
            .map(|n| {
                if m.kind == store::KIND_RICH {
                    strip_html_tags(&n.content)
                } else {
                    n.content
                }
            })
            .unwrap_or_default();
        let content_lc = plain.to_lowercase();
        if !note_matches(&m, &content_lc, &terms) {
            continue;
        }
        // 命中片段以第一个关键词为中心：列表里能直接看出"为什么这条被搜出来"
        if let Some(snip) = snippet_around(&plain, &terms) {
            m.excerpt = snip;
        }
        metas.push(m);
    }
    sort_metas(&mut metas, sort.as_deref());
    metas
}

/// 以最早出现的关键词为中心截一段摘要（约 60 字符），前后加省略号。
/// 用字符下标而不是字节下标：中文关键词命中时按字节切会 panic。
fn snippet_around(text: &str, terms: &[String]) -> Option<String> {
    let lc = text.to_lowercase();
    let byte_pos = terms.iter().filter_map(|t| lc.find(t.as_str())).min()?;
    let hit_char = lc[..byte_pos].chars().count();
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let start = hit_char.saturating_sub(12);
    let end = (start + 60).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(chars[start..end].iter());
    if end < chars.len() {
        out.push('…');
    }
    let squeezed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if squeezed.is_empty() {
        None
    } else {
        Some(squeezed)
    }
}

/// 按空白拆分查询串为关键词（已小写）。空串得到空向量。
fn split_terms(q: &str) -> Vec<String> {
    q.split_whitespace().map(|t| t.to_string()).collect()
}

/// 把 HTML 正文压成纯文本供搜索：去掉标签与注释，块级标签换成空格，避免相邻词粘连。
fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// 关键词匹配：每个词都要命中标题、标签或正文之一（AND）；空关键词表视为全部命中。
fn note_matches(meta: &NoteMeta, content_lc: &str, terms: &[String]) -> bool {
    if terms.is_empty() {
        return true;
    }
    let title = meta.title.to_lowercase();
    let tags: Vec<String> = meta.tags.iter().map(|t| t.to_lowercase()).collect();
    terms.iter().all(|term| {
        title.contains(term) || tags.iter().any(|t| t.contains(term)) || content_lc.contains(term)
    })
}

/// 按 sort 取全量笔记列表（不带搜索），供前端无搜索时展示。
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
        // 时间/标题都没法区分先后时，用文件名（前缀是创建时间戳）兜底：
        // 同一秒建的两篇、同名同修改时间的两篇，也要按"新的在前"稳定下来。
        // 排序必须稳定，否则每刷新一次列表，并列项的顺序就跳一次。
        Some("created") => metas.sort_by(|a, b| {
            b.created.cmp(&a.created).then_with(|| b.file_name.cmp(&a.file_name))
        }),
        Some("title") => metas.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(|| b.file_name.cmp(&a.file_name))
        }),
        _ => metas.sort_by(|a, b| {
            b.modified.cmp(&a.modified).then_with(|| b.file_name.cmp(&a.file_name))
        }),
    }
}

/// 侧栏自定义顺序（文件夹之间 + 每个文件夹内的笔记）。由前端在拖动排序后整体写回。
#[tauri::command]
pub fn get_order() -> store::VaultOrder {
    vault_dir()
        .map(|d| store::read_order(&d))
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_order(order: store::VaultOrder) -> Result<(), String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    store::write_order(&dir, &order)
}

/// 删除笔记：前端已确认文件名，此处仅删除（保留给已有流程复用）。
/// 返回值 true=进了系统回收站，false=回收站不可用、已永久删除（前端要如实告知用户）。
#[tauri::command]
pub fn delete_note(file_name: String) -> Result<bool, String> {
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
    // 扩展名跟着源文件走：导入 .html 仍是一篇富文本笔记，不会被改写成 .md
    let safe_stem = sanitize_stem(&src_stem);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| store::kind_of_name(&format!("x.{}", e)).is_some())
        .unwrap_or_else(|| "md".to_string());
    let desired = if safe_stem.is_empty() {
        format!("{}.{}", slugify(&meta.title), ext)
    } else {
        format!("{}.{}", safe_stem, ext)
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
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
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
        .set_title("导入 Markdown 文档（复制进笔记库）")
        .set_parent(&window)
        .add_filter("Markdown / 富文本", &["md", "markdown", "html", "htm"])
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

#[cfg(test)]
mod asset_tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mv-asset-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn ext_whitelist_accepts_only_png_jpg_jpeg() {
        for ok in ["png", "PNG", "jpg", "JPG", "jpeg", "JPEG", "Jpeg"] {
            assert!(normalize_image_ext(ok).is_some(), "应接受 {ok}");
        }
        for bad in ["gif", "webp", "svg", "bmp", "tiff", "", "exe"] {
            assert!(normalize_image_ext(bad).is_none(), "应拒绝 {bad}");
        }
        // jpeg 统一归一化为 jpg
        assert_eq!(normalize_image_ext("jpeg"), Some("jpg"));
        assert_eq!(normalize_image_ext("JPEG"), Some("jpg"));
    }

    #[test]
    fn size_limit_is_ten_megabytes() {
        assert_eq!(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
    }

    #[test]
    fn save_asset_writes_into_assets_dir() {
        let dir = tmp("save");
        let rel = save_asset_in(&dir, &b64(b"PNGDATA"), "png").unwrap();
        assert!(rel.starts_with(".assets/") && rel.ends_with(".png"), "返回 {rel}");
        // 文件确实落到磁盘，内容一致
        let written = std::fs::read(dir.join(&rel)).unwrap();
        assert_eq!(written, b"PNGDATA");
        // .assets 不会作为笔记文件夹被列出
        assert!(!crate::store::list_folders(&dir).contains(&".assets".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_asset_rejects_bad_ext_and_oversize() {
        let dir = tmp("reject");
        assert_eq!(save_asset_in(&dir, &b64(b"x"), "gif").unwrap_err(), "仅支持JPG、PNG、JPEG格式的图片");
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        assert_eq!(save_asset_in(&dir, &b64(&big), "png").unwrap_err(), "图片大小不能超过10M");
        // 拒绝时不应落盘
        assert!(!dir.join(".assets").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_asset_dedups_same_second_names() {
        let dir = tmp("dedup");
        let a = save_asset_in(&dir, &b64(b"ONE"), "png").unwrap();
        let b = save_asset_in(&dir, &b64(b"TWO"), "jpg").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(dir.join(&a)).unwrap(), b"ONE");
        assert_eq!(std::fs::read(dir.join(&b)).unwrap(), b"TWO");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_asset_roundtrips_as_data_url() {
        let dir = tmp("read");
        let rel = save_asset_in(&dir, &b64(b"HELLO"), "png").unwrap();
        let url = read_asset_in(&dir, &rel).unwrap();
        assert_eq!(url, format!("data:image/png;base64,{}", b64(b"HELLO")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_asset_rejects_traversal_and_missing() {
        let dir = tmp("readbad");
        for bad in [".assets/../config.json", "other/x.png", ".assets/a/b.png", "../../etc/passwd"] {
            assert!(read_asset_in(&dir, bad).is_err(), "应拒绝 {bad}");
        }
        assert!(read_asset_in(&dir, ".assets/nope.png").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    fn meta(title: &str, tags: &[&str]) -> NoteMeta {
        NoteMeta {
            file_name: format!("{}.md", title),
            folder: String::new(),
            title: title.to_string(),
            kind: String::new(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            created: String::new(),
            modified: String::new(),
            excerpt: String::new(),
        }
    }

    #[test]
    fn single_term_matches_title_tag_or_content() {
        let terms = split_terms("工作");
        assert!(note_matches(&meta("会议纪要", &["工作"]), "", &terms)); // 标签命中
        assert!(note_matches(&meta("工作总结", &[]), "", &terms));      // 标题命中
        assert!(note_matches(&meta("随笔", &[]), "今天工作很忙", &terms)); // 正文命中
        assert!(!note_matches(&meta("随笔", &[]), "今天很闲", &terms));
    }

    #[test]
    fn multiple_terms_require_all_present() {
        let terms = split_terms("会议 纪要");
        // 标题里同时含两个词
        assert!(note_matches(&meta("会议纪要", &[]), "", &terms));
        // 一个词在标题、一个词在正文：仍算命中
        assert!(note_matches(&meta("会议安排", &[]), "这是纪要草稿", &terms));
        // 只含一个词：不命中
        assert!(!note_matches(&meta("会议安排", &[]), "没有那个词", &terms));
    }

    #[test]
    fn empty_query_matches_everything() {
        assert!(split_terms("").is_empty());
        assert!(note_matches(&meta("任意", &[]), "", &[]));
        // 多余空白不产生空关键词
        assert_eq!(split_terms("  a   b "), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn matching_is_case_insensitive() {
        let terms = split_terms("hello");
        // note_matches 约定：title/tags 内部自会小写，content 由调用方预先小写
        assert!(note_matches(&meta("HELLO world", &[]), "", &terms));
        assert!(note_matches(&meta("x", &[]), "say hello there", &terms));
    }

    #[test]
    fn html_content_is_stripped_before_matching() {
        // 富文本笔记正文是 HTML：标签必须剥掉，否则搜 "strong" 会命中所有加粗的笔记
        let stripped = strip_html_tags("<p><strong>加粗</strong>正文</p>");
        // 标签位置换成空格：搜索按关键词拆分，多余空格无害
        assert_eq!(stripped.split_whitespace().collect::<String>(), "加粗正文");
        assert!(!stripped.contains('<'));
        // 相邻块级元素之间留空格，避免两个词粘成一个
        let spaced = strip_html_tags("<p>甲</p><p>乙</p>");
        assert!(spaced.contains("甲") && spaced.contains("乙"));
        let terms = split_terms("strong");
        assert!(!note_matches(&meta("笔记", &[]), &strip_html_tags("<p><strong>x</strong></p>").to_lowercase(), &terms));
    }
}
