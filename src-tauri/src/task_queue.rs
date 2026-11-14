//! Durable, explicit FIFO workflows. Child jobs own the GPU gate; the queue never
//! holds it while awaiting a child. Nothing executes automatically after restart.
use crate::{
    audio_toolbox,
    domain::{id, io_error, now, Project},
    project, tts, tts_batch, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Separation {
    pub model_id: String,
    pub source_track_id: String,
    pub device: String,
    pub window_seconds: u32,
    pub vocals: bool,
    pub music: bool,
    pub mute_source: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub name: String,
    pub selection: tts_batch::Selection,
    pub separation: Option<Separation>,
    pub dubbing: bool,
    pub continue_on_error: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub line_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: String,
    pub job_id: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DubRun {
    pub id: String,
    pub line_ids: Vec<String>,
    pub job_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub created_at: String,
    pub project_id: String,
    pub project_name: String,
    pub root: PathBuf,
    pub basis: Value,
    pub spec: Spec,
    pub status: String,
    pub stage: String,
    pub error: Option<String>,
    pub rows: Vec<Row>,
    pub dubbing_runs: Vec<DubRun>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    #[serde(default)]
    pub revision: u64,
    pub paused: bool,
    pub entries: Vec<Entry>,
    pub warning: Option<String>,
}
pub struct State {
    data: Queue,
    worker: bool,
    active: Option<String>,
    cancel: Arc<AtomicBool>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            data: Queue::default(),
            worker: false,
            active: None,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}
const MAX_BYTES: u64 = 32 * 1024 * 1024;
pub fn restore(folder: &std::path::Path) -> State {
    let mut state = State::default();
    let file = folder.join("task-queue.json");
    if !file.exists() {
        return state;
    }
    let read = || -> Result<Queue, String> {
        if std::fs::metadata(&file).map_err(io_error)?.len() > MAX_BYTES {
            return Err("QUEUE_LIMIT".into());
        }
        let q: Queue =
            serde_json::from_slice(&std::fs::read(&file).map_err(io_error)?).map_err(io_error)?;
        if q.entries.len() > 200 {
            return Err("QUEUE_LIMIT".into());
        }
        Ok(q)
    };
    match read() {
        Ok(mut q) => {
            q.paused = true;
            for e in &mut q.entries {
                if e.status == "running" {
                    e.status = "interrupted".into();
                    e.error = Some("QUEUE_RESTARTED".into());
                }
            }
            state.data = q;
        }
        Err(_) => {
            state.data.paused = true;
            state.data.warning = Some("QUEUE_CORRUPT".into());
        }
    }
    state
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub project_id: String,
    pub project_name: String,
    pub status: String,
    pub stage: String,
    pub error: Option<String>,
    pub separation: bool,
    pub dubbing: bool,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub current_line_id: Option<String>,
    pub current_job_id: Option<String>,
    pub problems: Vec<Value>,
    pub batch_ids: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub revision: u64,
    pub paused: bool,
    pub warning: Option<String>,
    pub entries: Vec<Summary>,
}
pub fn status(core: &Core) -> Result<View, String> {
    let state = core.queue.lock().map_err(io_error)?;
    Ok(View {
        revision: state.data.revision,
        paused: state.data.paused,
        warning: state.data.warning.clone(),
        entries: state
            .data
            .entries
            .iter()
            .map(|e| {
                let row = e.rows.iter().find(|r| r.status == "running");
                let dub = e.dubbing_runs.iter().rev().find(|r| r.status == "running");
                Summary {
                    id: e.id.clone(),
                    name: e.spec.name.clone(),
                    created_at: e.created_at.clone(),
                    project_id: e.project_id.clone(),
                    project_name: e.project_name.clone(),
                    status: e.status.clone(),
                    stage: e.stage.clone(),
                    error: e.error.clone(),
                    separation: e.spec.separation.is_some(),
                    dubbing: e.spec.dubbing,
                    total: e.rows.len(),
                    completed: e.rows.iter().filter(|r| r.status == "succeeded").count(),
                    failed: e.rows.iter().filter(|r| r.status == "failed").count()
                        + e.dubbing_runs
                            .iter()
                            .filter(|r| r.status == "failed")
                            .count(),
                    current_line_id: if e.stage == "separation" {
                        row.map(|r| r.line_id.clone())
                    } else {
                        None
                    },
                    current_job_id: if e.stage == "separation" {
                        row.and_then(|r| r.job_id.clone())
                    } else {
                        dub.and_then(|r| r.job_id.clone())
                    },
                    problems: e
                        .rows
                        .iter()
                        .filter(|r| r.error.is_some())
                        .take(20)
                        .map(|r| json!({"lineId":r.line_id,"error":r.error}))
                        .chain(
                            e.dubbing_runs
                                .iter()
                                .filter(|r| r.error.is_some())
                                .take(20)
                                .map(|r| json!({"jobId":r.job_id,"error":r.error})),
                        )
                        .collect(),
                    batch_ids: e
                        .dubbing_runs
                        .iter()
                        .filter_map(|r| r.job_id.clone())
                        .collect(),
                }
            })
            .collect(),
    })
}
pub fn details(core: &Core, key: &str, offset: u32, limit: u32) -> Result<Value, String> {
    if limit == 0 || limit > 200 {
        return Err("QUEUE_OPTIONS".into());
    }
    let mut e = entry(core, key)?;
    e.spec.selection.line_ids = e
        .rows
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|r| r.line_id.clone())
        .collect();
    Ok(
        json!({"id":e.id,"total":e.rows.len(),"offset":offset,"spec":e.spec,"rows":e.rows.iter().skip(offset as usize).take(limit as usize).collect::<Vec<_>>(),"dubbingRuns":e.dubbing_runs.iter().map(|r|json!({"id":r.id,"jobId":r.job_id,"lineCount":r.line_ids.len(),"status":r.status,"error":r.error})).collect::<Vec<_>>()}),
    )
}
pub fn active(core: &Core) -> bool {
    core.queue.lock().is_ok_and(|q| q.active.is_some())
}
fn change<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    edit: impl FnOnce(&mut Queue) -> Result<(), String>,
) -> Result<(), String> {
    change_state(core, app, |_, q| edit(q))
}
fn change_state<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    edit: impl FnOnce(&mut State, &mut Queue) -> Result<(), String>,
) -> Result<(), String> {
    {
        let mut s = core.queue.lock().map_err(io_error)?;
        let mut next = s.data.clone();
        edit(&mut s, &mut next)?;
        next.revision = next.revision.checked_add(1).ok_or("QUEUE_LIMIT")?;
        let bytes = serde_json::to_vec(&next).map_err(io_error)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("QUEUE_LIMIT".into());
        }
        project::atomic_write(&core.data_dir.join("task-queue.json"), &bytes)?;
        s.data = next;
    }
    let _ = app.emit("task-queue-changed", &status(core)?);
    Ok(())
}
fn update<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    edit: impl FnOnce(&mut Entry),
) -> Result<(), String> {
    change(core, app, |q| {
        let e = q
            .entries
            .iter_mut()
            .find(|e| e.id == key)
            .ok_or("INVALID_JOB")?;
        edit(e);
        Ok(())
    })
}
fn entry(core: &Core, key: &str) -> Result<Entry, String> {
    core.queue
        .lock()
        .map_err(io_error)?
        .data
        .entries
        .iter()
        .find(|e| e.id == key)
        .cloned()
        .ok_or("INVALID_JOB".into())
}
fn current(core: &Core, e: &Entry) -> Result<Project, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != e.root || s.project.id != e.project_id {
        return Err("STALE_REVISION".into());
    }
    Ok(s.project.clone())
}
fn basis(p: &Project, root: &std::path::Path, spec: &Spec) -> Result<Value, String> {
    let ids = &spec.selection.line_ids;
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let mut selected: HashSet<_> = ids.iter().cloned().collect();
    for g in p
        .speaker_dubbings
        .iter()
        .filter(|g| g.active && ids.contains(&g.parent_id))
    {
        selected.extend(g.voices.iter().map(|v| v.line_id.clone()));
    }
    let chars: HashSet<_> = p
        .dialogues
        .iter()
        .filter(|l| selected.contains(&l.id))
        .filter_map(|l| l.character_id.clone())
        .collect();
    let lines:Vec<_>=p.dialogues.iter().filter(|l|selected.contains(&l.id)).map(|l|json!({"id":l.id,"startMs":l.start_ms,"endMs":l.end_ms,"excluded":l.excluded_from_dubbing,"characterId":l.character_id,"ttsText":l.tts_text,"source":crate::speaker_dubbing::text(p,l,true),"target":crate::speaker_dubbing::text(p,l,false)})).collect();
    let options = &spec.selection.options;
    let references:Vec<_>=p.voice_references.iter().filter(|r|spec.dubbing&&options.reference_mode=="file"&&options.reference_id.as_deref()==Some(&r.id)).map(|r|json!({"reference":r,"stamp":crate::source_transcription::stamp(root,&r.path).ok()})).collect();
    let profiles = p
        .character_profiles
        .iter()
        .filter(|(key, _)| {
            spec.dubbing && options.reference_mode == "library" && chars.contains(*key)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let groups: Vec<_> = p
        .speaker_dubbings
        .iter()
        .filter(|g| {
            selected.contains(&g.parent_id)
                || g.voices.iter().any(|v| selected.contains(&v.line_id))
        })
        .collect();
    Ok(
        json!({"media":media,"stamp":crate::source_transcription::stamp(root,&media.path)?,"languages":p.languages,"lines":lines,"characters":p.characters.iter().filter(|c|chars.contains(&c.id)).collect::<Vec<_>>(),"references":references,"profiles":profiles,"pronunciation":p.pronunciation,"groups":groups}),
    )
}
fn checked(core: &Core, e: &Entry) -> Result<Project, String> {
    let p = current(core, e)?;
    if basis(&p, &e.root, &e.spec)? != e.basis {
        return Err("STALE_REVISION".into());
    }
    Ok(p)
}
fn capture(p: &Project, root: PathBuf, mut spec: Spec) -> Result<Entry, String> {
    if spec.name.trim().is_empty()
        || spec.name.chars().count() > 120
        || spec.name.contains('\0')
        || (!spec.dubbing && spec.separation.is_none())
        || !["all", "selected"].contains(&spec.selection.scope.as_str())
        || (spec.selection.approved_only && spec.selection.unapproved_only)
    {
        return Err("QUEUE_OPTIONS".into());
    }
    if spec.dubbing {
        spec.selection.options.validate()?;
        crate::tts_trials::count(spec.selection.take_count)?;
    }
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let requested: HashSet<_> = spec.selection.line_ids.iter().collect();
    if spec.selection.scope == "selected"
        && (requested.is_empty()
            || requested
                .iter()
                .any(|id| !p.dialogues.iter().any(|l| &l.id == *id)))
    {
        return Err("QUEUE_OPTIONS".into());
    }
    let children: HashSet<_> = p
        .speaker_dubbings
        .iter()
        .filter(|g| g.active)
        .flat_map(|g| g.voices.iter().map(|v| &v.line_id))
        .collect();
    let mut review = p.clone();
    review.clean_translation_approvals();
    let lines: Vec<_> = p
        .dialogues
        .iter()
        .filter(|l| {
            !l.excluded_from_dubbing.unwrap_or(false)
                && (if spec.selection.scope == "selected" {
                    requested.contains(&l.id)
                } else {
                    !children.contains(&l.id)
                })
                && (!spec.selection.approved_only
                    || review.translation_approvals.contains_key(&l.id))
                && (!spec.selection.unapproved_only
                    || !review.translation_approvals.contains_key(&l.id))
        })
        .collect();
    if lines.is_empty() || lines.len() > 50000 {
        return Err("QUEUE_EMPTY".into());
    }
    if let Some(sep) = &spec.separation {
        if !["mel-band-roformer-kim", "bs-roformer-viperx-1297"].contains(&sep.model_id.as_str())
            || (!sep.vocals && !sep.music)
            || (spec.dubbing && !sep.vocals)
            || !(2..=8).contains(&sep.window_seconds)
        {
            return Err("QUEUE_OPTIONS".into());
        }
        crate::audio_patch::source_track(p, Some(&sep.source_track_id))?;
        if !["auto", "cpu"].contains(&sep.device.as_str())
            && !sep.device.strip_prefix("cuda:").is_some_and(|x| {
                !x.is_empty() && x.len() <= 2 && x.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return Err("DEVICE_UNAVAILABLE".into());
        }
        if lines.iter().any(|l| {
            l.end_ms > media.info.duration_ms
                || l.end_ms <= l.start_ms
                || !(100..=60000).contains(&(l.end_ms - l.start_ms))
        }) {
            return Err("QUEUE_RANGE".into());
        }
    }
    spec.selection.scope = "selected".into();
    spec.selection.line_ids = lines.iter().map(|l| l.id.clone()).collect();
    Ok(Entry {
        id: id(),
        created_at: now(),
        project_id: p.id.clone(),
        project_name: p.name.clone(),
        basis: basis(p, &root, &spec)?,
        root,
        rows: lines
            .iter()
            .map(|l| Row {
                line_id: l.id.clone(),
                start_ms: l.start_ms,
                end_ms: l.end_ms,
                status: "pending".into(),
                job_id: None,
                error: None,
            })
            .collect(),
        spec,
        status: "pending".into(),
        stage: "waiting".into(),
        error: None,
        dubbing_runs: vec![],
    })
}
pub fn add<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    project_id: String,
    expected_revision: u64,
    spec: Spec,
) -> Result<String, String> {
    let e = {
        let g = core.session.lock().map_err(io_error)?;
        let s = g.as_ref().ok_or("NO_PROJECT")?;
        if s.project.id != project_id || s.project.revision != expected_revision {
            return Err("STALE_REVISION".into());
        }
        capture(&s.project, s.root.clone(), spec)?
    };
    let key = e.id.clone();
    change(&core, &app, |q| {
        if q.warning.is_some() {
            return Err("QUEUE_CORRUPT".into());
        }
        if q.entries.len() >= 200 {
            return Err("QUEUE_LIMIT".into());
        }
        q.entries.push(e);
        Ok(())
    })?;
    kick(core, app);
    Ok(key)
}
pub fn control<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    action: &str,
    key: Option<&str>,
) -> Result<View, String> {
    change_state(&core, &app, |state, q| {
        let active = state.active.clone();
        if action == "cancel" && active.as_deref() == key {
            state.cancel.store(true, Ordering::Relaxed);
        }
        match action {
            "pause" => q.paused = true,
            "resume" => {
                if q.warning.is_some() {
                    return Err("QUEUE_CORRUPT".into());
                }
                q.paused = false;
            }
            "clear" => {
                if q.warning.is_some() {
                    let source = core.data_dir.join("task-queue.json");
                    if source.is_file() {
                        std::fs::rename(
                            &source,
                            core.data_dir
                                .join(format!("task-queue-invalid-{}.json", id())),
                        )
                        .map_err(io_error)?;
                    }
                    q.warning = None;
                    q.paused = true;
                }
                q.entries
                    .retain(|e| e.status == "pending" || active.as_deref() == Some(&e.id));
            }
            "cancel" | "remove" | "retry" | "up" | "down" => {
                let index = q
                    .entries
                    .iter()
                    .position(|e| Some(e.id.as_str()) == key)
                    .ok_or("INVALID_JOB")?;
                let e = &q.entries[index];
                let is_active = active.as_deref() == Some(e.id.as_str());
                match action {
                    "cancel" => {
                        if !["pending", "running"].contains(&e.status.as_str()) {
                            return Err("QUEUE_OPTIONS".into());
                        }
                        if is_active {
                            q.entries[index].stage = "cancelling".into();
                        } else {
                            q.entries[index].status = "cancelled".into();
                        }
                    }
                    "remove" => {
                        if is_active {
                            return Err("BUSY".into());
                        }
                        q.entries.remove(index);
                    }
                    "retry" => {
                        if is_active
                            || !["failed", "partial", "cancelled", "interrupted"]
                                .contains(&e.status.as_str())
                        {
                            return Err("QUEUE_OPTIONS".into());
                        }
                        let e = &mut q.entries[index];
                        e.status = "pending".into();
                        e.error = None;
                        for row in &mut e.rows {
                            if row.status != "succeeded" {
                                row.status = "pending".into();
                                row.error = None;
                            }
                        }
                    }
                    _ => {
                        if is_active || e.status != "pending" {
                            return Err("QUEUE_OPTIONS".into());
                        }
                        let other = if action == "up" {
                            (0..index).rev().find(|i| q.entries[*i].status == "pending")
                        } else {
                            (index + 1..q.entries.len()).find(|i| q.entries[*i].status == "pending")
                        };
                        if let Some(other) = other {
                            q.entries.swap(index, other);
                        }
                    }
                }
            }
            _ => return Err("QUEUE_OPTIONS".into()),
        }
        Ok(())
    })?;
    kick(core.clone(), app);
    status(&core)
}
// Private executor interface permits deterministic FIFO/cancellation/restart
// regression checks without downloading or claiming to test neural models.
trait Engine: Clone + Send + Sync + 'static {
    fn separate(
        &self,
        e: &Entry,
        row: &Row,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
    fn apply(
        &self,
        e: &Entry,
        job: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn dub(
        &self,
        e: &Entry,
        run: &DubRun,
    ) -> impl std::future::Future<Output = Result<Option<String>, String>> + Send;
    fn wait(
        &self,
        e: &Entry,
        job: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}
struct Native<R: tauri::Runtime> {
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
}
impl<R: tauri::Runtime> Clone for Native<R> {
    fn clone(&self) -> Self {
        Self {
            core: self.core.clone(),
            app: self.app.clone(),
        }
    }
}
fn flag(core: &Core, key: &str) -> Result<Arc<AtomicBool>, String> {
    let q = core.queue.lock().map_err(io_error)?;
    if q.active.as_deref() != Some(key) {
        return Err("CANCELLED".into());
    }
    Ok(q.cancel.clone())
}
async fn idle(core: &Core, cancel: &AtomicBool) -> Result<(), String> {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        if !tts::busy(core) && core.gate.available_permits() > 0 {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
impl<R: tauri::Runtime> Engine for Native<R> {
    async fn separate(&self, e: &Entry, row: &Row) -> Result<String, String> {
        let cancel = flag(&self.core, &e.id)?;
        idle(&self.core, &cancel).await?;
        if let Some(job) = &row.job_id {
            let succeeded = self
                .core
                .jobs
                .lock()
                .map_err(io_error)?
                .get(job)
                .is_some_and(|j| j.saved.record.status == "succeeded");
            if succeeded {
                let p = checked(&self.core, e)?;
                if p.generations
                    .iter()
                    .any(|g| g["kind"] == "audioPatch" && g["operationId"] == *job)
                    || audio_toolbox::result(&self.core, &self.app, job)
                        .is_ok_and(|r| r["stale"] == false)
                {
                    return Ok(job.clone());
                }
            }
        }
        checked(&self.core, e)?;
        let s = e.spec.separation.as_ref().ok_or("QUEUE_OPTIONS")?;
        audio_toolbox::start(
            self.core.clone(),
            self.app.clone(),
            audio_toolbox::Options {
                model_id: s.model_id.clone(),
                source_track_id: s.source_track_id.clone(),
                start_ms: row.start_ms,
                end_ms: row.end_ms,
                device: s.device.clone(),
                prompt: String::new(),
                window_seconds: s.window_seconds,
            },
        )
    }
    async fn apply(&self, e: &Entry, job: &str) -> Result<(), String> {
        let cancel = flag(&self.core, &e.id)?;
        idle(&self.core, &cancel).await?;
        let p = checked(&self.core, e)?;
        if p.generations
            .iter()
            .any(|g| g["kind"] == "audioPatch" && g["operationId"] == job)
        {
            return Ok(());
        }
        let s = e.spec.separation.as_ref().ok_or("QUEUE_OPTIONS")?;
        let mut targets = vec![];
        if s.vocals {
            targets.push(audio_toolbox::Destination {
                output_id: "vocals".into(),
                track_id: None,
                role: Some("speech".into()),
            });
        }
        if s.music {
            targets.push(audio_toolbox::Destination {
                output_id: "instrumental".into(),
                track_id: None,
                role: Some("music".into()),
            });
        }
        audio_toolbox::apply(
            self.core.clone(),
            self.app.clone(),
            job.into(),
            targets,
            s.mute_source,
        )
        .await?;
        Ok(())
    }
    async fn dub(&self, e: &Entry, run: &DubRun) -> Result<Option<String>, String> {
        let cancel = flag(&self.core, &e.id)?;
        idle(&self.core, &cancel).await?;
        let p = checked(&self.core, e)?;
        if let Some(job) = &run.job_id {
            if self
                .core
                .jobs
                .lock()
                .map_err(io_error)?
                .get(job)
                .is_some_and(|j| j.saved.record.status == "succeeded")
            {
                return Ok(Some(job.clone()));
            }
            return match tts_batch::review::retry(
                self.core.clone(),
                self.app.clone(),
                job,
                tts_batch::review::RetrySelection {
                    scope: "unfinished".into(),
                    line_ids: vec![],
                    item_indices: vec![],
                },
            ) {
                Ok(key) => Ok(Some(key)),
                Err(s) if s == "TTS_BATCH_EMPTY" => Ok(None),
                Err(s) => Err(s),
            };
        }
        let selection = dubbing_selection(&p, e, run)?;
        let preview = tts_batch::preview(&self.core, &selection)?;
        if preview.ready.is_empty() && preview.blocked.is_empty() {
            return Ok(None);
        }
        if preview.ready.is_empty() {
            return Err(preview.blocked[0].error.clone());
        }
        tts_batch::enqueue_in_queue(
            self.core.clone(),
            self.app.clone(),
            selection,
            &format!("{}:{}", e.id, run.id),
        )
        .map(Some)
    }
    async fn wait(&self, e: &Entry, job: &str) -> Result<(), String> {
        let cancel = flag(&self.core, &e.id)?;
        loop {
            let result = {
                let jobs = self.core.jobs.lock().map_err(io_error)?;
                let j = jobs.get(job).ok_or("INVALID_JOB")?;
                if cancel.load(Ordering::Relaxed) {
                    j.cancel.store(true, Ordering::Relaxed);
                }
                match j.saved.record.status.as_str() {
                    "succeeded" => Some(Ok(())),
                    "failed" | "interrupted" | "cancelled" => Some(Err(j
                        .saved
                        .record
                        .error
                        .clone()
                        .unwrap_or_else(|| j.saved.record.status.to_uppercase()))),
                    _ => None,
                }
            };
            if let Some(result) = result {
                return if cancel.load(Ordering::Relaxed) {
                    Err("CANCELLED".into())
                } else {
                    result
                };
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
fn dubbing_selection(p: &Project, e: &Entry, run: &DubRun) -> Result<tts_batch::Selection, String> {
    let mut selection = e.spec.selection.clone();
    selection.line_ids = run.line_ids.clone();
    if e.spec.separation.is_some() && selection.options.reference_mode == "current" {
        selection.options.reference_track_id = Some(
            crate::mix::tracks(p)
                .iter()
                .find(|t| {
                    t.role.as_deref() == Some("speech")
                        && t.source_path.as_deref() == p.media.as_ref().map(|m| m.path.as_str())
                })
                .ok_or("INVALID_AUDIO_TRANSFER")?
                .id
                .clone(),
        );
    }
    Ok(selection)
}
async fn execute<R: tauri::Runtime, E: Engine>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    engine: &E,
) -> Result<bool, String> {
    let mut e = entry(core, key)?;
    checked(core, &e)?;
    let cancel = flag(core, key)?;
    if e.spec.separation.is_some() {
        update(core, app, key, |e| e.stage = "separation".into())?;
        for index in 0..e.rows.len() {
            if cancel.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            if e.rows[index].status == "succeeded" {
                continue;
            }
            e.rows[index].status = "running".into();
            update(core, app, key, |v| v.rows[index] = e.rows[index].clone())?;
            let result = async {
                let job = engine.separate(&e, &e.rows[index]).await?;
                e.rows[index].job_id = Some(job.clone());
                update(core, app, key, |v| v.rows[index].job_id = Some(job.clone()))?;
                engine.wait(&e, &job).await?;
                if cancel.load(Ordering::Relaxed) {
                    return Err("CANCELLED".into());
                }
                engine.apply(&e, &job).await
            }
            .await;
            match result {
                Ok(()) => {
                    e.rows[index].status = "succeeded".into();
                    e.rows[index].error = None;
                }
                Err(error) if error == "CANCELLED" => return Err(error),
                Err(error) => {
                    e.rows[index].status = "failed".into();
                    e.rows[index].error = Some(error.clone());
                    if !e.spec.continue_on_error {
                        update(core, app, key, |v| v.rows[index] = e.rows[index].clone())?;
                        return Err(error);
                    }
                }
            }
            update(core, app, key, |v| v.rows[index] = e.rows[index].clone())?;
        }
    }
    if e.spec.dubbing {
        update(core, app, key, |v| v.stage = "dubbing".into())?;
        let eligible: Vec<_> = e
            .rows
            .iter()
            .filter(|r| e.spec.separation.is_none() || r.status == "succeeded")
            .map(|r| r.line_id.clone())
            .collect();
        let included: HashSet<_> = e
            .dubbing_runs
            .iter()
            .flat_map(|r| r.line_ids.iter().cloned())
            .collect();
        let extra: Vec<_> = eligible
            .into_iter()
            .filter(|id| !included.contains(id))
            .collect();
        if !extra.is_empty() {
            e.dubbing_runs.push(DubRun {
                id: id(),
                line_ids: extra,
                job_id: None,
                status: "pending".into(),
                error: None,
            });
            update(core, app, key, |v| v.dubbing_runs = e.dubbing_runs.clone())?;
        }
        for index in 0..e.dubbing_runs.len() {
            if cancel.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            if ["succeeded", "skipped"].contains(&e.dubbing_runs[index].status.as_str()) {
                continue;
            }
            e.dubbing_runs[index].status = "running".into();
            update(core, app, key, |v| {
                v.dubbing_runs[index] = e.dubbing_runs[index].clone()
            })?;
            let outcome = async {
                let job = engine.dub(&e, &e.dubbing_runs[index]).await?;
                if let Some(job) = job {
                    e.dubbing_runs[index].job_id = Some(job.clone());
                    update(core, app, key, |v| {
                        v.dubbing_runs[index].job_id = Some(job.clone())
                    })?;
                    engine.wait(&e, &job).await?;
                    Ok("succeeded")
                } else {
                    Ok("skipped")
                }
            }
            .await;
            match outcome {
                Ok(status) => {
                    e.dubbing_runs[index].status = status.into();
                    e.dubbing_runs[index].error = None;
                }
                Err(error) if error == "CANCELLED" => return Err(error),
                Err(error) => {
                    e.dubbing_runs[index].status = "failed".into();
                    e.dubbing_runs[index].error = Some(error.clone());
                    update(core, app, key, |v| {
                        v.dubbing_runs[index] = e.dubbing_runs[index].clone()
                    })?;
                    if !e.spec.continue_on_error {
                        return Err(error);
                    }
                }
            }
            update(core, app, key, |v| {
                v.dubbing_runs[index] = e.dubbing_runs[index].clone()
            })?;
        }
    }
    Ok(e.rows.iter().any(|r| r.status == "failed")
        || e.dubbing_runs.iter().any(|r| r.status == "failed"))
}
fn kick<R: tauri::Runtime>(core: Arc<Core>, app: tauri::AppHandle<R>) {
    {
        let Ok(mut q) = core.queue.lock() else {
            return;
        };
        if q.worker || q.data.paused || !q.data.entries.iter().any(|e| e.status == "pending") {
            return;
        }
        q.worker = true;
    }
    let engine = Native {
        core: core.clone(),
        app: app.clone(),
    };
    tauri::async_runtime::spawn(pump(core, app, engine));
}
fn halt_in_memory<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    interrupted: bool,
) {
    if let Ok(mut q) = core.queue.lock() {
        q.data.paused = true;
        q.worker = false;
        q.active = None;
        if let Some(e) = q.data.entries.iter_mut().find(|e| e.id == key) {
            if interrupted {
                e.status = "interrupted".into();
            }
            e.error = Some("QUEUE_SAVE_FAILED".into());
        }
    }
    if let Ok(view) = status(core) {
        let _ = app.emit("task-queue-changed", &view);
    }
}
async fn pump<R: tauri::Runtime, E: Engine>(core: Arc<Core>, app: tauri::AppHandle<R>, engine: E) {
    loop {
        let next = {
            let Ok(mut q) = core.queue.lock() else {
                return;
            };
            if q.data.paused {
                q.worker = false;
                q.active = None;
                return;
            }
            match q
                .data
                .entries
                .iter()
                .find(|e| e.status == "pending")
                .map(|e| e.id.clone())
            {
                Some(id) => {
                    q.active = Some(id.clone());
                    q.cancel = Arc::new(AtomicBool::new(false));
                    Some(id)
                }
                None => {
                    q.worker = false;
                    q.active = None;
                    None
                }
            }
        };
        let Some(key) = next else {
            return;
        };
        if entry(&core, &key).and_then(|e| current(&core, &e)).is_err() {
            let _ = update(&core, &app, &key, |e| {
                e.stage = "waiting".into();
                e.error = Some("QUEUE_PROJECT_REQUIRED".into());
            });
            let _ = change(&core, &app, |q| {
                q.paused = true;
                Ok(())
            });
            if let Ok(mut q) = core.queue.lock() {
                q.active = None;
                q.worker = false;
            }
            return;
        }
        if update(&core, &app, &key, |e| {
            e.status = "running".into();
            e.error = None;
        })
        .is_err()
        {
            halt_in_memory(&core, &app, &key, false);
            return;
        }
        let result = execute(&core, &app, &key, &engine).await;
        let cancelled = flag(&core, &key).is_ok_and(|f| f.load(Ordering::Relaxed));
        let saved = update(&core, &app, &key, |e| {
            if cancelled {
                e.status = "cancelled".into();
                e.error = Some("CANCELLED".into());
            } else {
                match &result {
                    Ok(partial) => {
                        e.status = if *partial { "partial" } else { "succeeded" }.into();
                        e.error = None;
                    }
                    Err(error) => {
                        e.status = "failed".into();
                        e.error = Some(error.clone());
                    }
                }
            }
            e.stage = "done".into();
        });
        if saved.is_err() {
            halt_in_memory(&core, &app, &key, true);
            return;
        }
        let stop = entry(&core, &key).is_ok_and(|e| {
            !e.spec.continue_on_error && ["failed", "partial"].contains(&e.status.as_str())
        });
        if stop
            && change(&core, &app, |q| {
                q.paused = true;
                Ok(())
            })
            .is_err()
        {
            halt_in_memory(&core, &app, &key, false);
            return;
        }
    }
}

#[cfg(test)]
#[path = "task_queue_tests.rs"]
mod tests;
