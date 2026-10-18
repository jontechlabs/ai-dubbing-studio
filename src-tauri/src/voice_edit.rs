//! Non-destructive local edits. Every consumer uses this rendered, content-keyed
//! WAV before fitting the take to its video slot. Generated originals never change.
use crate::{audio_files, domain::io_error, jobs, media, project};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncReadExt;
static EDIT_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Piece {
    pub source_start_ms: Option<u64>,
    pub source_end_ms: Option<u64>,
    pub duration_ms: u64,
    pub gain: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    pub pieces: Vec<Piece>,
}
impl Edit {
    pub fn duration(&self) -> u64 {
        self.pieces.iter().map(|p| p.duration_ms).sum()
    }
    pub fn validate(&self, source_ms: u64) -> Result<(), String> {
        if self.pieces.is_empty() || self.pieces.len() > 256 {
            return Err("INVALID_VOICE_EDIT".into());
        }
        let mut duration = 0u64;
        for p in &self.pieces {
            let valid_source = match (p.source_start_ms, p.source_end_ms) {
                (None, None) => true,
                (Some(start), Some(end)) => start < end && end <= source_ms,
                _ => false,
            };
            if !valid_source
                || !(1..=120000).contains(&p.duration_ms)
                || !p.gain.is_finite()
                || !(0.0..=2.0).contains(&p.gain)
            {
                return Err("INVALID_VOICE_EDIT".into());
            }
            duration = duration
                .checked_add(p.duration_ms)
                .ok_or("INVALID_VOICE_EDIT")?;
            if duration > 120000 {
                return Err("INVALID_VOICE_EDIT".into());
            }
        }
        Ok(())
    }
}
pub fn key(edit: Option<&Edit>) -> String {
    edit.map(|e| serde_json::to_string(e).unwrap_or_default())
        .unwrap_or_default()
}
pub fn validate(p: &crate::domain::Project) -> Result<(), String> {
    if !p.voice_edits.is_empty() && p.format_version < 11 {
        return Err("INVALID_VOICE_EDIT".into());
    }
    for (id, edit) in &p.voice_edits {
        let g = p
            .generations
            .iter()
            .find(|g| g["kind"] == "tts" && g["id"] == *id)
            .ok_or("INVALID_VOICE_EDIT")?;
        edit.validate(g["durationMs"].as_u64().ok_or("INVALID_VOICE_EDIT")?)?;
    }
    Ok(())
}
pub async fn render(
    root: &Path,
    path: &str,
    edit: Option<&Edit>,
    ffmpeg: &Path,
    flag: &AtomicBool,
) -> Result<PathBuf, String> {
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let source = project::asset(root, path)?;
    let Some(edit) = edit else {
        return Ok(source);
    };
    let frames = audio_files::pcm_frames(&source, 1, 24000, "INVALID_GENERATION")?;
    if frames > 120 * 24000 {
        return Err("INVALID_GENERATION".into());
    }
    edit.validate(frames / 24)?;
    let target = edit.duration() * 24;
    let mut hash = Sha256::new();
    hash.update(b"voice-local-edit-v1");
    hash.update(key(Some(edit)));
    hash.update(std::fs::read(&source).map_err(io_error)?);
    let name = format!("voice-edit-{:x}.wav", hash.finalize());
    let cache = project::ensure_directory(root, "cache")?;
    let output = cache.join(&name);
    let _permit = tokio::select! { _ = jobs::cancelled(flag) => return Err("CANCELLED".into()), permit = EDIT_GATE.acquire() => permit.map_err(io_error)? };
    if output.exists() {
        let verified = project::asset(root, &format!("cache/{name}"))?;
        if audio_files::pcm_frames(&verified, 1, 24000, "INVALID_VOICE_EDIT").ok() == Some(target) {
            return Ok(verified);
        }
    }
    let temporary = tempfile::NamedTempFile::new_in(&cache)
        .map_err(io_error)?
        .into_temp_path();
    let script = tempfile::NamedTempFile::new_in(&cache).map_err(io_error)?;
    let audible: Vec<_> = edit
        .pieces
        .iter()
        .enumerate()
        .filter(|(_, p)| p.source_start_ms.is_some() && p.gain > 0.0)
        .collect();
    let mut filters = vec![];
    if !audible.is_empty() {
        filters.push(format!(
            "[0:a]asplit={}{dirs}",
            audible.len(),
            dirs = audible
                .iter()
                .map(|(i, _)| format!("[s{i}]"))
                .collect::<String>()
        ));
    }
    for (i, p) in edit.pieces.iter().enumerate() {
        let n = p.duration_ms * 24;
        if let (Some(start), Some(end)) = (p.source_start_ms, p.source_end_ms) {
            if p.gain > 0.0 {
                let mut chain = format!(
                    "[s{i}]atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS",
                    start * 24,
                    end * 24
                );
                let mut ratio = (end - start) as f64 / p.duration_ms as f64;
                if (ratio - 1.0).abs() > 1e-10 {
                    while ratio > 100.0 {
                        chain.push_str(",rubberband=tempo=100:pitch=1");
                        ratio /= 100.0;
                    }
                    while ratio < 0.01 {
                        chain.push_str(",rubberband=tempo=0.01:pitch=1");
                        ratio /= 0.01;
                    }
                    chain.push_str(&format!(",rubberband=tempo={ratio:.12}:pitch=1"));
                }
                chain.push_str(&format!(",volume={:.9},apad=whole_len={n},atrim=end_sample={n},afade=t=in:ss=0:ns={},afade=t=out:ss={}:ns={},asetpts=PTS-STARTPTS[p{i}]", p.gain, 48.min(n / 2), n.saturating_sub(48.min(n / 2)), 48.min(n / 2)));
                filters.push(chain);
                continue;
            }
        }
        filters.push(format!(
            "anullsrc=r=24000:cl=mono,atrim=end_sample={n},asetpts=PTS-STARTPTS[p{i}]"
        ));
    }
    filters.push(format!(
        "{}concat=n={}:v=0:a=1[out]",
        (0..edit.pieces.len())
            .map(|i| format!("[p{i}]"))
            .collect::<String>(),
        edit.pieces.len()
    ));
    std::fs::write(script.path(), filters.join(";\n")).map_err(io_error)?;
    let mut child = media::command(ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-threads",
            "1",
            "-filter_complex_threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(&source)
        .arg("-filter_complex_script")
        .arg(script.path())
        .args([
            "-map",
            "[out]",
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
    let mut stderr = child.stderr.take().ok_or("VOICE_EDIT_FAILED")?;
    let logger = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut bytes = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut bytes).await {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&bytes[..n]);
            if tail.len() > 8192 {
                tail.drain(..tail.len() - 8192);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let result = tokio::select! {
        _ = jobs::cancelled(flag) => { let _ = child.kill().await; let _ = child.wait().await; Err("CANCELLED".to_string()) },
        result = tokio::time::timeout(std::time::Duration::from_secs(120), child.wait()) => match result {
            Ok(result) => result.map_err(io_error), Err(_) => { let _ = child.kill().await; let _ = child.wait().await; Err("VOICE_EDIT_FAILED".into()) }
        }
    };
    let log = logger.await.map_err(io_error)?;
    if !result?.success() {
        return Err(format!("VOICE_EDIT_FAILED: {log}"));
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if audio_files::pcm_frames(&temporary, 1, 24000, "VOICE_EDIT_FAILED")? != target {
        return Err("VOICE_EDIT_FAILED".into());
    }
    temporary.persist(&output).map_err(io_error)?;
    Ok(output)
}
