//! Derived, disposable audio shared by the video player and MKV export.
//! Original takes are immutable; changing timings produces a different cache key.
use crate::{audio_files, domain::io_error, jobs, media, project};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncReadExt;
static FIT_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[cfg(test)]
pub(crate) async fn take(
    root: &Path,
    path: &str,
    slot_ms: u64,
    ffmpeg: &Path,
    flag: &AtomicBool,
) -> Result<PathBuf, String> {
    take_with_duration(root, path, slot_ms, false, ffmpeg, flag).await
}
pub(crate) async fn take_with_duration(
    root: &Path,
    path: &str,
    slot_ms: u64,
    exact: bool,
    ffmpeg: &Path,
    flag: &AtomicBool,
) -> Result<PathBuf, String> {
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if slot_ms == 0 {
        return Err("MIX_SLOT_CONFLICT".into());
    }
    if slot_ms > crate::voice_edit::MAX_DURATION_MS {
        return Err("VOICE_DURATION_OUT_OF_RANGE".into());
    }
    let source = project::asset(root, path)?;
    let frames = audio_files::pcm_frames(&source, 1, 24000, "INVALID_GENERATION")?;
    if frames > 120 * 24000 {
        return Err("INVALID_GENERATION".into());
    }
    let target = slot_ms.checked_mul(24).ok_or("INVALID_GENERATION")?;
    if frames == target || (!exact && frames <= target) {
        return Ok(source);
    }
    let mut hash = Sha256::new();
    hash.update(b"dubbing-fit-rubberband-v1");
    hash.update(target.to_le_bytes());
    hash.update(std::fs::read(&source).map_err(io_error)?);
    let cache = project::ensure_directory(root, "cache")?;
    let output = cache.join(format!("fit-{:x}.wav", hash.finalize()));
    if output.exists() {
        let verified = project::asset(
            root,
            &format!("cache/{}", output.file_name().unwrap().to_string_lossy()),
        )?;
        if audio_files::pcm_frames(&verified, 1, 24000, "INVALID_GENERATION").ok() == Some(target) {
            return Ok(verified);
        }
    }
    let _permit = tokio::select! {
        _ = jobs::cancelled(flag) => return Err("CANCELLED".into()),
        permit = FIT_GATE.acquire() => permit.map_err(io_error)?,
    };
    let temporary = tempfile::NamedTempFile::new_in(&cache)
        .map_err(io_error)?
        .into_temp_path();
    let mut ratio = frames as f64 / target as f64;
    let mut filters = vec![];
    // Rubber Band preserves pitch. Chain its supported tempo range for extreme slots;
    // the UI explicitly flags acceleration above 1.5x for listening/rewording.
    while ratio > 100.0 {
        filters.push("rubberband=tempo=100:pitch=1".to_string());
        ratio /= 100.0;
    }
    while ratio < 0.01 {
        filters.push("rubberband=tempo=0.01:pitch=1".to_string());
        ratio /= 0.01;
    }
    filters.push(format!("rubberband=tempo={ratio:.12}:pitch=1"));
    filters.push(format!(
        "apad=whole_len={target},atrim=end_sample={target},asetpts=PTS-STARTPTS"
    ));
    let mut child = media::command(ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(&source)
        .args([
            "-af",
            &filters.join(","),
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-y",
        ])
        .arg(&temporary)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let mut stderr = child.stderr.take().ok_or("VOICE_FIT_FAILED")?;
    let logger = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut bytes = [0u8; 4096];
        while let Ok(length) = stderr.read(&mut bytes).await {
            if length == 0 {
                break;
            }
            tail.extend_from_slice(&bytes[..length]);
            if tail.len() > 8192 {
                tail.drain(..tail.len() - 8192);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let result = tokio::select! {
        _ = jobs::cancelled(flag) => { let _ = child.kill().await; let _ = child.wait().await; Err("CANCELLED".to_string()) },
        result = tokio::time::timeout(std::time::Duration::from_secs(90), child.wait()) => match result {
            Ok(result) => result.map_err(io_error),
            Err(_) => { let _ = child.kill().await; let _ = child.wait().await; Err("VOICE_FIT_FAILED".into()) },
        },
    };
    let log = logger.await.map_err(io_error)?;
    if !result?.success() {
        return Err(format!("VOICE_FIT_FAILED: {log}"));
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if audio_files::pcm_frames(&temporary, 1, 24000, "VOICE_FIT_FAILED")? != target {
        return Err("VOICE_FIT_FAILED".into());
    }
    temporary.persist(&output).map_err(io_error)?;
    Ok(output)
}
