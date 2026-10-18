use crate::{
    audio_files,
    domain::{io_error, Project, Track},
    jobs, media, project, separation, tts, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::io::{AsyncBufReadExt, BufReader};
#[cfg(test)]
#[path = "mix_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default = "include_retouched_default")]
    pub include_retouched: bool,
    pub include_original: bool,
    pub source_subtitles: bool,
    pub target_subtitles: bool,
    pub codec: String,
    pub allow_incomplete: bool,
}
fn include_retouched_default() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub output: PathBuf,
    pub options: Options,
}
#[derive(Clone)]
pub(crate) struct Clip {
    pub id: String,
    pub path: String,
    pub slot_ms: u64,
    pub(crate) exact_duration: bool,
    start: u64,
    frames: u64,
    end_ms: u64,
}
impl Clip {
    pub(crate) fn start_ms(&self) -> u64 {
        self.start / 24
    }
    pub(crate) fn duration_ms(&self) -> u64 {
        self.frames / 24
    }
}

pub(crate) fn clips(p: &Project) -> Vec<Clip> {
    let Some(media) = &p.media else {
        return vec![];
    };
    let generations: std::collections::HashMap<_, _> = p
        .generations
        .iter()
        .filter(|g| g["kind"] == "tts")
        .filter_map(|g| Some((g["id"].as_str()?, g)))
        .collect();
    let mut clips: Vec<_> = p
        .dialogues
        .iter()
        .filter_map(|line| {
            let id = line.selected_generation_ids.get(&p.languages.target)?;
            let g = *generations.get(id.as_str())?;
            if g["dialogueId"] != line.id
                || g["language"] != p.languages.target
                || g["sourcePath"] != media.path
                || line.start_ms >= media.info.duration_ms
            {
                return None;
            }
            let offset = p
                .dubbing_timing
                .as_ref()
                .filter(|t| t.source_path == media.path)
                .and_then(|t| t.offsets_ms.get(&line.id))
                .and_then(|v| v.get(&p.languages.target))
                .copied()
                .unwrap_or(0);
            let start_ms = line
                .start_ms
                .saturating_add_signed(offset)
                .min(media.info.duration_ms.saturating_sub(1));
            let duration = p
                .dubbing_timing
                .as_ref()
                .filter(|t| t.source_path == media.path)
                .and_then(|t| t.durations_ms.get(&line.id))
                .and_then(|v| v.get(&p.languages.target))
                .copied();
            Some(Clip {
                id: id.clone(),
                path: g["path"].as_str()?.into(),
                slot_ms: 0,
                exact_duration: duration.is_some(),
                end_ms: start_ms
                    .saturating_add(duration.unwrap_or(line.end_ms - line.start_ms))
                    .min(media.info.duration_ms),
                start: start_ms * 24,
                frames: p
                    .voice_edits
                    .get(id)
                    .map(|e| e.duration())
                    .or_else(|| g["durationMs"].as_u64())?
                    .min(media.info.duration_ms - start_ms)
                    * 24,
            })
        })
        .collect();
    clips.sort_by_key(|c| c.start);
    let starts: Vec<_> = clips.iter().map(|c| c.start).collect();
    for (index, clip) in clips.iter_mut().enumerate() {
        let next = starts.get(index + 1).copied().unwrap_or(u64::MAX);
        let duplicate = index > 0 && starts[index - 1] == clip.start;
        clip.slot_ms = if duplicate {
            0
        } else {
            (clip.end_ms * 24).min(next).saturating_sub(clip.start) / 24
        };
        clip.frames = if clip.exact_duration {
            clip.slot_ms * 24
        } else {
            clip.frames.min(clip.slot_ms * 24)
        };
    }
    clips
}
fn default_track(kind: &str, mute: bool) -> Track {
    serde_json::from_value(
        serde_json::json!({"id":kind,"kind":kind,"language":"","mute":mute,"solo":false,"gain":1}),
    )
    .unwrap()
}
pub(crate) fn tracks(p: &Project) -> Vec<Track> {
    let mut result = vec![p
        .tracks
        .iter()
        .find(|t| t.kind == "original")
        .cloned()
        .unwrap_or_else(|| default_track("original", false))];
    result.extend(
        p.tracks
            .iter()
            .filter(|t| {
                t.kind == "audio"
                    && t.source_path
                        .as_ref()
                        .is_none_or(|s| p.media.as_ref().is_some_and(|m| s == &m.path))
            })
            .cloned(),
    );
    result.push(
        p.tracks
            .iter()
            .find(|t| t.kind == "dubbing")
            .cloned()
            .unwrap_or_else(|| default_track("dubbing", true)),
    );
    result
}
fn gain(track: &Track, tracks: &[Track]) -> f64 {
    if track.mute || (tracks.iter().any(|t| t.solo && !t.mute) && !track.solo) {
        0.0
    } else {
        track.gain
    }
}
// One bounded buffer per active take; thousands of clips do not become thousands of
// FFmpeg inputs or command-line arguments. Raw float keeps overlapping voices unclipped.
fn assemble(
    root: &Path,
    clips: &[Clip],
    duration: u64,
    output: &Path,
    flag: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<(), String> {
    struct Active {
        file: fs::File,
        start: u64,
        end: u64,
    }
    let mut active: Vec<Active> = vec![];
    let mut pending = clips.iter().peekable();
    let mut output = std::io::BufWriter::new(fs::File::create(output).map_err(io_error)?);
    let frames = duration * 24;
    let mut position = 0;
    let mut samples = vec![0f32; 4096];
    let mut input = vec![0u8; 8192];
    let mut bytes = vec![0u8; 16384];
    let mut last = -1.0;
    while position < frames {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let count = (frames - position).min(4096) as usize;
        samples[..count].fill(0.0);
        while pending
            .peek()
            .is_some_and(|c| c.start < position + count as u64)
        {
            let clip = pending.next().unwrap();
            let path = project::asset(root, &clip.path)?;
            let length = audio_files::pcm_frames(&path, 1, 24000, "INVALID_GENERATION")?;
            let mut file = fs::File::open(path).map_err(io_error)?;
            file.seek(SeekFrom::Start(12)).map_err(io_error)?;
            loop {
                let mut chunk = [0u8; 8];
                file.read_exact(&mut chunk).map_err(io_error)?;
                if &chunk[..4] == b"data" {
                    break;
                }
                let size = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
                file.seek(SeekFrom::Current((size + size % 2) as i64))
                    .map_err(io_error)?;
            }
            active.push(Active {
                file,
                start: clip.start,
                end: clip.start + length.min(clip.frames),
            });
            if active.len() > 128 {
                return Err("INVALID_EXPORT".into());
            }
        }
        for clip in &mut active {
            let start = position.max(clip.start);
            let end = (position + count as u64).min(clip.end);
            if start >= end {
                continue;
            }
            let length = (end - start) as usize;
            clip.file
                .read_exact(&mut input[..length * 2])
                .map_err(io_error)?;
            for i in 0..length {
                samples[(start - position) as usize + i] +=
                    f32::from(i16::from_le_bytes([input[i * 2], input[i * 2 + 1]])) / 32768.0;
            }
        }
        for (i, sample) in samples[..count].iter().enumerate() {
            bytes[i * 4..i * 4 + 4].copy_from_slice(&sample.to_le_bytes());
        }
        output.write_all(&bytes[..count * 4]).map_err(io_error)?;
        position += count as u64;
        active.retain(|c| c.end > position);
        let value = position as f64 / frames.max(1) as f64;
        if value - last >= 0.01 {
            progress(value);
            last = value;
        }
    }
    output.flush().map_err(io_error)?;
    Ok(())
}
fn validate(p: &Project, options: &Options) -> Result<(), String> {
    p.validate()?;
    if options.include_retouched {
        crate::inpaint::active(p)?;
    }
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if media.info.duration_ms == 0 || !["aac", "flac"].contains(&options.codec.as_str()) {
        return Err("INVALID_EXPORT".into());
    }
    if !options.allow_incomplete {
        let selected = clips(p);
        for line in &p.dialogues {
            if tts::text(p, line).is_empty() {
                continue;
            }
            let generation = line
                .selected_generation_ids
                .get(&p.languages.target)
                .and_then(|id| {
                    p.generations
                        .iter()
                        .find(|g| g["id"] == *id && g["kind"] == "tts")
                });
            if generation.is_none_or(|g| {
                g["sourcePath"] != media.path
                    || g["text"] != tts::text(p, line)
                    || g["startMs"] != line.start_ms
                    || g["endMs"] != line.end_ms
                    || g["characterId"] != serde_json::json!(line.character_id)
                    || selected
                        .iter()
                        .find(|c| c.id == g["id"].as_str().unwrap_or(""))
                        .is_none_or(|c| {
                            c.slot_ms == 0
                                || p.voice_edits
                                    .get(&c.id)
                                    .map(|e| e.duration() as f64)
                                    .unwrap_or_else(|| g["durationMs"].as_f64().unwrap_or(0.0))
                                    / c.slot_ms as f64
                                    > 1.5
                        })
            }) {
                return Err("MIX_REVIEW_REQUIRED".into());
            }
        }
    }
    Ok(())
}
fn destination(root: &Path, p: &Project, output: &Path) -> Result<PathBuf, String> {
    if output
        .extension()
        .is_none_or(|s| !s.eq_ignore_ascii_case("mkv"))
    {
        return Err("INVALID_EXPORT".into());
    }
    let parent = output
        .parent()
        .ok_or("INVALID_PATH")?
        .canonicalize()
        .map_err(io_error)?;
    if parent.starts_with(root) && !parent.starts_with(root.join("exports")) {
        return Err("INVALID_PATH".into());
    }
    if let Ok(existing) = output.canonicalize() {
        let mut assets: Vec<&str> = p.tracks.iter().filter_map(|t| t.path.as_deref()).collect();
        if let Some(media) = &p.media {
            assets.push(&media.path);
        }
        if assets
            .into_iter()
            .any(|asset| project::asset(root, asset).ok().as_ref() == Some(&existing))
        {
            return Err("INVALID_PATH".into());
        }
    }
    Ok(parent)
}
fn language(code: &str) -> &str {
    match code {
        "fr" => "fra",
        "en" => "eng",
        "ja" => "jpn",
        "zh" => "zho",
        "ko" => "kor",
        "de" => "deu",
        "es" => "spa",
        "it" => "ita",
        "ru" => "rus",
        _ => "und",
    }
}

pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    output: PathBuf,
    options: Options,
) -> Result<String, String> {
    let (root, p) = {
        let lock = core.session.lock().map_err(io_error)?;
        let s = lock.as_ref().ok_or("NO_PROJECT")?;
        (s.root.clone(), s.project.clone())
    };
    validate(&p, &options)?;
    destination(&root, &p, &output)?;
    let permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let request = Request {
        root,
        project_id: p.id.clone(),
        revision: p.revision,
        output,
        options,
    };
    let key = jobs::create(&core, &app, "mkvExport", p.id.clone(), None);
    if let Some(job) = core.jobs.lock().map_err(io_error)?.get_mut(&key) {
        job.saved.mix_request = Some(request.clone());
    }
    jobs::persist(&core);
    let result_key = key.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        jobs::update(&core, &app, &key, |j| {
            j.status = "running".into();
            j.stage = "mixAssemble".into();
            j.progress = Some(0.0);
            j.logs.push(format!(
                "Snapshot revision {}; selected takes: {}. Monitor volume is excluded.",
                p.revision,
                clips(&p).len()
            ));
        });
        let result = export(&core, &app, &key, &request, &p, &flag).await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(result_key)
}
async fn export<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    p: &Project,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let executable = media::binary(app, "ffmpeg")?;
    let parent = destination(&request.root, p, &request.output)?;
    let temporary = tempfile::tempdir_in(&parent).map_err(io_error)?;
    let voices = temporary.path().join("voices.f32");
    let tracks = tracks(p);
    let dubbed = tracks
        .iter()
        .any(|t| t.kind == "dubbing" && gain(t, &tracks) > 0.0);
    if dubbed {
        let root = request.root.clone();
        let mut selected = clips(p);
        selected.retain(|c| c.slot_ms > 0);
        jobs::update(core, app, key, |j| {
            j.stage = "mixFit".into();
            j.progress = Some(0.0);
        });
        let total = selected.len().max(1);
        for (index, clip) in selected.iter_mut().enumerate() {
            let edited = crate::voice_edit::render(
                &root,
                &clip.path,
                p.voice_edits.get(&clip.id),
                &executable,
                flag,
            )
            .await?;
            let relative = edited
                .strip_prefix(&root)
                .map_err(io_error)?
                .to_string_lossy()
                .replace('\\', "/");
            let fitted = crate::voice_fit::take_with_duration(
                &root,
                &relative,
                clip.slot_ms,
                clip.exact_duration,
                &executable,
                flag,
            )
            .await?;
            clip.path = fitted
                .strip_prefix(&root)
                .map_err(io_error)?
                .to_string_lossy()
                .replace('\\', "/");
            jobs::update(core, app, key, |j| {
                j.progress = Some((index + 1) as f64 / total as f64)
            });
        }
        jobs::update(core, app, key, |j| {
            j.stage = "mixAssemble".into();
            j.progress = Some(0.0);
        });
        let duration = p.media.as_ref().unwrap().info.duration_ms;
        let file = voices.clone();
        let cancel = flag.clone();
        let job_core = core.clone();
        let job_app = app.clone();
        let job_key = key.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            assemble(&root, &selected, duration, &file, &cancel, |value| {
                jobs::update(&job_core, &job_app, &job_key, |j| j.progress = Some(value))
            })
        })
        .await
        .map_err(io_error)??;
    }
    let output = tempfile::NamedTempFile::new_in(temporary.path())
        .map_err(io_error)?
        .into_temp_path();
    let args = arguments(
        &request.root,
        p,
        &request.options,
        &tracks,
        temporary.path(),
        &voices,
        &output,
    )?;
    jobs::update(core, app, key, |j| {
        j.stage = "mixEncode".into();
        j.progress = Some(0.0);
    });
    run(
        core,
        app,
        key,
        &executable,
        &args,
        p.media.as_ref().unwrap().info.duration_ms,
        flag,
    )
    .await?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let result = media::probe(app, &output).await?;
    if !result.streams.iter().any(|s| s.kind == "audio") {
        return Err("INVALID_EXPORT".into());
    }
    // Publish only a completed, probed container. A cancelled/failed export keeps any old destination.
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&output)
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)?;
    output.persist(&request.output).map_err(io_error)?;
    jobs::update(core, app, key, |j| {
        j.logs
            .push(format!("MKV written: {}", request.output.display()))
    });
    Ok(())
}
fn arguments(
    root: &Path,
    p: &Project,
    options: &Options,
    tracks: &[Track],
    temp: &Path,
    voices: &Path,
    output: &Path,
) -> Result<Vec<String>, String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let duration = media.info.duration_ms as f64 / 1000.0;
    let source = project::asset(root, &media.path)?;
    let mut args: Vec<String> = ["-hide_banner", "-v", "warning", "-nostdin", "-y", "-i"]
        .map(str::to_owned)
        .to_vec();
    args.push(source.to_string_lossy().into_owned());
    let mut index = 1usize;
    let mut filters = vec![];
    let mut labels = vec![];
    for track in tracks {
        let base = gain(track, tracks);
        if base == 0.0 {
            continue;
        }
        let input = match track.kind.as_str() {
            "original" => {
                let Some(stream) = media.audio_stream_index else {
                    continue;
                };
                format!("0:{stream}")
            }
            "audio" => {
                args.push("-i".into());
                args.push(
                    project::asset(root, track.path.as_deref().ok_or("INVALID_PATH")?)?
                        .to_string_lossy()
                        .into_owned(),
                );
                let value = format!("{index}:a:0");
                index += 1;
                value
            }
            "dubbing" => {
                args.extend(["-f", "f32le", "-ar", "24000", "-ac", "1", "-i"].map(str::to_owned));
                args.push(voices.to_string_lossy().into_owned());
                let value = format!("{index}:a:0");
                index += 1;
                value
            }
            _ => continue,
        };
        let label = format!("bus{}", labels.len());
        let mono =
            track.kind == "dubbing"
                || (track.kind == "original"
                    && media.info.streams.iter().any(|s| {
                        Some(s.index) == media.audio_stream_index && s.channels == Some(1)
                    }));
        crate::audio_patch::graph(
            root,
            p,
            track,
            &input,
            mono,
            base,
            &label,
            &mut args,
            &mut index,
            &mut filters,
            0,
            media.info.duration_ms,
        )?;
        labels.push(format!("[{label}]"));
    }
    if labels.is_empty() {
        filters.push(format!(
            "anullsrc=r=48000:cl=stereo,atrim=duration={duration}[mix]"
        ));
    } else {
        filters.push(format!("{}amix=inputs={}:normalize=0:dropout_transition=0,apad,atrim=duration={duration},aeval=exprs='clip(val(0),-1,1)|clip(val(1),-1,1)':channel_layout=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo[mix]",labels.join(""),labels.len()));
    }
    let edits = if options.include_retouched {
        crate::inpaint::active(p)?
    } else {
        vec![]
    };
    let mut video_map = "0:v:0".to_owned();
    for (number, edit) in edits.iter().enumerate() {
        args.extend([
            "-i".into(),
            project::asset(root, &edit.path)?
                .to_string_lossy()
                .into_owned(),
        ]);
        let previous = if number == 0 {
            "0:v:0".to_owned()
        } else {
            format!("vretouch{}", number - 1)
        };
        let start = edit.start_ms as f64 / 1000.0;
        let end = (edit.start_ms + edit.duration_ms) as f64 / 1000.0;
        filters.push(format!("[{index}:v:0]setpts=PTS-STARTPTS+{start}/TB[vpatch{number}];[{previous}][vpatch{number}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,{start})*lt(t,{end})'[vretouch{number}]"));
        index += 1;
        video_map = format!("[vretouch{number}]");
    }
    let graph = temp.join("mix.ffgraph");
    fs::write(&graph, filters.join(";\n")).map_err(io_error)?;
    let mut subtitles = vec![];
    for (include, cues, role, lang) in [
        (
            options.source_subtitles,
            &p.source_cues,
            "Original subtitles",
            &p.languages.source,
        ),
        (
            options.target_subtitles,
            &p.target_cues,
            "Translated subtitles",
            &p.languages.target,
        ),
    ] {
        if include && !cues.is_empty() {
            let path = temp.join(format!("subtitles-{index}.srt"));
            fs::write(&path, crate::subtitles::export_srt(cues)).map_err(io_error)?;
            args.extend(["-i".into(), path.to_string_lossy().into_owned()]);
            subtitles.push((index, role, lang));
            index += 1;
        }
    }
    args.extend([
        "-/filter_complex".into(),
        graph.to_string_lossy().into_owned(),
        "-map".into(),
        video_map,
        "-map".into(),
        "[mix]".into(),
        "-c:v".into(),
        if edits.is_empty() {
            "copy".into()
        } else {
            "libx264".into()
        },
        "-c:a:0".into(),
        options.codec.clone(),
        "-metadata:s:a:0".into(),
        format!("language={}", language(&p.languages.target)),
        "-metadata:s:a:0".into(),
        "title=Dubbing mix".into(),
        "-disposition:a:0".into(),
        "default".into(),
    ]);
    if !edits.is_empty() {
        args.extend(["-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"].map(str::to_owned));
    }
    if options.codec == "aac" {
        args.extend(["-b:a:0", "320k"].map(str::to_owned));
    }
    if options.include_original {
        if let Some(stream) = media.audio_stream_index {
            args.extend([
                "-map".into(),
                format!("0:{stream}"),
                "-c:a:1".into(),
                "copy".into(),
                "-metadata:s:a:1".into(),
                format!("language={}", language(&p.languages.source)),
                "-metadata:s:a:1".into(),
                "title=Original audio".into(),
                "-disposition:a:1".into(),
                "0".into(),
            ]);
        }
    }
    for (subtitle, (input, title, lang)) in subtitles.iter().enumerate() {
        args.extend([
            "-map".into(),
            format!("{input}:s:0"),
            format!("-metadata:s:s:{subtitle}"),
            format!("language={}", language(lang)),
            format!("-metadata:s:s:{subtitle}"),
            format!("title={title}"),
            format!("-disposition:s:{subtitle}"),
            "0".into(),
        ]);
    }
    args.extend([
        "-c:s".into(),
        "srt".into(),
        "-map_metadata".into(),
        "0".into(),
        "-map_chapters".into(),
        "0".into(),
        "-t".into(),
        duration.to_string(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-f".into(),
        "matroska".into(),
        output.to_string_lossy().into_owned(),
    ]);
    Ok(args)
}
pub(crate) async fn run<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    executable: &Path,
    args: &[String],
    duration: u64,
    flag: &AtomicBool,
) -> Result<(), String> {
    let mut child = media::command(executable)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("PROCESS_FAILED")?).lines();
    let stderr = child.stderr.take().ok_or("PROCESS_FAILED")?;
    let log_core = core.clone();
    let log_app = app.clone();
    let log_key = key.to_owned();
    let logger = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            jobs::update(&log_core, &log_app, &log_key, |j| j.logs.push(line));
        }
    });
    loop {
        tokio::select! {
            _=jobs::cancelled(flag)=>{let _=child.kill().await;let _=child.wait().await;let _=logger.await;return Err("CANCELLED".into());},
            line=stdout.next_line()=>{let Some(line)=line.map_err(io_error)? else{break;};if let Some(time)=line.strip_prefix("out_time_us=").and_then(|s|s.parse::<f64>().ok()){jobs::update(core,app,key,|j|j.progress=Some((time/1000.0/duration.max(1) as f64).clamp(0.0,1.0)));}}
        }
    }
    let status = tokio::select! {_=jobs::cancelled(flag)=>{let _=child.kill().await;let _=child.wait().await;let _=logger.await;return Err("CANCELLED".into());},status=child.wait()=>status.map_err(io_error)?};
    let _ = logger.await;
    if !status.success() {
        return Err("MKV_EXPORT_FAILED".into());
    }
    Ok(())
}
