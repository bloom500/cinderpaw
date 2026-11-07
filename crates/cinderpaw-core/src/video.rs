//! Video links: yt-dlp + ffmpeg on first use, a link's title and picture, a
//! short clip for hover, and the whole video to watch in the app.
//!
//! Darius, 29 Oct 2026: a YouTube, Instagram or X link should show as the video
//! itself, in the composer and in the chat. yt-dlp reads all of those sites with
//! one command, so one road serves every site; a site it cannot read stays a
//! plain link. Both programs are portable copies under
//! `~/.cinderpaw/toolchain/video/` (see toolchain.rs for why portable): nothing
//! on a fresh machine has them, and the person says yes before ~150 MB arrive.
//! The agent's `watch_video` tool reads the same folder and the same list.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The download list, shared with the agent (CinderpawAgent/src/video/tools.json).
const TOOLS: &str = include_str!("../../../CinderpawAgent/src/video/tools.json");

pub struct VideoTools {
    pub yt_dlp: PathBuf,
    pub ffmpeg: PathBuf,
}

fn dir() -> PathBuf {
    crate::paths::cinderpaw_dir().join("toolchain").join("video")
}

/// Node's `<platform>-<arch>` names, the keys of tools.json.
fn platform_key() -> String {
    let os = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

fn url_for(tool: &str) -> Option<String> {
    let all: serde_json::Value = serde_json::from_str(TOOLS).ok()?;
    all[tool][platform_key()].as_str().map(str::to_string)
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// The first file called `name` under `root`, depth first (ffmpeg archives nest it in bin/).
fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            dirs.push(p);
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    dirs.iter().find_map(|d| find_file(d, name))
}

/// Both programs, when they are already here.
pub fn find() -> Option<VideoTools> {
    let yt_dlp = dir().join(exe("yt-dlp"));
    let ffmpeg = find_file(&dir().join("ffmpeg"), &exe("ffmpeg"))?;
    yt_dlp.exists().then_some(VideoTools { yt_dlp, ffmpeg })
}

#[cfg(unix)]
fn make_runnable(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755));
}
#[cfg(not(unix))]
fn make_runnable(_: &Path) {}

/// Download whatever is missing. Called only after the person said yes.
pub async fn fetch() -> Result<VideoTools, String> {
    if let Some(t) = find() {
        return Ok(t);
    }
    let yt_url = url_for("ytDlp").ok_or("yt-dlp has no build for this computer")?;
    let ff_url = url_for("ffmpeg").ok_or("ffmpeg has no build for this computer")?;
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;

    let yt = dir().join(exe("yt-dlp"));
    if !yt.exists() {
        let bytes = reqwest::get(&yt_url).await.and_then(|r| r.error_for_status())
            .map_err(|e| format!("Downloading yt-dlp failed ({e}). Check the internet connection and try again."))?
            .bytes().await.map_err(|e| e.to_string())?;
        let part = yt.with_extension("part");
        std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &yt).map_err(|e| e.to_string())?;
        make_runnable(&yt);
    }
    if find_file(&dir().join("ffmpeg"), &exe("ffmpeg")).is_none() {
        // toolchain::fetch_and_extract unpacks into toolchain/<name>.
        tokio::time::timeout(Duration::from_secs(900), crate::toolchain::fetch_and_extract(&ff_url, "video/ffmpeg", None))
            .await
            .map_err(|_| "Downloading ffmpeg took more than 15 minutes. Check the internet connection and try again.".to_string())?
            .map_err(|e| format!("Downloading ffmpeg failed ({e}). Check the internet connection and try again."))?;
    }
    let tools = find().ok_or("The download finished but ffmpeg was not in it. Try again.")?;
    make_runnable(&tools.ffmpeg);
    Ok(tools)
}

/// yt-dlp with the flags every call shares, and no console window on Windows.
fn yt_dlp(t: &VideoTools) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&t.yt_dlp);
    cmd.arg("--no-playlist").arg("--no-warnings").arg("--ffmpeg-location").arg(&t.ffmpeg);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.kill_on_drop(true);
    cmd
}

async fn run(mut cmd: tokio::process::Command, secs: u64) -> Result<Vec<u8>, String> {
    let out = tokio::time::timeout(Duration::from_secs(secs), cmd.output())
        .await
        .map_err(|_| "The video site took too long to answer.".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("the site did not give the video");
        return Err(line.trim().trim_start_matches("ERROR:").trim().to_string());
    }
    Ok(out.stdout)
}

/// What a link's card shows. None of these fields is required by a site.
#[derive(serde::Serialize, Clone, Debug, specta::Type)]
pub struct VideoInfo {
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub uploader: Option<String>,
    pub site: Option<String>,
}

pub async fn info(url: &str) -> Result<VideoInfo, String> {
    let t = find().ok_or("no-tools")?;
    let mut cmd = yt_dlp(&t);
    cmd.arg("-J").arg("--skip-download").arg("--").arg(url);
    let v: serde_json::Value = serde_json::from_slice(&run(cmd, 45).await?).map_err(|e| e.to_string())?;
    let s = |k: &str| v[k].as_str().map(str::to_string);
    Ok(VideoInfo {
        title: s("title"),
        thumbnail: s("thumbnail"),
        duration: v["duration"].as_f64(),
        uploader: s("uploader").or_else(|| s("channel")),
        site: s("extractor_key"),
    })
}

/// Where one link's files live: `~/.cinderpaw/cache/videos/<hash of the link>/`.
fn cache_for(url: &str) -> PathBuf {
    use sha2::Digest;
    let h: String = sha2::Sha256::digest(url.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    crate::paths::cinderpaw_dir().join("cache").join("videos").join(h)
}

/// The first 10 seconds, small, for hover. Made once per link.
pub async fn preview(url: &str) -> Result<PathBuf, String> {
    let out = cache_for(url).join("preview.mp4");
    if out.exists() {
        return Ok(out);
    }
    let t = find().ok_or("no-tools")?;
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut cmd = yt_dlp(&t);
    cmd.args(["-f", "worst[ext=mp4][height>=240]/worst[ext=mp4]/worst", "--download-sections", "*0-10", "--remux-video", "mp4", "-o"])
        .arg(&out).arg("--").arg(url);
    run(cmd, 120).await?;
    out.exists().then_some(out).ok_or_else(|| "The clip did not arrive.".into())
}

/// The whole video, at most 720p, to watch in the app. Made once per link.
pub async fn full(url: &str) -> Result<PathBuf, String> {
    let out = cache_for(url).join("video.mp4");
    if out.exists() {
        return Ok(out);
    }
    let t = find().ok_or("no-tools")?;
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut cmd = yt_dlp(&t);
    cmd.args(["-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]/b", "--merge-output-format", "mp4", "-o"])
        .arg(&out).arg("--").arg(url);
    run(cmd, 1800).await?;
    out.exists().then_some(out).ok_or_else(|| "The video did not arrive.".into())
}

/// ffmpeg with no console window on Windows.
fn ffmpeg(t: &VideoTools) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&t.ffmpeg);
    cmd.arg("-hide_banner");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.kill_on_drop(true);
    cmd
}

/// Seconds, from the "Duration: 00:00:55.70" line ffmpeg prints for any input.
async fn duration_of(t: &VideoTools, file: &Path) -> Option<f64> {
    let out = ffmpeg(t).arg("-i").arg(file).output().await.ok()?;
    let err = String::from_utf8_lossy(&out.stderr);
    let d = err.split("Duration: ").nth(1)?.split(',').next()?.trim().to_string();
    let p: Vec<f64> = d.split(':').filter_map(|x| x.parse().ok()).collect();
    (p.len() == 3).then(|| p[0] * 3600.0 + p[1] * 60.0 + p[2])
}

/// Plain text out of a WebVTT file: no timings, no tags, no repeated lines
/// (auto captions repeat each line as it scrolls).
fn vtt_text(vtt: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in vtt.lines() {
        let l = line.trim();
        if l.is_empty() || l == "WEBVTT" || l.contains("-->") || l.starts_with("Kind:") || l.starts_with("Language:") || l.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let mut clean = String::new();
        let mut in_tag = false;
        for c in l.chars() {
            match c { '<' => in_tag = true, '>' => in_tag = false, _ if !in_tag => clean.push(c), _ => {} }
        }
        let clean = clean.trim().to_string();
        if !clean.is_empty() && out.last() != Some(&clean) {
            out.push(clean);
        }
    }
    out.join(" ")
}

/// What the agent gets from a video, whatever model it runs on: evenly spaced
/// frames (a model that can see reads them) and the words said in it, from the
/// site's captions (a model that cannot see still has those, plus the title).
#[derive(serde::Serialize)]
pub struct Watched {
    pub title: Option<String>,
    pub duration: Option<f64>,
    pub uploader: Option<String>,
    /// The video on disk, so the agent can cut a closer look with its own tools.
    pub file: String,
    /// The second each frame was taken at, in order.
    pub times: Vec<f64>,
    /// JPEGs as base64. One frame each, or `per_picture` frames laid out in a grid.
    pub pictures: Vec<String>,
    pub per_picture: usize,
    pub transcript: Option<String>,
}

/// Up to this many frames come as separate pictures; more are laid out
/// GRID x GRID to a picture. A model takes about a hundred pictures in one
/// request (Claude's ceiling is 100), so 300 separate frames would fail where
/// 19 grids of 16 go through. Darius, 30 Oct: no cap of 16 frames.
const GRID: usize = 4;
const ALONE: usize = GRID * GRID;
/// The most frames one call returns: 25 grids. Past that the agent asks again
/// for the next stretch (`start`/`end`), so any video can be seen frame by frame.
pub const MAX_FRAMES: usize = 400;

fn is_picture(file: &Path) -> bool {
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "avif"].contains(&ext.as_str())
}

/// When nobody asked for a number: one frame every 2 seconds of what is
/// watched, at least 8 and at most 64 (4 grids).
fn default_frames(span: Option<f64>) -> usize {
    span.map(|s| (s / 2.0).round() as usize).unwrap_or(8).clamp(8, 64)
}

/// `source` is a link (downloaded once, the same file the chat's player uses)
/// or a local file the host has already checked the agent may read: a video,
/// or a picture, which comes back as itself. `start`/`end` (seconds) narrow
/// the frames to one stretch, for a closer look at a moment.
pub async fn watch(source: &str, frames: Option<usize>, start: Option<f64>, end: Option<f64>) -> Result<Watched, String> {
    use base64::Engine as _;
    let t = find().ok_or("no-tools")?;
    let is_link = source.starts_with("http://") || source.starts_with("https://");
    let (file, mut info, transcript) = if is_link {
        let info = info(source).await.ok();
        let file = full(source).await?;
        // Captions only, in the languages people here speak plus whatever the
        // video was recorded in ("-orig"); never the site's hundred auto-translations.
        let subs = cache_for(source).join("subs");
        let mut cmd = yt_dlp(&t);
        cmd.args(["--skip-download", "--write-subs", "--write-auto-subs", "--sub-format", "vtt", "--sub-langs", "en.*,ro.*,.*-orig", "-o"])
            .arg(&subs).arg("--").arg(source);
        let _ = run(cmd, 60).await;
        let vtt = std::fs::read_dir(cache_for(source)).ok().and_then(|d| {
            d.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "vtt"))
        });
        let text = vtt.and_then(|p| std::fs::read_to_string(p).ok()).map(|s| vtt_text(&s)).filter(|s| !s.is_empty());
        (file, info, text)
    } else {
        (PathBuf::from(source), None, None)
    };
    let dir = std::env::temp_dir().join(format!("cinderpaw-frames-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let picture = is_picture(&file);
    let duration = if picture { None } else { duration_of(&t, &file).await.or(info.as_ref().and_then(|i| i.duration)) };
    let from = start.unwrap_or(0.0).max(0.0);
    let to = end.or(duration).filter(|&e| e > from);
    let n = if picture { 1 } else { frames.unwrap_or_else(|| default_frames(to.map(|e| e - from))).clamp(1, MAX_FRAMES) };
    let scale = if picture {
        // Up to the size a model reads at, never blown up. ffmpeg also opens
        // the kinds a model cannot take as they are (HEIC, TIFF, BMP).
        "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2".to_string()
    } else if n > ALONE {
        "scale=w=384:h=384:force_original_aspect_ratio=decrease:force_divisible_by=2".to_string()
    } else {
        "scale=512:-2".to_string()
    };
    let mut times = Vec::new();
    for i in 0..n {
        // The middle of each of n equal slices, so neither the black first frame nor the end card.
        let at = to.map(|e| from + (e - from) * (i as f64 + 0.5) / n as f64).unwrap_or(from + i as f64 * 5.0);
        // Numbered by frames taken, not asked for, so the grids below see no gap.
        let out = dir.join(format!("{:04}.jpg", times.len()));
        let mut cmd = ffmpeg(&t);
        if !picture {
            cmd.args(["-ss", &format!("{at:.2}")]);
        }
        let ok = cmd.arg("-i").arg(&file)
            .args(["-frames:v", "1", "-vf", &scale, "-q:v", "4", "-y"]).arg(&out)
            .status().await.is_ok_and(|s| s.success());
        // A time past the end "succeeds" with no file.
        if ok && out.exists() {
            times.push(if picture { 0.0 } else { (at * 10.0).round() / 10.0 });
        }
    }
    let per_picture = if times.len() > ALONE { ALONE } else { 1 };
    let names: Vec<PathBuf> = if per_picture == 1 {
        (0..times.len()).map(|i| dir.join(format!("{i:04}.jpg"))).collect()
    } else {
        let _ = ffmpeg(&t)
            .args(["-framerate", "1", "-i"]).arg(dir.join("%04d.jpg"))
            .args(["-vf", &format!("tile={GRID}x{GRID}:padding=6:color=white"), "-q:v", "3", "-y"]).arg(dir.join("grid_%03d.jpg"))
            .status().await;
        (1..=times.len().div_ceil(ALONE)).map(|i| dir.join(format!("grid_{i:03}.jpg"))).collect()
    };
    let pictures: Vec<String> = names.iter().filter_map(|p| std::fs::read(p).ok())
        .map(|b| base64::engine::general_purpose::STANDARD.encode(b)).collect();
    let _ = std::fs::remove_dir_all(&dir);
    if pictures.len() != names.len() {
        return Err("ffmpeg could not lay the frames out in grids. Ask for 16 frames or fewer.".into());
    }
    let info = info.take();
    Ok(Watched {
        title: info.as_ref().and_then(|i| i.title.clone())
            .or_else(|| file.file_name().map(|n| n.to_string_lossy().into_owned())),
        duration,
        uploader: info.and_then(|i| i.uploader),
        file: file.to_string_lossy().into_owned(),
        times,
        pictures,
        per_picture,
        transcript,
    })
}

/// The agent's side of the bridge: `video.ready`, `video.install`, `video.watch`.
/// A local path reaches here only after the host checked it (src-tauri lib.rs).
pub async fn handle_from_agent(op: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    match op {
        "ready" => Ok(serde_json::json!({ "ready": find().is_some() })),
        "install" => fetch().await.map(|_| serde_json::json!({ "ready": true })),
        "watch" => {
            let source = params["source"].as_str().ok_or("video.watch needs a source")?;
            let frames = params["frames"].as_u64().map(|n| n as usize);
            let (start, end) = (params["start"].as_f64(), params["end"].as_f64());
            serde_json::to_value(watch(source, frames, start, end).await?).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown video action: {other}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn captions_become_plain_text_once() {
        let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000\n<c>Hello</c> there\n\n00:00:01.000 --> 00:00:03.000\nHello there\nGeneral Kenobi\n";
        assert_eq!(super::vtt_text(vtt), "Hello there General Kenobi");
    }

    use super::*;

    #[test]
    fn this_computer_has_both_downloads() {
        assert!(url_for("ytDlp").is_some_and(|u| u.starts_with("https://")));
        assert!(url_for("ffmpeg").is_some_and(|u| u.starts_with("https://")));
    }

    #[test]
    fn the_default_grows_with_the_video() {
        assert_eq!(default_frames(None), 8);
        assert_eq!(default_frames(Some(5.0)), 8);
        assert_eq!(default_frames(Some(30.0)), 15);
        assert_eq!(default_frames(Some(3600.0)), 64);
        assert!(is_picture(Path::new("C:/a/Photo.HEIC")) && !is_picture(Path::new("a.mp4")));
    }

    #[test]
    fn one_link_one_folder() {
        assert_eq!(cache_for("https://youtu.be/a"), cache_for("https://youtu.be/a"));
        assert_ne!(cache_for("https://youtu.be/a"), cache_for("https://youtu.be/b"));
    }
}
