//! Offline track effects produce a private immutable copy (whole track) or a
//! replace layer (selection). The movie and all input audio stay untouched.
use crate::{
    audio_effects::{self, Effect},
    domain::{io_error, Project},
    jobs, media, mix, project, separation, Core,
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
#[cfg(test)]
#[path = "audio_fx_job_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub track_id: String,
    pub scope: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub effects: Vec<Effect>,
    pub replace_in_mix: bool,
    #[serde(default)]
    pub name: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
}
fn validate(p: &Project, o: &Options) -> Result<(), String> {
    p.validate()?;
    audio_effects::validate(&o.effects)?;
    let duration = p.media.as_ref().ok_or("MEDIA_MISSING")?.info.duration_ms;
    let track = mix::tracks(p)
        .into_iter()
        .find(|t| t.id == o.track_id)
        .ok_or("INVALID_AUDIO_EFFECTS")?;
    if !["track", "selection"].contains(&o.scope.as_str())
        || o.end_ms <= o.start_ms
        || o.end_ms > duration
        || (o.effects.is_empty() && baseline(p, o).is_none())
        || o.name
            .as_ref()
            .is_some_and(|n| n.is_empty() || n.chars().count() > 160 || n.contains('\0'))
    {
        return Err("INVALID_AUDIO_EFFECTS".into());
    }
    if o.scope == "selection"
        && (o.end_ms - o.start_ms > 120_000
            || o.end_ms - o.start_ms < 10
            || track.kind == "dubbing")
    {
        return Err("AUDIO_EFFECTS_SELECTION_LIMIT".into());
    }
    if o.scope == "track" && (o.start_ms != 0 || o.end_ms != duration) {
        return Err("INVALID_AUDIO_EFFECTS".into());
    }
    // Standard PCM WAV, shared by the WebView, waveform reader and export. Do
    // not create oversized RIFF files which those consumers cannot read.
    if (o.end_ms - o.start_ms) * 192 > u64::from(u32::MAX) - 4096 {
        return Err("AUDIO_EFFECTS_TOO_LONG".into());
    }
    Ok(())
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    let (request, snapshot) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        validate(&s.project, &options)?;
        #[cfg(windows)]
        if crate::voice_space::available(&s.root)?
            < (options.end_ms - options.start_ms) * 384 + 32 * 1024 * 1024
        {
            return Err("AUDIO_EFFECTS_DISK_REQUIRED".into());
        }
        (
            Request {
                root: s.root.clone(),
                project_id: s.project.id.clone(),
                revision: s.project.revision,
                options,
            },
            s.project.clone(),
        )
    };
    let permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let key = jobs::create(&core, &app, "audioEffects", snapshot.id.clone(), None);
    if let Some(job) = core.jobs.lock().map_err(io_error)?.get_mut(&key) {
        job.saved.audio_effects = Some(request.clone());
    }
    jobs::persist(&core);
    let result_key = key.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        jobs::update(&core, &app, &key, |j| {
            j.status = "running".into();
            j.stage = "fxPrepare".into();
        });
        let result = execute(&core, &app, &key, &request, &snapshot, &flag).await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(result_key)
}

fn baseline<'a>(p: &'a Project, o: &Options) -> Option<&'a serde_json::Value> {
    if o.scope == "track" {
        return p.generations.iter().rev().find(|g| {
            g["kind"] == "audioEffects"
                && g["trackId"] == o.track_id
                && g["effectsSourcePath"].is_string()
        });
    }
    for (index, g) in p.generations.iter().enumerate().rev() {
        if g["kind"] == "audioPatch"
            && g["operation"] == "effects"
            && g["trackId"] == o.track_id
            && g["startMs"] == o.start_ms
            && g["endMs"] == o.end_ms
            && g["effectsSourcePath"].is_string()
        {
            let covered = p.generations[index + 1..].iter().any(|later| {
                later["kind"] == "audioPatch"
                    && later["trackId"] == o.track_id
                    && later["startMs"]
                        .as_u64()
                        .is_some_and(|start| start < o.end_ms)
                    && later["endMs"].as_u64().is_some_and(|end| end > o.start_ms)
            });
            if !covered {
                return Some(g);
            }
        }
    }
    None
}
fn valid_effect_file(value: &serde_json::Value) -> Result<(), String> {
    let path = value.as_str().ok_or("INVALID_AUDIO_EFFECTS")?;
    crate::domain::valid_relative(path)?;
    if !path.starts_with("stems/patch-") || !path.ends_with(".wav") {
        return Err("INVALID_AUDIO_EFFECTS".into());
    }
    Ok(())
}
pub fn validate_project(p: &Project) -> Result<(), String> {
    for g in &p.generations {
        if g["kind"] != "audioEffects"
            && !(g["kind"] == "audioPatch" && g["operation"] == "effects")
        {
            continue;
        }
        if p.format_version < 18 {
            return Err("INVALID_AUDIO_EFFECTS".into());
        }
        let effects: Vec<Effect> =
            serde_json::from_value(g["effects"].clone()).map_err(|_| "INVALID_AUDIO_EFFECTS")?;
        audio_effects::validate(&effects)?;
        valid_effect_file(&g["effectsSourcePath"])?;
        if g["kind"] == "audioEffects" {
            valid_effect_file(&g["path"])?;
            let id = g["trackId"].as_str().ok_or("INVALID_AUDIO_EFFECTS")?;
            if g["id"] != id
                || !g["sourceTrackId"].is_string()
                || g["sourceTrackId"] == id
                || !g["replaceInMix"].is_boolean()
                || !g["sourceMuteBefore"].is_boolean()
                || !p.tracks.iter().any(|t| {
                    t.id == id && t.kind == "audio" && t.path.as_deref() == g["path"].as_str()
                })
            {
                return Err("INVALID_AUDIO_EFFECTS".into());
            }
        }
    }
    Ok(())
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
    let o = &r.options;
    let source = mix::tracks(p)
        .into_iter()
        .find(|t| t.id == o.track_id)
        .ok_or("INVALID_AUDIO_EFFECTS")?;
    let previous = baseline(p, o).cloned();
    let folder = project::ensure_directory(&r.root, "stems")?;
    let temporary = tempfile::tempdir_in(&folder).map_err(io_error)?;
    let dry = temporary.path().join("dry.wav");
    let output = temporary.path().join("processed.wav");
    let exe = media::binary(app, "ffmpeg")?;
    let frames = (o.end_ms - o.start_ms) * 48;
    let dry_input = if let Some(ref record) = previous {
        let path = project::asset(
            &r.root,
            record["effectsSourcePath"]
                .as_str()
                .ok_or("INVALID_AUDIO_EFFECTS")?,
        )?;
        if crate::audio_files::wav_frames(&path)? != frames {
            return Err("INVALID_AUDIO_EFFECTS".into());
        }
        path
    } else {
        if source.kind == "dubbing" {
            let raw = temporary.path().join("dubbing.f32");
            mix::render_dubbing_raw(core, app, key, p, &r.root, &raw, flag).await?;
            let args = vec![
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
                "-af".into(),
                "pan=stereo|c0=c0|c1=c0".into(),
                "-ac".into(),
                "2".into(),
                "-ar".into(),
                "48000".into(),
                "-c:a".into(),
                "pcm_s16le".into(),
                "-f".into(),
                "wav".into(),
                "-progress".into(),
                "pipe:1".into(),
                "-y".into(),
                dry.to_string_lossy().into_owned(),
            ];
            mix::run(core, app, key, &exe, &args, o.end_ms - o.start_ms, flag).await?;
            std::fs::remove_file(raw).map_err(io_error)?;
        } else {
            let mut input = p.clone();
            for t in &mut input.tracks {
                if t.id == o.track_id {
                    t.regions.clear();
                    t.regions_enabled = None;
                }
            }
            crate::audio_patch::snippet(
                core,
                app,
                key,
                &input,
                &r.root,
                crate::audio_patch::Snippet {
                    track_id: &o.track_id,
                    start_ms: o.start_ms,
                    end_ms: o.end_ms,
                    channels: 2,
                    rate: 48000,
                    fader: false,
                },
                &dry,
                flag,
            )
            .await?;
        }
        dry.clone()
    };
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    jobs::update(core, app, key, |j| {
        j.stage = "fxRender".into();
        j.progress = Some(0.0);
    });
    let chain = audio_effects::filter_chain(&o.effects)?;
    let chain = if chain.is_empty() {
        "anull".into()
    } else {
        chain
    };
    let filter=format!("{chain},aresample=48000,asetpts=N/SR/TB,apad=whole_len={frames},atrim=end_sample={frames},alimiter=limit=0.98:level=0:latency=1,asetpts=N/SR/TB");
    let args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "warning".into(),
        "-i".into(),
        dry_input.to_string_lossy().into_owned(),
        "-af".into(),
        filter,
        "-ac".into(),
        "2".into(),
        "-ar".into(),
        "48000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-f".into(),
        "wav".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-y".into(),
        output.to_string_lossy().into_owned(),
    ];
    mix::run(core, app, key, &exe, &args, o.end_ms - o.start_ms, flag)
        .await
        .map_err(|e| {
            if e == "MKV_EXPORT_FAILED" {
                "AUDIO_EFFECTS_FAILED".into()
            } else {
                e
            }
        })?;
    if crate::audio_files::wav_frames(&output)? != frames {
        return Err("AUDIO_EFFECTS_FAILED".into());
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let file_id = crate::domain::id();
    let relative = format!("stems/patch-{file_id}.wav");
    let final_path = folder.join(format!("patch-{file_id}.wav"));
    std::fs::rename(&output, &final_path).map_err(io_error)?;
    let mut created = vec![final_path];
    let dry_relative = if let Some(ref record) = previous {
        record["effectsSourcePath"].as_str().unwrap().to_owned()
    } else {
        let path = folder.join(format!("patch-{file_id}-dry.wav"));
        if let Err(e) = std::fs::rename(&dry, &path) {
            for created in created {
                let _ = std::fs::remove_file(created);
            }
            return Err(io_error(e));
        }
        created.push(path);
        format!("stems/patch-{file_id}-dry.wav")
    };
    let commit = (|| {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let mut guard = core.session.lock().map_err(io_error)?;
        let session = guard.as_mut().ok_or("NO_PROJECT")?;
        if session.root != r.root
            || session.project.id != r.project_id
            || session.project.revision != r.revision
        {
            return Err("STALE_REVISION".into());
        }
        let mut next = session.project.clone();
        next.format_version = next.format_version.max(18);
        if o.scope == "selection" {
            if let Some(ref record) = previous {
                next.generations.retain(|g| g["id"] != record["id"]);
            }
            next.generations.push(serde_json::json!({"kind":"audioPatch","id":file_id,"operationId":file_id,"operation":"effects","sourcePath":p.media.as_ref().unwrap().path,"trackId":o.track_id,"sourceTrackId":o.track_id,"startMs":o.start_ms,"endMs":o.end_ms,"mode":"replace","path":relative,"gain":1,"effects":o.effects,"effectsSourcePath":dry_relative}));
        } else if let Some(ref record) = previous {
            next.tracks
                .iter_mut()
                .find(|t| t.id == o.track_id)
                .ok_or("INVALID_AUDIO_EFFECTS")?
                .path = Some(relative.clone());
            let target = next
                .generations
                .iter_mut()
                .find(|g| g["id"] == record["id"])
                .ok_or("INVALID_AUDIO_EFFECTS")?;
            target["path"] = serde_json::json!(relative);
            target["effects"] = serde_json::json!(o.effects);
        } else {
            let mut track = source.clone();
            track.id = file_id.clone();
            track.kind = "audio".into();
            track.path = Some(relative.clone());
            track.duration_ms = Some(o.end_ms);
            track.source_path = Some(p.media.as_ref().unwrap().path.clone());
            track.generation_id = None;
            track.name = Some(o.name.clone().unwrap_or_else(|| "Audio · FX".into()));
            track.mute = !o.replace_in_mix;
            if o.replace_in_mix {
                if let Some(t) = next.tracks.iter_mut().find(|t| t.id == o.track_id) {
                    t.mute = true;
                } else {
                    let mut t = source.clone();
                    t.mute = true;
                    next.tracks.push(t);
                }
            }
            next.tracks.push(track);
            next.generations.push(serde_json::json!({"kind":"audioEffects","id":file_id,"sourcePath":p.media.as_ref().unwrap().path,"sourceTrackId":o.track_id,"trackId":file_id,"effects":o.effects,"path":relative,"replaceInMix":o.replace_in_mix,"sourceMuteBefore":source.mute,"effectsSourcePath":dry_relative}));
        }
        let saved = session.replace(next, r.revision)?;
        drop(guard);
        let _ = app.emit("project-changed", saved);
        Ok(())
    })();
    if commit.is_err() {
        for path in created {
            let _ = std::fs::remove_file(path);
        }
    }
    commit
}
