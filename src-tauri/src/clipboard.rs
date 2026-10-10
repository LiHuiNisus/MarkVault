//! Windows 剪贴板写入：把 .md 文件本身放进剪贴板（CF_HDROP），
//! 与资源管理器里"复制文件"等价，可在文件夹中 Ctrl+V 粘贴出副本；
//! 以及把纯文本（笔记完整路径）放进剪贴板（CF_UNICODETEXT）。
use crate::{config, store};
use std::path::PathBuf;

/// CF_HDROP：剪贴板中的文件列表格式。Win32 ABI 常量，取值固定为 15。
const CF_HDROP: u32 = 15;
/// CF_UNICODETEXT：UTF-16 纯文本格式。
const CF_UNICODETEXT: u32 = 13;

fn vault_dir() -> Option<PathBuf> {
    config::load_config().map(|c| PathBuf::from(c.vault_dir))
}

/// 解析并校验笔记文件路径，拒绝路径穿越（复用 store 的文件名校验）。
fn note_path(file_name: &str) -> Result<PathBuf, String> {
    let dir = vault_dir().ok_or("未配置笔记文件夹")?;
    let path = store::resolve_note_path(&dir, file_name)?;
    if !path.exists() {
        return Err("笔记文件不存在".into());
    }
    Ok(path)
}

/// 打开剪贴板：其他进程可能短暂占用，做短重试避免偶发失败。
fn open_clipboard() -> Result<(), String> {
    use windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    Err("剪贴板被其他程序占用".into())
}

/// 把一段字节写入 HGLOBAL 并交给剪贴板。成功时内存所有权转移给系统，不能释放。
fn set_clipboard_bytes(format: u32, bytes: &[u8]) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    open_clipboard()?;
    // 任何中途失败都要保证剪贴板被关闭，否则整机剪贴板会一直被占用
    let result = (|| -> Result<(), String> {
        unsafe { EmptyClipboard() }.map_err(|e| format!("清空剪贴板失败: {e}"))?;
        let hmem = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }
            .map_err(|e| format!("分配剪贴板内存失败: {e}"))?;
        let ptr = unsafe { GlobalLock(hmem) };
        if ptr.is_null() {
            return Err("锁定剪贴板内存失败".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(hmem);
            SetClipboardData(format, Some(HANDLE(hmem.0)))
        }
        .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        Ok(())
    })();
    unsafe { let _ = CloseClipboard(); }
    result
}

/// 构造 CF_HDROP 数据块：DROPFILES 头 + UTF-16 路径列表，双 NUL 结尾。
/// pFiles 为文件列表相对结构体起始的偏移，等于 DROPFILES 自身大小。
#[cfg(windows)]
fn build_hdrop(paths: &[PathBuf]) -> Vec<u8> {
    use windows::Win32::UI::Shell::DROPFILES;

    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        wide.extend(p.to_string_lossy().encode_utf16());
        wide.push(0);
    }
    wide.push(0); // 列表终止符

    // DROPFILES 全为 4 字节成员，无尾部填充，size_of 即真实布局长度
    let header_size = std::mem::size_of::<DROPFILES>() as u32;
    let header = DROPFILES {
        pFiles: header_size,
        pt: windows::Win32::Foundation::POINT { x: 0, y: 0 },
        fNC: false.into(),
        fWide: true.into(),
    };
    let mut buf = vec![0u8; header_size as usize + wide.len() * 2];
    unsafe {
        std::ptr::copy_nonoverlapping(
            &header as *const DROPFILES as *const u8,
            buf.as_mut_ptr(),
            header_size as usize,
        );
    }
    for (i, u) in wide.iter().enumerate() {
        let off = header_size as usize + i * 2;
        buf[off..off + 2].copy_from_slice(&u.to_le_bytes());
    }
    buf
}

/// 复制笔记文件到剪贴板（等同资源管理器"复制"），可在任意文件夹粘贴出副本。
#[tauri::command]
pub fn copy_note_file(file_name: String) -> Result<(), String> {
    let path = note_path(&file_name)?;
    #[cfg(windows)]
    {
        set_clipboard_bytes(CF_HDROP, &build_hdrop(&[path]))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("仅 Windows 支持复制文件到剪贴板".into())
    }
}

/// 复制笔记完整路径到剪贴板，返回该路径供前端提示。
#[tauri::command]
pub fn copy_note_path(file_name: String) -> Result<String, String> {
    let path = note_path(&file_name)?;
    let text = path.to_string_lossy().to_string();
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let mut bytes = Vec::with_capacity(wide.len() * 2);
    for u in wide {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    set_clipboard_bytes(CF_UNICODETEXT, &bytes)?;
    Ok(text)
}

/// 在资源管理器里定位笔记文件（选中该文件）。无 Explorer 时退回失败提示。
#[tauri::command]
pub fn reveal_note(file_name: String) -> Result<(), String> {
    let path = note_path(&file_name)?;
    reveal_path(path.to_string_lossy().to_string())
}

/// 在资源管理器里打开某个绝对路径（文件则选中它，目录则打开）。供导出后"打开所在文件夹"。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    #[cfg(windows)]
    {
        if p.is_file() {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", p.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("打开资源管理器失败: {e}"))?;
        } else {
            std::process::Command::new("explorer")
                .arg(p.to_string_lossy().to_string())
                .spawn()
                .map_err(|e| format!("打开资源管理器失败: {e}"))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        Err("仅 Windows 支持打开资源管理器".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn hdrop_layout_matches_dropfiles_header() {
        let buf = build_hdrop(&[PathBuf::from(r"D:\vault\note.md")]);
        // pFiles 指向结构体之后的文件列表区，即 DROPFILES 自身大小
        let header_size = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(header_size as usize, std::mem::size_of::<windows::Win32::UI::Shell::DROPFILES>());
        // fWide 位于 pFiles(4) + POINT(8) + fNC(4) 之后，必须为 1 表示 UTF-16
        let f_wide = i32::from_le_bytes(buf[16..20].try_into().unwrap());
        assert_eq!(f_wide, 1);
        // 路径 UTF-16 + 单项 NUL + 列表终止 NUL，总长 = 头 + 2*(len+2)
        assert_eq!(buf.len(), header_size as usize + (r"D:\vault\note.md".encode_utf16().count() + 2) * 2);
    }

    #[test]
    fn hdrop_list_is_double_nul_terminated() {
        let buf = build_hdrop(&[PathBuf::from(r"D:\a.md")]);
        assert_eq!(&buf[buf.len() - 4..], &[0, 0, 0, 0]);
    }
}
