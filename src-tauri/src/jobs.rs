use crate::{
    domain::{id, io_error, MediaAsset},
    media, project, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub status: String,
    pub progress: Option<f64>,
    pub stage: String,
    pub error: Option<String>,
    pub logs: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ImportRequest {
    #[serde(default)]
    pub lightweight: bool,
    pub path: PathBuf,
    pub root: PathBuf,
    pub project_id: String,
    pub audio_index: Option<u32>,
    pub force_proxy: bool,
    pub reuse: Option<MediaAsset>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PersistedJob {
    pub record: Job,
    pub request: Option<ImportRequest>,
    #[serde(default)]
    pub separation: Option<SeparationRequest>,
    #[serde(default)]
    pub runtime_cuda: Option<bool>,
    #[serde(default)]
    pub speaker_install: bool,
    #[serde(default)]
    pub speaker_request: Option<crate::speakers::Request>,
    #[serde(default)]
    pub tts_install: Option<bool>,
    #[serde(default)]
    pub voice_install: Option<String>,
    #[serde(default)]
    pub tts_request: Option<crate::tts::Request>,
    #[serde(default)]
    pub mix_request: Option<crate::mix::Request>,
    #[serde(default)]
    pub transcription: Option<crate::transcription::Request>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SeparationRequest {
    pub root: PathBuf,
    pub project_id: String,
    pub source_path: String,
    pub audio_index: u32,
    pub device: String,
}
pub struct Control {
    pub saved: PersistedJob,
    pub cancel: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
}

pub fn create<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    kind: &str,
    project_id: String,
    request: Option<ImportRequest>,
) -> String {
    let key = id();
    let record = Job {
        id: key.clone(),
        project_id,
        kind: kind.into(),
        status: "queued".into(),
        progress: None,
        stage: "probe".into(),
        error: None,
        logs: vec![],
    };
    if let Ok(mut jobs) = core.jobs.lock() {
        jobs.insert(
            key.clone(),
            Control {
                saved: PersistedJob {
                    record: record.clone(),
                    request,
                    separation: None,
                    runtime_cuda: None,
                    speaker_install: false,
                    speaker_request: None,
                    tts_install: None,
                    voice_install: None,
                    tts_request: None,
                    mix_request: None,
                    transcription: None,
                },
                cancel: Arc::new(AtomicBool::new(false)),
                paused: Arc::new(AtomicBool::new(false)),
            },
        );
    }
    let _ = app.emit("job-changed", &record);
    persist(core);
    key
}
pub fn persist(core: &Core) {
    if let Ok(jobs) = core.jobs.lock() {
        let saved: Vec<_> = jobs.values().map(|j| j.saved.clone()).collect();
        if let Ok(bytes) = serde_json::to_vec(&saved) {
            let _ = project::atomic_write(&core.data_dir.join("jobs.json"), &bytes);
        }
    }
}
pub fn update<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    change: impl FnOnce(&mut Job),
) {
    let record = core.jobs.lock().ok().and_then(|mut jobs| {
        jobs.get_mut(key).map(|c| {
            change(&mut c.saved.record);
            if c.saved.record.logs.len() > 160 {
                let extra = c.saved.record.logs.len() - 160;
                c.saved.record.logs.drain(..extra);
            }
            c.saved.record.clone()
        })
    });
    if let Some(record) = record {
        let _ = app.emit("job-changed", record);
    }
    persist(core);
}
pub fn active_processing(core: &Core) -> bool {
    core.jobs.lock().is_ok_and(|jobs| {
        jobs.values().any(|j| {
            ["import", "subtitles"].contains(&j.saved.record.kind.as_str())
                && ["queued", "running"].contains(&j.saved.record.status.as_str())
        })
    })
}
pub async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: ImportRequest,
) -> String {
    let key = create(
        &core,
        &app,
        "import",
        request.project_id.clone(),
        Some(request.clone()),
    );
    let return_id = key.clone();
    tauri::async_runtime::spawn(async move {
        let permit = core.gate.clone().acquire_owned().await;
        if permit.is_err() {
            return;
        }
        let flag = core
            .jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(&key).map(|c| c.cancel.clone()));
        let Some(flag) = flag else {
            return;
        };
        update(&core, &app, &key, |j| j.status = "running".into());
        let result = execute(&core, &app, &key, &request, &flag).await;
        if result.is_err() {
            for relative in [
                format!("cache/{key}.mp4"),
                format!(
                    "media/{key}.{}",
                    request
                        .path
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                ),
            ] {
                if let Ok(path) = project::asset(&request.root, &relative) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        update(&core, &app, &key, |j| match result {
            Ok(()) => {
                j.status = "succeeded".into();
                j.stage = "done".into();
                j.progress = Some(1.0);
            }
            Err(ref error) if error == "CANCELLED" => {
                j.status = "cancelled".into();
            }
            Err(error) => {
                j.status = "failed".into();
                j.error = Some(error);
            }
        });
    });
    return_id
}
async fn copy_media<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    source: &std::path::Path,
    target: &std::path::Path,
    flag: &AtomicBool,
) -> Result<(), String> {
    let mut input = tokio::fs::File::open(source).await.map_err(io_error)?;
    let total = input.metadata().await.map_err(io_error)?.len().max(1);
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .await
        .map_err(io_error)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut copied = 0_u64;
    let mut previous = -1_i32;
    loop {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let count = input.read(&mut buffer).await.map_err(io_error)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).await.map_err(io_error)?;
        copied += count as u64;
        let percent = (copied * 100 / total) as i32;
        if percent != previous {
            previous = percent;
            update(core, app, key, |j| {
                j.stage = "copy".into();
                j.progress = Some(copied as f64 / total as f64);
            });
        }
    }
    output.sync_all().await.map_err(io_error)?;
    Ok(())
}
struct ProxyInput<'a> {
    lightweight: bool,
    source: &'a std::path::Path,
    output: &'a std::path::Path,
    audio: Option<u32>,
    duration: u64,
}
async fn proxy<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    input: ProxyInput<'_>,
    flag: &AtomicBool,
) -> Result<(), String> {
    let ProxyInput {
        lightweight,
        source,
        output,
        audio,
        duration,
    } = input;
    let mut args = vec![
        "-hide_banner".to_owned(),
        "-loglevel".into(),
        "warning".into(),
        "-n".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v:0".into(),
    ];
    if let Some(index) = audio {
        args.extend([
            "-map".into(),
            format!("0:{index}"),
            "-c:a".into(),
            "aac".into(),
            "-ac".into(),
            "2".into(),
        ]);
    } else {
        args.push("-an".into());
    }
    args.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    args.extend(
        [
            "-g",
            "30",
            "-keyint_min",
            "30",
            "-sc_threshold",
            "0",
            "-threads",
            "2",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    if lightweight {
        args.extend(
            [
                "-vf",
                "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
            ]
            .into_iter()
            .map(str::to_owned),
        );
    }
    args.push(output.to_string_lossy().into_owned());
    update(core, app, key, |j| {
        j.stage = "proxy".into();
        j.progress = Some(0.0);
        j.logs.push(format!("ffmpeg args: {args:?}"));
    });
    let mut child = media::command(&media::binary(app, "ffmpeg")?)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("PROCESS_FAILED")?).lines();
    let stderr = child.stderr.take().ok_or("PROCESS_FAILED")?;
    let log_core = core.clone();
    let log_app = app.clone();
    let log_id = key.to_owned();
    let logger = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            update(&log_core, &log_app, &log_id, |j| j.logs.push(line));
        }
    });
    loop {
        tokio::select! {
            _ = cancelled(flag) => { let _ = child.kill().await; let _ = child.wait().await; let _ = logger.await; return Err("CANCELLED".into()); },
            line = stdout.next_line() => {
                let Some(line) = line.map_err(io_error)? else { break; };
                if let Some(time) = line.strip_prefix("out_time_us=").and_then(|s| s.parse::<f64>().ok()) {
                    update(core, app, key, |j| j.progress = Some((time / 1000.0 / duration.max(1) as f64).clamp(0.0, 1.0)));
                }
            }
        }
    }
    let status = tokio::select! {
        _ = cancelled(flag) => { let _ = child.kill().await; let _ = child.wait().await; let _ = logger.await; return Err("CANCELLED".into()); },
        status = child.wait() => status.map_err(io_error)?
    };
    let _ = logger.await;
    if !status.success() {
        return Err("PROCESS_FAILED: FFmpeg exited unsuccessfully".into());
    }
    Ok(())
}
async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &ImportRequest,
    flag: &AtomicBool,
) -> Result<(), String> {
    project::ensure_directory(&request.root, "media")?;
    project::ensure_directory(&request.root, "cache")?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let info = media::probe(app, &request.path).await?;
    if let Some(index) = request.audio_index {
        if !info
            .streams
            .iter()
            .any(|s| s.kind == "audio" && s.index == index)
        {
            return Err("INVALID_PROJECT".into());
        }
    }
    let extension = request
        .path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let relative = request
        .reuse
        .as_ref()
        .map(|m| m.path.clone())
        .unwrap_or_else(|| format!("media/{key}.{extension}"));
    if request.reuse.is_none() {
        copy_media(
            core,
            app,
            key,
            &request.path,
            &request.root.join(&relative),
            flag,
        )
        .await?;
    }
    let first_audio = info.streams.iter().find(|s| s.kind == "audio");
    let compatible = extension == "mp4"
        && info.streams.iter().filter(|s| s.kind == "audio").count() <= 1
        && info
            .streams
            .iter()
            .any(|s| s.kind == "video" && s.codec == "h264")
        && first_audio.is_none_or(|s| s.codec == "aac" && Some(s.index) == request.audio_index);
    let large = info
        .streams
        .iter()
        .any(|s| s.kind == "video" && (s.width.unwrap_or(0) > 1280 || s.height.unwrap_or(0) > 720));
    let preview = if request.force_proxy || !compatible || large {
        let output = format!("cache/{key}.mp4");
        proxy(
            core,
            app,
            key,
            ProxyInput {
                lightweight: request.lightweight,
                source: &request.root.join(&relative),
                output: &request.root.join(&output),
                audio: request.audio_index,
                duration: info.duration_ms,
            },
            flag,
        )
        .await?;
        Some(output)
    } else {
        None
    };
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    update(core, app, key, |j| {
        j.stage = "commit".into();
        j.progress = None;
    });
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if s.project.id != request.project_id || s.root != request.root {
        return Err("STALE_REVISION".into());
    }
    let mut next = s.project.clone();
    if request.reuse.is_none() {
        for track in &mut next.tracks {
            if ["original", "dubbing"].contains(&track.kind.as_str()) {
                track.regions.clear();
                track.regions_enabled = None;
            }
        }
    }
    let mut info = info;
    if let Some(old) = &request.reuse {
        info.original_name = old.info.original_name.clone();
    }
    next.media = Some(MediaAsset {
        id: id(),
        path: relative,
        preview_path: preview,
        audio_stream_index: request.audio_index,
        info,
    });
    let revision = s.project.revision;
    let saved = s.replace(next, revision)?;
    let _ = app.emit("project-changed", saved);
    Ok(())
}
