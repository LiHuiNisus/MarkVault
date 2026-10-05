use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMeta {
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub content: String,
}

/// frontmatter 采用 JSON（YAML 子集）：第一行 `---`，第二行 JSON 对象，第三行 `---`。
pub fn parse_frontmatter(raw: &str) -> (NoteMeta, String) {
    let mut lines = raw.lines();
    let fallback = NoteMeta {
        file_name: String::new(),
        title: String::new(),
        tags: vec![],
        created: String::new(),
        modified: String::new(),
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
    let json = serde_json::to_string(meta).unwrap_or_default();
    format!("---\n{}\n---\n{}", json, content)
}

pub fn list_notes(dir: &Path) -> Vec<NoteMeta> {
    let mut metas = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return metas,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let (mut meta, _) = parse_frontmatter(&raw);
        if meta.title.is_empty() {
            meta.title = file_name.trim_end_matches(".md").to_string();
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
        meta.file_name = file_name;
        metas.push(meta);
    }
    metas.sort_by(|a, b| b.modified.cmp(&a.modified));
    metas
}

pub fn read_note(dir: &Path, file_name: &str) -> Result<Note, String> {
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return Err("非法文件名".into());
    }
    let raw = std::fs::read_to_string(dir.join(file_name)).map_err(|e| e.to_string())?;
    let (mut meta, content) = parse_frontmatter(&raw);
    if meta.title.is_empty() {
        meta.title = file_name.trim_end_matches(".md").to_string();
    }
    meta.file_name = file_name.to_string();
    Ok(Note { meta, content })
}

pub fn write_note(dir: &Path, file_name: &str, note: &Note) -> Result<(), String> {
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return Err("非法文件名".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut meta = note.meta.clone();
    meta.modified = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let raw = serialize_note(&meta, &note.content);
    std::fs::write(dir.join(file_name), raw).map_err(|e| e.to_string())
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
    fn test_serialize_roundtrip() {
        let meta = NoteMeta {
            file_name: "20261005-100000-测试.md".into(),
            title: "测试笔记".into(),
            tags: vec!["a".into()],
            created: "2026-10-05T10:00:00".into(),
            modified: "2026-10-05T10:00:00".into(),
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
            file_name: "n.md".into(), title: "N".into(), tags: vec![],
            created: "2026-01-01T00:00:00".into(), modified: "2026-01-01T00:00:00".into(),
        };
        write_note(&dir, "n.md", &Note { meta, content: "c".into() }).unwrap();
        let note = read_note(&dir, "n.md").unwrap();
        assert!(note.meta.modified.as_str() > "2026-01-01");
    }
}
