use crate::{
    domain::{id, io_error, now, Project},
    jobs, project, separation, Core,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_gain: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intonation_guide: Option<IntonationGuide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default)]
    pub variant_id: Option<String>,
    pub device: String,
    pub reference_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_track_id: Option<String>,
    pub reference_id: Option<String>,
    pub mode: String,
    pub speed: f64,
    pub seed: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntonationGuide {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
}
impl Options {
    pub fn variant(&self) -> &str {
        self.variant_id.as_deref().unwrap_or("cosy3-official")
    }
    pub fn validate(&self) -> Result<(), String> {
        if self
            .output_gain
            .is_some_and(|g| !g.is_finite() || !(0.0..=4.0).contains(&g))
        {
            return Err("INVALID_OUTPUT_GAIN".into());
        }
        if let Some(g) = &self.intonation_guide {
            if self.variant() != "voxcpm2-bf16"
                || self.reference_mode == "current"
                || self.mode != "crossLingual"
                || !["style", "hybrid"].contains(&g.mode.as_str())
                || g.track_id
                    .as_ref()
                    .is_some_and(|t| t.is_empty() || t.len() > 128)
                || g.mode == "hybrid"
                    && (self.accent.as_deref().is_some_and(|a| a != "auto")
                        || self.mood.as_deref().is_some_and(|m| m != "default"))
            {
                return Err("TTS_GUIDE_UNSUPPORTED".into());
            }
        }
        crate::voice_quality::validate(self.variant(), self.quality.as_ref())?;
        crate::voice_accent::validate(self, None)?;
        let mood = self.mood.as_deref().unwrap_or("default");
        if crate::voice_mood::spec(Some(mood)).is_none()
            || ((self.variant().starts_with("qwen3") || self.variant().starts_with("chatterbox"))
                && mood != "default")
        {
            return Err("TTS_STYLE_UNSUPPORTED".into());
        }
        if self.variant() == "chatterbox-vc" {
            return Err("INVALID_TTS_REQUEST".into());
        }
        if self.variant() != "cosy3-official"
            && !crate::voice_engines::IDS.contains(&self.variant())
        {
            return Err("INVALID_TTS_REQUEST".into());
        }
        if !["auto", "cpu"].contains(&self.device.as_str())
            && !self
                .device
                .strip_prefix("cuda:")
                .or_else(|| self.device.strip_prefix("vulkan:"))
                .is_some_and(|index| index.parse::<u8>().is_ok())
        {
            return Err("DEVICE_UNAVAILABLE".into());
        }
        if !["character", "current", "custom", "file", "library"]
            .contains(&self.reference_mode.as_str())
            || !["zeroShot", "crossLingual"].contains(&self.mode.as_str())
            || !self.speed.is_finite()
            || !(0.5..=2.0).contains(&self.speed)
        {
            return Err("INVALID_TTS_REQUEST".into());
        }
        if self
            .reference_track_id
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
        {
            return Err("INVALID_AUDIO_TRANSFER".into());
        }
        Ok(())
    }
    pub fn required_format(&self) -> u32 {
        if self.output_gain.is_some_and(|g| g != 1.0) {
            return 22;
        }
        if self.reference_mode == "library" || self.intonation_guide.is_some() {
            return 21;
        }
        if self.quality.is_some() {
            return 19;
        }
        crate::voice_mood::format_version(self.mood.as_deref()).max(
            if crate::voice_engines::multilingual(self.variant()) {
                16
            } else if self.requires_v9() {
                9
            } else {
                5
            },
        )
    }
    pub fn requires_v9(&self) -> bool {
        self.reference_mode == "file" || self.accent.as_deref().is_some_and(|a| a != "auto")
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
    #[serde(default)]
    pub option_fingerprint: Option<String>,
    #[serde(default)]
    pub batch_item_id: Option<String>,
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
pub(crate) fn busy(core: &Core) -> bool {
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
fn copy_cancelled(
    reader: &mut impl std::io::Read,
    writer: &mut impl std::io::Write,
    flag: &AtomicBool,
) -> Result<(), String> {
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let size = reader.read(&mut buffer).map_err(io_error)?;
        if size == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..size]).map_err(io_error)?;
    }
}
pub(crate) fn extract(archive: &Path, destination: &Path, flag: &AtomicBool) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(archive).map_err(io_error)?).map_err(io_error)?;
    for index in 0..archive.len() {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let mut entry = archive.by_index(index).map_err(io_error)?;
        let name = entry.enclosed_name().ok_or("INVALID_PATH")?;
        if entry.is_dir() {
            continue;
        }
        let path = destination.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        copy_cancelled(
            &mut entry,
            &mut std::fs::File::create(path).map_err(io_error)?,
            flag,
        )?;
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
                let (archive,dest)=(archive,folder.join("python"));let extraction_flag=flag.clone();tauri::async_runtime::spawn_blocking(move||extract(&archive,&dest,&extraction_flag)).await.map_err(io_error)??;
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
                    let destination=folder.join("python/Lib/site-packages");let extraction_flag=flag.clone();tauri::async_runtime::spawn_blocking(move||extract(&archive,&destination,&extraction_flag)).await.map_err(io_error)??;
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
    let mut text = line
        .tts_text
        .clone()
        .unwrap_or_else(|| crate::speaker_dubbing::text(p, line, false));
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
    let value = serde_json::json!({"text":text(p,line),"start":line.start_ms,"end":line.end_ms,"character":line.character_id,"characterData":p.characters.iter().find(|character|Some(&character.id)==line.character_id.as_ref()),"voiceSettings":line.voice_settings,"isolatedVoice":crate::speaker_dubbing::voice(p,&line.id),"sourceCues":p.source_cues.iter().filter(|c|line.source_cue_ids.contains(&c.id)).collect::<Vec<_>>(),"fileReference":line.voice_settings.as_ref().filter(|o|o.reference_mode=="file").and_then(|o|o.reference_id.as_deref()).and_then(|id|p.voice_reference(None,id)),"referenceTrack":p.model_preferences.as_ref().map(|v|&v["referenceTrackId"]),"audioPatches":crate::audio_patch::all(p)?,"source":p.media.as_ref().map(|m|&m.path),"language":p.languages.target,"pronunciation":p.pronunciation});
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).map_err(io_error)?)
    ))
}
fn option_fingerprint(p: &Project, line_id: &str, options: &Options) -> Result<String, String> {
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == line_id)
        .ok_or("NO_DIALOGUES")?;
    let reference = if options.reference_mode == "current" {
        None
    } else {
        Some(reference(p, line, options)?)
    };
    let value = serde_json::json!({"options":options,"reference":reference,"selected":line.selected_generation_ids.get(&p.languages.target)});
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).map_err(io_error)?)
    ))
}
pub(crate) fn prepare_request(
    p: &Project,
    root: &Path,
    line_id: String,
    mut options: Options,
) -> Result<Request, String> {
    // Continuation inherits language and acting from its transcript/audio.
    // VoxCPM's control-instruction path is the separate reference-only mode.
    if options.variant() == "voxcpm2-bf16" && options.mode == "zeroShot" {
        options.accent = Some("auto".into());
        options.mood = Some("default".into());
    }
    if options.variant().starts_with("chatterbox")
        || options.variant() == "cosy3-official"
            && (options.mood.as_deref().is_some_and(|m| m != "default")
                || options.accent.as_deref().is_some_and(|a| a != "auto"))
    {
        options.mode = "crossLingual".into();
    }
    options.validate()?;
    validate_input(p, &line_id, &options)?;
    Ok(Request {
        root: root.into(),
        project_id: p.id.clone(),
        fingerprint: fingerprint(p, &line_id)?,
        option_fingerprint: Some(option_fingerprint(p, &line_id, &options)?),
        line_id,
        options,
        batch_item_id: None,
    })
}
pub(crate) fn matches_request(p: &Project, request: &Request) -> bool {
    if p.dialogues
        .iter()
        .any(|l| l.id == request.line_id && l.excluded_from_dubbing == Some(true))
    {
        return false;
    }
    fingerprint(p, &request.line_id).is_ok_and(|v| v == request.fingerprint)
        && request.option_fingerprint.as_ref().is_none_or(|expected| {
            option_fingerprint(p, &request.line_id, &request.options)
                .is_ok_and(|actual| &actual == expected)
        })
}
pub(crate) fn runtime_installed(core: &Core, options: &Options) -> bool {
    if options.variant() == "cosy3-official" {
        installed(core)
    } else {
        crate::voice_engines::installed(core, options.variant())
    }
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    line_id: String,
    mut options: Options,
) -> Result<String, String> {
    if options.variant().starts_with("chatterbox")
        || options.variant() == "cosy3-official"
            && (options.mood.as_deref().is_some_and(|m| m != "default")
                || options.accent.as_deref().is_some_and(|a| a != "auto"))
    {
        options.mode = "crossLingual".into();
    }
    options.validate()?;
    if busy(&core) {
        return Err("BUSY".into());
    }
    if !(if options.variant() == "cosy3-official" {
        installed(&core)
    } else {
        crate::voice_engines::installed(&core, options.variant())
    }) {
        return Err("TTS_RUNTIME_REQUIRED".into());
    }
    let request = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        prepare_request(&s.project, &s.root, line_id, options)?
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
pub(crate) fn validate_input(p: &Project, line_id: &str, options: &Options) -> Result<(), String> {
    if p.dialogues
        .iter()
        .any(|l| l.id == line_id && l.excluded_from_dubbing == Some(true))
    {
        return Err("DIALOGUE_EXCLUDED".into());
    }
    let groups = crate::speaker_dubbing::State::new(p);
    if !groups.children.contains_key(line_id) && !groups.enabled(line_id) {
        return Err("SPEAKER_DUBBING_PARENT_ACTIVE".into());
    }
    crate::voice_accent::validate(options, Some(&p.languages.target))?;
    let line = p
        .dialogues
        .iter()
        .find(|line| line.id == line_id)
        .ok_or("NO_DIALOGUES")?;
    if let Some(guide) = &options.intonation_guide {
        if p.media.is_none() || line.end_ms.saturating_sub(line.start_ms) < 1000 {
            return Err("TTS_GUIDE_TOO_SHORT".into());
        }
        crate::audio_patch::source_track(p, guide.track_id.as_deref())?;
        if guide.mode == "hybrid"
            && crate::speaker_dubbing::text(p, line, true)
                .trim()
                .is_empty()
        {
            return Err("TTS_GUIDE_TRANSCRIPT_REQUIRED".into());
        }
    }
    let t = text(p, line);
    if t.is_empty() || t.chars().count() > 1000 {
        return Err("TTS_TEXT_REQUIRED".into());
    }
    if !["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"]
        .contains(&p.languages.target.as_str())
    {
        return Err("TTS_LANGUAGE_UNSUPPORTED".into());
    }
    if (options.variant().starts_with("fish") || options.variant() == "drama3-comfy-fp8")
        && options.mode != "zeroShot"
    {
        return Err("TTS_TRANSCRIPT_REQUIRED".into());
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
    if options.reference_mode == "current" {
        crate::audio_patch::source_track(p, options.reference_track_id.as_deref())?;
        if options.mode == "zeroShot"
            && crate::speaker_dubbing::text(p, line, true)
                .trim()
                .is_empty()
        {
            return Err("TTS_TRANSCRIPT_REQUIRED".into());
        }
    }
    Ok(())
}
fn reference<'a>(
    p: &'a Project,
    line: &crate::domain::Dialogue,
    options: &Options,
) -> Result<&'a crate::domain::VoiceReference, String> {
    if options.reference_mode == "library" {
        return crate::voice_library::reference(
            p,
            line.character_id
                .as_deref()
                .ok_or("TTS_REFERENCE_REQUIRED")?,
            options.reference_id.as_deref(),
        )
        .ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED".into());
    }
    if options.reference_mode == "file" {
        return p
            .voice_references
            .iter()
            .find(|r| Some(&r.id) == options.reference_id.as_ref())
            .ok_or("TTS_REFERENCE_REQUIRED".into());
    }
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
pub(crate) async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let launch = worker_launch(core, app, request);
    execute_with_launch(core, app, key, request, flag, &launch).await
}
pub(crate) fn worker_launch<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    request: &Request,
) -> WorkerLaunch {
    if request.options.variant() == "cosy3-official" {
        WorkerLaunch {
            python: separation::python(&root(core)),
            script: separation::resources(app).join("cosyvoice_worker.py"),
            model: root(core).join("model"),
        }
    } else if crate::voice_engines::multilingual(request.options.variant()) {
        WorkerLaunch {
            python: separation::python(
                &crate::voice_engines::root(core).join("multilingual-runtime"),
            ),
            script: separation::resources(app).join("multilingual_worker.py"),
            model: crate::voice_engines::root(core).join(request.options.variant()),
        }
    } else if request.options.variant() == "drama3-comfy-fp8" {
        WorkerLaunch {
            python: separation::python(&crate::voice_engines::root(core).join("drama-runtime")),
            script: separation::resources(app).join("drama_worker.py"),
            model: crate::voice_engines::root(core).join(request.options.variant()),
        }
    } else {
        WorkerLaunch {
            python: separation::python(&crate::voice_engines::root(core).join("fish-runtime")),
            script: separation::resources(app).join("fish_worker.py"),
            model: crate::voice_engines::root(core).join(request.options.variant()),
        }
    }
}
pub(crate) struct WorkerLaunch {
    pub python: PathBuf,
    pub script: PathBuf,
    pub model: PathBuf,
}
pub(crate) async fn execute_with_launch<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
    launch: &WorkerLaunch,
) -> Result<(), String> {
    execute_with_session(core, app, key, request, flag, launch, None).await
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_with_session<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &AtomicBool,
    launch: &WorkerLaunch,
    mut hot: Option<&mut crate::tts_session::Session>,
) -> Result<(), String> {
    let p = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || !matches_request(&s.project, request)
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
    let ref_prepared = directory.join(format!("{generation_id}-normalized.wav"));
    let (reference_audio, transcript) = if request.options.reference_mode == "current" {
        let track =
            crate::audio_patch::source_track(&p, request.options.reference_track_id.as_deref())?;
        crate::speaker_dubbing::snippet(
            core,
            app,
            key,
            &p,
            &request.root,
            &line.id,
            crate::audio_patch::Snippet {
                track_id: &track.id,
                start_ms: line.start_ms,
                end_ms: line.end_ms.min(line.start_ms + 20000),
                channels: 1,
                rate: 24000,
                levels: crate::audio_patch::SnippetLevels::Reference,
            },
            &ref_temp,
            flag,
        )
        .await?;
        let transcript = crate::speaker_dubbing::text(&p, line, true);
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
    let guide_temp = directory.join(format!("{generation_id}-guide.wav"));
    let guide_prepared = directory.join(format!("{generation_id}-guide-normalized.wav"));
    let guide_transcript = crate::speaker_dubbing::text(&p, line, true);
    if let Some(guide) = &request.options.intonation_guide {
        let track = crate::audio_patch::source_track(&p, guide.track_id.as_deref())?;
        if let Err(error) = crate::speaker_dubbing::snippet(
            core,
            app,
            key,
            &p,
            &request.root,
            &line.id,
            crate::audio_patch::Snippet {
                track_id: &track.id,
                start_ms: line.start_ms,
                end_ms: line.end_ms.min(line.start_ms + 20000),
                channels: 1,
                rate: 24000,
                levels: crate::audio_patch::SnippetLevels::Reference,
            },
            &guide_temp,
            flag,
        )
        .await
        {
            let _ = std::fs::remove_file(&ref_temp);
            let _ = std::fs::remove_file(&guide_temp);
            return Err(error);
        }
    }
    if request.options.reference_mode == "library" {
        let owner = line
            .character_id
            .as_deref()
            .ok_or("TTS_REFERENCE_REQUIRED")?;
        let lib =
            crate::voice_library::library(&p, owner).ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED")?;
        let sample = lib
            .samples
            .iter()
            .find(|s| {
                Some(&s.id)
                    == request
                        .options
                        .reference_id
                        .as_ref()
                        .or(lib.default_sample_id.as_ref())
                    && s.status == "approved"
            })
            .ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED")?;
        if crate::voice_library::digest(&reference_audio)? != sample.sha256 {
            let _ = std::fs::remove_file(&guide_temp);
            return Err("VOICE_LIBRARY_REFERENCE_CHANGED".into());
        }
    }
    let input = directory.join(format!("{generation_id}.request.json"));
    let result_path = directory.join(format!("{generation_id}.result.json"));
    let raw_text = text(&p, line);
    let prompt_text = if request.options.variant().starts_with("fish")
        || request.options.variant() == "drama3-comfy-fp8"
    {
        crate::voice_accent::fish_prompt(&raw_text, &request.options)
    } else {
        raw_text.clone()
    };
    let input_value = serde_json::json!({"intonationGuide":request.options.intonation_guide,"guideAudio":guide_temp,"preparedGuideAudio":guide_prepared,"guideTranscript":guide_transcript,"preparedReferenceAudio":ref_prepared,"variantId":request.options.variant(),"slotMs":line.end_ms-line.start_ms,"quality":request.options.quality,"text":raw_text,"promptText":prompt_text,"mood":request.options.mood,"accent":request.options.accent,"language":p.languages.target,"referenceAudio":reference_audio,"referenceTranscript":transcript,"modelDir":launch.model,"outputPath":destination,"resultPath":result_path,"device":request.options.device,"speed":request.options.speed,"mode":request.options.mode,"seed":request.options.seed});
    project::atomic_write(&input, &serde_json::to_vec(&input_value).map_err(io_error)?)?;
    let result = tokio::time::timeout(Duration::from_secs(if request.options.variant()=="drama3-comfy-fp8"{3600}else{900}), async {
        if request.options.variant().contains("gguf") {
            return if let Some(session)=hot.as_deref_mut(){crate::voice_engines::generate_gguf_with_session(core,app,key,&input_value,flag,Some(session)).await}else{crate::voice_engines::generate_gguf(core,app,key,&input_value,flag).await};
        }
        let args = [
                launch.script.to_string_lossy().into_owned(),
                "--request".into(),
                input.to_string_lossy().into_owned(),
            ];
        if hot.as_ref().is_some_and(|s|s.compatible) {
            let mut compatible = input_value.clone(); compatible["compatibilityMode"] = true.into();
            project::atomic_write(&input, &serde_json::to_vec(&compatible).map_err(io_error)?)?;
        }
        let first = if let Some(session) = hot.as_deref_mut() {session.generate(core,app,key,launch,&input,flag).await} else {separation::process(core, app, key, &launch.python, &args, flag).await};
        if request.options.variant() == "cosy3-official" && request.options.device != "cpu"
            && !hot.as_ref().is_some_and(|s|s.compatible)
            && first.as_ref().is_err_and(|e| ["TTS_NATIVE_CRASH", "TTS_ENGINE_FAILED"].contains(&e.as_str()))
            && !flag.load(Ordering::Relaxed) {
            jobs::update(core, app, key, |j| {
                j.stage = "ttsCompatibility".into(); j.progress = None;
                j.logs.push("CosyVoice stopped unexpectedly. Retrying once with a compatible CUDA profile on the SAME selected device (FP32, math attention, no cuDNN). No CPU fallback.".into());
            });
            let _ = std::fs::remove_file(&destination);
            let _ = std::fs::remove_file(&result_path);
            let mut compatible = input_value.clone(); compatible["compatibilityMode"] = true.into();
            project::atomic_write(&input, &serde_json::to_vec(&compatible).map_err(io_error)?)?;
            if let Some(session)=hot.as_deref_mut(){session.compatible=true;session.generate(core,app,key,launch,&input,flag).await} else {separation::process(core, app, key, &launch.python, &args, flag).await}
        } else { first }
    })
    .await
    .map_err(|_| "TTS_TIMEOUT".to_owned())
    .and_then(|result| result);
    let _ = std::fs::remove_file(&input);
    let _ = std::fs::remove_file(&ref_temp);
    let _ = std::fs::remove_file(&ref_prepared);
    let _ = std::fs::remove_file(&guide_temp);
    let _ = std::fs::remove_file(&guide_prepared);
    if let Err(error) = result {
        if let Some(session) = hot {
            session.close_logged(core, app, key).await;
        }
        let _ = std::fs::remove_file(destination.with_extension("raw.wav"));
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
        } else if duration == 0 {
            "TTS_EMPTY_AUDIO"
        } else {
            "TTS_OUTPUT_TOO_LONG"
        }
        .into());
    }
    let generation = serde_json::json!({"id":generation_id,"kind":"tts","dialogueId":line.id,"providerId":if request.options.variant()=="cosy3-official"{"cosyvoice3"}else if request.options.variant()=="voxcpm2-bf16"{"voxcpm2"}else if request.options.variant()=="chatterbox-multilingual-v3"{"chatterbox"}else if request.options.variant()=="drama3-comfy-fp8"{"fish-drama3"}else if request.options.variant().starts_with("fish"){"fish-s2"}else{"qwen3-tts"},"modelId":request.options.variant(),"path":format!("generations/{generation_id}.wav"),"createdAt":now(),"sourcePath":p.media.as_ref().map(|m|&m.path),"startMs":line.start_ms,"endMs":line.end_ms,"text":text(&p,line),"language":p.languages.target,"characterId":line.character_id,"durationMs":duration,"sampleRate":24000,"options":request.options,"referenceTranscript":transcript,"qwenRecovery":metadata["qwenRecovery"],"guideAnalysis":metadata["guideAnalysis"],"guideTranscript":if request.options.intonation_guide.is_some(){Some(&guide_transcript)}else{None},"referenceId":if request.options.reference_mode=="current"{None}else{reference(&p,line,&request.options).ok().map(|r|&r.id)},"device":metadata["device"],"deviceName":metadata["deviceName"],"peakVramMb":metadata["peakVramMb"],"expertsInRam":metadata["expertsInRam"],"expertCacheGiB":metadata["expertCacheGiB"],"expertMemoryMode":metadata["expertMemoryMode"],"compatibilityMode":metadata["compatibilityMode"].as_bool().unwrap_or(false),"batchItemId":request.batch_item_id,"inputHash":request.fingerprint});
    let output_edit = request
        .options
        .output_gain
        .filter(|g| *g != 1.0)
        .map(|gain| crate::voice_edit::Edit {
            output_gain: Some(gain),
            pieces: vec![crate::voice_edit::Piece {
                source_start_ms: Some(0),
                source_end_ms: Some(duration),
                duration_ms: duration,
                gain: 1.0,
                envelope: None,
                effects: vec![],
            }],
        });
    if let Some(edit) = &output_edit {
        crate::voice_edit::render(
            &request.root,
            generation["path"].as_str().ok_or("INVALID_GENERATION")?,
            Some(edit),
            &crate::media::binary(app, "ffmpeg")?,
            flag,
        )
        .await?;
    }
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if s.root != request.root || s.project.id != request.project_id {
        return Err("STALE_REVISION".into());
    }
    let unchanged = matches_request(&s.project, request);
    let mut next = s.project.clone();
    next.format_version = next.format_version.max(request.options.required_format());
    next.generations.push(generation);
    if let Some(edit) = output_edit {
        next.voice_edits.insert(generation_id.clone(), edit);
    }
    if let Some(line) = next.dialogues.iter_mut().find(|l| l.id == request.line_id) {
        if unchanged {
            if request.batch_item_id.is_some() {
                line.voice_settings = Some(request.options.clone());
            }
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
    let updated = s.replace_grouped(
        next,
        s.project.revision,
        request.batch_item_id.as_ref().map(|_| key),
    )?;
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
        crate::voice_accent::validate(&settings, g["language"].as_str())?;
        if p.format_version < 9 && settings.requires_v9() {
            return Err("INVALID_GENERATION".into());
        }
        if p.format_version < settings.required_format() {
            return Err("INVALID_GENERATION".into());
        }
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
        if p.format_version < 9
            && line
                .voice_settings
                .as_ref()
                .is_some_and(Options::requires_v9)
        {
            return Err("INVALID_PROJECT".into());
        }
        if line
            .voice_settings
            .as_ref()
            .is_some_and(|v| p.format_version < v.required_format())
        {
            return Err("INVALID_PROJECT".into());
        }
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
