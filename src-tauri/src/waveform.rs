use crate::{domain::io_error, jobs, media, project, Core};
use serde::{Deserialize, Serialize};
use std::{
    hash::{Hash, Hasher},
    path::Path,
    process::Stdio,
    sync::{atomic::Ordering, Arc},
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub duration_ms: u64,
    pub step_ms: u64,
    pub peaks: Vec<f32>,
    pub audio_stream_index: u32,
}

pub async fn decode(
    executable: &Path,
    input: &Path,
    index: u32,
    duration_ms: u64,
    progress: impl Fn(f64),
) -> Result<Waveform, String> {
    let step_ms = 20.max(duration_ms.div_ceil(200_000));
    let samples_per_bin = step_ms * 8;
    let mut child = media::command(executable)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-copyts",
            "-start_at_zero",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(input)
        .args([
            "-map",
            &format!("0:{index}"),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-af",
            "aresample=8000:first_pts=0",
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let mut stdout = child.stdout.take().ok_or("WAVEFORM_FAILED")?;
    let stderr = child.stderr.take().ok_or("WAVEFORM_FAILED")?;
    let error_reader = async move {
        let mut bytes = Vec::new();
        stderr
            .take(65_536)
            .read_to_end(&mut bytes)
            .await
            .map_err(io_error)?;
        Ok::<_, String>(bytes)
    };
    let decode = async move {
        let mut buffer = vec![0_u8; 32_768];
        let mut pending = None;
        let mut count = 0_u64;
        let mut peak = 0_f32;
        let mut peaks = Vec::new();
        loop {
            let prefix = if let Some(byte) = pending.take() {
                buffer[0] = byte;
                1
            } else {
                0
            };
            let n = stdout.read(&mut buffer[prefix..]).await.map_err(io_error)?;
            if n == 0 {
                break;
            }
            let length = n + prefix;
            for bytes in buffer[..length].as_chunks::<2>().0 {
                let sample = i16::from_le_bytes(*bytes) as f32 / 32_768.0;
                peak = peak.max(sample.abs());
                count += 1;
                if count.is_multiple_of(samples_per_bin) {
                    peaks.push(peak);
                    peak = 0.0;
                }
            }
            if !length.is_multiple_of(2) {
                pending = Some(buffer[length - 1]);
            }
            if peaks.len() > 200_000 {
                return Err("WAVEFORM_FAILED: duration limit".into());
            }
            progress((count as f64 / 8.0 / duration_ms.max(1) as f64).min(0.99));
        }
        if !count.is_multiple_of(samples_per_bin) {
            peaks.push(peak);
        }
        if count == 0 {
            return Err("WAVEFORM_FAILED: empty audio".into());
        }
        Ok(Waveform {
            duration_ms: count / 8,
            step_ms,
            peaks,
            audio_stream_index: index,
        })
    };
    let (result, errors) = tokio::join!(decode, error_reader);
    let status = child.wait().await.map_err(io_error)?;
    if !status.success() {
        return Err(format!(
            "WAVEFORM_FAILED: {}",
            String::from_utf8_lossy(&errors?)
        ));
    }
    result
}

pub async fn get<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    track_id: Option<&str>,
) -> Result<Option<Waveform>, String> {
    let (root, project_id, input, index, duration) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if let Some(track_id) = track_id {
            let track = s
                .project
                .tracks
                .iter()
                .find(|track| track.id == track_id && track.kind == "audio")
                .ok_or("INVALID_PROJECT")?;
            (
                s.root.clone(),
                s.project.id.clone(),
                project::asset(&s.root, track.path.as_deref().ok_or("INVALID_PATH")?)?,
                0,
                track.duration_ms.ok_or("INVALID_PROJECT")?,
            )
        } else {
            let asset = s.project.media.as_ref().ok_or("MEDIA_MISSING")?;
            let Some(index) = asset.audio_stream_index else {
                return Ok(None);
            };
            if !asset
                .info
                .streams
                .iter()
                .any(|s| s.kind == "audio" && s.index == index)
            {
                return Ok(None);
            }
            (
                s.root.clone(),
                s.project.id.clone(),
                project::asset(&s.root, &asset.path)?,
                index,
                asset.info.duration_ms,
            )
        }
    };
    let metadata = std::fs::metadata(&input).map_err(io_error)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        input.clone(),
        metadata.len(),
        metadata.modified().map_err(io_error)?,
        index,
        1_u8,
    )
        .hash(&mut hash);
    project::ensure_directory(&root, "cache")?;
    let cache = root.join(format!("cache/waveform_v1_{:016x}.json", hash.finish()));
    if let Ok(bytes) = std::fs::read(&cache) {
        if let Ok(data) = serde_json::from_slice::<Waveform>(&bytes) {
            if data.step_ms > 0
                && data.peaks.len() <= 200_001
                && data
                    .peaks
                    .iter()
                    .all(|p| p.is_finite() && *p >= 0.0 && *p <= 1.0)
            {
                return Ok(Some(data));
            }
        }
    }
    let key = jobs::create(&core, &app, "waveform", project_id, None);
    jobs::update(&core, &app, &key, |job| job.stage = "waveform".into());
    let flag = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&key)
        .ok_or("INVALID_PROJECT")?
        .cancel
        .clone();
    let result: Result<Option<Waveform>, String> = async {
        let _permit = tokio::select! { _ = jobs::cancelled(&flag) => return Err("CANCELLED".into()), permit = core.gate.clone().acquire_owned() => permit.map_err(io_error)?, };
        if flag.load(Ordering::Relaxed) { return Err("CANCELLED".into()); }
        jobs::update(&core, &app, &key, |job| job.status = "running".into());
        let executable = media::binary(&app, "ffmpeg")?;
        let last = std::sync::atomic::AtomicU64::new(0);
        let progress = |fraction: f64| {
            // IPC and the persistent job log only need coarse updates.
            let bucket = (fraction * 50.0) as u64;
            if bucket > last.load(Ordering::Relaxed) {
                last.store(bucket, Ordering::Relaxed);
                jobs::update(&core, &app, &key, |job| job.progress = Some(fraction));
            }
        };
        let data = tokio::select! {
            _ = jobs::cancelled(&flag) => return Err("CANCELLED".into()),
            result = tokio::time::timeout(std::time::Duration::from_secs(1200), decode(&executable, &input, index, duration, progress)) => result.map_err(|_| "WAVEFORM_FAILED: timeout".to_owned())??,
        };
        if flag.load(Ordering::Relaxed) { return Err("CANCELLED".into()); }
        project::atomic_write(&cache, &serde_json::to_vec(&data).map_err(io_error)?)?;
        Ok(Some(data))
    }.await;
    jobs::update(&core, &app, &key, |job| match &result {
        Ok(_) => {
            job.status = "succeeded".into();
            job.stage = "done".into();
            job.progress = Some(1.0);
        }
        Err(error) => {
            job.status = if error == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            job.error = Some(error.clone());
        }
    });
    result
}
