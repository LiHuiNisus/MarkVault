use base64::Engine;
use tauri_plugin_dialog::DialogExt;

/// async 化：同步命令在 Tauri v2 主线程执行，render_pdf 的轮询会卡死 UI 并饿死消息泵。
#[tauri::command(async)]
pub fn export_note(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
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
        .set_parent(&window)
        .set_file_name(&default_name)
        .blocking_save_file()
        .ok_or("已取消")?;
    let path = target.to_string();
    // PDF 由 WebView2 原生 PrintToPdfStream 生成（无页眉页脚），其余格式前端传内容
    if format == "pdf" {
        render_pdf(&window, &path)?;
        return Ok(path);
    }
    let bytes: Vec<u8> = match format.as_str() {
        "png" => base64::engine::general_purpose::STANDARD
            .decode(&payload)
            .map_err(|e| e.to_string())?,
        _ => payload.into_bytes(),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// WebView2 原生 PDF：A4 纵向、无页眉页脚、1.0 缩放、约 1cm 边距。
/// with_webview 回调在主线程执行，PrintToPdfStream 异步完成；轮询共享结果后落盘。
#[cfg(windows)]
fn render_pdf(window: &tauri::WebviewWindow, path: &str) -> Result<(), String> {
    type PdfResult = Result<Vec<u8>, String>;
    let result: std::sync::Arc<std::sync::Mutex<Option<PdfResult>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let sink = result.clone();

    window
        .with_webview(move |webview| {
            let fail = |sink: &std::sync::Mutex<Option<PdfResult>>, e: String| {
                *sink.lock().unwrap() = Some(Err(e));
            };
            let run = || -> Result<(), String> {
                use windows::core::Interface as _;
                use webview2_com::Microsoft::Web::WebView2::Win32 as W2;
                let controller = webview.controller();
                let core = unsafe {
                    controller
                        .CoreWebView2()
                        .map_err(|e| format!("CoreWebView2 不可用: {e}"))?
                };
                let wv16: W2::ICoreWebView2_16 = core
                    .cast()
                    .map_err(|_| "WebView2 运行时过旧，不支持原生 PDF 导出".to_string())?;
                let env6: W2::ICoreWebView2Environment6 = webview
                    .environment()
                    .cast()
                    .map_err(|e| format!("ICoreWebView2Environment6 不可用: {e}"))?;
                let settings = unsafe {
                    env6.CreatePrintSettings()
                        .map_err(|e| format!("CreatePrintSettings 失败: {e}"))?
                };
                unsafe {
                    settings.SetOrientation(W2::COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT).ok();
                    settings.SetScaleFactor(1.0).ok();
                    // 单位英寸：A4 = 8.27 x 11.69；边距 0.4in ≈ 1cm
                    settings.SetPageWidth(8.27).ok();
                    settings.SetPageHeight(11.69).ok();
                    settings.SetMarginTop(0.4).ok();
                    settings.SetMarginBottom(0.4).ok();
                    settings.SetMarginLeft(0.4).ok();
                    settings.SetMarginRight(0.4).ok();
                    settings.SetShouldPrintHeaderAndFooter(false).ok();
                    settings.SetShouldPrintBackgrounds(true).ok();
                    settings.SetShouldPrintSelectionOnly(false).ok();
                }
                let handler_sink = sink.clone();
                let handler = webview2_com::PrintToPdfStreamCompletedHandler::create(Box::new(
                    move |errorcode, stream: Option<windows::Win32::System::Com::IStream>| {
                        if errorcode.is_err() {
                            *handler_sink.lock().unwrap() =
                                Some(Err(format!("PrintToPdf 失败: {errorcode:?}")));
                            return Ok(());
                        }
                        let Some(stream) = stream else {
                            *handler_sink.lock().unwrap() =
                                Some(Err("PrintToPdf 未返回数据流".into()));
                            return Ok(());
                        };
                        *handler_sink.lock().unwrap() = Some(read_stream(&stream));
                        Ok(())
                    },
                ));
                unsafe {
                    wv16.PrintToPdfStream(&settings, &handler)
                        .map_err(|e| format!("PrintToPdfStream 调用失败: {e}"))?;
                }
                Ok(())
            };
            if let Err(e) = run() {
                fail(&sink, e);
            }
        })
        .map_err(|e| format!("with_webview 失败: {e}"))?;

    // 等待回调完成（50ms 轮询，30s 超时）
    let started = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut guard = result.lock().unwrap();
        if let Some(res) = guard.take() {
            let bytes = res?;
            std::fs::write(path, bytes).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            return Err("PDF 生成超时".into());
        }
    }
}

#[cfg(windows)]
fn read_stream(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STREAM_SEEK_END, STREAM_SEEK_SET};
    unsafe {
        let mut end: u64 = 0;
        stream
            .Seek(0, STREAM_SEEK_END, Some(&mut end))
            .map_err(|e| format!("IStream Seek 失败: {e}"))?;
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| format!("IStream Seek 失败: {e}"))?;
        let mut buf = Vec::with_capacity(end as usize);
        let mut chunk = [0u8; 65536];
        loop {
            let mut read = 0u32;
            stream
                .Read(
                    chunk.as_mut_ptr() as *mut core::ffi::c_void,
                    chunk.len() as u32,
                    Some(&mut read),
                )
                .ok()
                .map_err(|e| format!("IStream Read 失败: {e:?}"))?;
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..read as usize]);
        }
        Ok(buf)
    }
}

#[cfg(not(windows))]
fn render_pdf(_window: &tauri::WebviewWindow, _path: &str) -> Result<(), String> {
    Err("仅 Windows 支持原生 PDF 导出".into())
}
