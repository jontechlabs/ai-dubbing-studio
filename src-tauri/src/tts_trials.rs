//! One cancellable operation, one dialogue, up to four immutable alternatives.
use crate::{domain::io_error, dubbing_pipeline, jobs, tts, Core};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};

#[cfg(test)]
#[path = "tts_trials_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Plan {
    Voice {
        line_id: String,
        options: tts::Options,
    },
    Pipeline {
        options: dubbing_pipeline::Options,
    },
}
impl Plan {
    fn line_id(&self) -> &str {
        match self {
            Self::Voice { line_id, .. } => line_id,
            Self::Pipeline { options } => &options.line_id,
        }
    }
    fn options(&self) -> &tts::Options {
        match self {
            Self::Voice { options, .. } => options,
            Self::Pipeline { options } => &options.tts,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub plan: Plan,
    pub count: u32,
    pub completed: u32,
    pub pipeline: Option<dubbing_pipeline::Request>,
}
pub(crate) fn count(value: Option<u32>) -> Result<u32, String> {
    let count = value.unwrap_or(1);
    if !(1..=4).contains(&count) {
        return Err("INVALID_TTS_TAKE_COUNT".into());
    }
    Ok(count)
}
fn seed(base: u32, index: u32) -> u32 {
    base.wrapping_add(index)
}
fn snapshot(core: &Core, r: &Request) -> Result<crate::domain::Project, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id || s.project.revision != r.revision {
        return Err("STALE_REVISION".into());
    }
    Ok(s.project.clone())
}
pub fn start<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    plan: Plan,
    total: u32,
) -> Result<String, String> {
    count(Some(total))?;
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !tts::runtime_installed(&core, plan.options()) {
        return Err("TTS_RUNTIME_REQUIRED".into());
    }
    if matches!(plan, Plan::Pipeline { .. })
        && !crate::voice_engines::installed(&core, "chatterbox-vc")
    {
        return Err("TTS_MODEL_REQUIRED".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        match &plan {
            Plan::Voice { line_id, options } => {
                tts::prepare_request(&s.project, &s.root, line_id.clone(), options.clone())?;
            }
            Plan::Pipeline { options } => dubbing_pipeline::validate(&s.project, options)?,
        }
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            revision: s.project.revision,
            plan,
            count: total,
            completed: 0,
            pipeline: None,
        }
    };
    resume(core, app, request)
}
fn persist<R: tauri::Runtime>(core: &Core, app: &tauri::AppHandle<R>, key: &str, r: &Request) {
    if let Ok(mut guard) = core.jobs.lock() {
        if let Some(job) = guard.get_mut(key) {
            job.saved.tts_trials = Some(r.clone());
        }
    }
    jobs::persist(core);
    jobs::update(core, app, key, |j| {
        j.batch = Some(crate::tts_batch::Progress {
            take_count: None,
            current_index: None,
            total: r.count as usize,
            completed: r.completed as usize,
            succeeded: r.completed as usize,
            failed: 0,
            skipped: 0,
            current_line_id: Some(r.plan.line_id().into()),
        });
    });
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
    mut r: Request,
    launch: Option<tts::WorkerLaunch>,
) -> Result<String, String> {
    count(Some(r.count))?;
    if r.completed > r.count {
        return Err("INVALID_TTS_TAKE_COUNT".into());
    }
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let p = snapshot(&core, &r)?;
    match &r.plan {
        Plan::Voice { line_id, options } => {
            tts::prepare_request(&p, &r.root, line_id.clone(), options.clone())?;
        }
        Plan::Pipeline { options } => dubbing_pipeline::validate(&p, options)?,
    }
    if let Some(pipeline) = &r.pipeline {
        if pipeline.root != r.root
            || pipeline.project_id != r.project_id
            || pipeline.revision != r.revision
            || pipeline.options.line_id != r.plan.line_id()
            || pipeline.options.tts.seed != seed(r.plan.options().seed, r.completed)
            || !matches!(r.plan, Plan::Pipeline { .. })
        {
            return Err("INVALID_DUBBING_PIPELINE".into());
        }
    }
    let key = jobs::create(&core, &app, "ttsTrials", r.project_id.clone(), None);
    persist(&core, &app, &key, &r);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result = async {
            let _permit = tokio::select! { _ = jobs::cancelled(&flag) => return Err("CANCELLED".into()), p = core.gate.clone().acquire_owned() => p.map_err(io_error)?, };
            jobs::update(&core, &app, &key, |j| { j.status = "running".into(); });
            let mut hot = crate::tts_session::Session::default();
            let outcome = async {
                while r.completed < r.count {
                    if flag.load(Ordering::Relaxed) { return Err("CANCELLED".into()); }
                    let p = snapshot(&core, &r)?;
                    let mut options = r.plan.options().clone();
                    options.seed = seed(options.seed, r.completed);
                    jobs::update(&core, &app, &key, |j| { j.stage = "ttsReference".into(); j.progress = None; j.logs.push(format!("Take {}/{}; seed {}. Earlier takes are preserved.", r.completed + 1, r.count, options.seed)); });
                    let next_revision = match &r.plan {
                        Plan::Voice { line_id, .. } => {
                            let request = tts::prepare_request(&p, &r.root, line_id.clone(), options)?;
                            let default_launch;
                            let selected_launch = if let Some(l) = &launch { l } else { default_launch = tts::worker_launch(&core, &app, &request); &default_launch };
                            tts::execute_with_session(&core, &app, &key, &request, &flag, selected_launch, Some(&mut hot)).await?;
                            r.revision + 1
                        }
                        Plan::Pipeline { options: original } => {
                            let pipeline = r.pipeline.clone().unwrap_or_else(|| {
                                let mut settings = original.clone(); settings.tts = options;
                                dubbing_pipeline::Request { root: r.root.clone(), project_id: r.project_id.clone(), revision: r.revision, options: settings, stages: vec![] }
                            });
                            let stages: usize = if pipeline.options.guide_strength > 0.0 { 3 } else { 2 };
                            let remaining = stages.checked_sub(pipeline.stages.len()).ok_or("INVALID_DUBBING_PIPELINE")?;
                            let next_revision = pipeline.revision + remaining as u64 + 1;
                            r.pipeline = Some(pipeline.clone());
                            persist(&core, &app, &key, &r);
                            if let Err(error) = dubbing_pipeline::run(&core, &app, &key, pipeline, &flag).await {
                                // Resume only an actual checkpoint of this attempt. An external
                                // project edit must never be accepted as our own revision.
                                let saved = core.jobs.lock().map_err(io_error)?.get(&key).and_then(|j| j.saved.dubbing_pipeline.clone());
                                if let Some(checkpoint) = saved.filter(|c| r.pipeline.as_ref().is_some_and(|old| c.options.tts.seed == old.options.tts.seed && c.options.line_id == old.options.line_id)) {
                                    let mut candidate = r.clone(); candidate.revision = checkpoint.revision;
                                    if snapshot(&core, &candidate).is_ok() { r.revision = checkpoint.revision; r.pipeline = Some(checkpoint); }
                                }
                                return Err(error);
                            }
                            next_revision
                        }
                    };
                    r.revision = next_revision;
                    snapshot(&core, &r)?;
                    r.completed += 1;
                    r.pipeline = None;
                    persist(&core, &app, &key, &r);
                }
                Ok(())
            }.await;
            hot.finish(&core, &app, &key).await;
            outcome
        }.await;
        persist(&core, &app, &key, &r);
        crate::separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
