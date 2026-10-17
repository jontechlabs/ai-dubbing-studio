use crate::domain::{MediaInfo, MediaStream};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tokio::process::Command;

pub fn binary<R: tauri::Runtime>(app: &tauri::AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    let filename = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Ok(root) = app.path().resource_dir() {
        let path = root.join("binaries").join(&filename);
        if path.is_file() {
            return Ok(path);
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&filename);
    if dev.is_file() {
        return Ok(dev);
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for folder in std::env::split_paths(&paths) {
            let p = folder.join(&filename);
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err(if name == "ffmpeg" {
        "FFMPEG_UNAVAILABLE"
    } else {
        "FFPROBE_UNAVAILABLE"
    }
    .into())
}
pub fn command(path: &Path) -> Command {
    let mut c = Command::new(path);
    c.kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x08000000);
    c
}
pub async fn probe<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<MediaInfo, String> {
    probe_executable(&binary(app, "ffprobe")?, path).await
}
pub async fn probe_executable(executable: &Path, path: &Path) -> Result<MediaInfo, String> {
    probe_kind(executable, path, "video").await
}
pub async fn probe_audio<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<MediaInfo, String> {
    probe_kind(&binary(app, "ffprobe")?, path, "audio").await
}
async fn probe_kind(executable: &Path, path: &Path, kind: &str) -> Result<MediaInfo, String> {
    if !path.is_file() {
        return Err("INVALID_PATH".into());
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        command(executable)
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-of",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .output(),
    )
    .await
    .map_err(|_| "PROCESS_FAILED: probe timeout".to_string())?
    .map_err(crate::domain::io_error)?;
    if !output.status.success() {
        return Err(format!(
            "PROCESS_FAILED: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    if kind == "video" {
        parse_probe(&output.stdout, name)
    } else {
        parse_probe_kind(&output.stdout, name, "audio")
    }
}
pub fn parse_probe(bytes: &[u8], original_name: String) -> Result<MediaInfo, String> {
    parse_probe_kind(bytes, original_name, "video")
}
fn parse_probe_kind(bytes: &[u8], original_name: String, kind: &str) -> Result<MediaInfo, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "PROCESS_FAILED: invalid FFprobe JSON".to_string())?;
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let streams = value["streams"]
        .as_array()
        .ok_or("PROCESS_FAILED")?
        .iter()
        .map(|v| {
            let codec = v["codec_name"].as_str().unwrap_or("unknown").to_owned();
            MediaStream {
                index: v["index"].as_u64().unwrap_or(0) as u32,
                kind: v["codec_type"].as_str().unwrap_or("unknown").into(),
                bitmap: ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]
                    .contains(&codec.as_str()),
                codec,
                language: v["tags"]["language"].as_str().unwrap_or("und").into(),
                title: v["tags"]["title"].as_str().unwrap_or("").into(),
                channels: v["channels"].as_u64().map(|n| n as u32),
                width: v["width"].as_u64().map(|n| n as u32),
                height: v["height"].as_u64().map(|n| n as u32),
            }
        })
        .collect::<Vec<_>>();
    if !streams.iter().any(|s| s.kind == kind) {
        return Err(if kind == "video" {
            "NO_VIDEO"
        } else {
            "INVALID_REFERENCE_AUDIO"
        }
        .into());
    }
    Ok(MediaInfo {
        original_name,
        duration_ms: (duration.max(0.0) * 1000.0).round() as u64,
        streams,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streams_and_bitmap() {
        let p = parse_probe(br#"{"format":{"duration":"12.345"},"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","width":1920},{"index":1,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle","tags":{"language":"jpn"}}]}"#, "a.mkv".into()).unwrap();
        assert_eq!(p.duration_ms, 12345);
        assert!(p.streams[1].bitmap);
        assert_eq!(p.streams[1].language, "jpn");
    }
}
