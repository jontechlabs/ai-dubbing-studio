//! MuseTalk 1.5, local CUDA inference and project-owned non-destructive variants.
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
impl Options {
    pub fn validate(&self) -> Result<(), String> {
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
            || e.id.is_empty()
            || e.fingerprint.len() != 64
            || e.path != format!("generations/lips-{}.mp4", e.id)
            || e.options.line_id != e.dialogue_id
            || e.options.generation_id != e.generation_id
            || !(1..=120000).contains(&e.slot_ms)
            || !e.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
            || !(200..=10000).contains(&e.duration_ms)
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
fn signature(
    p: &Project,
    line: &str,
    generation: &str,
) -> Result<(String, crate::mix::Clip), String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
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
    let value = format!(
        "{}|{}|{}|{}|{}|{}",
        media.path,
        p.languages.target,
        generation,
        clip.start_ms(),
        clip.slot_ms,
        clip.exact_duration
    );
    Ok((format!("{:x}", Sha256::digest(value.as_bytes())), clip))
}
pub fn current(p: &Project, e: &Edit) -> bool {
    p.media.as_ref().is_some_and(|m| m.path == e.source_path)
        && p.languages.target == e.language
        && signature(p, &e.dialogue_id, &e.generation_id).is_ok_and(|(s, c)| {
            s == e.fingerprint
                && c.start_ms() == e.start_ms
                && c.duration_ms() / 40 * 40 == e.duration_ms
                && c.slot_ms == e.slot_ms
                && c.exact_duration == e.exact_duration
        })
}
pub fn active(p: &Project) -> Result<Vec<Edit>, String> {
    let selected: Vec<_> = edits(p)?.into_iter().filter(|e| e.enabled).collect();
    if selected.iter().any(|e| !current(p, e)) {
        return Err("INPAINT_STALE".into());
    }
    Ok(selected)
}
pub fn root(core: &Core) -> PathBuf {
    crate::model_storage::root(core).join("musetalk-runtime")
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
fn installed(core: &Core) -> bool {
    root(core).join("ready.json").is_file()
        && separation::python(&root(core)).is_file()
        && root(core).join("model/unet/unet.pth").is_file()
}
pub async fn status<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let ready = installed(&core);
    let permit = core.gate.clone().try_acquire_owned().ok();
    let info = if ready && permit.is_some() {
        separation::probe(
            &separation::python(&root(&core)),
            &[
                separation::resources(&app)
                    .join("musetalk_worker.py")
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
        serde_json::json!({"installed":ready,"sizeBytes":manifest(&app,"musetalk-model.json")?.files.iter().map(|f|f.size).sum::<u64>(),"devices":info["devices"]}),
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
pub fn install<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
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
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="runtime".into();});
            let folder=root(&core);std::fs::create_dir_all(folder.join("python/Lib/site-packages")).map_err(io_error)?;let _=std::fs::remove_file(folder.join("ready.json"));
            let archive=folder.join("python.zip");
            separation::fetch(&core,&app,&key,&["https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip".into()],&archive,("4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",11133606),&flag).await?;
            let target=folder.join("python");let cancel=flag.clone();tauri::async_runtime::spawn_blocking(move||crate::tts::extract(&archive,&target,&cancel)).await.map_err(io_error)??;
            project::atomic_write(&folder.join("python/python312._pth"),b"python312.zip\n.\nLib/site-packages\nimport site\n")?;
            for f in manifest(&app,"musetalk-runtime.json")?.files {
                let mut archive=folder.join("wheels").join(&f.name);
                for shared in [crate::tts::root(&core).join("wheels").join(&f.name),crate::voice_engines::root(&core).join("fish-runtime/wheels").join(&f.name)]{
                    if crate::downloads::cached(&shared,&crate::downloads::Spec{urls:&[],sha256:&f.sha256,size:f.size},&flag).await?{archive=shared;break;}
                }
                fetch(&core,&app,&key,&f,&archive,&flag).await?;
                jobs::update(&core,&app,&key,|j|{j.stage="ttsExtract".into();j.progress=None;j.logs.push(format!("Verified runtime wheel: {}",f.name));});
                let target=folder.join("python/Lib/site-packages");let cancel=flag.clone();tauri::async_runtime::spawn_blocking(move||crate::tts::extract(&archive,&target,&cancel)).await.map_err(io_error)??;
            }
            let model=manifest(&app,"musetalk-model.json")?;
            for f in model.files{jobs::update(&core,&app,&key,|j|{j.stage="inpaintDownload".into();j.logs.push(format!("MuseTalk component: {}",f.name));});fetch(&core,&app,&key,&f,&folder.join("model").join(&f.name),&flag).await?;}
            let info=separation::probe(&separation::python(&folder),&[separation::resources(&app).join("musetalk_worker.py").to_string_lossy().into_owned(),"--info".into()],&flag,Duration::from_secs(90)).await?.ok_or("INPAINT_RUNTIME_FAILED")?;
            if info["runtimeReady"]!=true || info["torchVersion"]!="2.8.0" || info["cudaVersion"]!="12.8" {return Err("INPAINT_RUNTIME_FAILED".into());}
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}project::atomic_write(&folder.join("ready.json"),model.revision.as_bytes())
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
    if !installed(&core) {
        return Err("INPAINT_NOT_INSTALLED".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        let (fingerprint, clip) = signature(&s.project, &options.line_id, &options.generation_id)?;
        if !(200..=10000).contains(&clip.duration_ms()) {
            return Err("INPAINT_WINDOW_INVALID".into());
        }
        Request {
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
    format!("crop=iw*{w}:ih*{h}:'iw*({x}+({dx})*min(t/{seconds},1))':'ih*({y}+({dy})*min(t/{seconds},1))',scale=256:256",w=o.face.width,h=o.face.height,x=o.face.x,y=o.face.y,dx=o.end_x-o.face.x,dy=o.end_y-o.face.y)
}
pub(crate) fn overlay_expression(o: &Options, duration: u64, w: u32, h: u32) -> String {
    let seconds = duration as f64 / 1000.0;
    format!("[1:v]scale={}:{}:flags=lanczos,format=rgba[patch];[0:v][patch]overlay=x='main_w*({}+({})*min(t/{seconds},1))':y='main_h*({}+({})*min(t/{seconds},1))':eof_action=pass:repeatlast=0,format=yuv420p[out]",(o.face.width*w as f64).round() as u32,(o.face.height*h as f64).round() as u32,o.face.x,o.end_x-o.face.x,o.face.y,o.end_y-o.face.y)
}
async fn render<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    flag: &Arc<AtomicBool>,
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
    if !(5..=250).contains(&frames) {
        return Err("INPAINT_WINDOW_INVALID".into());
    }
    let ff = media::binary(app, "ffmpeg")?;
    let model = manifest(app, "musetalk-model.json")?;
    jobs::update(core, app, key, |j| {
        j.stage = "inpaintDevice".into();
        j.progress = None;
    });
    let inventory = separation::probe(
        &separation::python(&root(core)),
        &[
            separation::resources(app)
                .join("musetalk_worker.py")
                .to_string_lossy()
                .into_owned(),
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
            &root(core).join("model").join(&f.name),
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
    let fitted = crate::voice_fit::take_with_duration(
        &request.root,
        &clip.path,
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
    project::atomic_write(&worker_request,&serde_json::to_vec(&serde_json::json!({"device":request.options.device,"modelDirectory":root(core).join("model"),"inputDirectory":input,"outputDirectory":output,"audioPath":audio,"frames":frames,"mask":request.options.mask,"feather":request.options.feather,"blend":request.options.blend,"seed":request.options.seed})).map_err(io_error)?)?;
    tokio::time::timeout(
        Duration::from_secs(7200),
        separation::process(
            core,
            app,
            key,
            &separation::python(&root(core)),
            &[
                separation::resources(app)
                    .join("musetalk_worker.py")
                    .to_string_lossy()
                    .into_owned(),
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
    let id = crate::domain::id();
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
        fingerprint: hash,
        enabled: false,
        options: request.options.clone(),
        created_at: crate::domain::now(),
        model_revision: model.revision,
    };
    let mut next = s.project.clone();
    next.format_version = 8;
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
