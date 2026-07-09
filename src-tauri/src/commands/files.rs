//! Webview-facing file readers (text/data-url/extracted-text), guarded
//! against reaching into the Feral private dir.

use crate::*;

/// Reject a path that resolves inside the Feral private dir (`~/.feral`) where
/// the api-token, byok metadata and the agent DB live. The webview-facing file
/// readers below use this so they can't be turned into a secret-exfiltration
/// primitive (e.g. by an injected script): there is no legitimate reason to
/// drag those files into chat, and it denies a would-be XSS its highest-value
/// local targets. `canonical` must already be canonicalized (symlinks resolved)
/// so a symlink can't point out of an allowed dir into the private one.
fn deny_feral_private(canonical: &std::path::Path) -> Result<(), String> {
    if let Ok(feral) = paths::feral_dir().canonicalize() {
        if canonical.starts_with(&feral) {
            return Err("Access denied: path is inside the Feral private directory".into());
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn read_file_as_text(path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (max 10 MB)".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Read failed: {}", e))
}

/// Read an image file and return it as a `data:<mime>;base64,...` URL.
/// Used by the chat input's drag&drop path — dropped files arrive as OS
/// paths via the Tauri drag-drop event, so the webview can't read them
/// with the DOM File API the way pasted screenshots are read.
///
/// Security: this command is reachable from the webview, so it must not become
/// an arbitrary-file-read primitive. Two guards on top of the size cap:
///   - the resolved (canonical, symlink-followed) path may NOT be inside the
///     Feral private dir (`~/.feral`) where the api-token, byok metadata and
///     the agent DB live — there is no legitimate reason to drag those in, and
///     it denies a would-be XSS its highest-value local targets.
///   - the extension allowlist below keeps it to images, so it can never
///     return the *text* of a secret file even outside `~/.feral`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn read_file_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (max 10 MB)".into());
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return Err(format!("Not a supported image format: .{ext}")),
    };
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Read failed: {}", e))?;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Best-effort text extraction for chat attachments: PDF, OOXML/ODF documents
/// (docx/pptx/xlsx/odt) and any UTF-8 text file. This is what lets "drop any
/// file into the chat" actually reach the model — previously only plain text
/// survived and everything else became an "Unsupported format" dead chip.
///
/// Errors with the literal prefix "binary:" when the file has no extractable
/// text, so the frontend can fall back to attaching a path reference instead
/// of an error chip.
#[tauri::command]
#[specta::specta]
pub(crate) async fn extract_file_text(path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 25 * 1024 * 1024 {
        return Err("File too large (max 25 MB)".into());
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // PDF/zip parsing is CPU-bound — keep it off the async runtime.
    let text = tokio::task::spawn_blocking(move || extract_text_blocking(&canonical, &ext))
        .await
        .map_err(|e| format!("Extraction task failed: {}", e))??;
    const MAX_CHARS: usize = 200_000;
    if text.chars().count() > MAX_CHARS {
        let truncated: String = text.chars().take(MAX_CHARS).collect();
        return Ok(format!("{}\n\n[content truncated — file is longer]", truncated));
    }
    Ok(text)
}

fn extract_text_blocking(path: &std::path::Path, ext: &str) -> Result<String, String> {
    match ext {
        "pdf" => pdf_extract::extract_text(path)
            .map_err(|e| format!("PDF extraction failed: {}", e)),
        "docx" | "odt" | "pptx" | "xlsx" => extract_zip_xml_text(path, ext),
        _ => {
            let bytes = std::fs::read(path).map_err(|e| format!("Read failed: {}", e))?;
            String::from_utf8(bytes).map_err(|_| "binary: no extractable text".to_string())
        }
    }
}

/// Pull visible text out of an OOXML/ODF container (they are all zip files
/// holding XML). Paragraph-level tags become newlines; everything else is
/// stripped. Not a full XML parse — good enough for "let the model read the
/// document" and zero extra dependencies beyond `zip`.
fn extract_zip_xml_text(path: &std::path::Path, ext: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Open failed: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a valid .{} file: {}", ext, e))?;

    let mut wanted: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let name = match archive.by_index(i) {
            Ok(f) => f.name().to_string(),
            Err(_) => continue,
        };
        let keep = match ext {
            "docx" => name == "word/document.xml",
            "odt" => name == "content.xml",
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            "xlsx" => name == "xl/sharedStrings.xml",
            _ => false,
        };
        if keep {
            wanted.push(name);
        }
    }
    if wanted.is_empty() {
        return Err(format!("binary: no text part found in .{} file", ext));
    }
    wanted.sort();

    let mut out = String::new();
    for name in &wanted {
        use std::io::Read as _;
        let mut entry = archive
            .by_name(name)
            .map_err(|e| format!("Zip entry failed: {}", e))?;
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|e| format!("Zip read failed: {}", e))?;
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&strip_xml_to_text(&xml));
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err(format!("binary: .{} file contains no text", ext));
    }
    Ok(trimmed.to_string())
}

/// Strip XML tags, turning paragraph/row boundaries into newlines and
/// decoding the five standard entities.
fn strip_xml_to_text(xml: &str) -> String {
    const PARAGRAPH_CLOSERS: &[&str] = &[
        "/w:p", "/text:p", "/text:h", "/a:p", "/si", "/w:tr", "/table:table-row",
    ];
    let mut out = String::with_capacity(xml.len() / 8);
    let mut tag = String::new();
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.split_whitespace().next().unwrap_or("");
                if PARAGRAPH_CLOSERS.contains(&t) || t == "w:br" || t == "w:br/" {
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
            _ => {
                if in_tag {
                    tag.push(ch);
                } else {
                    out.push(ch);
                }
            }
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}
