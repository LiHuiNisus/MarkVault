// Verifies delete_note routes through the Windows Recycle Bin rather than unlinking.
// Prints the recycle-bin item count before and after, so a silent fallback to
// std::fs::remove_file would show up as "count unchanged".
use app_lib::store::{delete_note, write_note, Note, NoteMeta};

fn recycle_bin_count() -> usize {
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "(New-Object -ComObject Shell.Application).NameSpace(10).Items().Count"])
        .output()
        .expect("powershell failed");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(usize::MAX)
}

#[test]
fn delete_note_sends_file_to_recycle_bin() {
    let dir = std::env::temp_dir().join(format!("mv-recycle-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    write_note(
        &dir,
        "recycle-me.md",
        &Note {
            meta: NoteMeta {
                file_name: "recycle-me.md".into(),
                folder: String::new(),
                title: "回收站测试".into(),
                tags: vec![],
                created: "2026-01-01T00:00:00".into(),
                modified: String::new(),
            },
            content: "should land in the recycle bin".into(),
        },
    )
    .unwrap();

    let before = recycle_bin_count();
    delete_note(&dir, "recycle-me.md").unwrap();
    let after = recycle_bin_count();

    assert!(!dir.join("recycle-me.md").exists(), "原位置的文件应已删除");
    assert!(
        before != usize::MAX && after != usize::MAX && after > before,
        "回收站条目应增加：before={before} after={after}（若相等说明退回了永久删除）"
    );
    std::fs::remove_dir_all(&dir).ok();
}
