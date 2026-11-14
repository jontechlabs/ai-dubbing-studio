//! Ordered, non-destructive track layers. Replacements silence lower layers only.
use crate::{
    domain::{io_error, Project, Track},
    jobs, media, project, separation, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_workflow_id: Option<String>,
    pub kind: String,
    pub id: String,
    pub operation_id: String,
    pub operation: String,
    pub source_path: String,
    pub track_id: String,
    pub source_track_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub mode: String,
    pub path: Option<String>,
    pub gain: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dubbing_scope: Option<serde_json::Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub source_track_id: String,
    pub target_track_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub operation: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
}
pub fn all(p: &Project) -> Result<Vec<Patch>, String> {
    p.generations
        .iter()
        .filter(|g| g["kind"] == "audioPatch")
        .map(|g| serde_json::from_value(g.clone()).map_err(io_error))
        .collect()
}
pub fn layers(p: &Project, track_id: &str) -> Vec<Patch> {
    all(p)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| {
            e.track_id == track_id
                && p.media.as_ref().is_some_and(|m| m.path == e.source_path)
                && (e.track_id != "dubbing"
                    || e.operation != "leveling"
                    || e.dubbing_scope.as_ref()
                        == Some(&crate::volume_leveling::dubbing_scope(
                            p, e.start_ms, e.end_ms,
                        )))
        })
        .collect()
}
pub fn validate(p: &Project) -> Result<(), String> {
    if let Some(preferences) = &p.model_preferences {
        for key in ["referenceTrackId", "dubbingSourceTrackId"] {
            if !preferences[key].is_null()
                && !preferences[key]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 128)
            {
                return Err("INVALID_AUDIO_TRANSFER".into());
            }
        }
    }
    let patches = all(p)?;
    let queued = patches
        .iter()
        .filter(|e| e.queue_workflow_id.is_some())
        .count();
    if patches.len() - queued > 128 || queued > 32768 {
        return Err("AUDIO_TRANSFER_LIMIT".into());
    }
    let mut counts = std::collections::HashMap::new();
    for g in &p.generations {
        if let Some(id) = g["id"].as_str() {
            *counts.entry(id).or_insert(0usize) += 1;
        }
    }
    for e in patches {
        if let Some(key) = &e.queue_workflow_id {
            if p.format_version < 30
                || e.operation != "separation"
                || key.len() != 36
                || uuid::Uuid::parse_str(key).is_err()
            {
                return Err("INVALID_AUDIO_TRANSFER".into());
            }
        }
        if p.format_version < 8
            || e.kind != "audioPatch"
            || e.id.is_empty()
            || e.operation_id.is_empty()
            || (e.track_id == "dubbing" && e.operation != "leveling")
            || e.track_id.is_empty()
            || e.source_track_id.is_empty()
            || e.end_ms <= e.start_ms
            || !(10..=if e.operation == "leveling" && p.format_version >= 28 {
                crate::volume_leveling_dsp::MAX_MS
            } else if ["effects", "leveling"].contains(&e.operation.as_str()) {
                120000
            } else {
                60000
            })
                .contains(&(e.end_ms - e.start_ms))
            || e.end_ms > 86_400_000
            || !e.gain.is_finite()
            || !(0.0..=2.0).contains(&e.gain)
            || !["add", "replace", "silence"].contains(&e.mode.as_str())
            || !["copy", "move", "swap", "effects", "separation", "leveling"]
                .contains(&e.operation.as_str())
            || (e.operation == "leveling"
                && (p.format_version < 27
                    || e.mode != "replace"
                    || e.track_id != e.source_track_id
                    || (e.track_id == "dubbing"
                        && !e.dubbing_scope.as_ref().is_some_and(|v| v.is_array()))))
            || (e.operation == "separation" && p.format_version < 20)
            || (e.operation == "effects" && p.format_version < 18)
            || counts.get(e.id.as_str()) != Some(&1)
        {
            return Err("INVALID_AUDIO_TRANSFER".into());
        }
        crate::domain::valid_relative(&e.source_path)?;
        if e.mode == "silence" {
            if e.path.is_some() {
                return Err("INVALID_AUDIO_TRANSFER".into());
            }
        } else {
            let path = e.path.as_deref().ok_or("INVALID_AUDIO_TRANSFER")?;
            crate::domain::valid_relative(path)?;
            if !path.starts_with("stems/patch-") || !path.ends_with(".wav") {
                return Err("INVALID_AUDIO_TRANSFER".into());
            }
        }
    }
    Ok(())
}
fn sum(terms: &[String]) -> String {
    match terms.len() {
        0 => "0".into(),
        1 => terms[0].clone(),
        n => format!("({}+{})", sum(&terms[..n / 2]), sum(&terms[n / 2..])),
    }
}
fn gate(patches: &[Patch], index: Option<usize>, time: &str) -> String {
    let terms: Vec<_> = patches
        .iter()
        .enumerate()
        .filter(|(i, e)| index.is_none_or(|n| *i > n) && e.mode != "add")
        .map(|(_, e)| {
            format!(
                "gte({time},{:.6})*lt({time},{:.6})",
                e.start_ms as f64 / 1000.0,
                e.end_ms as f64 / 1000.0
            )
        })
        .collect();
    format!("if(gt({},0),0,1)", sum(&terms))
}
fn region(track: &Track, base: f64, time: &str) -> String {
    let terms: Vec<_> = if track.regions_enabled == Some(false) {
        vec![]
    } else {
        track
            .regions
            .iter()
            .map(|r| {
                format!(
                    "({})*gte({time},{:.6})*lt({time},{:.6})",
                    if r.mute { -1.0 } else { r.gain - 1.0 },
                    r.start_ms as f64 / 1000.0,
                    r.end_ms as f64 / 1000.0
                )
            })
            .collect()
    };
    format!("{base}*(1+{})", sum(&terms))
}
#[allow(clippy::too_many_arguments)]
pub fn graph(
    root: &Path,
    p: &Project,
    track: &Track,
    input: &str,
    mono: bool,
    base: f64,
    label: &str,
    args: &mut Vec<String>,
    index: &mut usize,
    filters: &mut Vec<String>,
    origin: u64,
    end: u64,
) -> Result<(), String> {
    let patches: Vec<_> = layers(p, &track.id)
        .into_iter()
        .filter(|e| e.start_ms < end && e.end_ms > origin)
        .collect();
    let mut scoped = track.clone();
    scoped
        .regions
        .retain(|r| r.start_ms < end && r.end_ms > origin);
    let track = &scoped;
    let time = format!("(t+{:.6})", origin as f64 / 1000.0);
    let reg = region(track, base, &time);
    let mut labels = vec![format!("[{label}_base]")];
    let pan = if mono { "pan=stereo|c0=c0|c1=c0," } else { "" };
    filters.push(format!("[{input}]{pan}aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,aeval=exprs='val(0)*({reg})*({})|val(1)*({reg})*({})':channel_layout=stereo[{label}_base]",gate(&patches,None,&time),gate(&patches,None,&time)));
    for (at, e) in patches.iter().enumerate() {
        if e.mode == "silence" || e.end_ms <= origin || e.start_ms >= end {
            continue;
        }
        let path = project::asset(root, e.path.as_deref().ok_or("INVALID_AUDIO_TRANSFER")?)?;
        let offset = origin.saturating_sub(e.start_ms);
        if offset > 0 {
            args.extend(["-ss".into(), format!("{:.6}", offset as f64 / 1000.0)]);
        }
        args.extend(["-i".into(), path.to_string_lossy().into_owned()]);
        let delay = e.start_ms.saturating_sub(origin);
        let mask = gate(&patches, Some(at), &time);
        let length = e.end_ms - e.start_ms - offset;
        let output = format!("{label}_patch{at}");
        filters.push(format!("[{}:a:0]atrim=duration={:.6},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay={delay}:all=1,aeval=exprs='val(0)*({reg})*({mask})*{}|val(1)*({reg})*({mask})*{}':channel_layout=stereo[{output}]",*index,length as f64/1000.0,e.gain,e.gain));
        *index += 1;
        labels.push(format!("[{output}]"));
    }
    filters.push(format!(
        "{}amix=inputs={}:normalize=0:dropout_transition=0[{label}]",
        labels.join(""),
        labels.len()
    ));
    Ok(())
}
pub fn source_track(p: &Project, requested: Option<&str>) -> Result<Track, String> {
    let tracks = crate::mix::tracks(p);
    let explicit = requested.filter(|s| *s != "auto").or_else(|| {
        p.model_preferences
            .as_ref()
            .and_then(|prefs| prefs["referenceTrackId"].as_str())
            .filter(|s| *s != "auto")
    });
    let selected = if let Some(id) = explicit {
        tracks.iter().find(|t| t.id == id && t.kind != "dubbing")
    } else {
        tracks
            .iter()
            .find(|t| t.role.as_deref() == Some("speech"))
            .or_else(|| tracks.iter().find(|t| t.kind == "original"))
    };
    selected.cloned().ok_or("INVALID_AUDIO_TRANSFER".into())
}
#[derive(Clone, Copy)]
pub enum SnippetLevels {
    /// Playback/export: track fader and selection levels.
    Mix,
    /// Editing tools: selection levels, before the track fader.
    Regions,
    /// Voice reference: before all listening controls, keeping audio patches.
    Reference,
}
#[derive(Clone, Copy)]
pub struct Snippet<'a> {
    pub track_id: &'a str,
    pub start_ms: u64,
    pub end_ms: u64,
    pub channels: u8,
    pub rate: u32,
    pub levels: SnippetLevels,
}
#[allow(clippy::too_many_arguments)]
pub async fn snippet<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    p: &Project,
    root: &Path,
    options: Snippet<'_>,
    output: &Path,
    flag: &AtomicBool,
) -> Result<(), String> {
    let patches = layers(p, options.track_id);
    let count = |a: u64, b: u64| {
        patches
            .iter()
            .filter(|e| e.start_ms < b && e.end_ms > a)
            .count()
    };
    if count(options.start_ms, options.end_ms) <= 32 {
        return snippet_direct(core, app, key, p, root, options, output, flag).await;
    }
    let temp = tempfile::tempdir().map_err(io_error)?;
    let mut files = String::from("ffconcat version 1.0\n");
    let mut cursor = options.start_ms;
    let mut index = 0;
    while cursor < options.end_ms {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let mut end = options.end_ms.min(cursor + 30000);
        while count(cursor, end) > 32 {
            if end - cursor <= 10 {
                return Err("AUDIO_TRANSFER_LIMIT".into());
            }
            end = cursor + (end - cursor) / 2;
        }
        let name = format!("chunk-{index}.wav");
        snippet_direct(
            core,
            app,
            key,
            p,
            root,
            Snippet {
                start_ms: cursor,
                end_ms: end,
                ..options
            },
            &temp.path().join(&name),
            flag,
        )
        .await?;
        files.push_str(&format!("file {name}\n"));
        cursor = end;
        index += 1;
    }
    let list = temp.path().join("chunks.ffconcat");
    project::atomic_write(&list, files.as_bytes())?;
    let args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "warning".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "1".into(),
        "-i".into(),
        list.to_string_lossy().into_owned(),
        "-map".into(),
        "0:a:0".into(),
        "-c:a".into(),
        "copy".into(),
        "-rf64".into(),
        "auto".into(),
        "-y".into(),
        output.to_string_lossy().into_owned(),
    ];
    crate::mix::run(
        core,
        app,
        key,
        &media::binary(app, "ffmpeg")?,
        &args,
        options.end_ms - options.start_ms,
        flag,
    )
    .await?;
    if crate::audio_files::pcm_frames(
        output,
        u16::from(options.channels),
        options.rate,
        "AUDIO_TRANSFER_FAILED",
    )? != (options.end_ms - options.start_ms) * u64::from(options.rate) / 1000
    {
        return Err("AUDIO_TRANSFER_FAILED".into());
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn snippet_direct<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    p: &Project,
    root: &Path,
    options: Snippet<'_>,
    output: &Path,
    flag: &AtomicBool,
) -> Result<(), String> {
    let mut track = source_track(p, Some(options.track_id))?;
    if matches!(options.levels, SnippetLevels::Reference) {
        // Mute/volume automation belongs to the mix, not the voice supplied to
        // a model. Change only this extraction's cloned track; keep its patches.
        track.regions_enabled = Some(false);
    }
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if options.end_ms <= options.start_ms || options.end_ms > media.info.duration_ms {
        return Err("INVALID_AUDIO_TRANSFER".into());
    }
    let (source, input, mono) = if track.kind == "original" {
        let stream = media.audio_stream_index.ok_or("NO_AUDIO_STREAM")?;
        (
            project::asset(root, &media.path)?,
            format!("0:{stream}"),
            media
                .info
                .streams
                .iter()
                .any(|s| s.index == stream && s.channels == Some(1)),
        )
    } else {
        (
            project::asset(root, track.path.as_deref().ok_or("INVALID_PATH")?)?,
            "0:a:0".into(),
            false,
        )
    };
    let mut args: Vec<String> = ["-nostdin", "-hide_banner", "-v", "warning", "-ss"]
        .map(str::to_owned)
        .to_vec();
    args.push(format!("{:.6}", options.start_ms as f64 / 1000.0));
    args.extend(["-i".into(), source.to_string_lossy().into_owned()]);
    let mut index = 1;
    let mut filters = vec![];
    let base = if matches!(options.levels, SnippetLevels::Mix) {
        if track.mute {
            0.0
        } else {
            track.gain
        }
    } else {
        1.0
    };
    graph(
        root,
        p,
        &track,
        &input,
        mono,
        base,
        "transfer",
        &mut args,
        &mut index,
        &mut filters,
        options.start_ms,
        options.end_ms,
    )?;
    let duration = options.end_ms - options.start_ms;
    // An empty/EOF base can make amix emit frames without timestamps. Counting
    // samples still bounds apad, whereas atrim=duration could then run forever.
    filters.push(format!("[transfer]apad,atrim=end_sample={},asetpts=N/SR/TB,aeval=exprs='clip(val(0),-1,1)|clip(val(1),-1,1)':channel_layout=stereo[cut]",duration * 48));
    let graph_file = output.with_extension("ffgraph");
    project::atomic_write(&graph_file, filters.join(";\n").as_bytes())?;
    args.extend([
        "-/filter_complex".into(),
        graph_file.to_string_lossy().into_owned(),
        "-map".into(),
        "[cut]".into(),
        "-vn".into(),
        "-ac".into(),
        options.channels.to_string(),
        "-ar".into(),
        options.rate.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-rf64".into(),
        "auto".into(),
        "-f".into(),
        "wav".into(),
        "-y".into(),
        output.to_string_lossy().into_owned(),
    ]);
    if cfg!(windows) && args.iter().map(|a| a.len() + 3).sum::<usize>() > 28000 {
        let _ = std::fs::remove_file(graph_file);
        return Err("AUDIO_TRANSFER_LIMIT".into());
    }
    let result = crate::mix::run(
        core,
        app,
        key,
        &media::binary(app, "ffmpeg")?,
        &args,
        duration,
        flag,
    )
    .await;
    let _ = std::fs::remove_file(graph_file);
    result.map_err(|e| {
        if e == "MKV_EXPORT_FAILED" {
            "AUDIO_TRANSFER_FAILED".into()
        } else {
            e
        }
    })
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        let p = &s.project;
        if options.source_track_id == options.target_track_id
            || options.end_ms <= options.start_ms
            || !(10..=60000).contains(&(options.end_ms - options.start_ms))
            || options.end_ms > p.media.as_ref().ok_or("MEDIA_MISSING")?.info.duration_ms
            || !["copy", "move", "swap"].contains(&options.operation.as_str())
        {
            return Err("INVALID_AUDIO_TRANSFER".into());
        }
        source_track(p, Some(&options.source_track_id))?;
        source_track(p, Some(&options.target_track_id))?;
        Request {
            root: s.root.clone(),
            project_id: p.id.clone(),
            revision: p.revision,
            options,
        }
    };
    let key = jobs::create(
        &core,
        &app,
        "audioTransfer",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .audio_transfer = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
        let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="audioTransfer".into();j.progress=None;});transfer(&core,&app,&key,&request,&flag).await
    }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
pub async fn transfer<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let p = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != r.root || s.project.id != r.project_id || s.project.revision != r.revision {
            return Err("STALE_REVISION".into());
        }
        s.project.clone()
    };
    project::ensure_directory(&r.root, "stems")?;
    project::ensure_directory(&r.root, "cache")?;
    let temporary = tempfile::tempdir_in(r.root.join("cache")).map_err(io_error)?;
    let a = temporary.path().join("source.wav");
    let b = temporary.path().join("target.wav");
    let o = &r.options;
    snippet(
        core,
        app,
        key,
        &p,
        &r.root,
        Snippet {
            track_id: &o.source_track_id,
            start_ms: o.start_ms,
            end_ms: o.end_ms,
            channels: 2,
            rate: 48000,
            levels: crate::audio_patch::SnippetLevels::Regions,
        },
        &a,
        flag,
    )
    .await?;
    if o.operation == "swap" {
        snippet(
            core,
            app,
            key,
            &p,
            &r.root,
            Snippet {
                track_id: &o.target_track_id,
                start_ms: o.start_ms,
                end_ms: o.end_ms,
                channels: 2,
                rate: 48000,
                levels: crate::audio_patch::SnippetLevels::Regions,
            },
            &b,
            flag,
        )
        .await?;
    }
    let operation_id = crate::domain::id();
    let mut added = vec![];
    let mut paths = vec![];
    for (track, mode, file, from) in [
        (
            o.target_track_id.as_str(),
            if o.operation == "swap" {
                "replace"
            } else {
                "add"
            },
            Some(&a),
            o.source_track_id.as_str(),
        ),
        (
            o.source_track_id.as_str(),
            if o.operation == "swap" {
                "replace"
            } else {
                "silence"
            },
            if o.operation == "swap" {
                Some(&b)
            } else {
                None
            },
            o.target_track_id.as_str(),
        ),
    ] {
        if track == o.source_track_id && o.operation == "copy" {
            continue;
        }
        let id = crate::domain::id();
        let path = file.map(|_| format!("stems/patch-{id}.wav"));
        if let (Some(input), Some(path)) = (file, &path) {
            let output = r.root.join(path);
            if let Err(e) = std::fs::rename(input, &output) {
                for path in paths {
                    let _ = std::fs::remove_file(path);
                }
                return Err(io_error(e));
            }
            paths.push(output);
        }
        added.push(
            serde_json::to_value(Patch {
                queue_workflow_id: None,
                kind: "audioPatch".into(),
                id,
                operation_id: operation_id.clone(),
                operation: o.operation.clone(),
                source_path: p.media.as_ref().unwrap().path.clone(),
                track_id: track.into(),
                source_track_id: from.into(),
                start_ms: o.start_ms,
                end_ms: o.end_ms,
                mode: mode.into(),
                path,
                gain: 1.0,
                dubbing_scope: None,
            })
            .map_err(io_error)?,
        );
    }
    let result = (|| {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let mut guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_mut().ok_or("NO_PROJECT")?;
        if s.root != r.root || s.project.id != r.project_id || s.project.revision != r.revision {
            return Err("STALE_REVISION".into());
        }
        let mut next = s.project.clone();
        next.format_version = next.format_version.max(8);
        next.generations.extend(added);
        let saved = s.replace(next, r.revision)?;
        drop(guard);
        let _ = app.emit("project-changed", saved);
        Ok(())
    })();
    if result.is_err() {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
    result
}
pub fn path(core: &Core, id: &str) -> Result<String, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    let patch = all(&s.project)?
        .into_iter()
        .find(|e| {
            e.id == id
                && s.project
                    .media
                    .as_ref()
                    .is_some_and(|m| m.path == e.source_path)
        })
        .ok_or("INVALID_AUDIO_TRANSFER")?;
    project::asset(
        &s.root,
        patch.path.as_deref().ok_or("INVALID_AUDIO_TRANSFER")?,
    )
    .map(|p| p.to_string_lossy().into_owned())
}

// Seek a short exact-PCM range for the Web Audio scheduler. Never decode an
// hours-long layer in the browser. These disposable files cannot edit a source.
pub fn segment_path(core: &Core, id: &str, start: u64, end: u64) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    if end <= start || end - start > 30000 {
        return Err("INVALID_AUDIO_TRANSFER".into());
    }
    let (root, source, patch) = {
        let guard = core.session.lock().map_err(io_error)?;
        let session = guard.as_ref().ok_or("NO_PROJECT")?;
        let patch = all(&session.project)?
            .into_iter()
            .find(|e| {
                e.id == id
                    && session
                        .project
                        .media
                        .as_ref()
                        .is_some_and(|m| m.path == e.source_path)
            })
            .ok_or("INVALID_AUDIO_TRANSFER")?;
        if end > patch.end_ms - patch.start_ms || patch.operation != "leveling" {
            return Err("INVALID_AUDIO_TRANSFER".into());
        }
        let source = project::asset(
            &session.root,
            patch.path.as_deref().ok_or("INVALID_AUDIO_TRANSFER")?,
        )?;
        (session.root.clone(), source, patch)
    };
    project::ensure_directory(&root, "cache")?;
    let cache = project::ensure_directory(&root, "cache/audio-patch-segments")?;
    let mut hash = Sha256::new();
    hash.update(b"patch-pcm-range-v1");
    hash.update(patch.id.as_bytes());
    hash.update(patch.path.as_deref().unwrap().as_bytes());
    hash.update(start.to_le_bytes());
    hash.update(end.to_le_bytes());
    let relative = format!("cache/audio-patch-segments/{:x}.wav", hash.finalize());
    let target = root.join(&relative);
    let frames = (end - start) * 48;
    if target.exists() {
        let verified = project::asset(&root, &relative)?;
        if crate::audio_files::wav_frames(&verified).ok() == Some(frames) {
            return Ok(verified.to_string_lossy().into_owned());
        }
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    let temporary = tempfile::NamedTempFile::new_in(&cache).map_err(io_error)?;
    crate::volume_leveling_dsp::copy_range(&source, temporary.path(), start, end)?;
    match temporary.persist_noclobber(&target) {
        Ok(_) => {}
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(io_error(e)),
    }
    let verified = project::asset(&root, &relative)?;
    if crate::audio_files::wav_frames(&verified)? != frames {
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    Ok(verified.to_string_lossy().into_owned())
}
