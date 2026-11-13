//! Two-phase selection levelling: immutable preview, then explicit revision-checked apply.
use crate::{
    audio_patch,
    domain::{io_error, Project},
    jobs, media, mix, project, separation, volume_leveling_dsp as dsp, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
#[cfg(test)]
#[path = "volume_leveling_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub media_id: String,
    pub track_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub mode: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
}
pub fn dubbing_scope(p: &Project, start: u64, end: u64) -> Value {
    let mut clips: Vec<_> = mix::clips(p)
        .into_iter()
        .filter(|c| c.slot_ms > 0 && c.start_ms() < end && c.start_ms() + c.slot_ms > start)
        .collect();
    clips.sort_by_cached_key(|c| c.id.clone());
    Value::Array(clips.into_iter().map(|c|json!({"id":c.id,"startMs":c.start_ms(),"slotMs":c.slot_ms,"durationMs":c.duration_ms(),"exactDuration":c.exact_duration,"edit":p.voice_edits.get(&c.id)})).collect())
}
fn replaced_layers(p: &Project, o: &Options) -> std::collections::HashSet<String> {
    audio_patch::layers(p, &o.track_id)
        .into_iter()
        .filter(|e| e.operation == "leveling" && e.start_ms >= o.start_ms && e.end_ms <= o.end_ms)
        .map(|e| e.id)
        .collect()
}
fn validate(p: &Project, o: &Options) -> Result<(), String> {
    p.validate()?;
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let track = mix::tracks(p)
        .into_iter()
        .find(|t| t.id == o.track_id)
        .ok_or("VOLUME_LEVELING_OPTIONS")?;
    if media.id != o.media_id
        || !["low", "high"].contains(&o.mode.as_str())
        || o.end_ms <= o.start_ms
        || !(100..=dsp::MAX_MS).contains(&(o.end_ms - o.start_ms))
        || o.end_ms > media.info.duration_ms
        || o.end_ms > 86_400_000
        || o.end_ms > track.duration_ms.unwrap_or(media.info.duration_ms)
    {
        return Err("VOLUME_LEVELING_OPTIONS".into());
    }
    if audio_patch::all(p)?.len() + 1 - replaced_layers(p, o).len() > 128 {
        return Err("AUDIO_TRANSFER_LIMIT".into());
    }
    Ok(())
}
fn current(core: &Core, r: &Request) -> Result<Project, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id || s.project.revision != r.revision {
        return Err("STALE_REVISION".into());
    }
    Ok(s.project.clone())
}
fn request(core: &Core, id: &str) -> Result<Request, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_JOB")?;
    core.jobs
        .lock()
        .map_err(io_error)?
        .get(id)
        .and_then(|j| j.saved.volume_leveling.clone())
        .ok_or("INVALID_JOB".into())
}
fn folder(r: &Request, id: &str) -> Result<PathBuf, String> {
    // All callers resolve the UUID through the recorded job first.
    project::ensure_directory(&r.root, "cache")?;
    Ok(project::ensure_directory(&r.root, "cache/volume-leveling")?.join(id))
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    project_id: String,
    expected_revision: u64,
    options: Options,
) -> Result<String, String> {
    let (r, p) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.project.id != project_id || s.project.revision != expected_revision {
            return Err("STALE_REVISION".into());
        }
        validate(&s.project, &options)?;
        #[cfg(windows)]
        if crate::voice_space::available(&s.root)?
            < (options.end_ms - options.start_ms) * 1152 + 32 * 1024 * 1024
        {
            return Err("AUDIO_EFFECTS_DISK_REQUIRED".into());
        }
        (
            Request {
                root: s.root.clone(),
                project_id,
                revision: expected_revision,
                options,
            },
            s.project.clone(),
        )
    };
    let permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let key = jobs::create(&core, &app, "volumeLeveling", p.id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_JOB")?
        .saved
        .volume_leveling = Some(r.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let flag = core.jobs.lock().unwrap()[&key].cancel.clone();
        jobs::update(&core, &app, &key, |j| {
            j.status = "running".into();
            j.stage = "levelingPrepare".into();
        });
        let result = execute(&core, &app, &key, &r, &p, &flag).await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    p: &Project,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    current(core, r)?;
    project::ensure_directory(&r.root, "cache")?;
    let parent = project::ensure_directory(&r.root, "cache/volume-leveling")?;
    let temporary = tempfile::tempdir_in(&parent).map_err(io_error)?;
    let input = temporary.path().join("original.wav");
    let output = temporary.path().join("leveled.wav");
    extract(core, app, key, r, p, &input, flag).await?;
    jobs::update(core, app, key, |j| {
        j.stage = "levelingAnalyze".into();
        j.progress = Some(0.0);
    });
    let a = input.clone();
    let b = output.clone();
    let frames = (r.options.end_ms - r.options.start_ms) * 48;
    let mode = r.options.mode.clone();
    let cancel = flag.clone();
    let job_core = core.clone();
    let job_app = app.clone();
    let job_key = key.to_owned();
    let stats = tauri::async_runtime::spawn_blocking(move || {
        dsp::process_file(&a, &b, frames, &mode, &cancel, |value| {
            jobs::update(&job_core, &job_app, &job_key, |j| j.progress = Some(value))
        })
    })
    .await
    .map_err(io_error)??;
    // Chromium cannot reliably seek RF64. Lossless FLAC previews cover the same
    // full range; the canonical result and applied patch remain exact PCM WAV/RF64.
    if frames * 4 > u64::from(u32::MAX) - 36 {
        jobs::update(core, app, key, |j| {
            j.stage = "levelingPreview".into();
            j.progress = Some(0.0);
        });
        for role in ["original", "leveled"] {
            let args = vec![
                "-nostdin".into(),
                "-hide_banner".into(),
                "-v".into(),
                "warning".into(),
                "-i".into(),
                temporary
                    .path()
                    .join(format!("{role}.wav"))
                    .to_string_lossy()
                    .into_owned(),
                "-c:a".into(),
                "flac".into(),
                "-compression_level".into(),
                "0".into(),
                "-y".into(),
                temporary
                    .path()
                    .join(format!("{role}.flac"))
                    .to_string_lossy()
                    .into_owned(),
            ];
            mix::run(
                core,
                app,
                key,
                &media::binary(app, "ffmpeg")?,
                &args,
                r.options.end_ms - r.options.start_ms,
                flag,
            )
            .await?;
        }
    }
    current(core, r)?;
    project::atomic_write(
        &temporary.path().join("result.json"),
        &serde_json::to_vec(&stats).map_err(io_error)?,
    )?;
    // Serialize publication with discard: cancellation cannot leave a late preview behind.
    let guard = core.jobs.lock().map_err(io_error)?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    std::fs::rename(temporary.path(), parent.join(key)).map_err(io_error)?;
    drop(guard);
    jobs::update(core, app, key, |j| j.progress = Some(1.0));
    Ok(())
}
async fn extract<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    p: &Project,
    output: &std::path::Path,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let o = &r.options;
    let mut track = mix::tracks(p)
        .into_iter()
        .find(|t| t.id == o.track_id)
        .ok_or("VOLUME_LEVELING_OPTIONS")?;
    if track.kind != "dubbing" {
        return audio_patch::snippet(
            core,
            app,
            key,
            p,
            &r.root,
            audio_patch::Snippet {
                track_id: &o.track_id,
                start_ms: o.start_ms,
                end_ms: o.end_ms,
                channels: 2,
                rate: 48000,
                levels: audio_patch::SnippetLevels::Reference,
            },
            output,
            flag,
        )
        .await;
    }
    let raw = output.with_extension("f32");
    mix::render_dubbing_range_raw(core, app, key, p, &r.root, &raw, flag, o.start_ms, o.end_ms)
        .await?;
    track.regions.clear();
    track.regions_enabled = None;
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "warning".into(),
        "-f".into(),
        "f32le".into(),
        "-ar".into(),
        "24000".into(),
        "-ac".into(),
        "1".into(),
        "-i".into(),
        raw.to_string_lossy().into_owned(),
    ];
    let mut filters = vec![];
    let mut index = 1;
    audio_patch::graph(
        &r.root,
        p,
        &track,
        "0:a:0",
        true,
        1.0,
        "leveled_input",
        &mut args,
        &mut index,
        &mut filters,
        o.start_ms,
        o.end_ms,
    )?;
    let frames = (o.end_ms - o.start_ms) * 48;
    filters.push(format!(
        "[leveled_input]apad,atrim=end_sample={frames},asetpts=N/SR/TB[out]"
    ));
    let graph = output.with_extension("ffgraph");
    project::atomic_write(&graph, filters.join(";\n").as_bytes())?;
    args.extend([
        "-/filter_complex".into(),
        graph.to_string_lossy().into_owned(),
        "-map".into(),
        "[out]".into(),
        "-ac".into(),
        "2".into(),
        "-ar".into(),
        "48000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-rf64".into(),
        "auto".into(),
        "-f".into(),
        "wav".into(),
        "-y".into(),
        output.to_string_lossy().into_owned(),
    ]);
    mix::run(
        core,
        app,
        key,
        &media::binary(app, "ffmpeg")?,
        &args,
        o.end_ms - o.start_ms,
        flag,
    )
    .await
}
pub fn result(core: &Core, id: &str) -> Result<Value, String> {
    let r = request(core, id)?;
    let p = current(core, &r)?;
    let guard = core.jobs.lock().map_err(io_error)?;
    let j = guard.get(id).ok_or("INVALID_JOB")?;
    if j.saved.record.status != "succeeded" || j.cancel.load(Ordering::Relaxed) {
        return Err("VOLUME_LEVELING_NOT_READY".into());
    }
    drop(guard);
    let path = project::asset(&r.root, &format!("cache/volume-leveling/{id}/result.json"))?;
    let stats: dsp::Stats =
        serde_json::from_slice(&std::fs::read(path).map_err(io_error)?).map_err(io_error)?;
    Ok(json!({"id":id,"projectId":p.id,"revision":r.revision,"options":r.options,"stats":stats}))
}
pub fn path<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    id: &str,
    role: &str,
    preview: bool,
) -> Result<String, String> {
    result(core, id)?;
    let r = request(core, id)?;
    if !["original", "leveled"].contains(&role) {
        return Err("VOLUME_LEVELING_OPTIONS".into());
    }
    let extension =
        if preview && r.options.end_ms - r.options.start_ms > (u64::from(u32::MAX) - 36) / 192 {
            "flac"
        } else {
            "wav"
        };
    let path = project::asset(
        &r.root,
        &format!("cache/volume-leveling/{id}/{role}.{extension}"),
    )?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(path.to_string_lossy().into_owned())
}
pub fn apply<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    id: &str,
    project_id: &str,
    expected_revision: u64,
) -> Result<Project, String> {
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let r = request(core, id)?;
    if r.project_id != project_id || r.revision != expected_revision {
        return Err("STALE_REVISION".into());
    }
    let details = result(core, id)?;
    let p = current(core, &r)?;
    validate(&p, &r.options)?;
    let source = project::asset(&r.root, &format!("cache/volume-leveling/{id}/leveled.wav"))?;
    if crate::audio_files::wav_frames(&source)? != (r.options.end_ms - r.options.start_ms) * 48 {
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    #[cfg(windows)]
    if crate::voice_space::available(&r.root)?
        < (r.options.end_ms - r.options.start_ms) * 192 + 32 * 1024 * 1024
    {
        return Err("AUDIO_EFFECTS_DISK_REQUIRED".into());
    }
    let patch_id = crate::domain::id();
    let relative = format!("stems/patch-{patch_id}.wav");
    let parent = project::ensure_directory(&r.root, "stems")?;
    let target = parent.join(format!("patch-{patch_id}.wav"));
    if let Err(e) = std::fs::copy(source, &target) {
        let _ = std::fs::remove_file(&target);
        return Err(io_error(e));
    }
    let saved = (|| {
        let jobs = core.jobs.lock().map_err(io_error)?;
        if jobs
            .get(id)
            .ok_or("INVALID_JOB")?
            .cancel
            .load(Ordering::Relaxed)
        {
            return Err("CANCELLED".into());
        }
        let mut guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_mut().ok_or("NO_PROJECT")?;
        if s.root != r.root
            || s.project.id != r.project_id
            || s.project.revision != expected_revision
        {
            return Err("STALE_REVISION".into());
        }
        let mut next = s.project.clone();
        next.format_version =
            next.format_version
                .max(if r.options.end_ms - r.options.start_ms > 120000 {
                    28
                } else {
                    27
                });
        // The prepared audio already contains these active lower layers.
        // Consolidate full coverage; undo still owns their immutable WAVs.
        let replaced = replaced_layers(&p, &r.options);
        next.generations
            .retain(|g| g["id"].as_str().is_none_or(|id| !replaced.contains(id)));
        let scope = if r.options.track_id == "dubbing" {
            Some(dubbing_scope(&p, r.options.start_ms, r.options.end_ms))
        } else {
            None
        };
        let mut layer = json!({"kind":"audioPatch","id":patch_id,"operationId":id,"operation":"leveling","sourcePath":p.media.as_ref().unwrap().path,"trackId":r.options.track_id,"sourceTrackId":r.options.track_id,"startMs":r.options.start_ms,"endMs":r.options.end_ms,"mode":"replace","path":relative,"gain":1.0,"volumeLeveling":details,"createdAt":crate::domain::now()});
        if let Some(scope) = scope {
            layer["dubbingScope"] = scope;
        }
        next.generations.push(layer);
        s.replace(next, expected_revision)
    })();
    match saved {
        Ok(saved) => {
            let _ = app.emit("project-changed", &saved);
            let _ = discard(core, id);
            Ok(saved)
        }
        Err(e) => {
            let _ = std::fs::remove_file(target);
            Err(e)
        }
    }
}
pub fn discard(core: &Core, id: &str) -> Result<(), String> {
    let r = request(core, id)?;
    {
        let guard = core.jobs.lock().map_err(io_error)?;
        let j = guard.get(id).ok_or("INVALID_JOB")?;
        j.cancel.store(true, Ordering::Relaxed);
    }
    let path = folder(&r, id)?;
    if path.exists() {
        let canonical = path.canonicalize().map_err(io_error)?;
        let parent = project::ensure_directory(&r.root, "cache/volume-leveling")?;
        if !canonical.starts_with(&parent) || canonical.parent() != Some(parent.as_path()) {
            return Err("INVALID_PATH".into());
        }
        std::fs::remove_dir_all(canonical).map_err(io_error)?;
    }
    Ok(())
}
