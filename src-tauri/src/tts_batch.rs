use crate::{
    domain::{id, io_error, Dialogue, Project},
    jobs, project, separation, tts, Core,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
#[path = "tts_batch_tests.rs"]
mod tests;
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub scope: String,
    #[serde(default)]
    pub approved_only: bool,
    #[serde(default)]
    pub unapproved_only: bool,
    pub line_ids: Vec<String>,
    pub force: bool,
    pub options: tts::Options,
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
    pub untranslated: usize,
    pub unapproved: usize,
    pub approved: usize,
    pub existing: usize,
    pub ready: Vec<String>,
    pub blocked: Vec<Problem>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub total: usize,
    pub completed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub current_line_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub request: tts::Request,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    #[serde(default)]
    pub approved_only: bool,
    #[serde(default)]
    pub unapproved_only: bool,
    pub project_id: String,
    pub language: String,
    pub items: Vec<Item>,
    pub skipped: usize,
}

fn plain(text: &str) -> String {
    let mut tag = false;
    text.chars()
        .filter(|c| {
            if *c == '<' {
                tag = true;
                false
            } else if *c == '>' && tag {
                tag = false;
                false
            } else {
                !tag
            }
        })
        .collect::<String>()
        .trim()
        .to_owned()
}
pub(crate) fn translated(p: &Project, line: &Dialogue) -> bool {
    p.target_cues
        .iter()
        .any(|c| line.target_cue_ids.contains(&c.id) && !plain(&c.text).is_empty())
}
pub(crate) fn usable(p: &Project, root: &Path, line: &Dialogue) -> bool {
    let Some(key) = line.selected_generation_ids.get(&p.languages.target) else {
        return false;
    };
    let Some(g) = p.generations.iter().find(|g| {
        g["kind"] == "tts"
            && g["id"] == *key
            && g["dialogueId"] == line.id
            && g["language"] == p.languages.target
    }) else {
        return false;
    };
    if g["text"] != tts::text(p, line)
        || g["startMs"] != line.start_ms
        || g["endMs"] != line.end_ms
        || g["characterId"] != serde_json::json!(line.character_id)
        || g["sourcePath"] != serde_json::json!(p.media.as_ref().map(|m| &m.path))
    {
        return false;
    }
    if g["path"]
        .as_str()
        .is_none_or(|path| project::asset(root, path).is_err())
    {
        return false;
    }
    let Ok(options) = serde_json::from_value::<tts::Options>(g["options"].clone()) else {
        return false;
    };
    if options.reference_mode != "current"
        && (options.reference_mode == "file" || g.get("referenceId").is_some())
    {
        let owner = if options.reference_mode == "file" {
            None
        } else {
            line.character_id.as_deref()
        };
        let reference = g["referenceId"]
            .as_str()
            .and_then(|id| p.voice_reference(owner, id));
        if reference.is_none_or(|r| g["referenceTranscript"] != r.transcript) {
            return false;
        }
        if options.reference_mode == "character"
            && p.characters
                .iter()
                .find(|c| Some(&c.id) == line.character_id.as_ref())
                .is_none_or(|c| serde_json::json!(c.default_reference_id) != g["referenceId"])
        {
            return false;
        }
    } else if options.reference_mode == "current" && options.mode == "zeroShot" {
        let original = p
            .source_cues
            .iter()
            .filter(|c| line.source_cue_ids.contains(&c.id))
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if g["referenceTranscript"] != original {
            return false;
        }
    }
    true
}
pub fn plan(
    p: &Project,
    root: &Path,
    selection: &Selection,
) -> Result<(Preview, Vec<Item>), String> {
    selection.options.validate()?;
    if !["all", "selected"].contains(&selection.scope.as_str())
        || (selection.approved_only && selection.unapproved_only)
    {
        return Err("INVALID_TTS_BATCH".into());
    }
    let ids: HashSet<_> = selection.line_ids.iter().collect();
    if selection.scope == "selected"
        && (ids.is_empty()
            || ids
                .iter()
                .any(|id| !p.dialogues.iter().any(|l| &l.id == *id)))
    {
        return Err("INVALID_TTS_BATCH".into());
    }
    let mut preview = Preview {
        requested: 0,
        untranslated: 0,
        unapproved: 0,
        approved: 0,
        existing: 0,
        ready: vec![],
        blocked: vec![],
    };
    let mut items = vec![];
    let mut approved = p.clone();
    approved.clean_translation_approvals();
    for line in &p.dialogues {
        if selection.scope == "selected" && !ids.contains(&line.id) {
            continue;
        }
        preview.requested += 1;
        if !translated(p, line) {
            preview.untranslated += 1;
            continue;
        }
        if selection.approved_only && !approved.translation_approvals.contains_key(&line.id) {
            preview.unapproved += 1;
            continue;
        }
        if selection.unapproved_only && approved.translation_approvals.contains_key(&line.id) {
            preview.approved += 1;
            continue;
        }
        if !selection.force && usable(p, root, line) {
            preview.existing += 1;
            continue;
        }
        match tts::prepare_request(p, root, line.id.clone(), selection.options.clone()) {
            Ok(mut request) => {
                request.batch_item_id = Some(id());
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
pub fn preview(core: &Core, selection: &Selection) -> Result<Preview, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    plan(&s.project, &s.root, selection).map(|(preview, _)| preview)
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    selection: Selection,
) -> Result<String, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !tts::runtime_installed(&core, &selection.options) {
        return Err("TTS_RUNTIME_REQUIRED".into());
    }
    let (request, preview) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let (preview, items) = plan(&s.project, &s.root, &selection)?;
        if items.is_empty() {
            return Err("TTS_BATCH_EMPTY".into());
        }
        (
            Request {
                root: s.root.clone(),
                approved_only: selection.approved_only,
                unapproved_only: selection.unapproved_only,
                project_id: s.project.id.clone(),
                language: s.project.languages.target.clone(),
                items,
                skipped: preview.existing
                    + preview.untranslated
                    + preview.unapproved
                    + preview.approved
                    + preview.blocked.len(),
            },
            preview,
        )
    };
    start(core, app, request, Some(preview))
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
    launch: Option<tts::WorkerLaunch>,
) -> Result<String, String> {
    if request.approved_only && request.unapproved_only {
        return Err("INVALID_TTS_BATCH".into());
    }
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.languages.target != request.language
        {
            return Err("STALE_REVISION".into());
        }
    }
    for item in &mut request.items {
        if item.status != "succeeded" {
            item.status = "pending".into();
            item.error = None;
        }
    }
    start_with_launch(core, app, request, None, launch)
}
fn progress(request: &Request, current: Option<String>) -> Progress {
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
    Progress {
        total: request.items.len(),
        completed: succeeded + failed,
        succeeded,
        failed,
        skipped: request.skipped,
        current_line_id: current,
    }
}
fn persist<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    request: &Request,
    current: Option<String>,
) {
    jobs::update(core, app, key, |j| {
        j.batch = Some(progress(request, current))
    });
}
fn folder(core: &Core, key: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(key).map_err(|_| "INVALID_TTS_BATCH")?;
    Ok(core.data_dir.join("batches").join(key))
}
#[derive(Serialize, Deserialize)]
struct Outcome {
    index: usize,
    status: String,
    error: Option<String>,
}
fn record_item(core: &Core, key: &str, index: usize, item: &Item) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
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
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_data().map_err(io_error)
}
pub fn load(core: &Core, key: &str) -> Result<Request, String> {
    let folder = folder(core, key)?;
    let mut request: Request =
        serde_json::from_slice(&std::fs::read(folder.join("request.json")).map_err(io_error)?)
            .map_err(io_error)?;
    if let Ok(bytes) = std::fs::read(folder.join("results.jsonl")) {
        // Only newline-terminated outcomes are committed; a crashed final write can be ignored.
        for line in bytes
            .split_inclusive(|b| *b == b'\n')
            .filter(|line| line.ends_with(b"\n"))
        {
            let outcome: Outcome = serde_json::from_slice(line).map_err(io_error)?;
            let item = request
                .items
                .get_mut(outcome.index)
                .ok_or("INVALID_TTS_BATCH")?;
            item.status = outcome.status;
            item.error = outcome.error;
        }
    }
    Ok(request)
}
fn already_committed(p: &Project, root: &Path, item: &Item) -> bool {
    p.generations.iter().any(|g| {
        g["kind"] == "tts"
            && g["batchItemId"]
                .as_str()
                .is_some_and(|id| Some(id) == item.request.batch_item_id.as_deref())
            && g["path"]
                .as_str()
                .is_some_and(|path| project::asset(root, path).is_ok())
    })
}
fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
    preview: Option<Preview>,
) -> Result<String, String> {
    start_with_launch(core, app, request, preview, None)
}
fn start_with_launch<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    mut request: Request,
    preview: Option<Preview>,
    launch: Option<tts::WorkerLaunch>,
) -> Result<String, String> {
    let key = jobs::create(&core, &app, "ttsBatch", request.project_id.clone(), None);
    let save = (|| {
        let folder = folder(&core, &key)?;
        std::fs::create_dir_all(&folder).map_err(io_error)?;
        project::atomic_write(
            &folder.join("request.json"),
            &serde_json::to_vec(&request).map_err(io_error)?,
        )
    })();
    if let Err(error) = save {
        separation::finish(&core, &app, &key, &Err(error.clone()));
        return Err(error);
    }
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .tts_batch = Some(key.clone());
    persist(&core, &app, &key, &request, None);
    jobs::update(&core, &app, &key, |j| {
        j.stage = "ttsBatch".into();
        if let Some(p) = preview {
            j.logs.push(format!("Batch: {} ready; {} already dubbed; {} without translation; {} unapproved excluded; {} approved excluded; {} invalid references/options excluded.",p.ready.len(),p.existing,p.untranslated,p.unapproved,p.approved,p.blocked.len()));
            for problem in p.blocked {
                j.logs
                    .push(format!("Excluded {}: {}", problem.line_id, problem.error));
            }
        }
    });
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|j|j.status="running".into());
            let mut hot=crate::tts_session::Session::default();
            let outcome=async {
            for index in 0..request.items.len() {
                if request.items[index].status=="succeeded"{continue;}
                if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
                let committed={let session=core.session.lock().map_err(io_error)?;let s=session.as_ref().ok_or("NO_PROJECT")?;if s.root!=request.root||s.project.id!=request.project_id||s.project.languages.target!=request.language{return Err("STALE_REVISION".into());}already_committed(&s.project,&s.root,&request.items[index])};
                if committed{request.items[index].status="succeeded".into();record_item(&core,&key,index,&request.items[index])?;persist(&core,&app,&key,&request,None);continue;}
                let item=&request.items[index];let line_id=item.request.line_id.clone();
                if request.approved_only || request.unapproved_only {
                    let session=core.session.lock().map_err(io_error)?;let s=session.as_ref().ok_or("NO_PROJECT")?;
                    let mut current=s.project.clone();current.clean_translation_approvals();
                    let approved=current.translation_approvals.contains_key(&line_id);
                    if request.approved_only && !approved { return Err("TTS_BATCH_TRANSLATION_UNAPPROVED".into()); }
                    if request.unapproved_only && approved { return Err("TTS_BATCH_TRANSLATION_APPROVED".into()); }
                }
                persist(&core,&app,&key,&request,Some(line_id.clone()));
                jobs::update(&core,&app,&key,|j|{j.stage="ttsReference".into();j.progress=None;j.logs.push(format!("Dubbing {}/{}: {}",index+1,request.items.len(),line_id));});
                let default_launch;let launch=if let Some(launch)=launch.as_ref(){launch}else{default_launch=tts::worker_launch(&core,&app,&item.request);&default_launch};let result=tts::execute_with_session(&core,&app,&key,&item.request,&flag,launch,Some(&mut hot)).await;
                let item=&mut request.items[index];
                match result {
                    Ok(())=>{item.status="succeeded".into();item.error=None;}
                    Err(error) if error=="CANCELLED"||flag.load(Ordering::Relaxed)=>{persist(&core,&app,&key,&request,None);return Err("CANCELLED".into());}
                    Err(error)=>{item.status="failed".into();item.error=Some(error.clone());jobs::update(&core,&app,&key,|j|j.logs.push(format!("Failed {line_id}: {error}")));}
                }
                record_item(&core,&key,index,&request.items[index])?;
                persist(&core,&app,&key,&request,None);
                if request.items[index].error.as_deref().is_some_and(|e|["TTS_OUT_OF_MEMORY","TTS_SYSTEM_MEMORY","TTS_FP8_MEMORY_REQUIRED","TTS_FP8_CUDA_REQUIRED","MODEL_CHECKSUM_FAILED","TTS_DRAMA_RAM_REQUIRED","TTS_DRAMA_VRAM_REQUIRED","TTS_DRAMA_DISK_REQUIRED","DEVICE_UNAVAILABLE","TTS_RUNTIME_FAILED","TTS_RUNTIME_REQUIRED"].contains(&e)){return Err("TTS_BATCH_PARTIAL".into());}
            }
            if request.items.iter().any(|i|i.status=="failed"){Err("TTS_BATCH_PARTIAL".into())}else{Ok(())}
            }.await; hot.finish(&core,&app,&key).await;outcome
        }.await;
        persist(&core, &app, &key, &request, None);
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}
