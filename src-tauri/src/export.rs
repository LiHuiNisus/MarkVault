use base64::Engine;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn export_note(
    app: tauri::AppHandle,
    file_name: String,
    format: String,
    payload: String,
) -> Result<String, String> {
    let ext = match format.as_str() {
        "html" => "html",
        "md" => "md",
        "doc" => "doc",
        "pdf" => "pdf",
        "png" => "png",
        _ => return Err("不支持的格式".into()),
    };
    let default_name = format!("{}.{}", file_name.trim_end_matches(".md"), ext);
    let target = app
        .dialog()
        .file()
        .set_title("导出位置")
        .set_file_name(&default_name)
        .blocking_save_file()
        .ok_or("已取消")?;
    let path = target.to_string();
    let bytes: Vec<u8> = match format.as_str() {
        "png" | "pdf" => base64::engine::general_purpose::STANDARD
            .decode(&payload)
            .map_err(|e| e.to_string())?,
        _ => payload.into_bytes(),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}
