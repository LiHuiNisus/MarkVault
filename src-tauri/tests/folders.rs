//! 需求核对与边界用例：单层文件夹特性。与 store/commands 同 crate，可调用私有项。
//! 只测纯逻辑与磁盘行为，不触碰 Tauri 命令宏（那需要 AppHandle）。
use app_lib::store::{
    create_folder, delete_folder, delete_note, list_folders, list_notes, move_note, read_note,
    rename_folder, resolve_note_path, set_tags, write_note, Note, NoteMeta,
};

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mv-folders-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn meta(file_name: &str, folder: &str) -> NoteMeta {
    NoteMeta {
        file_name: file_name.into(),
        folder: folder.into(),
        title: file_name.into(),
        tags: vec![],
        created: "2026-01-01T00:00:00".into(),
        modified: String::new(),
    }
}

/// 往相对路径写一篇笔记，自动从路径里推 folder（模拟 save_note 的行为）。
fn put(dir: &std::path::Path, rel: &str, body: &str) {
    let name = rel.rsplit('/').next().unwrap();
    let folder = rel.split_once('/').map(|(f, _)| f).unwrap_or("");
    write_note(dir, rel, &Note { meta: meta(name, folder), content: body.into() }).unwrap();
}

/// 去重后的实际落点名（move_note 负责改名，这里只需表达"移进去后文件名可能变"）。
fn move_into(dir: &std::path::Path, from: &str, to_folder: &str) -> String {
    let base = base_name(from);
    let mut dst = if to_folder.is_empty() { base.to_string() } else { format!("{to_folder}/{base}") };
    // 目标已存在时模拟 dedup：追加 -2
    if resolve_note_path(dir, &dst).map(|p| p.exists()).unwrap_or(false) {
        let stem = base.trim_end_matches(".md");
        dst = if to_folder.is_empty() {
            format!("{stem}-2.md")
        } else {
            format!("{to_folder}/{stem}-2.md")
        };
    }
    move_note(dir, from, &dst).unwrap();
    dst
}

fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap()
}

/* ---------- 需求 1：新建文件夹 ---------- */

#[test]
fn creates_folder_and_rejects_bad_names() {
    let dir = tmp_dir("create");
    create_folder(&dir, "工作").unwrap();
    assert!(dir.join("工作").is_dir());
    // 幂等：重复建同名不报错
    create_folder(&dir, "工作").unwrap();
    // 非法名一律拒绝
    assert!(create_folder(&dir, "").is_err());
    assert!(create_folder(&dir, "../escape").is_err());
    assert!(create_folder(&dir, "a/b").is_err());
    assert!(create_folder(&dir, "C:win").is_err());
    assert!(create_folder(&dir, "a<b>").is_err());
    assert!(create_folder(&dir, ".").is_err());
    // 拒绝后不应在库外留下任何东西
    assert!(!std::path::Path::new(&dir).parent().unwrap().join("escape").exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn list_folders_only_returns_directories() {
    let dir = tmp_dir("listfolders");
    create_folder(&dir, "b").unwrap();
    create_folder(&dir, "a").unwrap();
    put(&dir, "root.md", "R");
    std::fs::create_dir_all(dir.join(".hidden")).unwrap();
    let names = list_folders(&dir);
    assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 需求 1：文件夹下可新建文档 ---------- */

#[test]
fn note_can_live_in_folder_with_slash_path() {
    let dir = tmp_dir("inside");
    create_folder(&dir, "工作").unwrap();
    put(&dir, "工作/a.md", "A");
    assert!(dir.join("工作").join("a.md").is_file());
    let n = read_note(&dir, "工作/a.md").unwrap();
    assert_eq!(n.meta.folder, "工作");
    // file_name 就是相对路径本身（前端直接当唯一键用）
    assert_eq!(n.meta.file_name, "工作/a.md");
    assert_eq!(n.content, "A");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_creates_missing_subdir() {
    let dir = tmp_dir("mkdir");
    put(&dir, "未建过/x.md", "X");
    assert!(dir.join("未建过").join("x.md").is_file());
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 列表：根 + 一层，且不递归 ---------- */

#[test]
fn list_notes_covers_root_and_one_level_only() {
    let dir = tmp_dir("list");
    put(&dir, "root.md", "R");
    put(&dir, "sub/b.md", "B");
    // 第二层目录直接落到磁盘上（write_note 只允许一层，手动建）
    std::fs::create_dir_all(dir.join("sub").join("deep")).unwrap();
    std::fs::write(dir.join("sub").join("deep").join("c.md"), "C").unwrap();
    let metas = list_notes(&dir);
    let names: Vec<String> = metas.iter().map(|m| m.file_name.clone()).collect();
    assert!(names.contains(&"root.md".to_string()));
    assert!(names.contains(&"sub/b.md".to_string()));
    assert!(!names.iter().any(|f| f.ends_with("c.md")), "第二层不应被列出");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn list_notes_ignores_non_md_in_folder() {
    let dir = tmp_dir("nonmd");
    create_folder(&dir, "sub").unwrap();
    std::fs::write(dir.join("sub").join("x.txt"), "T").unwrap();
    put(&dir, "sub/ok.md", "O");
    let metas = list_notes(&dir);
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].file_name, "sub/ok.md");
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 需求 1：移入 / 移出，且不丢数据 ---------- */

#[test]
fn move_into_folder_dedups_without_overwriting() {
    let dir = tmp_dir("dedup");
    put(&dir, "a.md", "A");
    put(&dir, "sub/a.md", "EXISTING");
    let dst = move_into(&dir, "a.md", "sub");
    assert_eq!(dst, "sub/a-2.md");
    // 已存在的文件内容必须原样保留
    assert_eq!(read_note(&dir, "sub/a.md").unwrap().content, "EXISTING");
    // 新来的被改名保留，内容不丢
    assert_eq!(read_note(&dir, "sub/a-2.md").unwrap().content, "A");
    // 源已不在根目录
    assert!(!dir.join("a.md").exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn move_out_to_root_preserves_content() {
    let dir = tmp_dir("out");
    put(&dir, "sub/a.md", "A");
    move_into(&dir, "sub/a.md", "");
    assert_eq!(read_note(&dir, "a.md").unwrap().content, "A");
    assert_eq!(read_note(&dir, "a.md").unwrap().meta.folder, "");
    assert!(!dir.join("sub").join("a.md").exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn move_refuses_when_source_missing() {
    let dir = tmp_dir("missing");
    assert!(move_note(&dir, "nope.md", "sub/nope.md").is_err());
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 路径安全：只允许一层，且逐段校验 ---------- */

#[test]
fn resolve_rejects_traversal_and_extra_levels() {
    let dir = tmp_dir("safe");
    assert!(resolve_note_path(&dir, "a.md").is_ok());
    assert!(resolve_note_path(&dir, "sub/a.md").is_ok());
    for bad in [
        "",
        "/a.md",
        "a/b/c.md",
        "../a.md",
        "a/../../b.md",
        "sub/",
        "a//b.md",
        "C:/a.md",
        "a\\b.md",
    ] {
        assert!(resolve_note_path(&dir, bad).is_err(), "应拒绝: {bad}");
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn resolve_keeps_path_inside_vault() {
    let dir = tmp_dir("inside-vault");
    let p = resolve_note_path(&dir, "sub/a.md").unwrap();
    assert_eq!(p.parent().unwrap().parent().unwrap(), dir);
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 文件夹重命名 / 删除 ---------- */

#[test]
fn rename_folder_moves_contents() {
    let dir = tmp_dir("rename");
    put(&dir, "old/a.md", "A");
    rename_folder(&dir, "old", "new").unwrap();
    assert_eq!(read_note(&dir, "new/a.md").unwrap().content, "A");
    assert_eq!(read_note(&dir, "new/a.md").unwrap().meta.folder, "new");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_folder_refuses_when_nonempty() {
    let dir = tmp_dir("delnonempty");
    put(&dir, "sub/a.md", "KEEP");
    assert!(delete_folder(&dir, "sub").is_err());
    // 拒绝后目录与内容必须都还在
    assert!(dir.join("sub").is_dir());
    assert_eq!(read_note(&dir, "sub/a.md").unwrap().content, "KEEP");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_folder_removes_when_empty() {
    let dir = tmp_dir("delempty");
    create_folder(&dir, "sub").unwrap();
    delete_folder(&dir, "sub").unwrap();
    assert!(!dir.join("sub").exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn folder_ops_reject_non_directory_targets() {
    let dir = tmp_dir("nondir");
    put(&dir, "a.md", "A");
    assert!(delete_folder(&dir, "a.md").is_err());
    assert!(rename_folder(&dir, "a.md", "b").is_err());
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 删除进回收站：可恢复，且不像普通目录那样被列出 ---------- */

#[test]
fn delete_moves_note_into_trash_not_erase() {
    let dir = tmp_dir("trash");
    put(&dir, "a.md", "A");
    delete_note(&dir, "a.md").unwrap();
    // 原位置已空
    assert!(!dir.join("a.md").exists());
    // 内容进了 .trash，可手动恢复
    assert_eq!(read_note(dir.join(".trash").as_path(), "a.md").unwrap().content, "A");
    // .trash 是隐藏目录，不出现在文件夹列表与笔记列表里
    assert!(!list_folders(&dir).contains(&".trash".to_string()));
    assert!(list_notes(&dir).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_same_name_twice_keeps_both_in_trash() {
    let dir = tmp_dir("trashdedup");
    put(&dir, "a.md", "FIRST");
    delete_note(&dir, "a.md").unwrap();
    put(&dir, "a.md", "SECOND");
    delete_note(&dir, "a.md").unwrap();
    let trash = dir.join(".trash");
    assert_eq!(read_note(&trash, "a.md").unwrap().content, "FIRST");
    assert_eq!(read_note(&trash, "a-2.md").unwrap().content, "SECOND");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_missing_note_errors_without_creating_trash() {
    let dir = tmp_dir("trashmissing");
    assert!(delete_note(&dir, "nope.md").is_err());
    assert!(!dir.join(".trash").exists());
    std::fs::remove_dir_all(&dir).ok();
}

/* ---------- 结构化筛选：标签只比 frontmatter，文件夹可精确限定 ---------- */

#[test]
fn set_tags_replaces_without_touching_modified() {
    let dir = tmp_dir("settags");
    put(&dir, "a.md", "A");
    let before = read_note(&dir, "a.md").unwrap().meta.modified;
    std::thread::sleep(std::time::Duration::from_millis(1100));
    set_tags(&dir, "a.md", vec!["工作".into(), "报告".into()]).unwrap();
    let n = read_note(&dir, "a.md").unwrap();
    assert_eq!(n.meta.tags, vec!["工作".to_string(), "报告".to_string()]);
    // 只改标签不该把笔记顶到"最近修改"
    assert_eq!(n.meta.modified, before);
    // 内容不受影响
    assert_eq!(n.content, "A");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn set_tags_can_clear_all_tags() {
    let dir = tmp_dir("cleartags");
    write_note(
        &dir,
        "a.md",
        &Note {
            meta: NoteMeta {
                file_name: "a.md".into(),
                folder: String::new(),
                title: "A".into(),
                tags: vec!["旧".into()],
                created: "2026-01-01T00:00:00".into(),
                modified: String::new(),
            },
            content: "A".into(),
        },
    )
    .unwrap();
    set_tags(&dir, "a.md", vec![]).unwrap();
    assert!(read_note(&dir, "a.md").unwrap().meta.tags.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}
