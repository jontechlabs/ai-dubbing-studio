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
            e.track_id == track_id && p.media.as_ref().is_some_and(|m| m.path == e.source_path)
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
    if patches.len() > 128 {
        return Err("AUDIO_TRANSFER_LIMIT".into());
    }
    for e in patches {
        if p.format_version < 8
            || e.kind != "audioPatch"
            || e.id.is_empty()
            || e.operation_id.is_empty()
            || e.track_id == "dubbing"
            || e.track_id.is_empty()
            || e.source_track_id.is_empty()
            || e.end_ms <= e.start_ms
            || !(10..=if e.operation == "effects" {
                120000
            } else {
                60000
            })
                .contains(&(e.end_ms - e.start_ms))
            || e.end_ms > 86_400_000
            || !e.gain.is_finite()
            || !(0.0..=2.0).contains(&e.gain)
            || !["add", "replace", "silence"].contains(&e.mode.as_str())
            || !["copy", "move", "swap", "effects", "separation"].contains(&e.operation.as_str())
            || (e.operation == "separation" && p.format_version < 20)
            || (e.operation == "effects" && p.format_version < 18)
            || p.generations.iter().filter(|g| g["id"] == e.id).count() != 1
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
    let patches = layers(p, &track.id);
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
pub struct Snippet<'a> {
    pub track_id: &'a str,
    pub start_ms: u64,
    pub end_ms: u64,
    pub channels: u8,
    pub rate: u32,
    pub fader: bool,
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
    let track = source_track(p, Some(options.track_id))?;
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
    let base = if options.fader {
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
            fader: false,
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
                fader: false,
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
