//! One frozen selected take per dialogue, one common reference, new immutable
//! takes only. Each outcome is durable; cancellation owns/awaits one private worker.
use crate::{
    domain::{io_error, Project},
    jobs, project, separation, tts, voice_capture as vc, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
#[cfg(test)]
#[path = "voice_batch_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub line_ids: Vec<String>,
    pub reference: vc::Options,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub line_id: String,
    pub source_id: String,
    pub basis: String,
    pub status: String,
    pub error: Option<String>,
    pub generation_id: Option<String>,
    pub origin_index: usize,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
    pub items: Vec<Item>,
    pub origin: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub ready: Vec<String>,
    pub blocked: Vec<Value>,
}
fn configured(o: &Options, id: &str) -> vc::Options {
    let mut v = o.reference.clone();
    v.generation_id = id.into();
    v
}
pub(crate) fn plan(p: &Project, root: &Path, o: &Options) -> Result<(Preview, Vec<Item>), String> {
    o.reference.validate()?;
    if o.line_ids.is_empty()
        || o.line_ids.len() > 50000
        || o.reference.reference_mode.as_deref() == Some("current")
    {
        return Err("INVALID_VOICE_CONVERSION".into());
    }
    let mut ids = HashSet::new();
    for id in &o.line_ids {
        if !p.dialogues.iter().any(|l| l.id == *id) {
            return Err("NO_DIALOGUES".into());
        }
        if let Some(group) = p
            .speaker_dubbings
            .iter()
            .find(|g| g.parent_id == *id && g.active)
        {
            ids.extend(group.voices.iter().map(|v| v.line_id.clone()));
        } else {
            ids.insert(id.clone());
        }
    }
    let mut preview = Preview {
        ready: vec![],
        blocked: vec![],
    };
    let mut items = vec![];
    for line in p.dialogues.iter().filter(|l| ids.contains(&l.id)) {
        let result = (|| {
            if line.excluded_from_dubbing == Some(true) {
                return Err("DIALOGUE_EXCLUDED".into());
            }
            let id = line
                .selected_generation_ids
                .get(&p.languages.target)
                .ok_or("INVALID_GENERATION")?;
            let options = configured(o, id);
            let g = vc::inputs(p, &options)?;
            if g["dialogueId"] != line.id {
                return Err("INVALID_GENERATION".into());
            }
            project::asset(root, g["path"].as_str().ok_or("INVALID_GENERATION")?)?;
            let basis = vc::fingerprint(p, &options)?;
            Ok::<_, String>((id.clone(), basis))
        })();
        match result {
            Ok((id, basis)) => {
                preview.ready.push(line.id.clone());
                items.push(Item {
                    line_id: line.id.clone(),
                    source_id: id,
                    basis,
                    status: "pending".into(),
                    error: None,
                    generation_id: None,
                    origin_index: items.len(),
                });
            }
            Err(error) => preview
                .blocked
                .push(json!({"lineId":line.id,"error":error})),
        }
    }
    Ok((preview, items))
}
pub fn preview(core: &Core, o: &Options) -> Result<Preview, String> {
    let g = core.session.lock().map_err(io_error)?;
    let s = g.as_ref().ok_or("NO_PROJECT")?;
    plan(&s.project, &s.root, o).map(|p| p.0)
}
fn folder(core: &Core, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_JOB")?;
    Ok(core.data_dir.join("voice-batches").join(id))
}
fn load(core: &Core, id: &str) -> Result<Request, String> {
    let dir = folder(core, id)?;
    if std::fs::metadata(dir.join("request.json"))
        .map_err(io_error)?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("INVALID_JOB".into());
    }
    let mut r: Request =
        serde_json::from_slice(&std::fs::read(dir.join("request.json")).map_err(io_error)?)
            .map_err(io_error)?;
    if let Ok(bytes) = std::fs::read(dir.join("results.jsonl")) {
        for line in bytes
            .split_inclusive(|b| *b == b'\n')
            .filter(|b| b.ends_with(b"\n"))
        {
            let (index, item): (usize, Item) = serde_json::from_slice(line).map_err(io_error)?;
            let old = r.items.get_mut(index).ok_or("INVALID_JOB")?;
            if old.source_id != item.source_id || old.line_id != item.line_id {
                return Err("INVALID_JOB".into());
            }
            *old = item;
        }
    }
    Ok(r)
}
fn record(core: &Core, id: &str, index: usize, item: &Item) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder(core, id)?.join("results.jsonl"))
        .map_err(io_error)?;
    let mut bytes = serde_json::to_vec(&(index, item)).map_err(io_error)?;
    bytes.push(b'\n');
    f.write_all(&bytes).map_err(io_error)?;
    f.sync_data().map_err(io_error)
}
fn reconcile(p: &Project, r: &mut Request, root_id: &str) {
    for item in &mut r.items {
        if item.status == "succeeded" {
            continue;
        }
        if let Some(g) = p.generations.iter().rev().find(|g| {
            g["kind"] == "tts"
                && g["voiceConversionBatchRootId"] == root_id
                && g["voiceConversionBatchItemIndex"].as_u64() == Some(item.origin_index as u64)
                && g["takeOrigin"]["sourceGenerationId"] == item.source_id
                && g["path"]
                    .as_str()
                    .is_some_and(|p| project::asset(&r.root, p).is_ok())
        }) {
            item.status = "succeeded".into();
            item.error = None;
            item.generation_id = g["id"].as_str().map(str::to_owned);
        }
    }
}
pub fn report(core: &Core, id: &str, offset: u32, limit: u32) -> Result<Value, String> {
    if limit == 0 || limit > 200 {
        return Err("INVALID_JOB".into());
    }
    let mut r = load(core, id)?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id {
        return Err("STALE_REVISION".into());
    }
    let root = r.origin.clone().unwrap_or_else(|| id.into());
    reconcile(&s.project, &mut r, &root);
    Ok(
        json!({"id":id,"total":r.items.len(),"offset":offset,"items":r.items.iter().skip(offset as usize).take(limit as usize).collect::<Vec<_>>() }),
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
    if !crate::voice_engines::installed(&core, "chatterbox-vc") {
        return Err("TTS_MODEL_REQUIRED".into());
    }
    let r = {
        let g = core.session.lock().map_err(io_error)?;
        let s = g.as_ref().ok_or("NO_PROJECT")?;
        let (_, items) = plan(&s.project, &s.root, &options)?;
        if items.is_empty() {
            return Err("VC_BATCH_EMPTY".into());
        }
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            revision: s.project.revision,
            options,
            items,
            origin: None,
        }
    };
    enqueue(core, app, r, None)
}
pub fn retry<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    id: &str,
    line_ids: &[String],
) -> Result<String, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let mut r = load(&core, id)?;
    let root = r.origin.as_deref().unwrap_or(id).to_owned();
    r = load(&core, &root)?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id {
        return Err("STALE_REVISION".into());
    }
    reconcile(&s.project, &mut r, &root);
    if line_ids.iter().any(|id| {
        !r.items
            .iter()
            .any(|i| i.line_id == *id && i.status != "succeeded")
    }) {
        return Err("INVALID_JOB".into());
    }
    r.items.retain(|i| {
        i.status != "succeeded" && (line_ids.is_empty() || line_ids.contains(&i.line_id))
    });
    if r.items.is_empty() {
        return Err("VC_BATCH_EMPTY".into());
    }
    for i in &mut r.items {
        if vc::fingerprint(&s.project, &configured(&r.options, &i.source_id))? != i.basis {
            return Err("STALE_REVISION".into());
        }
        i.status = "pending".into();
        i.error = None;
        i.generation_id = None;
    }
    r.revision = s.project.revision;
    r.origin = Some(root);
    drop(guard);
    enqueue(core, app, r, None)
}
fn checkpoint<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    id: &str,
    r: &Request,
    current: Option<usize>,
    warm: bool,
) {
    let done = r.items.iter().filter(|i| i.status != "pending").count();
    let failed = r.items.iter().filter(|i| i.status == "failed").count();
    let forecast = core.session.lock().ok().and_then(|g| {
        g.as_ref().map(|s| {
            let mut h = crate::generation_timing::History::new(&s.project);
            let mut f = crate::work_estimate::Forecast::default();
            let mut loaded = warm;
            for (index, item) in r
                .items
                .iter()
                .enumerate()
                .filter(|(_, i)| i.status == "pending")
            {
                if Some(index) == current {
                    f.active = Some(crate::work_estimate::Active {
                        job_id: id.into(),
                        estimated_ms: None,
                        baseline_elapsed_ms: 0,
                    });
                } else {
                    let o = configured(&r.options, &item.source_id);
                    let ms = vc::inputs(&s.project, &o).ok().and_then(|source| {
                        h.predict(&crate::generation_timing::Query::new(
                            "voiceConversion",
                            json!({"options":o,"language":s.project.languages.target}),
                            crate::generation_timing::audio_units(&s.project, source),
                            loaded,
                        ))
                    });
                    f.push(ms);
                }
                loaded = true;
            }
            f
        })
    });
    jobs::update(core, app, id, |j| {
        j.estimate = None;
        j.work_estimate = forecast;
        j.batch = Some(crate::tts_batch::Progress {
            current_index: current,
            take_count: None,
            total: r.items.len(),
            completed: done,
            succeeded: done - failed,
            failed,
            skipped: 0,
            current_line_id: current.map(|i| r.items[i].line_id.clone()),
        });
    });
}
fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    mut r: Request,
    launch: Option<tts::WorkerLaunch>,
) -> Result<String, String> {
    let id = jobs::create(
        &core,
        &app,
        "voiceConversionBatch",
        r.project_id.clone(),
        None,
    );
    let dir = folder(&core, &id)?;
    let saved = (|| {
        std::fs::create_dir_all(&dir).map_err(io_error)?;
        project::atomic_write(
            &dir.join("request.json"),
            &serde_json::to_vec(&r).map_err(io_error)?,
        )
    })();
    if let Err(e) = saved {
        separation::finish(&core, &app, &id, &Err(e.clone()));
        return Err(e);
    }
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&id)
        .ok_or("INVALID_JOB")?
        .saved
        .voice_conversion_batch = Some(id.clone());
    checkpoint(&core, &app, &id, &r, None, false);
    let out = id.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&id).unwrap().cancel.clone();
        let mut hot = crate::tts_session::Session::default();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};
            jobs::update(&core,&app,&id,|j|{j.status="running".into();j.stage="vcPrepare".into();});
            let result=async {
                for index in 0..r.items.len() {
                    if flag.load(Ordering::Relaxed) {return Err("CANCELLED".into());}
                    checkpoint(&core,&app,&id,&r,Some(index),hot.is_loaded());
                    let request=vc::Request {root:r.root.clone(),project_id:r.project_id.clone(),revision:r.revision,batch_origin:Some(r.origin.as_deref().unwrap_or(&id).into()),batch_index:Some(r.items[index].origin_index),options:configured(&r.options,&r.items[index].source_id)};
                    let result=vc::execute_project(&core,&app,&id,&request,&flag,Some(&mut hot),launch.as_ref()).await;
                    match result {
                        Ok(p)=>{r.revision=p.revision;r.items[index].status="succeeded".into();r.items[index].generation_id=p.generations.last().and_then(|g|g["id"].as_str()).map(str::to_owned);},
                        Err(e) if e=="CANCELLED" || flag.load(Ordering::Relaxed)=>return Err("CANCELLED".into()),
                        Err(e)=>{r.items[index].status="failed".into();r.items[index].error=Some(e);}
                    }
                    record(&core,&id,index,&r.items[index])?;
                    if let Some(origin)=&r.origin {record(&core,origin,r.items[index].origin_index,&r.items[index])?;}
                    checkpoint(&core,&app,&id,&r,None,hot.is_loaded());
                    if let Some(e)=r.items[index].error.as_deref() {if ["STALE_REVISION","NO_PROJECT","TTS_OUT_OF_MEMORY","DEVICE_UNAVAILABLE","TTS_MODEL_REQUIRED"].contains(&e) {return Err(e.into());}}
                }
                if r.items.iter().any(|i|i.status=="failed") {Err("VC_BATCH_PARTIAL".into())} else {Ok(())}
            }.await;
            hot.finish(&core,&app,&id).await;result
        }.await;
        hot.close().await;
        checkpoint(&core, &app, &id, &r, None, false);
        separation::finish(&core, &app, &id, &result);
    });
    Ok(out)
}
/// Canonical PCM slicing avoids shell/decoder path issues and never alters the
/// cached edited source WAV. Only the selected 1–20 s reference is copied.
pub(crate) async fn trim_reference(
    source: &Path,
    target: &Path,
    start_ms: u64,
    end_ms: u64,
    flag: &AtomicBool,
) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let frames = crate::audio_files::pcm_frames(source, 1, 24000, "INVALID_REFERENCE_AUDIO")?;
    if end_ms <= start_ms
        || !(1000..=20000).contains(&(end_ms - start_ms))
        || end_ms.checked_mul(24).is_none_or(|end| end > frames)
    {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    // voice_edit::render writes canonical ffmpeg WAV; locate the data chunk,
    // accounting for LIST/JUNK headers instead of assuming a 44-byte header.
    let mut f = std::fs::File::open(source).map_err(io_error)?;
    f.seek(SeekFrom::Start(12)).map_err(io_error)?;
    loop {
        let mut chunk = [0u8; 8];
        f.read_exact(&mut chunk).map_err(io_error)?;
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
        if &chunk[..4] == b"data" {
            break;
        }
        f.seek(SeekFrom::Current((size + (size % 2)) as i64))
            .map_err(io_error)?;
    }
    f.seek(SeekFrom::Current((start_ms * 48) as i64))
        .map_err(io_error)?;
    let size = ((end_ms - start_ms) * 48) as u32;
    let mut bytes = vec![0; size as usize];
    f.read_exact(&mut bytes).map_err(io_error)?;
    let mut out = std::fs::File::create(target).map_err(io_error)?;
    out.write_all(b"RIFF").map_err(io_error)?;
    out.write_all(&(size + 36).to_le_bytes())
        .map_err(io_error)?;
    out.write_all(b"WAVEfmt ").map_err(io_error)?;
    out.write_all(&16u32.to_le_bytes()).map_err(io_error)?;
    out.write_all(&[1, 0, 1, 0]).map_err(io_error)?;
    out.write_all(&24000u32.to_le_bytes()).map_err(io_error)?;
    out.write_all(&48000u32.to_le_bytes()).map_err(io_error)?;
    out.write_all(&[2, 0, 16, 0]).map_err(io_error)?;
    out.write_all(b"data").map_err(io_error)?;
    out.write_all(&size.to_le_bytes()).map_err(io_error)?;
    out.write_all(&bytes).map_err(io_error)
}
