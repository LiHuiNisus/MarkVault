use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 默认笔记文件夹名：与 app.exe 同级的这个子目录，安装后开箱可用。
pub const NOTES_DIR_NAME: &str = "notes";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub vault_dir: String,
    /// 一次性初始化标记。首次启动创建默认文件夹后置 true；
    /// 之后用户用「文件夹」按钮自选的目录不会被下次启动改写。
    #[serde(default)]
    pub initialized: bool,
}

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MarkVault")
        .join("config.json")
}

/// exe 同级目录下的 notes；exe 路径取不到时退回用户配置目录，保证总有可写位置。
pub fn default_vault_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(NOTES_DIR_NAME)))
        .or_else(|| dirs::config_dir().map(|d| d.join("MarkVault").join(NOTES_DIR_NAME)))
        .unwrap_or_else(|| PathBuf::from(NOTES_DIR_NAME))
}

pub fn load_config() -> Option<AppConfig> {
    let text = std::fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    serde_json::to_string_pretty(cfg)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(p, s).map_err(|e| e.to_string()))
}

/// 同秒/同名冲突时追加 -2、-3…（与 commands::dedup_name 同规则，迁移时不想跨模块依赖）。
fn dedup_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.trim_end_matches(".md");
    for n in 2..10000 {
        let candidate = dir.join(format!("{}-{}.md", stem, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}-{}.md", stem, chrono::Utc::now().timestamp_millis()))
}

/// 把 src 下所有 .md 移到 dst（重名自动改名）。src 不存在或与 dst 相同则什么都不做；
/// 原目录整体保留，不做删除。
fn migrate_notes(src: &Path, dst: &Path) -> Result<(), String> {
    if src == dst || !src.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = match path.file_name().map(|n| n.to_string_lossy().to_string()) {
            Some(n) => n,
            None => continue,
        };
        let target = dedup_path(dst, &name);
        // rename 跨盘符会失败，退回先复制再删除
        if std::fs::rename(&path, &target).is_err() {
            std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 启动初始化：保证存在可写的笔记目录与配置文件。
/// 首次启动在 exe 同级创建 notes 目录当作笔记库（原目录的 .md 一并迁入，原目录保留）。
/// exe 同级不可写时（如装到 Program Files）退回用户配置目录，避免启动直接失败。
pub fn init_config() -> Result<AppConfig, String> {
    let default_dir = default_vault_dir();
    let mut cfg = load_config().unwrap_or(AppConfig {
        vault_dir: String::new(),
        initialized: false,
    });
    if !cfg.initialized {
        if !cfg.vault_dir.is_empty() {
            migrate_notes(Path::new(&cfg.vault_dir), &default_dir)?;
        }
        cfg.vault_dir = default_dir.to_string_lossy().to_string();
        cfg.initialized = true;
        save_config(&cfg)?;
    }
    if std::fs::create_dir_all(Path::new(&cfg.vault_dir)).is_err() {
        // 默认位置建不出来（权限/只读盘）：换到用户配置目录，保证应用能启动
        let fallback = dirs::config_dir()
            .ok_or("无法确定笔记目录")?
            .join("MarkVault")
            .join(NOTES_DIR_NAME);
        std::fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
        cfg.vault_dir = fallback.to_string_lossy().to_string();
        save_config(&cfg)?;
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_roundtrip_in_memory() {
        let cfg = AppConfig { vault_dir: "D:\\notes".into(), initialized: true };
        let s = serde_json::to_string(&cfg).unwrap();
        let back: AppConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.vault_dir, "D:\\notes");
    }

    /// 老版本 config.json 没有 initialized 字段，反序列化必须默认为 false 以便触发迁移。
    #[test]
    fn test_config_without_initialized_field() {
        let back: AppConfig = serde_json::from_str(r#"{"vault_dir":"D:\\old"}"#).unwrap();
        assert_eq!(back.vault_dir, "D:\\old");
        assert!(!back.initialized);
    }

    #[test]
    fn test_migrate_notes_moves_md_and_renames_collision() {
        let base = std::env::temp_dir().join(format!("mv-migrate-{}", std::process::id()));
        let src = base.join("old");
        let dst = base.join("new");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a.md"), "A").unwrap();
        std::fs::write(dst.join("a.md"), "existing").unwrap(); // 触发重名改名
        std::fs::write(src.join("b.txt"), "ignore").unwrap();  // 非 .md 不动
        migrate_notes(&src, &dst).unwrap();
        assert!(!src.join("a.md").exists());
        assert_eq!(std::fs::read_to_string(dst.join("a-2.md")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(dst.join("a.md")).unwrap(), "existing");
        assert!(src.join("b.txt").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    /// 迁移必须零丢件：源目录所有 .md 一个不少地出现在目标目录（重名者改名保留）。
    #[test]
    fn test_migrate_notes_preserves_every_md() {
        let base = std::env::temp_dir().join(format!("mv-noloss-{}", std::process::id()));
        let src = base.join("old");
        let dst = base.join("new");
        std::fs::create_dir_all(&src).unwrap();
        let names = [
            "20261009-131744-alpha.md",
            "20261009-131751-beta.md",
            "20261009-131909-gamma.md",
            "20261009-142905-untitled.md",
            "20261009-175824-untitled-2.md",
        ];
        for (i, n) in names.iter().enumerate() {
            std::fs::write(src.join(n), format!("body-{i}")).unwrap();
        }
        migrate_notes(&src, &dst).unwrap();
        // 源目录已空，目标目录条目数 == 文件数（文件名可能因去重变化，按内容比对）
        assert_eq!(std::fs::read_dir(&src).unwrap().count(), 0);
        let mut bodies: Vec<String> = std::fs::read_dir(&dst)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
            .map(|e| std::fs::read_to_string(e.path()).unwrap())
            .collect();
        bodies.sort();
        let mut expect: Vec<String> = (0..names.len()).map(|i| format!("body-{i}")).collect();
        expect.sort();
        assert_eq!(bodies, expect);
        std::fs::remove_dir_all(&base).ok();
    }

    /// 目标目录缺省不存在时，迁移要自己建出来（全新安装路径）。
    #[test]
    fn test_migrate_notes_creates_missing_dst() {
        let base = std::env::temp_dir().join(format!("mv-mkdir-{}", std::process::id()));
        let src = base.join("old");
        let dst = base.join("deep").join("notes");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("x.md"), "X").unwrap();
        migrate_notes(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("x.md")).unwrap(), "X");
        std::fs::remove_dir_all(&base).ok();
    }
}
