//! Sequential dialogue-owned lip retouches. The source movie is never a target.
use crate::{
    domain::{id, io_error, Project},
    inpaint, jobs, project, separation, tts, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};
use tauri::Emitter;
#[cfg(test)]
#[path = "inpaint_batch_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub face: crate::lips::Region,
    pub end_x: f64,
    pub end_y: f64,
    pub mask: crate::lips::Region,
}
impl Crop {
    pub(crate) fn apply(&self, options: &mut inpaint::Options) {
        options.face = self.face.clone();
        options.end_x = self.end_x;
        options.end_y = self.end_y;
        options.mask = self.mask.clone();
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub scope: String,
    pub line_ids: Vec<String>,
    pub force: bool,
    pub use_saved_crops: bool,
    pub use_common_crop: bool,
    #[serde(default)]
    pub activate: bool,
    #[serde(default)]
    pub crops: BTreeMap<String, Crop>,
    pub options: inpaint::Options,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub line_id: String,
    pub error: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub requested: usize,
    pub undubbed: usize,
    pub existing: usize,
    pub missing_crop: usize,
    pub ready: Vec<String>,
    pub blocked: Vec<Problem>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub request: inpaint::Request,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub activate: bool,
    pub root: PathBuf,
    pub project_id: String,
    pub language: String,
    pub items: Vec<Item>,
    pub skipped: usize,
}

pub fn plan(
    p: &Project,
    root: &Path,
    selection: &Selection,
) -> Result<(Preview, Vec<Item>), String> {
    selection.options.validate()?;
    if !["all", "selected"].contains(&selection.scope.as_str()) {
        return Err("INVALID_INPAINT_BATCH".into());
    }
    let ids: HashSet<_> = selection.line_ids.iter().collect();
    if (selection.scope == "selected" && ids.is_empty())
        || ids
            .iter()
            .copied()
            .chain(selection.crops.keys())
            .any(|id| !p.dialogues.iter().any(|l| &l.id == id))
    {
        return Err("INVALID_INPAINT_BATCH".into());
    }
    let mut preview = Preview {
        requested: 0,
        undubbed: 0,
        existing: 0,
        missing_crop: 0,
        ready: vec![],
        blocked: vec![],
    };
    let edits = inpaint::edits(p)?;
    let clips = crate::mix::clips(p);
    let by_id: std::collections::HashMap<_, _> = clips.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut items = vec![];
    for line in &p.dialogues {
        if line.excluded_from_dubbing == Some(true) {
            continue;
        }
        if selection.scope == "selected" && !ids.contains(&line.id) {
            continue;
        }
        preview.requested += 1;
        let Some(generation) = line.selected_generation_ids.get(&p.languages.target) else {
            preview.undubbed += 1;
            continue;
        };
        if !selection.force
            && edits.iter().any(|e| {
                e.dialogue_id == line.id
                    && inpaint::current_from_clip(
                        p,
                        e,
                        by_id.get(e.generation_id.as_str()).copied(),
                    )
                    && project::asset(root, &e.path).is_ok()
            })
        {
            preview.existing += 1;
            continue;
        }
        let mut options = selection.options.clone();
        options.line_id = line.id.clone();
        options.generation_id = generation.clone();
        if let Some(crop) = selection.crops.get(&line.id) {
            crop.apply(&mut options);
        } else if let Some(saved) = edits.iter().rev().find(|e| {
            selection.use_saved_crops
                && e.dialogue_id == line.id
                && p.media.as_ref().is_some_and(|m| m.path == e.source_path)
        }) {
            Crop {
                face: saved.options.face.clone(),
                end_x: saved.options.end_x,
                end_y: saved.options.end_y,
                mask: saved.options.mask.clone(),
            }
            .apply(&mut options);
        } else if !selection.use_common_crop {
            preview.missing_crop += 1;
            continue;
        }
        let result = (|| {
            options.validate()?;
            let clip = by_id.get(generation.as_str()).ok_or("INVALID_GENERATION")?;
            let fingerprint = inpaint::fingerprint(p, generation, clip)?;
            let g = p
                .generations
                .iter()
                .find(|g| g["kind"] == "tts" && g["id"] == *generation)
                .ok_or("INVALID_GENERATION")?;
            let path = g["path"].as_str().ok_or("INVALID_GENERATION")?;
            project::asset(root, path)?;
            if g["sourcePath"] != serde_json::json!(p.media.as_ref().map(|m| &m.path)) {
                return Err("INPAINT_STALE".into());
            }
            if !(200..=options.max_duration()).contains(&clip.duration_ms()) {
                return Err("INPAINT_WINDOW_INVALID".into());
            }
            Ok(inpaint::Request {
                output_id: Some(id()),
                root: root.to_owned(),
                project_id: p.id.clone(),
                fingerprint,
                options,
            })
        })();
        match result {
            Ok(request) => {
                preview.ready.push(line.id.clone());
                items.push(Item {
                    request,
                    status: "pending".into(),
                    error: None,
                });
            }
            Err(error) => preview.blocked.push(Problem {
                line_id: line.id.clone(),
                error,
            }),
        }
    }
    Ok((preview, items))
}
fn folder(core: &Core, key: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(key).map_err(|_| "INVALID_INPAINT_BATCH")?;
    Ok(core.data_dir.join("lip-batches").join(key))
}
#[derive(Serialize, Deserialize)]
struct Outcome {
    index: usize,
    status: String,
    error: Option<String>,
}
fn record(core: &Core, key: &str, index: usize, item: &Item) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder(core, key)?.join("results.jsonl"))
        .map_err(io_error)?;
    let mut bytes = serde_json::to_vec(&Outcome {
        index,
        status: item.status.clone(),
        error: item.error.clone(),
    })
    .map_err(io_error)?;
    bytes.push(b'\n');
    f.write_all(&bytes).map_err(io_error)?;
    f.sync_data().map_err(io_error)
}
pub fn load(core: &Core, key: &str) -> Result<Request, String> {
    let dir = folder(core, key)?;
    let mut request: Request =
        serde_json::from_slice(&std::fs::read(dir.join("request.json")).map_err(io_error)?)
            .map_err(io_error)?;
    if let Ok(bytes) = std::fs::read(dir.join("results.jsonl")) {
        for line in bytes
            .split_inclusive(|b| *b == b'\n')
            .filter(|s| s.ends_with(b"\n"))
        {
            let row: Outcome = serde_json::from_slice(line).map_err(io_error)?;
            let item = request
                .items
                .get_mut(row.index)
                .ok_or("INVALID_INPAINT_BATCH")?;
            item.status = row.status;
            item.error = row.error;
        }
    }
    Ok(request)
}
fn progress<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    current: Option<String>,
) {
    let succeeded = request
        .items
        .iter()
        .filter(|i| i.status == "succeeded")
        .count();
    let failed = request
        .items
        .iter()
        .filter(|i| i.status == "failed")
        .count();
    jobs::update(core, app, key, |j| {
        j.batch = Some(crate::tts_batch::Progress {
            total: request.items.len(),
            completed: succeeded
                + failed
                + request
                    .items
                    .iter()
                    .filter(|i| i.status == "skipped")
                    .count(),
            succeeded,
            failed,
            skipped: request.skipped
                + request
                    .items
                    .iter()
                    .filter(|i| i.status == "skipped")
                    .count(),
            current_line_id: current,
        })
    });
}
fn activate<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    request: &inpaint::Request,
) -> Result<(), String> {
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.root != request.root || s.project.id != request.project_id {
        return Err("INPAINT_STALE".into());
    }
    let target = request
        .output_id
        .as_deref()
        .ok_or("INVALID_INPAINT_BATCH")?;
    let edits = inpaint::edits(&s.project)?;
    let edit = edits
        .iter()
        .find(|e| e.id == target)
        .ok_or("INPAINT_STALE")?;
    if !inpaint::current(&s.project, edit) {
        return Err("INPAINT_STALE".into());
    }
    if edit.enabled {
        return Ok(());
    }
    let mut next = s.project.clone();
    for e in &edits {
        if e.id == target
            || (e.enabled
                && e.start_ms < edit.start_ms + edit.duration_ms
                && edit.start_ms < e.start_ms + e.duration_ms)
        {
            if let Some(value) = next.generations.iter_mut().find(|g| g["id"] == e.id) {
                value["enabled"] = serde_json::json!(e.id == target);
            }
        }
    }
    let revision = s.project.revision;
    let saved = s.replace(next, revision)?;
    drop(guard);
    app.emit("project-changed", saved).map_err(io_error)
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    selection: Selection,
) -> Result<String, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !inpaint::installed(&core, selection.options.model()) {
        return Err("INPAINT_NOT_INSTALLED".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        let (preview, items) = plan(&s.project, &s.root, &selection)?;
        if items.is_empty() {
            return Err("INPAINT_BATCH_EMPTY".into());
        }
        Request {
            activate: selection.activate,
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            language: s.project.languages.target.clone(),
            items,
            skipped: preview.undubbed
                + preview.existing
                + preview.missing_crop
                + preview.blocked.len(),
        }
    };
    start(core, app, request)
}
pub fn resume<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    resume_with_launch(core, app, request, None)
}
fn resume_with_launch<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    mut request: Request,
    launch: Option<inpaint::WorkerLaunch>,
) -> Result<String, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    for item in &mut request.items {
        if item.status != "succeeded" {
            item.status = "pending".into();
            item.error = None;
        }
    }
    start_with_launch(core, app, request, launch)
}
fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    start_with_launch(core, app, request, None)
}
fn start_with_launch<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    mut request: Request,
    launch: Option<inpaint::WorkerLaunch>,
) -> Result<String, String> {
    {
        let g = core.session.lock().map_err(io_error)?;
        let s = g.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.languages.target != request.language
        {
            return Err("INPAINT_STALE".into());
        }
    }
    let key = jobs::create(
        &core,
        &app,
        "inpaintBatch",
        request.project_id.clone(),
        None,
    );
    let saved = (|| {
        let d = folder(&core, &key)?;
        std::fs::create_dir_all(&d).map_err(io_error)?;
        project::atomic_write(
            &d.join("request.json"),
            &serde_json::to_vec(&request).map_err(io_error)?,
        )
    })();
    if let Err(error) = saved {
        separation::finish(&core, &app, &key, &Err(error.clone()));
        return Err(error);
    }
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_INPAINT_BATCH")?
        .saved
        .inpaint_batch = Some(key.clone());
    progress(&core, &app, &key, &request, None);
    jobs::persist(&core);
    let result_key = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="inpaintBatch".into();j.logs.push("Sequential lip retouches: one private sequence per dialogue; source video unchanged; each worker exits and releases VRAM between items.".into());});
            for index in 0..request.items.len(){
                if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
                if request.items[index].status=="succeeded"{continue;}
                let committed={let guard=core.session.lock().map_err(io_error)?;let s=guard.as_ref().ok_or("NO_PROJECT")?;
                    if s.root!=request.root||s.project.id!=request.project_id||s.project.languages.target!=request.language{return Err("INPAINT_STALE".into());}
                    let target=request.items[index].request.output_id.as_deref().ok_or("INVALID_INPAINT_BATCH")?;
                    inpaint::edits(&s.project)?.iter().any(|e|e.id==target && inpaint::current(&s.project,e) && project::asset(&s.root,&e.path).is_ok())
                };
                let line=request.items[index].request.options.line_id.clone();
                let excluded={let guard=core.session.lock().map_err(io_error)?;let session=guard.as_ref().ok_or("NO_PROJECT")?;session.project.dialogues.iter().any(|l|l.id==line&&l.excluded_from_dubbing==Some(true))};
                if excluded {request.items[index].status="skipped".into();request.items[index].error=None;record(&core,&key,index,&request.items[index])?;progress(&core,&app,&key,&request,None);continue;}

                progress(&core,&app,&key,&request,Some(line.clone()));
                jobs::update(&core,&app,&key,|j|{j.progress=None;j.logs.push(format!("Dialogue {}/{}: {}",index+1,request.items.len(),line));});
                let result: Result<(), String> = async {
                    if !committed {inpaint::render_with_launch(&core,&app,&key,&request.items[index].request,&flag,launch.as_ref()).await?;}
                    if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
                    if request.activate {activate(&core,&app,&request.items[index].request)?;}
                    Ok(())
                }.await;
                match result{
                    Ok(())=>{request.items[index].status="succeeded".into();request.items[index].error=None;}
                    Err(error) if error=="CANCELLED"||flag.load(Ordering::Relaxed)=>return Err("CANCELLED".into()),
                    Err(error)=>{request.items[index].status="failed".into();request.items[index].error=Some(error.clone());jobs::update(&core,&app,&key,|j|j.logs.push(format!("Failed {line}: {error}")));}
                }
                record(&core,&key,index,&request.items[index])?;progress(&core,&app,&key,&request,None);
                if request.items[index].error.as_deref().is_some_and(|e|["INPAINT_GPU_MEMORY","INPAINT_DISK_REQUIRED","INPAINT_RUNTIME_FAILED","INPAINT_NOT_INSTALLED","DEVICE_UNAVAILABLE","MODEL_CHECKSUM_FAILED"].contains(&e)){return Err("INPAINT_BATCH_PARTIAL".into());}
                // Update consumers after each independently committed sequence.
                let _=app.emit("lip-batch-item",&line);
            }
            if request.items.iter().any(|i|i.status=="failed"){Err("INPAINT_BATCH_PARTIAL".into())}else{Ok(())}
        }.await;
        progress(&core, &app, &key, &request, None);
        separation::finish(&core, &app, &key, &result);
    });
    Ok(result_key)
}
