//! Experimental, CPU-only contour transfer onto an existing take. Neither
//! source audio, guide audio nor the main movie are ever opened for writing.
use crate::{
    audio_files,
    domain::{id, io_error, now, Project},
    jobs, media, project, separation, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;
#[path = "prosody_signal.rs"]
mod signal;
#[cfg(test)]
#[path = "prosody_tests.rs"]
mod tests;

pub const MAX_MS: u64 = 30_000;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub generation_id: String,
    pub reference_mode: String,
    pub reference_id: Option<String>,
    #[serde(default)]
    pub character_id: Option<String>,
    #[serde(default)]
    pub reference_track_id: Option<String>,
    pub strength: f64,
    pub pitch: bool,
    pub rhythm: bool,
    pub energy: bool,
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if self.generation_id.is_empty()
            || self.generation_id.len() > 128
            || !self.strength.is_finite()
            || !(0.0..=1.0).contains(&self.strength)
            || !(self.pitch || self.rhythm || self.energy)
            || !matches!(self.reference_mode.as_str(), "dialogue" | "reference")
            || (self.reference_mode == "reference"
                && self.reference_id.as_ref().is_none_or(|id| id.is_empty()))
            || [
                &self.reference_id,
                &self.character_id,
                &self.reference_track_id,
            ]
            .iter()
            .any(|id| id.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128))
        {
            return Err("INVALID_PROSODY_REQUEST".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
}
pub fn status<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Value {
    json!({"available":media::binary(app,"praat").is_ok(),"version":"6.4.67","maxDurationMs":MAX_MS,"experimental":true,"device":"cpu"})
}
fn inputs<'a>(
    p: &'a Project,
    o: &Options,
) -> Result<(&'a Value, &'a crate::domain::Dialogue), String> {
    o.validate()?;
    let g = p
        .generations
        .iter()
        .find(|g| g["kind"] == "tts" && g["id"] == o.generation_id)
        .ok_or("INVALID_GENERATION")?;
    let line = p
        .dialogues
        .iter()
        .find(|l| Some(l.id.as_str()) == g["dialogueId"].as_str())
        .ok_or("NO_DIALOGUES")?;
    let duration = p
        .voice_edits
        .get(&o.generation_id)
        .map_or_else(|| g["durationMs"].as_u64().unwrap_or(0), |e| e.duration());
    if !(150..=MAX_MS).contains(&duration) {
        return Err("PROSODY_TOO_LONG".into());
    }
    if g["language"] != p.languages.target {
        return Err("INVALID_PROSODY_REQUEST".into());
    }
    if o.reference_mode == "dialogue" {
        if p.media.is_none() {
            return Err("NO_MEDIA".into());
        }
        if !(150..=MAX_MS).contains(&(line.end_ms - line.start_ms)) {
            return Err("PROSODY_TOO_LONG".into());
        }
        crate::audio_patch::source_track(p, o.reference_track_id.as_deref())?;
    } else {
        guide_reference(p, o)?;
    }
    Ok((g, line))
}
fn guide_reference<'a>(
    p: &'a Project,
    o: &Options,
) -> Result<&'a crate::domain::VoiceReference, String> {
    let references = if let Some(character) = &o.character_id {
        &p.characters
            .iter()
            .find(|c| &c.id == character)
            .ok_or("INVALID_CHARACTER")?
            .references
    } else {
        &p.voice_references
    };
    references
        .iter()
        .find(|r| Some(&r.id) == o.reference_id.as_ref())
        .ok_or("TTS_REFERENCE_REQUIRED".into())
}
pub fn validate(p: &Project) -> Result<(), String> {
    for g in &p.generations {
        if let Some(data) = g.get("prosodyTransfer") {
            let o: Options = serde_json::from_value(data["options"].clone())
                .map_err(|_| "INVALID_PROSODY_REQUEST")?;
            o.validate()?;
            if p.format_version < 14
                || g["kind"] != "tts"
                || data["algorithm"] != "praat-psola-v1"
                || data["sourceGenerationId"].as_str() != Some(o.generation_id.as_str())
                || data["sourceGenerationId"] == g["id"]
                || ["sourceDurationMs", "guideDurationMs"].iter().any(|key| {
                    data[*key]
                        .as_u64()
                        .is_none_or(|n| !(150..=MAX_MS).contains(&n))
                })
            {
                return Err("INVALID_PROSODY_REQUEST".into());
            }
        }
    }
    Ok(())
}
pub fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    media::binary(&app, "praat")?;
    let request = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        inputs(&s.project, &options)?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            revision: s.project.revision,
            options,
        }
    };
    enqueue(core, app, request)
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    let key = jobs::create(
        &core,
        &app,
        "prosodyTransfer",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .prosody = Some(request.clone());
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="prosodyPrepare".into();j.progress=Some(0.0);});
            execute(&core,&app,&key,&request,&flag).await
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}
fn check(p: &Project, request: &Request) -> Result<(), String> {
    if p.id != request.project_id || p.revision != request.revision {
        return Err("STALE_REVISION".into());
    }
    inputs(p, &request.options)?;
    Ok(())
}
async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let p = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root {
            return Err("STALE_REVISION".into());
        }
        check(&s.project, request)?;
        s.project.clone()
    };
    let (source, line) = inputs(&p, &request.options)?;
    let ffmpeg = media::binary(app, "ffmpeg")?;
    let source_path = crate::voice_edit::render(
        &request.root,
        source["path"].as_str().ok_or("INVALID_GENERATION")?,
        p.voice_edits.get(&request.options.generation_id),
        &ffmpeg,
        flag,
    )
    .await?;
    let temporary = tempfile::tempdir().map_err(io_error)?;
    let base = temporary.path().join("base.wav");
    let guide = temporary.path().join("guide.wav");
    let base_frames = audio_files::pcm_frames(&source_path, 1, 24000, "INVALID_GENERATION")?;
    if !(150 * 24..=MAX_MS * 24).contains(&base_frames) {
        return Err("PROSODY_TOO_LONG".into());
    }
    signal::write_pcm(&base, &signal::read_pcm(&source_path)?)?;
    if request.options.reference_mode == "dialogue" {
        let track =
            crate::audio_patch::source_track(&p, request.options.reference_track_id.as_deref())?;
        crate::audio_patch::snippet(
            core,
            app,
            key,
            &p,
            &request.root,
            crate::audio_patch::Snippet {
                track_id: &track.id,
                start_ms: line.start_ms,
                end_ms: line.end_ms,
                channels: 1,
                rate: 24000,
                fader: false,
            },
            &guide,
            flag,
        )
        .await?;
    } else {
        let path = project::asset(&request.root, &guide_reference(&p, &request.options)?.path)?;
        let frames = audio_files::pcm_frames(&path, 1, 24000, "INVALID_REFERENCE_AUDIO")?;
        if !(150 * 24..=MAX_MS * 24).contains(&frames) {
            return Err("PROSODY_TOO_LONG".into());
        }
        signal::write_pcm(&guide, &signal::read_pcm(&path)?)?;
    }
    let source_ms = audio_files::pcm_frames(&base, 1, 24000, "INVALID_GENERATION")? / 24;
    let guide_ms = audio_files::pcm_frames(&guide, 1, 24000, "INVALID_REFERENCE_AUDIO")? / 24;
    if !(150..=MAX_MS).contains(&source_ms) || !(150..=MAX_MS).contains(&guide_ms) {
        return Err("PROSODY_TOO_LONG".into());
    }
    let processed = temporary.path().join("processed.wav");
    process(
        &media::binary(app, "praat")?,
        &base,
        &guide,
        &processed,
        &request.options,
        flag,
        |stage, progress| {
            jobs::update(core, app, key, |j| {
                j.stage = stage.into();
                j.progress = Some(progress);
            })
        },
    )
    .await?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let duration = audio_files::pcm_frames(&processed, 1, 24000, "PROSODY_RENDER_FAILED")? / 24;
    let generation_id = id();
    let relative = format!("generations/{generation_id}.wav");
    let directory = project::ensure_directory(&request.root, "generations")?;
    let output = directory.join(format!("{generation_id}.wav"));
    let mut staging = tempfile::NamedTempFile::new_in(&directory).map_err(io_error)?;
    std::io::copy(
        &mut std::fs::File::open(&processed).map_err(io_error)?,
        &mut staging,
    )
    .map_err(io_error)?;
    staging.as_file().sync_all().map_err(io_error)?;
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if s.root != request.root {
        return Err("STALE_REVISION".into());
    }
    check(&s.project, request)?;
    let mut derived = source.clone();
    derived["id"] = json!(generation_id);
    derived["path"] = json!(relative);
    derived["createdAt"] = json!(now());
    derived["durationMs"] = json!(duration);
    derived["device"] = json!("cpu");
    derived["deviceName"] = json!("CPU · Praat");
    derived["peakVramMb"] = json!(0);
    derived["batchItemId"] = Value::Null;
    derived["compatibilityMode"] = json!(false);
    derived["prosodyTransfer"] = json!({"algorithm":"praat-psola-v1","sourceGenerationId":request.options.generation_id,"sourceDurationMs":source_ms,"guideDurationMs":guide_ms,"options":request.options});
    let mut next = s.project.clone();
    next.format_version = next.format_version.max(14);
    next.generations.push(derived);
    let current = next
        .dialogues
        .iter_mut()
        .find(|l| l.id == line.id)
        .ok_or("NO_DIALOGUES")?;
    current
        .selected_generation_ids
        .insert(p.languages.target.clone(), generation_id);
    current.status = if duration > current.end_ms - current.start_ms {
        "review"
    } else {
        "generated"
    }
    .into();
    staging.persist_noclobber(&output).map_err(io_error)?;
    match s.replace(next, s.project.revision) {
        Ok(updated) => {
            let _ = app.emit("project-changed", updated);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&output);
            Err(error)
        }
    }
}
fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[255, 254]) || bytes.iter().filter(|b| **b == 0).count() > bytes.len() / 5
    {
        String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}
async fn praat(
    executable: &Path,
    script: &Path,
    args: &[&Path],
    flag: &AtomicBool,
) -> Result<(), String> {
    let mut c = media::command(executable);
    c.arg("--no-pref-files")
        .arg("--no-plugins")
        .arg("--run")
        .arg(script)
        .args(args);
    let result = tokio::select! {_=jobs::cancelled(flag)=>return Err("CANCELLED".into()),result=tokio::time::timeout(Duration::from_secs(90),c.output())=>result.map_err(|_|"PROSODY_TIMEOUT")?.map_err(io_error)?};
    if !result.status.success() {
        let details = decode(if result.stderr.is_empty() {
            &result.stdout
        } else {
            &result.stderr
        });
        return Err(format!(
            "PROSODY_RENDER_FAILED\n{}",
            details.chars().take(2000).collect::<String>()
        ));
    }
    Ok(())
}
async fn process(
    executable: &Path,
    base: &Path,
    guide: &Path,
    output: &Path,
    options: &Options,
    flag: &AtomicBool,
    mut progress: impl FnMut(&str, f64),
) -> Result<(), String> {
    let dir = output.parent().ok_or("INVALID_PATH")?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if options.strength == 0.0 {
        std::fs::copy(base, output).map_err(io_error)?;
        return Ok(());
    }
    let analyze = dir.join("analyze.praat");
    let render = dir.join("render.praat");
    std::fs::write(
        &analyze,
        include_str!("../../workers/prosody-analyze.praat"),
    )
    .map_err(io_error)?;
    std::fs::write(&render, include_str!("../../workers/prosody-render.praat"))
        .map_err(io_error)?;
    let source_csv = dir.join("source.csv");
    let guide_csv = dir.join("guide.csv");
    progress("prosodyAnalyze", 0.15);
    praat(executable, &analyze, &[base, &source_csv], flag).await?;
    praat(executable, &analyze, &[guide, &guide_csv], flag).await?;
    let source = signal::parse(
        std::fs::read_to_string(&source_csv)
            .map_err(io_error)?
            .trim_start_matches('\u{feff}'),
    )?;
    let guide = signal::parse(
        std::fs::read_to_string(&guide_csv)
            .map_err(io_error)?
            .trim_start_matches('\u{feff}'),
    )?;
    let plan = signal::plan(&source, &guide, options)?;
    let plan_file = dir.join("plan.csv");
    std::fs::write(&plan_file, plan.csv()).map_err(io_error)?;
    let resynth = dir.join("resynth.wav");
    progress("prosodyRender", 0.55);
    praat(executable, &render, &[base, &plan_file, &resynth], flag).await?;
    let mut samples = signal::read_pcm(&resynth)?;
    let planned = *plan.output_times.last().unwrap();
    if (samples.len() as f64 / 24000.0 - planned).abs() > 0.025 {
        return Err("PROSODY_RENDER_FAILED".into());
    }
    plan.apply_energy(&mut samples);
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    progress("prosodySave", 0.9);
    signal::write_pcm(output, &samples)
}
