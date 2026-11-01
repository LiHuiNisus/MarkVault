use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMeta {
    /// 相对路径：根目录为裸文件名，文件夹内为 "文件夹/文件名"。前端直接当唯一键用。
    #[serde(default)]
    pub file_name: String,
    /// 所属文件夹名，根目录为空串。不入 frontmatter（磁盘位置才是事实来源）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder: String,
    #[serde(default)]
    pub title: String,
    /// 笔记类型："md"（Markdown）或 "rich"（富文本 HTML）。由磁盘扩展名推出，不写进 frontmatter。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub modified: String,
    /// 列表里显示的一行摘要（由正文派生，不落盘）。列表只拿元数据，
    /// 没有它侧栏就只能显示标题+时间，翻找时缺少判断依据。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub content: String,
}

/// 侧栏自定义排序：文件夹之间的顺序 + 每个文件夹（根目录用空串作键）内的笔记顺序。
/// 存在库根的 `.markvault-order.json`（不是笔记，扩展名不是笔记类型，扫描时自动跳过）。
/// 顺序是展示元数据，不写进任何笔记的 frontmatter。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VaultOrder {
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub notes: std::collections::HashMap<String, Vec<String>>,
}

/// 排序文件：点开头，资源管理器里默认隐藏，也不会被当成文件夹或笔记列出。
pub const ORDER_FILE: &str = ".markvault-order.json";

/// 读取排序文件。文件不存在或内容损坏时返回空顺序（前端会按当前列表补齐），不报错。
pub fn read_order(dir: &Path) -> VaultOrder {
    let raw = match std::fs::read_to_string(dir.join(ORDER_FILE)) {
        Ok(r) => r,
        Err(_) => return VaultOrder::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn write_order(dir: &Path, order: &VaultOrder) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(order).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(ORDER_FILE), raw).map_err(|e| e.to_string())
}

/// 笔记的两种类型：Markdown 与富文本。类型在创建时确定，之后不可更改。
/// 类型落在文件扩展名上（.md / .html），磁盘是唯一事实来源，不写进 frontmatter。
pub const KIND_MD: &str = "md";
pub const KIND_RICH: &str = "rich";

/// 类型对应的文件扩展名（不含点）。
pub fn ext_for_kind(kind: &str) -> &'static str {
    if kind == KIND_RICH { "html" } else { "md" }
}

/// 从文件名/相对路径推导笔记类型。非笔记扩展名返回 None。
pub fn kind_of_name(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => Some(KIND_MD),
        "html" | "htm" => Some(KIND_RICH),
        _ => None,
    }
}

/// 去掉笔记扩展名，得到文件名主干。非笔记扩展名原样返回。
pub fn strip_note_ext(name: &str) -> &str {
    for ext in [".md", ".markdown", ".html", ".htm"] {
        if let Some(stem) = name.strip_suffix(ext) {
            return stem;
        }
        // 大小写不敏感：Windows 上 `A.MD` 也能打开。
        // 中文文件名是多字节，切之前必须确认落在字符边界上，否则 panic。
        let cut = name.len().saturating_sub(ext.len());
        if cut > 0
            && name.is_char_boundary(cut)
            && name[cut..].eq_ignore_ascii_case(ext)
        {
            return &name[..cut];
        }
    }
    name
}

/// frontmatter 采用 JSON（YAML 子集）：第一行 `---`，第二行 JSON 对象，第三行 `---`。
/// CRLF 文件先归一化为 LF，否则 `\n---\n` 永远匹配不到（Windows 记事本编辑过的文件会丢元数据）。
pub fn parse_frontmatter(raw: &str) -> (NoteMeta, String) {
    let raw = &raw.replace("\r\n", "\n");
    let mut lines = raw.lines();
    let fallback = NoteMeta {
        file_name: String::new(),
        folder: String::new(),
        title: String::new(),
        kind: String::new(),
        tags: vec![],
        created: String::new(),
        modified: String::new(),
        excerpt: String::new(),
    };
    if lines.next() != Some("---") {
        return (fallback, raw.to_string());
    }
    let json_line = match lines.next() {
        Some(l) if l.trim().starts_with('{') => l,
        _ => return (fallback, raw.to_string()),
    };
    let rest_start = raw.find('\n').map(|i| i + 1).unwrap_or(0);
    let rest = &raw[rest_start..];
    let after_meta = match rest.find("\n---\n") {
        Some(i) => &rest[i + 5..],
        None => match rest.strip_prefix("---\n") {
            Some(s) => s,
            None => return (fallback, raw.to_string()),
        },
    };
    match serde_json::from_str::<NoteMeta>(json_line) {
        Ok(meta) => (meta, after_meta.to_string()),
        Err(_) => (fallback, raw.to_string()),
    }
}

pub fn serialize_note(meta: &NoteMeta, content: &str) -> String {
    // kind 由磁盘扩展名推出，不落进 frontmatter：文件改名后元数据不会自相矛盾
    let mut meta = meta.clone();
    meta.kind = String::new();
    // excerpt 是列表用的派生数据：写进 frontmatter 只会随着正文改动变成脏数据
    meta.excerpt = String::new();
    let json = serde_json::to_string(&meta).unwrap_or_default();
    format!("---\n{}\n---\n{}", json, content)
}

/* ---------- 列表摘要 ---------- */

const EXCERPT_CHARS: usize = 80;

/// 把正文压成一行摘要：跳过代码块与空行，剥掉 Markdown 标记与链接地址。
/// 列表用它给"这篇讲什么"一个判断依据，比只显示标题+时间有用得多。
pub fn make_excerpt(content: &str, kind: &str) -> String {
    let src = if kind == KIND_RICH {
        strip_html_text(content)
    } else {
        content.to_string()
    };
    let mut out = String::new();
    let mut in_fence = false;
    for line in src.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || t.is_empty() {
            continue;
        }
        // 表格分隔行（|---|---|）只剩符号，摘要里是纯噪音
        if (t.chars().all(|c| matches!(c, '-' | ':' | '|' | ' '))) {
            continue;
        }
        let cleaned = clean_md_line(t);
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&cleaned);
        if out.chars().count() >= EXCERPT_CHARS {
            break;
        }
    }
    truncate_chars(collapse_spaces(&out), EXCERPT_CHARS)
}

/// 富文本：去掉标签与注释，块级标签位置补空格，避免相邻段落粘成一个词。
fn strip_html_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// 去掉行内 Markdown 标记；`[文字](链接)` / `![alt](图)` 只保留可见文字，
/// 否则摘要里会出现一长串 URL，把真正有用的内容挤掉。
fn clean_md_line(line: &str) -> String {
    let cs: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '!' && i + 1 < cs.len() && cs[i + 1] == '[' {
            if let Some((label, next)) = take_label(&cs, i + 2) {
                out.push_str(&label);
                i = next;
                continue;
            }
        }
        if c == '[' {
            if let Some((label, next)) = take_label(&cs, i + 1) {
                out.push_str(&label);
                i = next;
                continue;
            }
        }
        if matches!(c, '#' | '*' | '`' | '>' | '|' | '~' | '_' | '[' | ']') {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    // 列表项与任务项的行首标记（"- "、"- [ ] "）对摘要没有信息量，只留正文
    collapse_spaces(&out)
        .trim_start_matches(|c: char| c == '-' || c == '+' || c == '•' || c == ' ')
        .to_string()
}

/// 读 `[标签](地址)`：返回标签文本与收尾下标（指向 `)` 之后）。
fn take_label(cs: &[char], start: usize) -> Option<(String, usize)> {
    let mut j = start;
    let mut label = String::new();
    while j < cs.len() && cs[j] != ']' {
        label.push(cs[j]);
        j += 1;
    }
    if j >= cs.len() {
        return None;
    }
    j += 1; // 跳过 ]
    if j < cs.len() && cs[j] == '(' {
        let mut depth = 1;
        j += 1;
        while j < cs.len() && depth > 0 {
            match cs[j] {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            j += 1;
        }
    }
    Some((label, j))
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 扫描单侧目录中的笔记（.md / .html），rel_prefix 为 None（根）或 Some("文件夹名")。
fn collect_notes(dir: &Path, rel_prefix: Option<&str>, metas: &mut Vec<NoteMeta>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        // 只认笔记扩展名：.md / .markdown / .html / .htm。图片、临时文件一律跳过。
        if kind_of_name(&name).is_none() {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let (mut meta, content) = parse_frontmatter(&raw);
        if meta.title.is_empty() {
            meta.title = strip_note_ext(&name).to_string();
        }
        if meta.created.is_empty() {
            // created 为空时回退到文件系统创建时间
            meta.created = entry
                .metadata()
                .ok()
                .and_then(|m| m.created().ok())
                .map(|t| {
                    chrono::DateTime::<chrono::Local>::from(t)
                        .format("%Y-%m-%dT%H:%M:%S")
                        .to_string()
                })
                .unwrap_or_default();
        }
        // file_name 存相对路径：根目录是裸文件名，文件夹内是 "文件夹/文件名"；folder 单独存一份便于前端分组
        meta.folder = rel_prefix.unwrap_or("").to_string();
        meta.kind = kind_of_name(&name).unwrap_or(KIND_MD).to_string();
        meta.file_name = match rel_prefix {
            Some(p) => format!("{}/{}", p, name),
            None => name.clone(),
        };
        meta.excerpt = make_excerpt(&content, meta.kind.as_str());
        metas.push(meta);
    }
}

/// 列出笔记：根目录 + 一层子文件夹。只认一层，文件夹内不再递归。
pub fn list_notes(dir: &Path) -> Vec<NoteMeta> {
    let mut metas = Vec::new();
    collect_notes(dir, None, &mut metas);
    for folder in list_folders(dir) {
        collect_notes(&dir.join(&folder), Some(&folder), &mut metas);
    }
    metas.sort_by(|a, b| b.modified.cmp(&a.modified));
    metas
}

/// 列出 vault 下的一层文件夹名（跳过隐藏项），按名称排序。
pub fn list_folders(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return names,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        names.push(name);
    }
    names.sort();
    names
}

/// 单个路径段校验：拒绝路径穿越、盘符/ADS 冒号、Windows 非法字符。
fn validate_segment(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err("非法名称".into());
    }
    Ok(())
}

/// 笔记相对路径校验：允许「文件名」或「文件夹名/文件名」两种形态，至多一层文件夹。
/// 每段单独跑 validate_segment，所以 `../x`、`a/../../b`、`C:x` 这类仍被拦下。
pub fn validate_rel_path(rel: &str) -> Result<(), String> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err("非法路径：只支持一层文件夹".into());
    }
    for p in parts {
        validate_segment(p)?;
    }
    Ok(())
}

/// 校验文件名后拼出笔记绝对路径；不检查文件是否存在。
/// rel 允许一层文件夹（"folder/note.md"），逐段校验防穿越。
pub fn resolve_note_path(dir: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    validate_rel_path(rel)?;
    let mut path = dir.to_path_buf();
    for seg in rel.split('/') {
        path.push(seg);
    }
    Ok(path)
}

pub fn read_note(dir: &Path, file_name: &str) -> Result<Note, String> {
    let path = resolve_note_path(dir, file_name)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (mut meta, content) = parse_frontmatter(&raw);
    if meta.title.is_empty() {
        // 无 frontmatter 时用文件名兜底；文件夹路径需剥掉前缀
        let base = file_name.rsplit('/').next().unwrap_or(file_name);
        meta.title = strip_note_ext(base).to_string();
    }
    // 类型永远由磁盘扩展名决定，frontmatter 里即便写了 kind 也不采信
    meta.kind = kind_of_name(file_name).unwrap_or(KIND_MD).to_string();
    // 磁盘位置才是事实来源：frontmatter 里的 folder 一律忽略
    meta.folder = match file_name.rsplit_once('/') {
        Some((f, _)) => f.to_string(),
        None => String::new(),
    };
    meta.file_name = file_name.to_string();
    // 保存/读取都会把 meta 回给前端，摘要跟着内容一起给：列表行更新时不必再读一次盘
    meta.excerpt = make_excerpt(&content, meta.kind.as_str());
    Ok(Note { meta, content })
}

pub fn write_note(dir: &Path, file_name: &str, note: &Note) -> Result<(), String> {
    let path = resolve_note_path(dir, file_name)?;
    // 目标可能在文件夹内，先建出文件夹（根目录时 parent 就是 dir，无害）
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut meta = note.meta.clone();
    meta.modified = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let raw = serialize_note(&meta, &note.content);
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

/// 只改标签、不碰正文与 modified。
/// 标签改名/删除是"整理元数据"，不是编辑内容：沿用 write_note 会把 modified 改成现在，
/// 一次整理就把整库的「按修改时间」排序打乱，用户看到的是一堆笔记突然跳到最前。
pub fn rewrite_tags(dir: &Path, file_name: &str, tags: Vec<String>) -> Result<(), String> {
    let note = read_note(dir, file_name)?;
    let mut meta = note.meta.clone();
    meta.tags = tags;
    meta.excerpt = String::new();
    let raw = serialize_note(&meta, &note.content);
    let path = resolve_note_path(dir, file_name)?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

/// 删除笔记：交给系统回收站，用户可以自己到回收站里找回。
/// 回收站不可用时（如网络盘）退回直接删除，保证删除动作不会卡住——但这条路径是
/// **永久删除**，调用方必须知道。返回 `true` 表示进了回收站，`false` 表示已永久删除。
pub fn delete_note(dir: &Path, file_name: &str) -> Result<bool, String> {
    let path = resolve_note_path(dir, file_name)?;
    if !path.exists() {
        return Err("笔记不存在".into());
    }
    if move_to_recycle_bin(&path).is_ok() {
        return Ok(true);
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(false)
}

/// 把文件送进系统回收站（要求用户能从回收站恢复）。
/// `FOF_ALLOWUNDO` 是「进回收站」而非永久删除的关键标志；加 NOCONFIRMATION/SILENT/NOERRORUI
/// 让这次操作完全静默——是否需要确认由应用自己的弹窗负责。
#[cfg(windows)]
fn move_to_recycle_bin(path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, SHFILEOPSTRUCTW, FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_NOCONFIRMATION,
        FOF_SILENT, FO_DELETE,
    };

    // pFrom 要求双 NUL 结尾的宽字符串（列表以空串收尾）
    let mut wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().collect();
    wide.push(0);
    wide.push(0);

    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("移入回收站失败（错误码 {rc}）"));
    }
    if !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else {
        Err("移入回收站被中止".into())
    }
}

#[cfg(not(windows))]
fn move_to_recycle_bin(path: &Path) -> Result<(), String> {
    let _ = path;
    Err("仅 Windows 支持回收站".into())
}

/// 移动/改名笔记：src → dst 均为相对路径（可含一层文件夹）。
/// 目标已存在时抛错，交由命令层决策（不静默覆盖）。跨盘符 rename 失败退回复制+删除。
pub fn move_note(dir: &Path, src: &str, dst: &str) -> Result<(), String> {
    let from = resolve_note_path(dir, src)?;
    let to = resolve_note_path(dir, dst)?;
    if !from.exists() {
        return Err("原始笔记不存在".into());
    }
    if to.exists() {
        return Err("目标位置已存在同名笔记".into());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(&from, &to).is_err() {
        std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        std::fs::remove_file(&from).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 新建文件夹：目录已存在则直接成功（幂等），便于重复点击。
pub fn create_folder(dir: &Path, name: &str) -> Result<(), String> {
    validate_segment(name)?;
    std::fs::create_dir_all(dir.join(name)).map_err(|e| e.to_string())
}

/// 重命名文件夹，并把其中笔记 frontmatter 之外的引用保持不变（文件随目录整体迁移）。
pub fn rename_folder(dir: &Path, old_name: &str, new_name: &str) -> Result<(), String> {
    validate_segment(old_name)?;
    validate_segment(new_name)?;
    let from = dir.join(old_name);
    let to = dir.join(new_name);
    if !from.is_dir() {
        return Err("文件夹不存在".into());
    }
    if to.exists() && to != from {
        return Err("同名文件夹已存在".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 删除文件夹：仅允许空文件夹，避免连带删掉笔记。
/// 非空时返回明确的错误提示，由用户先移出内容。
pub fn delete_folder(dir: &Path, name: &str) -> Result<(), String> {
    validate_segment(name)?;
    let path = dir.join(name);
    if !path.is_dir() {
        return Err("文件夹不存在".into());
    }
    let count = std::fs::read_dir(&path).map_err(|e| e.to_string())?.count();
    if count > 0 {
        return Err("文件夹非空，请先移出其中的笔记".into());
    }
    std::fs::remove_dir(path).map_err(|e| e.to_string())
}

/// 只改标签、不动 modified 的落盘（批量改标签时不该把全部笔记顶到"最近修改"）。
pub fn set_tags(dir: &Path, file_name: &str, tags: Vec<String>) -> Result<(), String> {
    let mut note = read_note(dir, file_name)?;
    let modified = note.meta.modified.clone();
    note.meta.tags = tags;
    let mut meta = note.meta;
    meta.modified = modified;
    let raw = serialize_note(&meta, &note.content);
    let path = resolve_note_path(dir, file_name)?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

pub fn rename_note(dir: &Path, file_name: &str, new_title: &str) -> Result<NoteMeta, String> {
    let mut note = read_note(dir, file_name)?;
    let modified = note.meta.modified.clone();
    note.meta.title = new_title.to_string();
    // 直接落盘，跳过 write_note（它会刷新 modified）；仅标题变化不改"最近修改"排序位置
    let mut meta = note.meta;
    meta.modified = modified;
    let raw = serialize_note(&meta, &note.content);
    let path = resolve_note_path(dir, file_name)?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir() -> std::path::PathBuf {
        // keep(): 不自动删除（与旧 into_path 语义一致），tempfile 3.20+ 替代已废弃的 into_path
        tempfile::tempdir().unwrap().keep()
    }

    const SAMPLE: &str = "---\n{\"title\": \"测试笔记\", \"tags\": [\"工作\", \"灵感\"], \"created\": \"2026-10-05T10:00:00\", \"modified\": \"2026-10-05T10:00:00\"}\n---\n正文第一行\n";

    #[test]
    fn test_parse_frontmatter_ok() {
        let (meta, content) = parse_frontmatter(SAMPLE);
        assert_eq!(meta.title, "测试笔记");
        assert_eq!(meta.tags, vec!["工作".to_string(), "灵感".to_string()]);
        assert_eq!(content, "正文第一行\n");
    }

    #[test]
    fn test_parse_no_frontmatter() {
        let (meta, content) = parse_frontmatter("没有元数据");
        assert_eq!(meta.title, ""); // 前端回退用文件名
        assert_eq!(content, "没有元数据");
    }

    #[test]
    fn test_parse_broken_frontmatter() {
        let (meta, content) = parse_frontmatter("---\n{broken\n---\n正文");
        assert_eq!(meta.title, "");
        assert_eq!(content, "---\n{broken\n---\n正文");
    }

    #[test]
    fn test_kind_from_extension_and_not_serialized() {
        assert_eq!(kind_of_name("a.md"), Some(KIND_MD));
        assert_eq!(kind_of_name("a.MD"), Some(KIND_MD));
        assert_eq!(kind_of_name("a.markdown"), Some(KIND_MD));
        assert_eq!(kind_of_name("a.html"), Some(KIND_RICH));
        assert_eq!(kind_of_name("a.HTM"), Some(KIND_RICH));
        assert_eq!(kind_of_name("a.png"), None);
        assert_eq!(kind_of_name("noext"), None);
        assert_eq!(strip_note_ext("标题.html"), "标题");
        assert_eq!(strip_note_ext("标题.md"), "标题");
        assert_eq!(strip_note_ext("标题.txt"), "标题.txt");
        // 类型由磁盘扩展名推出，不能写进 frontmatter：文件改名后元数据会自相矛盾
        let meta = NoteMeta {
            file_name: "n.html".into(),
            folder: String::new(),
            title: "T".into(),
            kind: KIND_RICH.into(),
            tags: vec![],
            created: String::new(),
            modified: String::new(),
            excerpt: String::new(),
        };
        let raw = serialize_note(&meta, "x");
        assert!(!raw.contains("\"kind\""), "{}", raw);
    }

    #[test]
    fn test_list_notes_sees_html_and_md() {
        let dir = tmp_dir();
        fs::write(
            dir.join("a.html"),
            "---\n{\"title\":\"富文本\",\"tags\":[],\"created\":\"2026-01-01T00:00:00\",\"modified\":\"2026-01-02T00:00:00\"}\n---\n<p>x</p>",
        )
        .unwrap();
        fs::write(
            dir.join("b.md"),
            "---\n{\"title\":\"Markdown\",\"tags\":[],\"created\":\"2026-01-01T00:00:00\",\"modified\":\"2026-01-01T00:00:00\"}\n---\n# x",
        )
        .unwrap();
        let list = list_notes(&dir);
        assert_eq!(list.len(), 2);
        let rich = list.iter().find(|m| m.file_name == "a.html").unwrap();
        assert_eq!(rich.kind, KIND_RICH);
        let md = list.iter().find(|m| m.file_name == "b.md").unwrap();
        assert_eq!(md.kind, KIND_MD);
        // 读取时同样按扩展名还原类型
        assert_eq!(read_note(&dir, "a.html").unwrap().meta.kind, KIND_RICH);
    }

    #[test]
    fn test_serialize_roundtrip() {
        let meta = NoteMeta {
            file_name: "20261005-100000-测试.md".into(),
            folder: String::new(),
            title: "测试笔记".into(),
            kind: String::new(),
            tags: vec!["a".into()],
            created: "2026-10-05T10:00:00".into(),
            modified: "2026-10-05T10:00:00".into(),
            excerpt: String::new(),
        };
        let raw = serialize_note(&meta, "正文");
        let (meta2, content2) = parse_frontmatter(&raw);
        assert_eq!(meta2.title, "测试笔记");
        assert_eq!(content2, "正文");
    }

    #[test]
    fn test_list_notes_sorted_by_modified_desc() {
        let dir = tmp_dir();
        fs::write(dir.join("a.md"), "---\n{\"title\":\"A\",\"tags\":[],\"created\":\"2026-01-01T00:00:00\",\"modified\":\"2026-01-01T00:00:00\"}\n---\nx").unwrap();
        fs::write(dir.join("b.md"), "---\n{\"title\":\"B\",\"tags\":[],\"created\":\"2026-01-02T00:00:00\",\"modified\":\"2026-01-02T00:00:00\"}\n---\nx").unwrap();
        let list = list_notes(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "B");
    }

    #[test]
    fn test_write_note_updates_modified() {
        let dir = tmp_dir();
        let meta = NoteMeta {
            file_name: "n.md".into(), folder: String::new(), title: "N".into(), kind: String::new(), tags: vec![],
            created: "2026-01-01T00:00:00".into(), modified: "2026-01-01T00:00:00".into(),
            excerpt: String::new(),
        };
        write_note(&dir, "n.md", &Note { meta, content: "c".into() }).unwrap();
        let note = read_note(&dir, "n.md").unwrap();
        assert!(note.meta.modified.as_str() > "2026-01-01");
    }

    #[test]
    fn test_rewrite_tags_keeps_modified_and_content() {
        let dir = tmp_dir();
        let meta = NoteMeta {
            file_name: "t.md".into(), folder: String::new(), title: "T".into(), kind: String::new(),
            tags: vec!["旧".into(), "保留".into()],
            created: "2026-01-01T00:00:00".into(), modified: "2026-01-02T00:00:00".into(),
            excerpt: String::new(),
        };
        write_note(&dir, "t.md", &Note { meta, content: "正文不动".into() }).unwrap();
        let before = read_note(&dir, "t.md").unwrap();
        rewrite_tags(&dir, "t.md", vec!["新".into(), "保留".into()]).unwrap();
        let after = read_note(&dir, "t.md").unwrap();
        assert_eq!(after.meta.tags, vec!["新".to_string(), "保留".to_string()]);
        assert_eq!(after.content, "正文不动");
        // 标签是元数据：整理标签不该把笔记的修改时间刷新成现在
        assert_eq!(after.meta.modified, before.meta.modified);
    }

    #[test]
    fn test_make_excerpt_strips_markup_and_truncates() {        let md = "# 标题\n\n- [ ] 待办事项\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n**加粗** 与 [链接](https://example.com) 还有 `代码`";
        let ex = make_excerpt(md, KIND_MD);
        assert!(ex.contains("待办事项"), "{}", ex);
        assert!(!ex.contains("https"), "URL 不该进摘要: {}", ex);
        assert!(!ex.contains('['), "{}", ex);
        assert!(!ex.contains('#'), "{}", ex);
        assert!(!ex.contains("---"), "{}", ex);
        let long = "字".repeat(200);
        let cut = make_excerpt(&long, KIND_MD);
        assert_eq!(cut.chars().count(), EXCERPT_CHARS + 1);
        assert!(cut.ends_with('…'));
    }
}

#[cfg(test)]
mod order_tests {
    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        tempfile::tempdir().unwrap().keep()
    }

    #[test]
    fn test_order_roundtrip() {
        let dir = tmp_dir();
        let mut notes = std::collections::HashMap::new();
        notes.insert("".to_string(), vec!["b.md".to_string(), "a.md".to_string()]);
        notes.insert("工作".to_string(), vec!["工作/x.md".to_string()]);
        let order = VaultOrder { folders: vec!["工作".into()], notes };
        write_order(&dir, &order).unwrap();
        let back = read_order(&dir);
        assert_eq!(back.folders, vec!["工作".to_string()]);
        assert_eq!(back.notes[""], vec!["b.md".to_string(), "a.md".to_string()]);
        assert_eq!(back.notes["工作"], vec!["工作/x.md".to_string()]);
    }

    #[test]
    fn test_order_missing_file_is_empty() {
        let dir = tmp_dir();
        let back = read_order(&dir);
        assert!(back.folders.is_empty());
        assert!(back.notes.is_empty());
    }

    #[test]
    fn test_order_broken_file_is_empty() {
        let dir = tmp_dir();
        std::fs::write(dir.join(ORDER_FILE), "{not json").unwrap();
        // 损坏的排序文件不能拖垮启动：读成空顺序，前端会按当前列表重建
        let back = read_order(&dir);
        assert!(back.folders.is_empty());
    }

    #[test]
    fn test_order_file_not_listed_as_note_or_folder() {
        let dir = tmp_dir();
        std::fs::write(dir.join(ORDER_FILE), "{\"folders\":[],\"notes\":{}}").unwrap();
        std::fs::write(dir.join("a.md"), "---\n{\"title\":\"A\"}\n---\nx").unwrap();
        // .markvault-order.json 是点开头的非笔记文件，既不能出现在笔记列表里，也不能当文件夹
        let list = list_notes(&dir);
        assert_eq!(list.len(), 1, "{:?}", list.iter().map(|m| &m.file_name).collect::<Vec<_>>());
        assert!(list_folders(&dir).is_empty());
    }
}

#[cfg(test)]
mod crlf_tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter_crlf() {
        let raw = "---\r\n{\"title\": \"CRLF笔记\", \"tags\": [\"a\"], \"created\": \"2026-01-01T00:00:00\", \"modified\": \"2026-01-01T00:00:00\"}\r\n---\r\n正文\r\n";
        let (meta, content) = parse_frontmatter(raw);
        assert_eq!(meta.title, "CRLF笔记");
        assert_eq!(meta.tags, vec!["a"]);
        assert!(content.starts_with("正文"));
    }

    #[test]
    fn test_validate_rel_path() {
        assert!(validate_rel_path("a.md").is_ok());
        assert!(validate_rel_path("工作/a.md").is_ok());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../x.md").is_err());
        assert!(validate_rel_path("C:notes.md").is_err());
        assert!(validate_rel_path("a.md:ads").is_err());
        assert!(validate_rel_path("a<b>.md").is_err());
        // 只允许一层文件夹，且每段都要过校验
        assert!(validate_rel_path("a/b/c.md").is_err());
        assert!(validate_rel_path("a//b.md").is_err());
        assert!(validate_rel_path("a/../../b.md").is_err());
        assert!(validate_rel_path("sub/").is_err());
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_rename_preserves_modified() {
        let dir = PathBuf::from(std::env::temp_dir().join(format!("mvtest-{}", std::process::id())));
        std::fs::create_dir_all(&dir).unwrap();
        let meta = NoteMeta {
            file_name: "r.md".into(),
            folder: String::new(),
            title: "旧".into(),
            kind: String::new(),
            tags: vec![],
            created: "2026-01-01T00:00:00".into(),
            modified: "2026-01-02T00:00:00".into(),
            excerpt: String::new(),
        };
        write_note(&dir, "r.md", &Note { meta, content: "x".into() }).unwrap();
        let m1 = read_note(&dir, "r.md").unwrap().meta.modified;
        assert_ne!(m1, "");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let after = rename_note(&dir, "r.md", "新").unwrap();
        assert_eq!(after.title, "新");
        // 重命名只改标题：modified 保持为 write_note 时的值，不刷新为 rename 时刻
        assert_eq!(after.modified, m1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
