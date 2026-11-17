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
    pub reference_range: Option<ReferenceRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_track_id: Option<String>,
    pub generation_id: String,
    pub reference_id: String,
    pub character_id: Option<String>,
    pub device: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceRange {
    pub start_ms: u64,
    pub end_ms: u64,
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
            .is_some_and(|s| !["current", "reference", "generation"].contains(&s))
            || (self.reference_mode.as_deref() != Some("current")
                && (self.reference_id.is_empty() || self.reference_id.len() > 128))
        {
            return Err("INVALID_VOICE_CONVERSION".into());
        }
        if self.reference_range.as_ref().is_some_and(|r| {
            self.reference_mode.as_deref() != Some("generation")
                || r.end_ms <= r.start_ms
                || !(1000..=20000).contains(&(r.end_ms - r.start_ms))
        }) {
            return Err("INVALID_REFERENCE_AUDIO".into());
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
    } else if o.reference_mode.as_deref() == Some("generation") {
        generation_reference(p, o)?;
    } else {
        reference(p, o)?;
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub batch_origin: Option<String>,
    #[serde(default)]
    pub batch_index: Option<usize>,
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
pub(crate) fn inputs<'a>(p: &'a Project, o: &Options) -> Result<&'a Value, String> {
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
    } else if o.reference_mode.as_deref() == Some("generation") {
        generation_reference(p, o)?;
    } else {
        reference(p, o)?;
    }
    Ok(g)
}
pub(crate) fn generation_reference<'a>(
    p: &'a Project,
    o: &Options,
) -> Result<(&'a Value, u64, u64), String> {
    let g = p
        .generations
        .iter()
        .find(|g| {
            g["kind"] == "tts" && g["id"] == o.reference_id && g["language"] == p.languages.target
        })
        .ok_or("INVALID_GENERATION")?;
    let duration = crate::generation_timing::audio_units(p, g);
    let start = o.reference_range.as_ref().map_or(0, |r| r.start_ms);
    let end = o
        .reference_range
        .as_ref()
        .map_or(duration.min(20000), |r| r.end_ms);
    if end <= start || end > duration || !(1000..=20000).contains(&(end - start)) {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    Ok((g, start, end))
}
pub(crate) fn fingerprint(p: &Project, o: &Options) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let source = inputs(p, o)?;
    let line = p
        .dialogues
        .iter()
        .find(|l| Some(l.id.as_str()) == source["dialogueId"].as_str())
        .ok_or("NO_DIALOGUES")?;
    let reference = if o.reference_mode.as_deref() == Some("generation") {
        let (g, start, end) = generation_reference(p, o)?;
        json!({"generation":g,"edit":p.voice_edits.get(&o.reference_id),"start":start,"end":end})
    } else {
        json!(reference(p, o)?)
    };
    Ok(format!("{:x}",Sha256::digest(json!({"source":source,"edit":p.voice_edits.get(&o.generation_id),"reference":reference,"media":p.media,"language":p.languages.target,"start":line.start_ms,"end":line.end_ms,"character":line.character_id,"text":tts::text(p,line),"timing":p.dubbing_timing.as_ref().map(|t|json!({"sourcePath":t.source_path,"offset":t.offsets_ms.get(&line.id),"duration":t.durations_ms.get(&line.id)})),"options":o}).to_string().as_bytes())))
}
pub fn validate(p: &Project) -> Result<(), String> {
    for g in &p.generations {
        if let Some(origin) = g.get("takeOrigin") {
            if p.format_version < 17
                || g["kind"] != "tts"
                || !matches!(
                    origin["type"].as_str(),
                    Some("microphone" | "conversion" | "separation")
                )
            {
                return Err("INVALID_VOICE_CONVERSION".into());
            }
            if origin["type"] == "separation"
                && (p.format_version < 34
                    || ["separationId", "sourceTrackId", "sourceLanguage"]
                        .iter()
                        .any(|key| {
                            origin[key]
                                .as_str()
                                .is_none_or(|s| s.is_empty() || s.len() > 128)
                        })
                    || !matches!(
                        origin["outputId"].as_str(),
                        Some("voice-1" | "voice-2" | "voice-3")
                    ))
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
    if generation["generationTiming"]["takeId"].as_str() == Some("") {
        generation["generationTiming"]["takeId"] = json!(key);
    }
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
    if line.excluded_from_dubbing == Some(true) {
        return Err("DIALOGUE_EXCLUDED".into());
    }
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
            batch_origin: None,
            batch_index: None,
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
    execute_project(core, app, key, request, flag, None, None)
        .await
        .map(|_| ())
}
pub(crate) async fn execute_project<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
    hot: Option<&mut crate::tts_session::Session>,
    launch: Option<&tts::WorkerLaunch>,
) -> Result<Project, String> {
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
    let measurement = crate::generation_timing::begin(
        core,
        app,
        key,
        &p,
        "voiceConversion",
        json!({"options":request.options,"language":p.languages.target}),
        crate::generation_timing::audio_units(&p, source),
        hot.as_ref().is_some_and(|s| s.is_loaded()),
    );
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
        crate::speaker_dubbing::snippet(
            core,
            app,
            key,
            &p,
            &request.root,
            &l.id,
            crate::audio_patch::Snippet {
                track_id: &track.id,
                start_ms: l.start_ms,
                end_ms: l.end_ms.min(l.start_ms + 20000),
                channels: 1,
                rate: 24000,
                levels: crate::audio_patch::SnippetLevels::Reference,
            },
            &target,
            flag,
        )
        .await?;
        target
    } else if request.options.reference_mode.as_deref() == Some("generation") {
        let (g, start, end) = generation_reference(&p, &request.options)?;
        let rendered = crate::voice_edit::render(
            &request.root,
            g["path"].as_str().ok_or("INVALID_GENERATION")?,
            p.voice_edits.get(&request.options.reference_id),
            &media::binary(app, "ffmpeg")?,
            flag,
        )
        .await?;
        let target = temporary.path().join("reference.wav");
        crate::voice_batch::trim_reference(&rendered, &target, start, end, flag).await?;
        target
    } else {
        project::asset(&request.root, &reference(&p, &request.options)?.path)?
    };
    let output = temporary.path().join("converted.wav");
    let result = temporary.path().join("result.json");
    let input = temporary.path().join("request.json");
    project::atomic_write(&input,&serde_json::to_vec(&json!({"variantId":"chatterbox-vc","modelDir":voice_engines::root(core).join("chatterbox-vc"),"sourceAudio":wav,"sourceGenerationId":request.options.generation_id,"referenceAudio":reference,"outputPath":output,"resultPath":result,"device":request.options.device,"referenceKey":crate::voice_edit::key(p.voice_edits.get(&request.options.reference_id))+&serde_json::to_string(&request.options.reference_range).map_err(io_error)?+&request.options.reference_id+request.options.character_id.as_deref().unwrap_or_default()})).map_err(io_error)?)?;
    let default_launch = tts::WorkerLaunch {
        python: separation::python(&voice_engines::root(core).join("multilingual-runtime")),
        script: separation::resources(app).join("voice_conversion_worker.py"),
        model: voice_engines::root(core).join("chatterbox-vc"),
    };
    let launch = launch.unwrap_or(&default_launch);
    if let Some(session) = hot {
        session
            .generate(core, app, key, launch, &input, flag)
            .await?;
    } else {
        separation::process(
            core,
            app,
            key,
            &launch.python,
            &[
                launch.script.to_string_lossy().into_owned(),
                "--request".into(),
                input.to_string_lossy().into_owned(),
            ],
            flag,
        )
        .await?;
    }
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
    generation["generationTiming"] = measurement.finish("");
    for field in [
        "voiceConversionBatchId",
        "voiceConversionBatchRootId",
        "voiceConversionBatchItemIndex",
    ] {
        generation
            .as_object_mut()
            .ok_or("INVALID_GENERATION")?
            .remove(field);
    }
    if let Some(origin) = &request.batch_origin {
        generation["voiceConversionBatchId"] = json!(key);
        generation["voiceConversionBatchRootId"] = json!(origin);
        generation["voiceConversionBatchItemIndex"] = json!(request.batch_index);
    }
    generation["providerId"] = json!("chatterbox-vc");
    generation["modelId"] = json!("chatterbox-vc");
    for field in ["device", "deviceName", "peakVramMb"] {
        generation[field] = metadata[field].clone();
    }
    generation["takeOrigin"] = json!({"type":"conversion","sourceGenerationId":request.options.generation_id,"referenceId":if request.options.reference_mode.as_deref()==Some("current"){format!("dialogue:{}",source["dialogueId"].as_str().unwrap_or_default())}else{request.options.reference_id.clone()},"characterId":request.options.character_id,"referenceMode":request.options.reference_mode,"referenceTrackId":request.options.reference_track_id,"referenceRange":request.options.reference_range});
    publish(
        core,
        app,
        (&request.root, &request.project_id, request.revision),
        &output,
        generation,
        flag,
    )
}
