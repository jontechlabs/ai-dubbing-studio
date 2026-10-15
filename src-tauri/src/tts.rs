use crate::{
    domain::{id, io_error, now, Project},
    jobs, media, project, separation, Core,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;
#[cfg(test)]
#[path = "tts_tests.rs"]
mod tests;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub device: String,
    pub reference_mode: String,
    pub reference_id: Option<String>,
    pub mode: String,
    pub speed: f64,
    pub seed: u32,
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if !["auto", "cpu"].contains(&self.device.as_str())
            && !self
                .device
                .strip_prefix("cuda:")
                .is_some_and(|index| index.parse::<u8>().is_ok())
        {
            return Err("DEVICE_UNAVAILABLE".into());
        }
        if !["character", "current", "custom"].contains(&self.reference_mode.as_str())
            || !["zeroShot", "crossLingual"].contains(&self.mode.as_str())
            || !self.speed.is_finite()
            || !(0.5..=2.0).contains(&self.speed)
        {
            return Err("INVALID_TTS_REQUEST".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub line_id: String,
    pub options: Options,
    pub fingerprint: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub installing: bool,
    pub size_bytes: u64,
    pub inventory: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    name: String,
    #[serde(default)]
    url: String,
    size: u64,
    sha256: String,
    #[serde(default)]
    bundled_path: Option<String>,
}
#[derive(Deserialize)]
struct Manifest {
    revision: String,
    files: Vec<File>,
}
#[derive(Deserialize)]
struct RuntimeManifest {
    common: Vec<File>,
    variants: std::collections::HashMap<String, Vec<File>>,
}
pub fn root(core: &Core) -> PathBuf {
    crate::model_storage::root(core).join("cosyvoice3-runtime")
}
fn manifest<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Manifest, String> {
    serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("cosyvoice-model.json"))
            .map_err(io_error)?,
    )
    .map_err(io_error)
}
fn installed(core: &Core) -> bool {
    let folder = root(core);
    separation::python(&folder).is_file()
        && folder.join("ready.json").is_file()
        && [
            "cosyvoice3.yaml",
            "llm.pt",
            "flow.pt",
            "hift.pt",
            "speech_tokenizer_v3.onnx",
            "campplus.onnx",
            "CosyVoice-BlankEN/model.safetensors",
        ]
        .iter()
        .all(|name| folder.join("model").join(name).is_file())
}
fn busy(core: &Core) -> bool {
    core.jobs.lock().is_ok_and(|jobs| {
        jobs.values()
            .any(|job| ["queued", "running", "paused"].contains(&job.saved.record.status.as_str()))
    })
}
pub async fn status<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<Status, String> {
    let ready = installed(&core);
    let permit = core.gate.clone().try_acquire_owned().ok();
    let inventory = if ready && permit.is_some() {
        separation::probe(
            &separation::python(&root(&core)),
            &[
                separation::resources(&app)
                    .join("cosyvoice_worker.py")
                    .to_string_lossy()
                    .into_owned(),
                "--info".into(),
            ],
            &AtomicBool::new(false),
            Duration::from_secs(30),
        )
        .await?
    } else {
        None
    };
    Ok(Status{installed:ready,installing:core.jobs.lock().map_err(io_error)?.values().any(|j|j.saved.record.kind=="ttsInstall" && ["queued","running"].contains(&j.saved.record.status.as_str())),size_bytes:manifest(&app)?.files.iter().map(|f|f.size).sum(),inventory:inventory.unwrap_or_else(||serde_json::json!({"devices":[],"warning":if ready{Some("DEVICE_PROBE_FAILED")}else{None}}))})
}
fn extract(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(archive).map_err(io_error)?).map_err(io_error)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io_error)?;
        let name = entry.enclosed_name().ok_or("INVALID_PATH")?;
        if entry.is_dir() {
            continue;
        }
        let path = destination.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        std::io::copy(
            &mut entry,
            &mut std::fs::File::create(path).map_err(io_error)?,
        )
        .map_err(io_error)?;
    }
    Ok(())
}
pub fn install<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    cuda: bool,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("RUNTIME_PLATFORM_UNSUPPORTED".into());
    }
    if busy(&core) {
        return Err("BUSY".into());
    }
    let key = jobs::create(&core, &app, "ttsInstall", String::new(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .tts_install = Some(cuda);
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="runtime".into();});
            let folder=root(&core);std::fs::create_dir_all(folder.join("python/Lib/site-packages")).map_err(io_error)?;
            let _=std::fs::remove_file(folder.join("ready.json"));
            let worker=separation::resources(&app).join("cosyvoice_worker.py").to_string_lossy().into_owned();
            let existing=separation::probe(&separation::python(&folder),&[worker.clone(),"--runtime-info".into()],&flag,Duration::from_secs(60)).await?;
            if !existing.is_some_and(|v|v["runtimeReady"]==true && v["cudaVersion"].as_str()==if cuda{Some("12.8")}else{None}){
                let archive=folder.join("python.zip");
                separation::fetch(&core,&app,&key,&["https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip".into()],&archive,("4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",11133606),&flag).await?;
                let (archive,dest)=(archive,folder.join("python"));tauri::async_runtime::spawn_blocking(move||extract(&archive,&dest)).await.map_err(io_error)??;
                project::atomic_write(&folder.join("python/python312._pth"),b"python312.zip\n.\nLib/site-packages\nimport site\n")?;
                let runtime:RuntimeManifest=serde_json::from_slice(&std::fs::read(separation::resources(&app).join("cosyvoice-runtime.json")).map_err(io_error)?).map_err(io_error)?;
                let mut files=runtime.variants.into_iter().find(|(name,_)|name==if cuda{"cu128"}else{"cpu"}).ok_or("TTS_RUNTIME_FAILED")?.1;files.extend(runtime.common);
                std::fs::create_dir_all(folder.join("wheels")).map_err(io_error)?;
                for file in files {
                    crate::domain::valid_relative(&file.name)?;
                    jobs::update(&core,&app,&key,|j|{j.stage="dependencies".into();j.progress=Some(0.0);j.logs.push(format!("Installing verified wheel: {}",file.name));});
                    let archive=if let Some(path)=file.bundled_path {crate::domain::valid_relative(&path)?;let archive=separation::resources(&app).join(path);let bytes=std::fs::read(&archive).map_err(io_error)?;if bytes.len() as u64!=file.size || format!("{:x}",Sha256::digest(&bytes))!=file.sha256{return Err("MODEL_CHECKSUM_FAILED".into());}archive}
                    else {let archive=folder.join("wheels").join(&file.name);separation::fetch(&core,&app,&key,&[file.url],&archive,(&file.sha256,file.size),&flag).await?;archive};
                    jobs::update(&core,&app,&key,|j|{j.stage="ttsExtract".into();j.progress=None;});
                    let destination=folder.join("python/Lib/site-packages");tauri::async_runtime::spawn_blocking(move||extract(&archive,&destination)).await.map_err(io_error)??;
                    if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
                }
                jobs::update(&core,&app,&key,|j|{j.stage="dependenciesCheck".into();j.progress=None;});
                if separation::probe(&separation::python(&folder),&[worker,"--runtime-info".into()],&flag,Duration::from_secs(90)).await?.is_none_or(|v|v["runtimeReady"]!=true){return Err("TTS_RUNTIME_FAILED".into());}
            }
            let model=manifest(&app)?;std::fs::create_dir_all(folder.join("model/CosyVoice-BlankEN")).map_err(io_error)?;
            for file in model.files {crate::domain::valid_relative(&file.name)?;jobs::update(&core,&app,&key,|j|{j.stage="ttsModel".into();j.progress=Some(0.0);j.logs.push(format!("Verified model file: {}",file.name));});separation::fetch(&core,&app,&key,&[file.url],&folder.join("model").join(&file.name),(&file.sha256,file.size),&flag).await?;}
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            project::atomic_write(&folder.join("ready.json"),&serde_json::to_vec(&serde_json::json!({"revision":model.revision,"cuda":cuda})).map_err(io_error)?)
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}

pub fn text(p: &Project, line: &crate::domain::Dialogue) -> String {
    let mut text = line.tts_text.clone().unwrap_or_else(|| {
        p.target_cues
            .iter()
            .filter(|cue| line.target_cue_ids.contains(&cue.id))
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    });
    let mut dictionary: Vec<_> = p.pronunciation.iter().collect();
    dictionary.sort_by_key(|(key, _)| std::cmp::Reverse(key.len()));
    for (key, value) in dictionary {
        if !key.is_empty() {
            text = text.replace(key, value);
        }
    }
    // Subtitle formatting tags are not speech.
    let mut clean = String::new();
    let mut tag = false;
    for c in text.chars() {
        if c == '<' {
            tag = true;
        } else if c == '>' && tag {
            tag = false;
        } else if !tag {
            clean.push(c);
        }
    }
    clean.trim().to_owned()
}
pub fn fingerprint(p: &Project, line_id: &str) -> Result<String, String> {
    let line = p
        .dialogues
        .iter()
        .find(|line| line.id == line_id)
        .ok_or("NO_DIALOGUES")?;
    let value = serde_json::json!({"text":text(p,line),"start":line.start_ms,"end":line.end_ms,"character":line.character_id,"characterData":p.characters.iter().find(|character|Some(&character.id)==line.character_id.as_ref()),"voiceSettings":line.voice_settings,"source":p.media.as_ref().map(|m|&m.path),"language":p.languages.target,"pronunciation":p.pronunciation});
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).map_err(io_error)?)
    ))
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    line_id: String,
    options: Options,
) -> Result<String, String> {
    options.validate()?;
    if busy(&core) {
        return Err("BUSY".into());
    }
    if !installed(&core) {
        return Err("TTS_RUNTIME_REQUIRED".into());
    }
    let request = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        validate_input(&s.project, &line_id, &options)?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            fingerprint: fingerprint(&s.project, &line_id)?,
            line_id,
            options,
        }
    };
    let key = jobs::create(&core, &app, "tts", request.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .tts_request = Some(request.clone());
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="ttsReference".into();});execute(&core,&app,&key,&request,&flag).await}.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}
fn validate_input(p: &Project, line_id: &str, options: &Options) -> Result<(), String> {
    let line = p
        .dialogues
        .iter()
        .find(|line| line.id == line_id)
        .ok_or("NO_DIALOGUES")?;
    let t = text(p, line);
    if t.is_empty() || t.chars().count() > 1000 {
        return Err("TTS_TEXT_REQUIRED".into());
    }
    if !["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"]
        .contains(&p.languages.target.as_str())
    {
        return Err("TTS_LANGUAGE_UNSUPPORTED".into());
    }
    if options.reference_mode != "current" {
        let reference = reference(p, line, options)?;
        if reference.duration_ms < 1000 {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        if options.mode == "zeroShot" && reference.transcript.trim().is_empty() {
            return Err("TTS_TRANSCRIPT_REQUIRED".into());
        }
    } else if p.media.is_none() || line.end_ms - line.start_ms < 1000 {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    Ok(())
}
fn reference<'a>(
    p: &'a Project,
    line: &crate::domain::Dialogue,
    options: &Options,
) -> Result<&'a crate::domain::VoiceReference, String> {
    let character = p
        .characters
        .iter()
        .find(|c| Some(&c.id) == line.character_id.as_ref())
        .ok_or("TTS_REFERENCE_REQUIRED")?;
    let reference_id = if options.reference_mode == "custom" {
        options.reference_id.as_ref()
    } else {
        character.default_reference_id.as_ref()
    };
    character
        .references
        .iter()
        .find(|r| Some(&r.id) == reference_id)
        .ok_or("TTS_REFERENCE_REQUIRED".into())
}
async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let launch = WorkerLaunch {
        python: separation::python(&root(core)),
        script: separation::resources(app).join("cosyvoice_worker.py"),
        model: root(core).join("model"),
    };
    execute_with_launch(core, app, key, request, flag, &launch).await
}
struct WorkerLaunch {
    python: PathBuf,
    script: PathBuf,
    model: PathBuf,
}
async fn execute_with_launch<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
    launch: &WorkerLaunch,
) -> Result<(), String> {
    let p = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || fingerprint(&s.project, &request.line_id)? != request.fingerprint
        {
            return Err("STALE_REVISION".into());
        }
        s.project.clone()
    };
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == request.line_id)
        .ok_or("NO_DIALOGUES")?;
    let directory = project::ensure_directory(&request.root, "generations")?;
    let generation_id = id();
    let destination = directory.join(format!("{generation_id}.wav"));
    let ref_temp = directory.join(format!("{generation_id}-reference.wav"));
    let (reference_audio, transcript) = if request.options.reference_mode == "current" {
        let (source, index) = crate::speakers::audio_source(&p, &request.root)?;
        let args = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-nostdin".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-i".into(),
            source.to_string_lossy().into_owned(),
            "-map".into(),
            format!("0:{index}"),
            "-ss".into(),
            format!("{:.3}", line.start_ms as f64 / 1000.0),
            "-t".into(),
            format!(
                "{:.3}",
                (line.end_ms - line.start_ms).min(20000) as f64 / 1000.0
            ),
            "-vn".into(),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "24000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-n".into(),
            ref_temp.to_string_lossy().into_owned(),
        ];
        separation::process(core, app, key, &media::binary(app, "ffmpeg")?, &args, flag).await?;
        let transcript = p
            .source_cues
            .iter()
            .filter(|cue| line.source_cue_ids.contains(&cue.id))
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        (ref_temp.clone(), transcript)
    } else {
        let reference = reference(&p, line, &request.options)?;
        (
            project::asset(&request.root, &reference.path)?,
            reference.transcript.clone(),
        )
    };
    if request.options.mode == "zeroShot" && transcript.trim().is_empty() {
        let _ = std::fs::remove_file(&ref_temp);
        return Err("TTS_TRANSCRIPT_REQUIRED".into());
    }
    let input = directory.join(format!("{generation_id}.request.json"));
    let result_path = directory.join(format!("{generation_id}.result.json"));
    let input_value = serde_json::json!({"text":text(&p,line),"language":p.languages.target,"referenceAudio":reference_audio,"referenceTranscript":transcript,"modelDir":launch.model,"outputPath":destination,"resultPath":result_path,"device":request.options.device,"speed":request.options.speed,"mode":request.options.mode,"seed":request.options.seed});
    project::atomic_write(&input, &serde_json::to_vec(&input_value).map_err(io_error)?)?;
    let result = tokio::time::timeout(
        Duration::from_secs(900),
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
        ),
    )
    .await
    .map_err(|_| "TTS_TIMEOUT".to_owned())
    .and_then(|result| result);
    let _ = std::fs::remove_file(&input);
    let _ = std::fs::remove_file(&ref_temp);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_file(&result_path);
        return Err(error);
    }
    let duration =
        crate::audio_files::pcm_frames(&destination, 1, 24000, "TTS_EMPTY_AUDIO")? * 1000 / 24000;
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&result_path).map_err(io_error)?)
            .map_err(io_error)?;
    let _ = std::fs::remove_file(&result_path);
    if duration == 0 || duration > 120000 || flag.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(&destination);
        return Err(if flag.load(Ordering::Relaxed) {
            "CANCELLED"
        } else {
            "TTS_EMPTY_AUDIO"
        }
        .into());
    }
    let generation = serde_json::json!({"id":generation_id,"kind":"tts","dialogueId":line.id,"providerId":"cosyvoice3","modelId":"cosyvoice3-05b-rl","path":format!("generations/{generation_id}.wav"),"createdAt":now(),"sourcePath":p.media.as_ref().map(|m|&m.path),"startMs":line.start_ms,"endMs":line.end_ms,"text":text(&p,line),"language":p.languages.target,"characterId":line.character_id,"durationMs":duration,"sampleRate":24000,"options":request.options,"referenceTranscript":transcript,"referenceId":if request.options.reference_mode=="current"{None}else{reference(&p,line,&request.options).ok().map(|r|&r.id)},"device":metadata["device"],"deviceName":metadata["deviceName"],"peakVramMb":metadata["peakVramMb"],"inputHash":request.fingerprint});
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if s.root != request.root || s.project.id != request.project_id {
        return Err("STALE_REVISION".into());
    }
    let unchanged =
        fingerprint(&s.project, &request.line_id).is_ok_and(|value| value == request.fingerprint);
    let mut next = s.project.clone();
    next.format_version = next.format_version.max(5);
    next.generations.push(generation);
    if let Some(line) = next.dialogues.iter_mut().find(|l| l.id == request.line_id) {
        if unchanged {
            line.selected_generation_ids
                .insert(p.languages.target.clone(), generation_id);
            line.status = if duration > line.end_ms - line.start_ms {
                "review"
            } else {
                "generated"
            }
            .into();
        }
    }
    let updated = s.replace(next, s.project.revision)?;
    app.emit("project-changed", updated).map_err(io_error)
}
pub fn validate_generations(p: &Project) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for g in &p.generations {
        if g["kind"] != "tts" {
            continue;
        }
        for name in [
            "dialogueId",
            "language",
            "text",
            "providerId",
            "modelId",
            "createdAt",
            "device",
            "deviceName",
            "inputHash",
            "referenceTranscript",
        ] {
            if g[name].as_str().is_none() {
                return Err("INVALID_GENERATION".into());
            }
        }
        let settings: Options =
            serde_json::from_value(g["options"].clone()).map_err(|_| "INVALID_GENERATION")?;
        settings.validate()?;
        if g["startMs"].as_u64().is_none()
            || g["endMs"]
                .as_u64()
                .is_none_or(|end| end <= g["startMs"].as_u64().unwrap_or(u64::MAX))
            || g["sampleRate"].as_u64() != Some(24000)
        {
            return Err("INVALID_GENERATION".into());
        }
        let key = g["id"].as_str().ok_or("INVALID_GENERATION")?;
        let path = g["path"].as_str().ok_or("INVALID_GENERATION")?;
        crate::domain::valid_relative(path)?;
        if p.format_version < 5
            || key.is_empty()
            || !ids.insert(key)
            || !path.starts_with("generations/")
            || g["durationMs"]
                .as_u64()
                .is_none_or(|v| v == 0 || v > 120000)
            || g["dialogueId"].as_str().is_none()
            || g["language"].as_str().is_none()
            || g["text"].as_str().is_none()
            || g["inputHash"].as_str().is_none()
        {
            return Err("INVALID_GENERATION".into());
        }
    }
    for line in &p.dialogues {
        for (language, key) in &line.selected_generation_ids {
            if !p.generations.iter().any(|g| {
                g["id"] == *key && g["dialogueId"] == line.id && g["language"] == *language
            }) {
                return Err("INVALID_GENERATION".into());
            }
        }
    }
    Ok(())
}
