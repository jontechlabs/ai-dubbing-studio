//! Local MuseTalk/LatentSync inference and project-owned non-destructive sequences.
use crate::{
    domain::{io_error, Project},
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference_steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance_scale: Option<f64>,
    pub line_id: String,
    pub generation_id: String,
    pub device: String,
    pub face: crate::lips::Region,
    pub end_x: f64,
    pub end_y: f64,
    pub mask: crate::lips::Region,
    pub feather: f64,
    pub blend: f64,
    pub style: String,
    pub seed: u32,
}
pub const MUSE: &str = "musetalk-15-fp16";
pub fn valid_model(id: &str) -> Result<(), String> {
    if [MUSE, "latentsync-15", "latentsync-16"].contains(&id) {
        Ok(())
    } else {
        Err("INPAINT_MODEL_INVALID".into())
    }
}
impl Options {
    pub fn model(&self) -> &str {
        self.model_id.as_deref().unwrap_or(MUSE)
    }
    pub fn resolution(&self) -> u32 {
        if self.model() == "latentsync-16" {
            512
        } else {
            256
        }
    }
    pub fn max_duration(&self) -> u64 {
        if self.model() == MUSE {
            10000
        } else {
            120000
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        valid_model(self.model())?;
        if self
            .inference_steps
            .is_some_and(|v| !(10..=50).contains(&v))
            || self
                .guidance_scale
                .is_some_and(|v| !v.is_finite() || !(1.0..=3.0).contains(&v))
        {
            return Err("INPAINT_SETTINGS_INVALID".into());
        }
        self.face.validate()?;
        self.mask.validate()?;
        let end = crate::lips::Region {
            x: self.end_x,
            y: self.end_y,
            ..self.face.clone()
        };
        end.validate()?;
        if !self
            .device
            .strip_prefix("cuda:")
            .is_some_and(|n| n.parse::<u8>().is_ok())
        {
            return Err("INPAINT_CUDA_REQUIRED".into());
        }
        if !self.feather.is_finite()
            || !(0.01..=0.45).contains(&self.feather)
            || !self.blend.is_finite()
            || !(0.1..=1.0).contains(&self.blend)
            || !["anime", "live"].contains(&self.style.as_str())
        {
            return Err("INPAINT_MASK_INVALID".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub output_id: Option<String>,
    pub root: PathBuf,
    pub project_id: String,
    pub fingerprint: String,
    pub options: Options,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub kind: String,
    pub id: String,
    pub dialogue_id: String,
    pub generation_id: String,
    pub source_path: String,
    pub language: String,
    pub path: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub slot_ms: u64,
    pub exact_duration: bool,
    pub fingerprint: String,
    #[serde(default)]
    pub voice_edit_key: String,
    pub enabled: bool,
    pub options: Options,
    pub created_at: String,
    pub model_revision: String,
}
pub fn edits(p: &Project) -> Result<Vec<Edit>, String> {
    p.generations
        .iter()
        .filter(|g| g["kind"] == "lipVideo")
        .map(|g| serde_json::from_value(g.clone()).map_err(io_error))
        .collect()
}
pub fn validate(p: &Project) -> Result<(), String> {
    let mut enabled = vec![];
    for e in edits(p)? {
        e.options.validate()?;
        if p.format_version < 8
            || (e.options.model() != MUSE && p.format_version < 13)
            || e.id.is_empty()
            || e.fingerprint.len() != 64
            || e.path != format!("generations/lips-{}.mp4", e.id)
            || e.options.line_id != e.dialogue_id
            || e.options.generation_id != e.generation_id
            || !(1..=120000).contains(&e.slot_ms)
            || !e.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
            || !(200..=e.options.max_duration()).contains(&e.duration_ms)
            || e.start_ms > 86_400_000
            || e.start_ms + e.duration_ms > 86_410_000
            || p.generations.iter().filter(|g| g["id"] == e.id).count() != 1
        {
            return Err("INPAINT_INVALID_VARIANT".into());
        }
        crate::domain::valid_relative(&e.path)?;
        crate::domain::valid_relative(&e.source_path)?;
        if e.enabled {
            enabled.push((e.start_ms, e.start_ms + e.duration_ms));
        }
    }
    enabled.sort_unstable();
    if enabled.windows(2).any(|w| w[0].1 > w[1].0) {
        return Err("INPAINT_OVERLAP".into());
    }
    Ok(())
}
pub(crate) fn signature(
    p: &Project,
    line: &str,
    generation: &str,
) -> Result<(String, crate::mix::Clip), String> {
    let l = p
        .dialogues
        .iter()
        .find(|l| l.id == line)
        .ok_or("NO_DIALOGUES")?;
    if l.selected_generation_ids
        .get(&p.languages.target)
        .map(String::as_str)
        != Some(generation)
    {
        return Err("INPAINT_STALE".into());
    }
    let clip = crate::mix::clips(p)
        .into_iter()
        .find(|c| c.id == generation)
        .ok_or("INVALID_GENERATION")?;
    Ok((fingerprint(p, generation, &clip)?, clip))
}
pub(crate) fn fingerprint(
    p: &Project,
    generation: &str,
    clip: &crate::mix::Clip,
) -> Result<String, String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let mut value = format!(
        "{}|{}|{}|{}|{}|{}",
        media.path,
        p.languages.target,
        generation,
        clip.start_ms(),
        clip.slot_ms,
        clip.exact_duration
    );
    if let Some(edit) = p.voice_edits.get(generation) {
        value.push('|');
        value.push_str(&crate::voice_edit::key(Some(edit)));
    }
    Ok(format!("{:x}", Sha256::digest(value.as_bytes())))
}
pub fn current(p: &Project, e: &Edit) -> bool {
    let clips = crate::mix::clips(p);
    current_from_clip(p, e, clips.iter().find(|c| c.id == e.generation_id))
}
pub(crate) fn current_from_clip(p: &Project, e: &Edit, clip: Option<&crate::mix::Clip>) -> bool {
    p.media.as_ref().is_some_and(|m| m.path == e.source_path)
        && p.languages.target == e.language
        && p.dialogues.iter().any(|l| {
            l.id == e.dialogue_id
                && l.selected_generation_ids.get(&p.languages.target) == Some(&e.generation_id)
        })
        && clip.is_some_and(|c| {
            c.id == e.generation_id
                && fingerprint(p, &e.generation_id, c).is_ok_and(|s| s == e.fingerprint)
                && c.start_ms() == e.start_ms
                && c.duration_ms() / 40 * 40 == e.duration_ms
                && c.slot_ms == e.slot_ms
                && c.exact_duration == e.exact_duration
        })
}
pub fn active(p: &Project) -> Result<Vec<Edit>, String> {
    let selected: Vec<_> = edits(p)?.into_iter().filter(|e| e.enabled).collect();
    let clips = crate::mix::clips(p);
    let by_id: std::collections::HashMap<_, _> = clips.iter().map(|c| (c.id.as_str(), c)).collect();
    if selected
        .iter()
        .any(|e| !current_from_clip(p, e, by_id.get(e.generation_id.as_str()).copied()))
    {
        return Err("INPAINT_STALE".into());
    }
    Ok(selected)
}
pub fn root(core: &Core) -> PathBuf {
    runtime_root(core, MUSE)
}
pub(crate) fn runtime_root(core: &Core, id: &str) -> PathBuf {
    crate::model_storage::root(core).join(if id == MUSE {
        "musetalk-runtime"
    } else {
        "latentsync-runtime"
    })
}
fn worker_name(id: &str) -> &str {
    if id == MUSE {
        "musetalk_worker.py"
    } else {
        "latentsync_worker.py"
    }
}
fn runtime_name(id: &str) -> &str {
    if id == MUSE {
        "musetalk-runtime.json"
    } else {
        "latentsync-runtime.json"
    }
}
fn ready_path(core: &Core, id: &str) -> PathBuf {
    runtime_root(core, id).join(if id == MUSE {
        "ready.json".into()
    } else {
        format!("ready-{id}.json")
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    name: String,
    #[serde(default)]
    url: String,
    size: u64,
    sha256: String,
}
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    revision: String,
    files: Vec<File>,
}
fn manifest<R: tauri::Runtime>(app: &tauri::AppHandle<R>, name: &str) -> Result<Manifest, String> {
    serde_json::from_slice(&std::fs::read(separation::resources(app).join(name)).map_err(io_error)?)
        .map_err(io_error)
}
#[derive(Deserialize)]
struct LatentModels {
    common: Vec<File>,
    variants: std::collections::BTreeMap<String, Manifest>,
}
fn model_manifest<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<Manifest, String> {
    valid_model(id)?;
    if id == MUSE {
        return manifest(app, "musetalk-model.json");
    }
    let mut models: LatentModels = serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("latentsync-model.json"))
            .map_err(io_error)?,
    )
    .map_err(io_error)?;
    let mut variant = models.variants.remove(id).ok_or("INPAINT_MODEL_INVALID")?;
    variant.files.extend(models.common);
    Ok(variant)
}
pub(crate) fn installed(core: &Core, id: &str) -> bool {
    ready_path(core, id).is_file()
        && separation::python(&runtime_root(core, id)).is_file()
        && runtime_root(core, id)
            .join("model")
            .join(if id == MUSE {
                "unet/unet.pth".into()
            } else {
                format!("{id}/unet.pt")
            })
            .is_file()
}
fn complete(path: &Path, size: u64) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == size)
}

pub fn space<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<serde_json::Value, String> {
    valid_model(id)?;
    let folder = runtime_root(core, id);
    let model_bytes = model_manifest(app, id)?
        .files
        .iter()
        .filter(|f| !complete(&folder.join("model").join(&f.name), f.size))
        .map(|f| f.size)
        .sum::<u64>();
    let mut download_bytes = if complete(&folder.join("python.zip"), 11133606) {
        0
    } else {
        11133606
    };
    for f in manifest(app, runtime_name(id))?.files {
        if ![
            folder.join("wheels").join(&f.name),
            crate::tts::root(core).join("wheels").join(&f.name),
            root(core).join("wheels").join(&f.name),
            crate::voice_engines::root(core)
                .join("fish-runtime/wheels")
                .join(&f.name),
        ]
        .iter()
        .any(|p| complete(p, f.size))
        {
            download_bytes += f.size;
        }
    }
    let present = if folder.join("python").is_dir() {
        crate::model_storage::directory_size(&folder.join("python"))
            .ok()
            .filter(|v| !v.partial)
            .map_or(0, |v| v.bytes)
    } else {
        0
    };
    let runtime_bytes = (10_u64 * 1024_u64.pow(3)).saturating_sub(present);
    let required_bytes = model_bytes + download_bytes + runtime_bytes + 2 * 1024_u64.pow(3);
    let available_bytes = crate::voice_space::available(&folder)?;
    Ok(
        serde_json::json!({"path":folder,"requiredBytes":required_bytes,"availableBytes":available_bytes,"enough":available_bytes>=required_bytes}),
    )
}
pub async fn status<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    id: &str,
) -> Result<serde_json::Value, String> {
    valid_model(id)?;
    let ready = installed(&core, id);
    let permit = core.gate.clone().try_acquire_owned().ok();
    let info = if ready && permit.is_some() {
        separation::probe(
            &separation::python(&runtime_root(&core, id)),
            &[
                separation::resources(&app)
                    .join(worker_name(id))
                    .to_string_lossy()
                    .into_owned(),
                "--info".into(),
            ],
            &AtomicBool::new(false),
            Duration::from_secs(90),
        )
        .await?
        .unwrap_or(serde_json::json!({"devices":[]}))
    } else {
        serde_json::json!({"devices":[]})
    };
    Ok(
        serde_json::json!({"modelId":id,"installed":ready,"sizeBytes":model_manifest(&app,id)?.files.iter().map(|f|f.size).sum::<u64>(),"devices":info["devices"],"space":space(&core,&app,id)?}),
    )
}
async fn fetch<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    f: &File,
    path: &Path,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    crate::domain::valid_relative(&f.name)?;
    separation::fetch(
        core,
        app,
        key,
        std::slice::from_ref(&f.url),
        path,
        (&f.sha256, f.size),
        flag,
    )
    .await
}
pub fn install_model<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    model_id: &str,
) -> Result<String, String> {
    valid_model(model_id)?;
    let model_id = model_id.to_owned();
    if !cfg!(windows) {
        return Err("RUNTIME_PLATFORM_UNSUPPORTED".into());
    }
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    let key = jobs::create(&core, &app, "inpaintInstall", String::new(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .inpaint_install = true;
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .inpaint_model = Some(model_id.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="runtime".into();});
            let budget=space(&core,&app,&model_id)?;
            jobs::update(&core,&app,&key,|j|j.logs.push(format!("Disk preflight: available {} bytes, required {} bytes at {}",budget["availableBytes"],budget["requiredBytes"],budget["path"])));
            if budget["enough"] != true { return Err("INPAINT_DISK_REQUIRED".into()); }
            let folder=runtime_root(&core,&model_id);std::fs::create_dir_all(folder.join("python/Lib/site-packages")).map_err(io_error)?;let _=std::fs::remove_file(ready_path(&core,&model_id));
            let archive=folder.join("python.zip");
            separation::fetch(&core,&app,&key,&["https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip".into()],&archive,("4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",11133606),&flag).await?;
            let target=folder.join("python");let cancel=flag.clone();tauri::async_runtime::spawn_blocking(move||crate::tts::extract(&archive,&target,&cancel)).await.map_err(io_error)??;
            project::atomic_write(&folder.join("python/python312._pth"),b"python312.zip\n.\nLib/site-packages\nimport site\n")?;
            for f in manifest(&app,runtime_name(&model_id))?.files {
                let mut archive=folder.join("wheels").join(&f.name);
                for shared in [root(&core).join("wheels").join(&f.name),crate::tts::root(&core).join("wheels").join(&f.name),crate::voice_engines::root(&core).join("fish-runtime/wheels").join(&f.name)]{
                    if crate::downloads::cached(&shared,&crate::downloads::Spec{urls:&[],sha256:&f.sha256,size:f.size},&flag).await?{archive=shared;break;}
                }
                fetch(&core,&app,&key,&f,&archive,&flag).await?;
                jobs::update(&core,&app,&key,|j|{j.stage="ttsExtract".into();j.progress=None;j.logs.push(format!("Verified runtime wheel: {}",f.name));});
                let target=folder.join("python/Lib/site-packages");let cancel=flag.clone();tauri::async_runtime::spawn_blocking(move||crate::tts::extract(&archive,&target,&cancel)).await.map_err(io_error)??;
            }
            let model=model_manifest(&app,&model_id)?;
            for f in model.files{jobs::update(&core,&app,&key,|j|{j.stage="inpaintDownload".into();j.logs.push(format!("{} component: {}",model_id,f.name));});fetch(&core,&app,&key,&f,&folder.join("model").join(&f.name),&flag).await?;}
            let info=separation::probe(&separation::python(&folder),&[separation::resources(&app).join(worker_name(&model_id)).to_string_lossy().into_owned(),"--info".into()],&flag,Duration::from_secs(90)).await?.ok_or("INPAINT_RUNTIME_FAILED")?;
            if info["runtimeReady"]!=true || info["torchVersion"]!="2.8.0" || info["cudaVersion"]!="12.8" || (model_id != MUSE && info["diffusersVersion"]!="0.32.2") {return Err("INPAINT_RUNTIME_FAILED".into());}
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}project::atomic_write(&ready_path(&core,&model_id),model.revision.as_bytes())
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    options.validate()?;
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !installed(&core, options.model()) {
        return Err("INPAINT_NOT_INSTALLED".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        let (fingerprint, clip) = signature(&s.project, &options.line_id, &options.generation_id)?;
        if !(200..=options.max_duration()).contains(&clip.duration_ms()) {
            return Err("INPAINT_WINDOW_INVALID".into());
        }
        Request {
            output_id: None,
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            fingerprint,
            options,
        }
    };
    let key = jobs::create(&core, &app, "inpaint", request.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .inpaint = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
        let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
        jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="inpaintPrepare".into();j.progress=None;});
        render(&core,&app,&key,&request,&flag).await
    }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
pub fn media_path(core: &Core, id: &str) -> Result<String, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    let e = edits(&s.project)?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("INPAINT_INVALID_VARIANT")?;
    project::asset(&s.root, &e.path).map(|p| p.to_string_lossy().into_owned())
}

async fn ffmpeg<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    args: Vec<String>,
    duration: u64,
    flag: &AtomicBool,
) -> Result<(), String> {
    crate::mix::run(
        core,
        app,
        key,
        &media::binary(app, "ffmpeg")?,
        &args,
        duration,
        flag,
    )
    .await
    .map_err(|e| {
        if e == "MKV_EXPORT_FAILED" {
            "INPAINT_FAILED".into()
        } else {
            e
        }
    })
}
pub(crate) fn crop_expression(o: &Options, duration: u64) -> String {
    let seconds = duration as f64 / 1000.0;
    format!("crop=iw*{w}:ih*{h}:'iw*({x}+({dx})*min(t/{seconds},1))':'ih*({y}+({dy})*min(t/{seconds},1))',scale={size}:{size}",size=o.resolution(),w=o.face.width,h=o.face.height,x=o.face.x,y=o.face.y,dx=o.end_x-o.face.x,dy=o.end_y-o.face.y)
}
pub(crate) fn overlay_expression(o: &Options, duration: u64, w: u32, h: u32) -> String {
    let seconds = duration as f64 / 1000.0;
    format!("[1:v]scale={}:{}:flags=lanczos,format=rgba[patch];[0:v][patch]overlay=x='main_w*({}+({})*min(t/{seconds},1))':y='main_h*({}+({})*min(t/{seconds},1))':eof_action=pass:repeatlast=0,format=yuv420p[out]",(o.face.width*w as f64).round() as u32,(o.face.height*h as f64).round() as u32,o.face.x,o.end_x-o.face.x,o.face.y,o.end_y-o.face.y)
}
#[derive(Clone)]
pub(crate) struct WorkerLaunch {
    pub python: PathBuf,
    pub script: PathBuf,
    pub model: PathBuf,
}
pub(crate) async fn render<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    render_with_launch(core, app, key, request, flag, None).await
}
pub(crate) async fn render_with_launch<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &Arc<AtomicBool>,
    launch: Option<&WorkerLaunch>,
) -> Result<(), String> {
    let p = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root || s.project.id != request.project_id {
            return Err("INPAINT_STALE".into());
        }
        s.project.clone()
    };
    let (hash, clip) = signature(&p, &request.options.line_id, &request.options.generation_id)?;
    if hash != request.fingerprint {
        return Err("INPAINT_STALE".into());
    }
    let duration = clip.duration_ms() / 40 * 40;
    let frames = duration / 40;
    if !(5..=request.options.max_duration() / 40).contains(&frames) {
        return Err("INPAINT_WINDOW_INVALID".into());
    }
    #[cfg(windows)]
    {
        // Input/output PNGs are private to this dialogue's temporary directory.
        let pixels = u64::from(request.options.resolution()).pow(2);
        let required = frames * pixels * 8 + 2 * 1024_u64.pow(3);
        if crate::voice_space::available(&request.root)? < required {
            return Err("INPAINT_DISK_REQUIRED".into());
        }
    }
    let ff = media::binary(app, "ffmpeg")?;
    let model_id = request.options.model();
    let folder = runtime_root(core, model_id);
    let model = if launch.is_some() {
        Manifest {
            revision: "protocol-fixture".into(),
            files: vec![],
        }
    } else {
        model_manifest(app, model_id)?
    };
    let launch = launch.cloned().unwrap_or_else(|| WorkerLaunch {
        python: separation::python(&folder),
        script: separation::resources(app).join(worker_name(model_id)),
        model: folder.join("model"),
    });
    jobs::update(core, app, key, |j| {
        j.stage = "inpaintDevice".into();
        j.progress = None;
    });
    let inventory = separation::probe(
        &launch.python,
        &[
            launch.script.to_string_lossy().into_owned(),
            "--info".into(),
        ],
        flag,
        Duration::from_secs(90),
    )
    .await?
    .ok_or("INPAINT_RUNTIME_FAILED")?;
    if !inventory["devices"]
        .as_array()
        .is_some_and(|devices| devices.iter().any(|d| d["id"] == request.options.device))
    {
        return Err("DEVICE_UNAVAILABLE".into());
    }
    jobs::update(core, app, key, |j| {
        j.stage = "ttsVerify".into();
        j.progress = None;
    });
    for f in &model.files {
        if !crate::downloads::cached(
            &folder.join("model").join(&f.name),
            &crate::downloads::Spec {
                urls: &[],
                sha256: &f.sha256,
                size: f.size,
            },
            flag,
        )
        .await?
        {
            return Err("MODEL_CHECKSUM_FAILED".into());
        }
    }
    project::ensure_directory(&request.root, "cache")?;
    project::ensure_directory(&request.root, "generations")?;
    let temporary = tempfile::tempdir_in(request.root.join("cache")).map_err(io_error)?;
    let temp = temporary.path();
    let input = temp.join("input");
    let output = temp.join("output");
    std::fs::create_dir(&input).map_err(io_error)?;
    std::fs::create_dir(&output).map_err(io_error)?;
    let base = temp.join("base.mp4");
    let source = project::asset(
        &request.root,
        &p.media.as_ref().ok_or("MEDIA_MISSING")?.path,
    )?;
    jobs::update(core, app, key, |j| {
        j.stage = "inpaintPrepare".into();
        j.progress = None;
    });
    let seconds = format!("{:.3}", duration as f64 / 1000.0);
    ffmpeg(
        core,
        app,
        key,
        vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-v".into(),
            "warning".into(),
            "-ss".into(),
            format!("{:.3}", clip.start_ms() as f64 / 1000.0),
            "-i".into(),
            source.to_string_lossy().into_owned(),
            "-t".into(),
            seconds.clone(),
            "-an".into(),
            "-vf".into(),
            "setpts=PTS-STARTPTS,fps=25,setsar=1,format=yuv420p".into(),
            "-frames:v".into(),
            frames.to_string(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "fast".into(),
            "-crf".into(),
            "10".into(),
            "-y".into(),
            base.to_string_lossy().into_owned(),
        ],
        duration,
        flag,
    )
    .await?;
    let info = media::probe(app, &base).await?;
    let video = info
        .streams
        .iter()
        .find(|s| s.kind == "video")
        .ok_or("INPAINT_FRAME_INVALID")?;
    let (w, h) = (
        video.width.ok_or("INPAINT_FRAME_INVALID")?,
        video.height.ok_or("INPAINT_FRAME_INVALID")?,
    );
    if request.options.face.width * (w as f64) < 32.0
        || request.options.face.height * (h as f64) < 32.0
    {
        return Err("INPAINT_FACE_TOO_SMALL".into());
    }
    ffmpeg(
        core,
        app,
        key,
        vec![
            "-nostdin".into(),
            "-v".into(),
            "warning".into(),
            "-i".into(),
            base.to_string_lossy().into_owned(),
            "-vf".into(),
            crop_expression(&request.options, duration),
            "-frames:v".into(),
            frames.to_string(),
            "-start_number".into(),
            "0".into(),
            input.join("%06d.png").to_string_lossy().into_owned(),
        ],
        duration,
        flag,
    )
    .await?;
    let edited = crate::voice_edit::render(
        &request.root,
        &clip.path,
        p.voice_edits.get(&clip.id),
        &ff,
        flag,
    )
    .await?;
    let relative = edited
        .strip_prefix(&request.root)
        .map_err(io_error)?
        .to_string_lossy()
        .replace('\\', "/");
    let fitted = crate::voice_fit::take_with_duration(
        &request.root,
        &relative,
        clip.slot_ms,
        clip.exact_duration,
        &ff,
        flag,
    )
    .await?;
    let audio = temp.join("voice.wav");
    ffmpeg(
        core,
        app,
        key,
        vec![
            "-nostdin".into(),
            "-v".into(),
            "warning".into(),
            "-i".into(),
            fitted.to_string_lossy().into_owned(),
            "-af".into(),
            format!("apad,atrim=duration={seconds}"),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "16000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            audio.to_string_lossy().into_owned(),
        ],
        duration,
        flag,
    )
    .await?;
    let worker_request = temp.join("request.json");
    project::atomic_write(&worker_request,&serde_json::to_vec(&serde_json::json!({"device":request.options.device,"modelDirectory":launch.model,"modelId":model_id,"inferenceSteps":request.options.inference_steps.unwrap_or(20),"guidanceScale":request.options.guidance_scale.unwrap_or(1.5),"inputDirectory":input,"outputDirectory":output,"audioPath":audio,"frames":frames,"mask":request.options.mask,"feather":request.options.feather,"blend":request.options.blend,"seed":request.options.seed})).map_err(io_error)?)?;
    tokio::time::timeout(
        Duration::from_secs(7200),
        separation::process(
            core,
            app,
            key,
            &launch.python,
            &[
                launch.script.to_string_lossy().into_owned(),
                "--request".into(),
                worker_request.to_string_lossy().into_owned(),
            ],
            flag,
        ),
    )
    .await
    .map_err(|_| "INPAINT_TIMEOUT")??;
    for n in 0..frames {
        if !output.join(format!("{n:06}.png")).is_file() {
            return Err("INPAINT_FRAME_INVALID".into());
        }
    }
    jobs::update(core, app, key, |j| {
        j.stage = "inpaintCompose".into();
        j.progress = None;
    });
    let rendered = temp.join("result.mp4");
    ffmpeg(
        core,
        app,
        key,
        vec![
            "-nostdin".into(),
            "-v".into(),
            "warning".into(),
            "-i".into(),
            base.to_string_lossy().into_owned(),
            "-framerate".into(),
            "25".into(),
            "-i".into(),
            output.join("%06d.png").to_string_lossy().into_owned(),
            "-filter_complex".into(),
            overlay_expression(&request.options, duration, w, h),
            "-map".into(),
            "[out]".into(),
            "-an".into(),
            "-frames:v".into(),
            frames.to_string(),
            "-c:v".into(),
            "libx264".into(),
            "-crf".into(),
            "16".into(),
            "-movflags".into(),
            "+faststart".into(),
            rendered.to_string_lossy().into_owned(),
        ],
        duration,
        flag,
    )
    .await?;
    let checked = media::probe(app, &rendered).await?;
    if checked.duration_ms.abs_diff(duration) > 80
        || !checked
            .streams
            .iter()
            .any(|s| s.kind == "video" && s.width == Some(w) && s.height == Some(h))
    {
        return Err("INPAINT_FRAME_INVALID".into());
    }
    let id = request.output_id.clone().unwrap_or_else(crate::domain::id);
    uuid::Uuid::parse_str(&id).map_err(|_| "INPAINT_INVALID_VARIANT")?;
    let path = format!("generations/lips-{id}.mp4");
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if s.root != request.root
        || s.project.id != request.project_id
        || signature(
            &s.project,
            &request.options.line_id,
            &request.options.generation_id,
        )?
        .0 != hash
        || flag.load(Ordering::Relaxed)
    {
        return Err(if flag.load(Ordering::Relaxed) {
            "CANCELLED"
        } else {
            "INPAINT_STALE"
        }
        .into());
    }
    if s.project.generations.iter().any(|g| g["id"] == id) {
        return Err("INPAINT_STALE".into());
    }
    std::fs::rename(&rendered, s.root.join(&path)).map_err(io_error)?;
    let destination = s.root.join(&path);
    let edit = Edit {
        kind: "lipVideo".into(),
        id,
        dialogue_id: request.options.line_id.clone(),
        generation_id: request.options.generation_id.clone(),
        source_path: p.media.as_ref().unwrap().path.clone(),
        language: p.languages.target,
        path,
        start_ms: clip.start_ms(),
        duration_ms: duration,
        slot_ms: clip.slot_ms,
        exact_duration: clip.exact_duration,
        voice_edit_key: crate::voice_edit::key(p.voice_edits.get(&clip.id)),
        fingerprint: hash,
        enabled: false,
        options: request.options.clone(),
        created_at: crate::domain::now(),
        model_revision: model.revision,
    };
    let mut next = s.project.clone();
    next.format_version = next
        .format_version
        .max(if model_id == MUSE { 8 } else { 13 });
    next.generations
        .push(serde_json::to_value(edit).map_err(io_error)?);
    let revision = s.project.revision;
    let saved = match s.replace(next, revision) {
        Ok(saved) => saved,
        Err(e) => {
            let _ = std::fs::remove_file(destination);
            return Err(e);
        }
    };
    drop(session);
    app.emit("project-changed", saved).map_err(io_error)?;
    Ok(())
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    fn options() -> Options {
        serde_json::from_value(serde_json::json!({"lineId":"line","generationId":"take","device":"cuda:1","face":{"x":0.1,"y":0.1,"width":0.7,"height":0.8},"endX":0.1,"endY":0.1,"mask":{"x":0.2,"y":0.55,"width":0.6,"height":0.4},"feather":0.12,"blend":1,"style":"live","seed":0})).unwrap()
    }
    #[test]
    fn legacy_defaults_and_latent_profile_limits_are_validated() {
        let mut o = options();
        assert_eq!(o.model(), MUSE);
        assert_eq!((o.resolution(), o.max_duration()), (256, 10000));
        o.validate().unwrap();
        for (id, resolution) in [("latentsync-15", 256), ("latentsync-16", 512)] {
            o.model_id = Some(id.into());
            assert_eq!((o.resolution(), o.max_duration()), (resolution, 120000));
            o.validate().unwrap();
        }
        o.inference_steps = Some(9);
        assert_eq!(o.validate().unwrap_err(), "INPAINT_SETTINGS_INVALID");
        o.inference_steps = Some(50);
        o.guidance_scale = Some(f64::NAN);
        assert!(o.validate().is_err());
        o.guidance_scale = Some(3.0);
        o.validate().unwrap();
        o.model_id = Some("../model".into());
        assert_eq!(o.validate().unwrap_err(), "INPAINT_MODEL_INVALID");
    }
    #[test]
    fn latent_manifest_has_distinct_pinned_weights_and_shared_components() {
        let models: LatentModels =
            serde_json::from_str(include_str!("../../workers/latentsync-model.json")).unwrap();
        assert_eq!(models.common.len(), 5);
        assert_eq!(models.variants.len(), 2);
        let a = &models.variants["latentsync-15"].files[0];
        let b = &models.variants["latentsync-16"].files[0];
        assert_ne!(a.sha256, b.sha256);
        assert_ne!(a.name, b.name);
        for f in models.common.iter().chain([a, b]) {
            crate::domain::valid_relative(&f.name).unwrap();
            assert_eq!(f.sha256.len(), 64);
            assert!(f.url.starts_with("https://huggingface.co/"));
            assert!(f.size > 0);
        }
    }
}
