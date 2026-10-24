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
    title: Option<String>,
) -> Result<String, String> {
    let ext = match format.as_str() {
        "html" => "html",
        "md" => "md",
        "docx" => "docx",
        "pdf" => "pdf",
        "png" => "png",
        _ => return Err("不支持的格式".into()),
    };
    // 默认文件名优先用笔记标题（用户认得的名字），清洗 Windows 非法字符后截断；
    // 标题为空时退回内部文件名末段（避免把路径分隔符带进文件名）。
    let safe_title = title.as_deref().map(sanitize_filename).filter(|s| !s.is_empty());
    let default_name = match safe_title {
        Some(t) => format!("{}.{}", t, ext),
        None => {
            let raw = file_name
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(file_name.as_str());
            // 富文本笔记是 .html，也要剥干净，避免导出成 "标题.html.docx"
            let base = crate::store::strip_note_ext(raw);
            format!("{}.{}", base, ext)
        }
    };
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
    // DOCX 由前端传结构化的段落数组，这里打包成 OOXML（真 Word 文件，不是改扩展名的 HTML）
    if format == "docx" {
        let doc = docx_from_payload(&payload)?;
        std::fs::write(&path, doc).map_err(|e| e.to_string())?;
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

/// 前端传的 DOCX 载荷：段落数组，block 取 heading/paragraph/list/code/quote。
#[derive(serde::Deserialize)]
struct DocxBlock {
    #[serde(default)]
    block: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    level: u8,
}

/// 把段落数组打包成最小可用 OOXML 文档（[Content_Types].xml + rels + document.xml）。
fn docx_from_payload(payload: &str) -> Result<Vec<u8>, String> {
    let blocks: Vec<DocxBlock> =
        serde_json::from_str(payload).map_err(|e| format!("文档内容解析失败: {e}"))?;
    let body = build_document_xml(&blocks);
    write_docx_zip(&body)
}

/// 正文 XML：段落顺序即文档顺序。标题用 pStyle，代码块用等宽字体，引用用斜体缩进。
fn build_document_xml(blocks: &[DocxBlock]) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
    );
    for b in blocks {
        let text = xml_escape(&b.text);
        match b.block.as_str() {
            "heading" => {
                let lvl = b.level.clamp(1, 6);
                s.push_str(&format!(
                    r#"<w:p><w:pPr><w:pStyle w:val="Heading{}"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    lvl, text
                ));
            }
            "code" => {
                s.push_str(&format!(
                    r#"<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    text
                ));
            }
            "quote" => {
                s.push_str(&format!(
                    r#"<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    text
                ));
            }
            "list" => {
                s.push_str(&format!(
                    r#"<w:p><w:pPr><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">• {}</w:t></w:r></w:p>"#,
                    text
                ));
            }
            _ => {
                s.push_str(&format!(
                    r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    text
                ));
            }
        }
    }
    // sectPr 必须有，否则 Word 打开报文档损坏
    s.push_str(
        r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>"#,
    );
    s
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 写出 docx 压缩包：4 个必需部件 + 一个最小 styles.xml（提供 Heading1-6 样式）。
fn write_docx_zip(document_xml: &str) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

    let doc_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

    let styles = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style></w:styles>"#;

    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut put = |name: &str, data: &str| -> Result<(), String> {
            zw.start_file(name, opts).map_err(|e| e.to_string())?;
            zw.write_all(data.as_bytes()).map_err(|e| e.to_string())
        };
        put("[Content_Types].xml", content_types)?;
        put("_rels/.rels", rels)?;
        put("word/_rels/document.xml.rels", doc_rels)?;
        put("word/document.xml", document_xml)?;
        put("word/styles.xml", styles)?;
        zw.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// 用笔记标题当导出文件名：替换 Windows 非法字符，去掉首尾空格与点，截断到 80 字符。
fn sanitize_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    trimmed.chars().take(80).collect::<String>()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_payload_builds_valid_zip() {
        let payload = r#"[{"block":"heading","level":1,"text":"标题"},{"block":"paragraph","text":"正文"},{"block":"code","text":"let x = 1;"},{"block":"list","text":"项目"},{"block":"quote","text":"引用"}]"#;
        let bytes = docx_from_payload(payload).unwrap();
        // ZIP 魔数 PK\x03\x04
        assert_eq!(&bytes[0..4], b"PK\x03\x04");
        // 必须能读回，且含文档与样式两个部件
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().unwrap().to_string())
            .collect();
        for need in ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "_rels/.rels"] {
            assert!(names.iter().any(|n| n == need), "缺少部件 {need}, 实有 {names:?}");
        }
        let mut doc = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").unwrap(), &mut doc).unwrap();
        assert!(doc.contains("标题") && doc.contains("Heading1"));
        assert!(doc.contains("<w:sectPr>"));
    }

    #[test]
    fn docx_escapes_xml_specials() {
        let payload = r#"[{"block":"paragraph","text":"a < b & c > d \"q\""}]"#;
        let bytes = docx_from_payload(payload).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut doc = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").unwrap(), &mut doc).unwrap();
        assert!(doc.contains("a &lt; b &amp; c &gt; d &quot;q&quot;"));
        assert!(!doc.contains("a < b"));
    }

    #[test]
    fn docx_rejects_bad_payload() {
        assert!(docx_from_payload("not json").is_err());
    }
}
