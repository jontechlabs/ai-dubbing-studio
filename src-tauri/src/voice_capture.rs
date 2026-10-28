//! Immutable microphone takes and local audio-to-audio timbre conversion.
use crate::{
    audio_files,
    domain::{id, io_error, now, Project},
    jobs, media, project, separation, tts, voice_engines, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;
#[cfg(test)]
#[path = "voice_capture_tests.rs"]
mod tests;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_track_id: Option<String>,
    pub generation_id: String,
    pub reference_id: String,
    pub character_id: Option<String>,
    pub device: String,
}
impl Options {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if [&self.generation_id]
            .iter()
            .any(|v| v.is_empty() || v.len() > 128)
            || self
                .character_id
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 128)
            || !(matches!(self.device.as_str(), "auto" | "cpu")
                || self.device.strip_prefix("cuda:").is_some_and(|v| {
                    !v.is_empty() && v.len() <= 2 && v.bytes().all(|v| v.is_ascii_digit())
                }))
        {
            return Err("INVALID_VOICE_CONVERSION".into());
        }
        if self
            .reference_mode
            .as_deref()
            .is_some_and(|s| !["current", "reference"].contains(&s))
            || (self.reference_mode.as_deref() != Some("current")
                && (self.reference_id.is_empty() || self.reference_id.len() > 128))
        {
            return Err("INVALID_VOICE_CONVERSION".into());
        }
        Ok(())
    }
}
pub(crate) fn validate_reference(p: &Project, o: &Options, line_id: &str) -> Result<(), String> {
    o.validate()?;
    if o.reference_mode.as_deref() == Some("current") {
        let line = p
            .dialogues
            .iter()
            .find(|l| l.id == line_id)
            .ok_or("NO_DIALOGUES")?;
        if p.media.is_none() || line.end_ms - line.start_ms < 1000 {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        crate::audio_patch::source_track(p, o.reference_track_id.as_deref())?;
    } else {
        reference(p, o)?;
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub project_id: String,
    pub expected_revision: u64,
    pub line_id: String,
}

fn reference<'a>(p: &'a Project, o: &Options) -> Result<&'a crate::domain::VoiceReference, String> {
    let refs = match &o.character_id {
        Some(id) => {
            &p.characters
                .iter()
                .find(|c| &c.id == id)
                .ok_or("INVALID_CHARACTER")?
                .references
        }
        None => &p.voice_references,
    };
    let r = refs
        .iter()
        .find(|r| r.id == o.reference_id)
        .or_else(|| {
            o.character_id
                .as_deref()
                .and_then(|id| crate::voice_library::library(p, id))
                .and_then(|library| {
                    library
                        .samples
                        .iter()
                        .find(|s| s.status == "approved" && s.reference.id == o.reference_id)
                })
                .map(|s| &s.reference)
        })
        .ok_or("TTS_REFERENCE_REQUIRED")?;
    if !(1000..=20000).contains(&r.duration_ms) {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    Ok(r)
}
fn inputs<'a>(p: &'a Project, o: &Options) -> Result<&'a Value, String> {
    o.validate()?;
    let g = p
        .generations
        .iter()
        .find(|g| {
            g["kind"] == "tts" && g["id"] == o.generation_id && g["language"] == p.languages.target
        })
        .ok_or("INVALID_GENERATION")?;
    let duration = p
        .voice_edits
        .get(&o.generation_id)
        .map_or_else(|| g["durationMs"].as_u64().unwrap_or(0), |e| e.duration());
    if !(150..=120000).contains(&duration) {
        return Err("VC_INVALID_AUDIO".into());
    }
    if !p
        .dialogues
        .iter()
        .any(|l| Some(l.id.as_str()) == g["dialogueId"].as_str())
    {
        return Err("NO_DIALOGUES".into());
    }
    if o.reference_mode.as_deref() == Some("current") {
        let l = p
            .dialogues
            .iter()
            .find(|l| Some(l.id.as_str()) == g["dialogueId"].as_str())
            .ok_or("NO_DIALOGUES")?;
        if p.media.is_none() || l.end_ms - l.start_ms < 1000 {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        crate::audio_patch::source_track(p, o.reference_track_id.as_deref())?;
    } else {
        reference(p, o)?;
    }
    Ok(g)
}
pub fn validate(p: &Project) -> Result<(), String> {
    for g in &p.generations {
        if let Some(origin) = g.get("takeOrigin") {
            if p.format_version < 17
                || g["kind"] != "tts"
                || !matches!(origin["type"].as_str(), Some("microphone" | "conversion"))
            {
                return Err("INVALID_VOICE_CONVERSION".into());
            }
            if origin["type"] == "conversion"
                && (origin["sourceGenerationId"]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 128)
                    || origin["sourceGenerationId"] == g["id"]
                    || origin["referenceId"]
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s.len() > 128))
            {
                return Err("INVALID_VOICE_CONVERSION".into());
            }
        }
    }
    Ok(())
}
/// Stage a verified WAV, then commit project + new take together. Failed/stale
/// operations never alter the selected take or any pre-existing audio file.
fn publish<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    basis: (&Path, &str, u64),
    wav: &Path,
    mut generation: Value,
    flag: &AtomicBool,
) -> Result<Project, String> {
    let (root, project_id, revision) = basis;
    let duration = audio_files::pcm_frames(wav, 1, 24000, "VC_INVALID_AUDIO")? / 24;
    if !(150..=120000).contains(&duration) {
        return Err("VC_INVALID_AUDIO".into());
    }
    let key = id();
    let directory = project::ensure_directory(root, "generations")?;
    let output = directory.join(format!("{key}.wav"));
    let mut staging = tempfile::NamedTempFile::new_in(&directory).map_err(io_error)?;
    std::io::copy(
        &mut std::fs::File::open(wav).map_err(io_error)?,
        &mut staging,
    )
    .map_err(io_error)?;
    staging.as_file().sync_all().map_err(io_error)?;
    generation["id"] = json!(key);
    generation["path"] = json!(format!("generations/{key}.wav"));
    generation["createdAt"] = json!(now());
    generation["durationMs"] = json!(duration);
    generation["batchItemId"] = Value::Null;
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if s.root != root || s.project.id != project_id || s.project.revision != revision {
        return Err("STALE_REVISION".into());
    }
    let mut next = s.project.clone();
    let line = next
        .dialogues
        .iter_mut()
        .find(|l| Some(l.id.as_str()) == generation["dialogueId"].as_str())
        .ok_or("NO_DIALOGUES")?;
    line.selected_generation_ids
        .insert(next.languages.target.clone(), key);
    line.status = "review".into();
    next.generations.push(generation);
    next.format_version = next.format_version.max(17);
    next.validate()?;
    staging.persist_noclobber(&output).map_err(io_error)?;
    match s.replace(next, revision) {
        Ok(updated) => {
            let _ = app.emit("project-changed", &updated);
            Ok(updated)
        }
        Err(error) => {
            let _ = std::fs::remove_file(output);
            Err(error)
        }
    }
}
pub fn save_microphone<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    capture: Capture,
    bytes: &[u8],
) -> Result<Project, String> {
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    // Canonical mono PCM16 24 kHz WAV generated by the capture worklet. Do not
    // decode arbitrary browser codecs, trust a reported duration or truncate.
    if bytes.len() < 44 + 150 * 48 || bytes.len() > 44 + 120000 * 48 {
        return Err("MIC_INVALID_AUDIO".into());
    }
    let mut temporary = tempfile::NamedTempFile::new().map_err(io_error)?;
    temporary.write_all(bytes).map_err(io_error)?;
    let frames = audio_files::pcm_frames(temporary.path(), 1, 24000, "MIC_INVALID_AUDIO")?;
    if !(150 * 24..=120000 * 24).contains(&frames) {
        return Err("MIC_INVALID_AUDIO".into());
    }
    let (root, p) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.project.id != capture.project_id || s.project.revision != capture.expected_revision {
            return Err("STALE_REVISION".into());
        }
        (s.root.clone(), s.project.clone())
    };
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == capture.line_id)
        .ok_or("NO_DIALOGUES")?;
    let generation = json!({"kind":"tts","dialogueId":line.id,"providerId":"microphone","modelId":"microphone-pcm24","sourcePath":p.media.as_ref().map(|m| &m.path),"startMs":line.start_ms,"endMs":line.end_ms,"text":tts::text(&p,line),"language":p.languages.target,"characterId":line.character_id,"sampleRate":24000,"options":{"device":"cpu","referenceMode":"current","referenceId":null,"mode":"crossLingual","speed":1.0,"seed":0},"referenceTranscript":"","device":"cpu","deviceName":"Microphone","peakVramMb":0,"inputHash":"microphone","takeOrigin":{"type":"microphone"}});
    publish(
        &core,
        &app,
        (&root, &p.id, p.revision),
        temporary.path(),
        generation,
        &AtomicBool::new(false),
    )
}
pub fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !voice_engines::installed(&core, "chatterbox-vc") {
        return Err("TTS_MODEL_REQUIRED".into());
    }
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
        "voiceConversion",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .voice_conversion = Some(request.clone());
    jobs::persist(&core);
    let result = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result = async {
            let _permit = tokio::select! { _=jobs::cancelled(&flag)=>return Err("CANCELLED".into()), p=core.gate.clone().acquire_owned()=>p.map_err(io_error)? };
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="vcPrepare".into();j.progress=Some(0.0);});
            execute(&core,&app,&key,&request,&flag).await
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(result)
}
pub(crate) async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let p = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.revision != request.revision
        {
            return Err("STALE_REVISION".into());
        }
        s.project.clone()
    };
    let source = inputs(&p, &request.options)?;
    let wav = crate::voice_edit::render(
        &request.root,
        source["path"].as_str().ok_or("INVALID_GENERATION")?,
        p.voice_edits.get(&request.options.generation_id),
        &media::binary(app, "ffmpeg")?,
        flag,
    )
    .await?;
    let temporary = tempfile::tempdir().map_err(io_error)?;
    let reference = if request.options.reference_mode.as_deref() == Some("current") {
        let l = p
            .dialogues
            .iter()
            .find(|l| Some(l.id.as_str()) == source["dialogueId"].as_str())
            .ok_or("NO_DIALOGUES")?;
        let track =
            crate::audio_patch::source_track(&p, request.options.reference_track_id.as_deref())?;
        let target = temporary.path().join("reference.wav");
        crate::audio_patch::snippet(
            core,
            app,
            key,
            &p,
            &request.root,
            crate::audio_patch::Snippet {
                track_id: &track.id,
                start_ms: l.start_ms,
                end_ms: l.end_ms.min(l.start_ms + 20000),
                channels: 1,
                rate: 24000,
                fader: false,
            },
            &target,
            flag,
        )
        .await?;
        target
    } else {
        project::asset(&request.root, &reference(&p, &request.options)?.path)?
    };
    let output = temporary.path().join("converted.wav");
    let result = temporary.path().join("result.json");
    let input = temporary.path().join("request.json");
    project::atomic_write(&input,&serde_json::to_vec(&json!({"variantId":"chatterbox-vc","modelDir":voice_engines::root(core).join("chatterbox-vc"),"sourceAudio":wav,"referenceAudio":reference,"outputPath":output,"resultPath":result,"device":request.options.device})).map_err(io_error)?)?;
    separation::process(
        core,
        app,
        key,
        &separation::python(&voice_engines::root(core).join("multilingual-runtime")),
        &[
            separation::resources(app)
                .join("voice_conversion_worker.py")
                .to_string_lossy()
                .into_owned(),
            "--request".into(),
            input.to_string_lossy().into_owned(),
        ],
        flag,
    )
    .await?;
    if audio_files::pcm_frames(&output, 1, 24000, "VC_INVALID_AUDIO")?
        != audio_files::pcm_frames(&wav, 1, 24000, "VC_INVALID_AUDIO")?
    {
        return Err("VC_DURATION_MISMATCH".into());
    }
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(result).map_err(io_error)?).map_err(io_error)?;
    let mut generation = source.clone();
    generation
        .as_object_mut()
        .ok_or("INVALID_GENERATION")?
        .remove("dubbingPipeline");
    generation
        .as_object_mut()
        .ok_or("INVALID_GENERATION")?
        .remove("prosodyTransfer");
    generation["providerId"] = json!("chatterbox-vc");
    generation["modelId"] = json!("chatterbox-vc");
    for field in ["device", "deviceName", "peakVramMb"] {
        generation[field] = metadata[field].clone();
    }
    generation["takeOrigin"] = json!({"type":"conversion","sourceGenerationId":request.options.generation_id,"referenceId":if request.options.reference_mode.as_deref()==Some("current"){format!("dialogue:{}",source["dialogueId"].as_str().unwrap_or_default())}else{request.options.reference_id.clone()},"characterId":request.options.character_id,"referenceMode":request.options.reference_mode,"referenceTrackId":request.options.reference_track_id});
    publish(
        core,
        app,
        (&request.root, &request.project_id, request.revision),
        &output,
        generation,
        flag,
    )
    .map(|_| ())
}
