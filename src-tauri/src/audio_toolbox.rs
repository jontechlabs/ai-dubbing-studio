//! Review-first separation of a bounded source region. Applying adds reversible
//! timeline layers; the source movie and all previous audio assets stay intact.
use crate::{
    audio_patch,
    domain::{id, io_error, Project},
    jobs, project, separation, voice_engines, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
#[derive(Clone, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub family: String,
    pub files: Vec<voice_engines::File>,
    pub outputs: Vec<String>,
    pub license: String,
    pub source: String,
}
fn models<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Vec<Model>, String> {
    let data: Value = serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("audio-toolbox-models.json"))
            .map_err(io_error)?,
    )
    .map_err(io_error)?;
    serde_json::from_value(data["models"].clone()).map_err(io_error)
}
fn model<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Result<Model, String> {
    models(app)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or("AUDIO_TOOLBOX_OPTIONS".into())
}
fn root(core: &Core) -> PathBuf {
    voice_engines::root(core).join("audio-toolbox")
}
fn runtime(core: &Core) -> PathBuf {
    voice_engines::root(core).join("audio-toolbox-runtime")
}
fn ready(core: &Core, m: &Model) -> bool {
    runtime(core).join("ready.json").is_file()
        && m.files.iter().all(|f| {
            std::fs::metadata(root(core).join(&m.id).join(&f.name)).is_ok_and(|x| x.len() == f.size)
        })
}
fn required(core: &Core, m: &Model) -> u64 {
    let missing = m
        .files
        .iter()
        .filter(|f| {
            !std::fs::metadata(root(core).join(&m.id).join(&f.name))
                .is_ok_and(|v| v.len() == f.size)
        })
        .map(|f| f.size)
        .sum::<u64>();
    missing
        + if runtime(core).join("ready.json").is_file() {
            256 * 1024 * 1024
        } else {
            12 * 1024 * 1024 * 1024
        }
}
pub async fn status<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<Value, String> {
    let folder = root(&core);
    std::fs::create_dir_all(&folder).map_err(io_error)?;
    let available = crate::voice_space::available(&folder).ok();
    let mut devices = vec![json!({"id":"cpu","name":"CPU"})];
    if runtime(&core).join("ready.json").exists() {
        if let Some(info) = separation::probe(
            &separation::python(&runtime(&core)),
            &[
                separation::resources(&app)
                    .join("audio_toolbox_worker.py")
                    .to_string_lossy()
                    .into_owned(),
                "--info".into(),
            ],
            &AtomicBool::new(false),
            Duration::from_secs(30),
        )
        .await?
        {
            devices = info["devices"].as_array().cloned().unwrap_or(devices);
        }
    }
    Ok(
        json!({"availableBytes":available,"models":models(&app)?.iter().map(|m|json!({"id":m.id,"name":m.name,"family":m.family,"installed":ready(&core,m),"modelBytes":m.files.iter().map(|f|f.size).sum::<u64>(),"requiredBytes":required(&core,m),"outputs":m.outputs,"license":m.license,"source":m.source})).collect::<Vec<_>>(),"devices":devices}),
    )
}
pub fn install<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    model_id: String,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("RUNTIME_PLATFORM_UNSUPPORTED".into());
    }
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let m = model(&app, &model_id)?;
    let folder = root(&core).join(&m.id);
    std::fs::create_dir_all(&folder).map_err(io_error)?;
    if crate::voice_space::available(&folder)
        .ok()
        .is_some_and(|free| free < required(&core, &m))
    {
        return Err("AUDIO_TOOLBOX_DISK_REQUIRED".into());
    }
    let key = jobs::create(&core, &app, "toolboxInstall", String::new(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_JOB")?
        .saved
        .toolbox_install = Some(model_id);
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="dependenciesCheck".into();j.progress=None;});
if !runtime(&core).join("ready.json").is_file(){voice_engines::install_python_profile(&core,&app,&key,&flag,"audio-toolbox").await?;project::atomic_write(&runtime(&core).join("ready.json"),b"{\"profile\":\"audio-toolbox-cu128\"}")?;}
for f in &m.files{crate::domain::valid_relative(&f.name)?;let path=folder.join(&f.name);std::fs::create_dir_all(path.parent().ok_or("INVALID_PATH")?).map_err(io_error)?;jobs::update(&core,&app,&key,|j|{j.stage="toolboxModel".into();j.progress=None;j.logs.push(format!("Verified model file: {}",f.name));});separation::fetch(&core,&app,&key,std::slice::from_ref(&f.url),&path,(&f.sha256,f.size),&flag).await?;}Ok(())}.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub model_id: String,
    pub source_track_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub device: String,
    pub prompt: String,
    pub window_seconds: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub source_path: String,
    pub options: Options,
    pub snapshot: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Destination {
    pub output_id: String,
    pub track_id: Option<String>,
    pub role: Option<String>,
}
fn validate(p: &Project, o: &Options, m: &Model) -> Result<(), String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if o.end_ms <= o.start_ms
        || o.end_ms > media.info.duration_ms
        || !(100..=60000).contains(&(o.end_ms - o.start_ms))
        || !(2..=8).contains(&o.window_seconds)
        || o.prompt.chars().count() > 500
        || o.prompt.contains('\0')
    {
        return Err("AUDIO_TOOLBOX_OPTIONS".into());
    }
    if m.family == "audiosep" && o.prompt.trim().is_empty() {
        return Err("AUDIO_TOOLBOX_PROMPT".into());
    }
    if !["auto", "cpu"].contains(&o.device.as_str())
        && !o
            .device
            .strip_prefix("cuda:")
            .is_some_and(|x| !x.is_empty() && x.len() <= 2 && x.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("DEVICE_UNAVAILABLE".into());
    }
    audio_patch::source_track(p, Some(&o.source_track_id))?;
    Ok(())
}
pub fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let m = model(&app, &options.model_id)?;
    if !ready(&core, &m) {
        return Err("AUDIO_TOOLBOX_MODEL_REQUIRED".into());
    }
    let r = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        validate(&s.project, &options, &m)?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            source_path: s.project.media.as_ref().unwrap().path.clone(),
            snapshot: snapshot(&s.project, &s.root, &options)?,
            options,
        }
    };
    enqueue(core, app, r)
}
fn snapshot(p: &Project, root: &Path, o: &Options) -> Result<Value, String> {
    let track = audio_patch::source_track(p, Some(&o.source_track_id))?;
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let path = if track.kind == "original" {
        &media.path
    } else {
        track.path.as_ref().ok_or("INVALID_PATH")?
    };
    let patches = audio_patch::layers(p, &track.id);
    let mut files = vec![crate::source_transcription::stamp(root, path)?];
    for layer in &patches {
        if let Some(path) = &layer.path {
            files.push(crate::source_transcription::stamp(root, path)?);
        }
    }
    Ok(
        json!({"media":media.id,"source":media.path,"stream":media.audio_stream_index,"duration":media.info.duration_ms,"trackId":track.id,"path":path,"regions":track.regions,"enabled":track.regions_enabled,"patches":patches,"files":files}),
    )
}
fn current(core: &Core, r: &Request) -> Result<Project, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root
        || s.project.id != r.project_id
        || s.project
            .media
            .as_ref()
            .is_none_or(|m| m.path != r.source_path)
    {
        return Err("STALE_REVISION".into());
    }
    Ok(s.project.clone())
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    r: Request,
) -> Result<String, String> {
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let p = current(&core, &r)?;
    if snapshot(&p, &r.root, &r.options)? != r.snapshot {
        return Err("STALE_REVISION".into());
    }
    let m = model(&app, &r.options.model_id)?;
    validate(&p, &r.options, &m)?;
    if !ready(&core, &m) {
        return Err("AUDIO_TOOLBOX_MODEL_REQUIRED".into());
    }
    let key = jobs::create(&core, &app, "audioToolbox", r.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_JOB")?
        .saved
        .toolbox_request = Some(r.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};let p=current(&core,&r)?;if snapshot(&p,&r.root,&r.options)?!=r.snapshot{return Err("STALE_REVISION".into());}
jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="toolboxPrepare".into();j.progress=None;});
let temporary=tempfile::tempdir().map_err(io_error)?;let input=temporary.path().join("input.wav");let output=temporary.path().join("output");let result=temporary.path().join("result.json");let request=temporary.path().join("request.json");
audio_patch::snippet(&core,&app,&key,&p,&r.root,audio_patch::Snippet{track_id:&r.options.source_track_id,start_ms:r.options.start_ms,end_ms:r.options.end_ms,channels:2,rate:48000,fader:false},&input,&flag).await?;
project::atomic_write(&request,&serde_json::to_vec(&json!({"modelId":m.id,"modelDir":root(&core).join(&m.id),"runtimeDir":runtime(&core),"inputPath":input,"outputDir":output,"resultPath":result,"device":r.options.device,"prompt":r.options.prompt,"windowSeconds":r.options.window_seconds})).map_err(io_error)?)?;
separation::process(&core,&app,&key,&separation::python(&runtime(&core)),&[separation::resources(&app).join("audio_toolbox_worker.py").to_string_lossy().into_owned(),"--request".into(),request.to_string_lossy().into_owned()],&flag).await?;
let data:Value=serde_json::from_slice(&std::fs::read(&result).map_err(io_error)?).map_err(io_error)?;let rows=data["outputs"].as_array().ok_or("AUDIO_TOOLBOX_INVALID_AUDIO")?;if rows.len()!=m.outputs.len(){return Err("AUDIO_TOOLBOX_INVALID_AUDIO".into());}
project::ensure_directory(&r.root,"cache")?;let parent=project::ensure_directory(&r.root,"cache/audio-toolbox")?;let folder=parent.join(&key);std::fs::create_dir(&folder).map_err(io_error)?;
for role in &m.outputs{if !rows.iter().any(|v|v["id"]==*role&&v["file"]==format!("{role}.wav")){return Err("AUDIO_TOOLBOX_INVALID_AUDIO".into());}let file=output.join(format!("{role}.wav"));if crate::audio_files::wav_frames(&file)?!=(r.options.end_ms-r.options.start_ms)*48{return Err("AUDIO_TOOLBOX_INVALID_AUDIO".into());}std::fs::copy(&file,folder.join(format!("{role}.wav"))).map_err(io_error)?;}
if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}project::atomic_write(&folder.join("result.json"),&serde_json::to_vec(&data).map_err(io_error)?)?;Ok(())}.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
fn request(core: &Core, id: &str) -> Result<Request, String> {
    let guard = core.jobs.lock().map_err(io_error)?;
    let j = guard.get(id).ok_or("INVALID_JOB")?;
    if j.saved.record.status != "succeeded" {
        return Err("AUDIO_TOOLBOX_NOT_READY".into());
    }
    j.saved.toolbox_request.clone().ok_or("INVALID_JOB".into())
}
pub fn result<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<Value, String> {
    let r = request(core, id)?;
    let p = current(core, &r)?;
    let spec = model(app, &r.options.model_id)?;
    let path = project::asset(&r.root, &format!("cache/audio-toolbox/{id}/result.json"))?;
    let data: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(io_error)?).map_err(io_error)?;
    Ok(
        json!({"id":id,"options":r.options,"outputs":spec.outputs,"commonGain":data["commonGain"],"deviceName":data["deviceName"],"stale":snapshot(&p,&r.root,&r.options)?!=r.snapshot,"applied":p.generations.iter().any(|g|g["kind"]=="audioPatch"&&g["operationId"]==id)}),
    )
}
pub fn path<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    id: &str,
    output: &str,
) -> Result<String, String> {
    let r = request(core, id)?;
    current(core, &r)?;
    if !model(app, &r.options.model_id)?
        .outputs
        .iter()
        .any(|v| v == output)
    {
        return Err("AUDIO_TOOLBOX_OPTIONS".into());
    }
    let file = project::asset(&r.root, &format!("cache/audio-toolbox/{id}/{output}.wav"))?;
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(io_error)?;
    Ok(file.to_string_lossy().into_owned())
}
fn silence(path: &Path) -> Result<(), String> {
    let mut b = vec![];
    let frames = 48000u32;
    b.extend(b"RIFF");
    b.extend((36 + frames * 4).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(48000u32.to_le_bytes());
    b.extend(192000u32.to_le_bytes());
    b.extend(4u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend((frames * 4).to_le_bytes());
    b.resize(44 + frames as usize * 4, 0);
    project::atomic_write(path, &b)
}
pub async fn apply<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    key: String,
    destinations: Vec<Destination>,
    mute_source: bool,
) -> Result<Project, String> {
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let r = request(&core, &key)?;
    let p = current(&core, &r)?;
    if snapshot(&p, &r.root, &r.options)? != r.snapshot {
        return Err("STALE_REVISION".into());
    }
    if p.generations
        .iter()
        .any(|g| g["kind"] == "audioPatch" && g["operationId"] == key)
    {
        return Err("AUDIO_TOOLBOX_ALREADY_APPLIED".into());
    }
    let m = model(&app, &r.options.model_id)?;
    if destinations.is_empty() || destinations.len() > m.outputs.len() {
        return Err("AUDIO_TOOLBOX_OPTIONS".into());
    }
    let mut outputs = HashSet::new();
    let mut targets = HashSet::new();
    let mut next = p.clone();
    next.format_version = next.format_version.max(23);
    let tracks = crate::mix::tracks(&p);
    let mut resolved = vec![];
    for d in &destinations {
        if !m.outputs.contains(&d.output_id) || !outputs.insert(&d.output_id) {
            return Err("AUDIO_TOOLBOX_OPTIONS".into());
        }
        let target = if let Some(track) = &d.track_id {
            tracks
                .iter()
                .find(|t| &t.id == track && t.kind == "audio")
                .map(|t| t.id.clone())
                .ok_or("AUDIO_TOOLBOX_OPTIONS")?
        } else {
            let role = d
                .role
                .as_deref()
                .filter(|r| ["speech", "music", "sfx"].contains(r))
                .ok_or("AUDIO_TOOLBOX_OPTIONS")?;
            if let Some(t) = next.tracks.iter().find(|t| {
                t.role.as_deref() == Some(role)
                    && t.source_path.as_deref() == Some(r.source_path.as_str())
            }) {
                t.id.clone()
            } else {
                let track_id = id();
                next.tracks.push(serde_json::from_value(json!({"id":track_id,"kind":"audio","role":role,"language":p.languages.source,"mute":false,"solo":false,"gain":1,"path":format!("stems/patch-{track_id}-base.wav"),"sourcePath":r.source_path,"durationMs":p.media.as_ref().unwrap().info.duration_ms})).map_err(io_error)?);
                track_id
            }
        };
        if !targets.insert(target.clone()) {
            return Err("AUDIO_TOOLBOX_OPTIONS".into());
        }
        resolved.push((d.output_id.clone(), target));
    }
    project::ensure_directory(&r.root, "stems")?;
    for t in &next.tracks {
        if !p.tracks.iter().any(|old| old.id == t.id) {
            silence(&r.root.join(t.path.as_ref().ok_or("INVALID_PATH")?))?;
        }
    }
    for (output, target) in resolved {
        let patch_id = id();
        let rel = format!("stems/patch-{patch_id}.wav");
        let source = project::asset(&r.root, &format!("cache/audio-toolbox/{key}/{output}.wav"))?;
        if crate::audio_files::wav_frames(&source)? != (r.options.end_ms - r.options.start_ms) * 48
        {
            return Err("AUDIO_TOOLBOX_INVALID_AUDIO".into());
        }
        std::fs::copy(source, r.root.join(&rel)).map_err(io_error)?;
        next.generations.push(json!({"kind":"audioPatch","id":patch_id,"operationId":key,"operation":"separation","sourcePath":r.source_path,"sourceTrackId":r.options.source_track_id,"trackId":target,"startMs":r.options.start_ms,"endMs":r.options.end_ms,"mode":"replace","path":rel,"gain":1,"toolboxModel":m.id,"toolboxOutput":output,"prompt":r.options.prompt}));
    }
    if mute_source && !targets.contains(&r.options.source_track_id) {
        next.generations.push(json!({"kind":"audioPatch","id":id(),"operationId":key,"operation":"separation","sourcePath":r.source_path,"sourceTrackId":r.options.source_track_id,"trackId":r.options.source_track_id,"startMs":r.options.start_ms,"endMs":r.options.end_ms,"mode":"silence","path":null,"gain":1}));
    }
    next.validate()?;
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != p.id || s.project.revision != p.revision {
        return Err("STALE_REVISION".into());
    }
    let saved = s.replace(next, p.revision)?;
    app.emit("project-changed", &saved).map_err(io_error)?;
    Ok(saved)
}
