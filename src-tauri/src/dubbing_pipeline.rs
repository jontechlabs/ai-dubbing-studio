//! Serial, cancellable TTS -> optional delivery guide -> timbre conversion.
//! Completed stages are immutable takes; a failed stage never discards them.
use crate::{
    domain::{io_error, Project},
    jobs, project, tts, voice_capture, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub line_id: String,
    pub tts: tts::Options,
    pub conversion: voice_capture::Options,
    pub guide_strength: f64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
    pub stages: Vec<String>,
}
fn validate(p: &Project, o: &Options) -> Result<(), String> {
    tts::validate_input(p, &o.line_id, &o.tts)?;
    voice_capture::validate_reference(p, &o.conversion, &o.line_id)?;
    if !o.guide_strength.is_finite() || !(0.0..=1.0).contains(&o.guide_strength) {
        return Err("INVALID_PROSODY_REQUEST".into());
    }
    if o.guide_strength > 0.0
        && p.dialogues
            .iter()
            .find(|l| l.id == o.line_id)
            .is_none_or(|l| l.end_ms - l.start_ms > crate::prosody::MAX_MS)
    {
        return Err("PROSODY_DURATION_INVALID".into());
    }
    Ok(())
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
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        validate(&s.project, &options)?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            revision: s.project.revision,
            options,
            stages: vec![],
        }
    };
    enqueue(core, app, request)
}
fn snapshot(core: &Core, r: &Request) -> Result<Project, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id || s.project.revision != r.revision {
        return Err("STALE_REVISION".into());
    }
    Ok(s.project.clone())
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    snapshot(&core, &request)?;
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let key = jobs::create(&core, &app, "ttsPipeline", request.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .dubbing_pipeline = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),p=core.gate.clone().acquire_owned()=>p.map_err(io_error)?};
        jobs::update(&core,&app,&key,|j|{j.status="running".into();j.progress=None;});
        run(&core,&app,&key,request,&flag).await
      }.await;
        crate::separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
fn advance<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &mut Request,
    before: &Project,
) -> Result<(), String> {
    r.revision += 1;
    let p = snapshot(core, r)?;
    if p.generations.len() != before.generations.len() + 1
        || p.generations[..before.generations.len()] != before.generations
    {
        return Err("STALE_REVISION".into());
    }
    let g = p.generations.last().ok_or("INVALID_GENERATION")?;
    if g["dialogueId"] != r.options.line_id || g["kind"] != "tts" {
        return Err("INVALID_GENERATION".into());
    }
    r.stages
        .push(g["id"].as_str().ok_or("INVALID_GENERATION")?.into());
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .dubbing_pipeline = Some(r.clone());
    jobs::persist(core);
    jobs::update(core, app, key, |j| {
        j.logs.push(format!(
            "Completed pipeline stage {}; take {} preserved.",
            r.stages.len(),
            r.stages.last().unwrap()
        ))
    });
    Ok(())
}
async fn run<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    mut r: Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let guided = r.options.guide_strength > 0.0;
    if r.stages.is_empty() {
        let p = snapshot(core, &r)?;
        validate(&p, &r.options)?;
        let mut options = r.options.tts.clone();
        options.output_gain = None;
        let request = tts::Request {
            root: r.root.clone(),
            project_id: r.project_id.clone(),
            line_id: r.options.line_id.clone(),
            options,
            fingerprint: tts::fingerprint(&p, &r.options.line_id)?,
            option_fingerprint: None,
            batch_item_id: None,
        };
        jobs::update(core, app, key, |j| {
            j.logs
                .push("Pipeline 1: French/raw TTS. The original take is kept independently.".into())
        });
        tts::execute(core, app, key, &request, flag).await?;
        advance(core, app, key, &mut r, &p)?;
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if guided && r.stages.len() == 1 {
        let p = snapshot(core, &r)?;
        let request = crate::prosody::Request {
            root: r.root.clone(),
            project_id: r.project_id.clone(),
            revision: r.revision,
            options: crate::prosody::Options {
                generation_id: r.stages[0].clone(),
                reference_mode: "dialogue".into(),
                reference_id: None,
                character_id: None,
                reference_track_id: r.options.tts.reference_track_id.clone(),
                strength: r.options.guide_strength,
                pitch: true,
                rhythm: true,
                energy: true,
            },
        };
        jobs::update(core, app, key, |j| {
            j.logs.push(
                "Optional delivery guide: source dialogue contours, before timbre conversion."
                    .into(),
            )
        });
        crate::prosody::execute(core, app, key, &request, flag).await?;
        advance(core, app, key, &mut r, &p)?;
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let expected = if guided { 2 } else { 1 };
    if r.stages.len() == expected {
        let p = snapshot(core, &r)?;
        let mut options = r.options.conversion.clone();
        options.generation_id = r.stages.last().unwrap().clone();
        let request = voice_capture::Request {
            root: r.root.clone(),
            project_id: r.project_id.clone(),
            revision: r.revision,
            options,
        };
        jobs::update(core, app, key, |j| {
            j.logs.push("Pipeline 2: local timbre conversion. TTS process has exited; models are not held in VRAM together.".into())
        });
        voice_capture::execute(core, app, key, &request, flag).await?;
        advance(core, app, key, &mut r, &p)?;
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let p = snapshot(core, &r)?;
    let id = r.stages.last().ok_or("INVALID_GENERATION")?.clone();
    let gain = r.options.tts.output_gain.unwrap_or(1.0);
    let mut edit = None;
    if gain != 1.0 {
        let g = p.generations.last().ok_or("INVALID_GENERATION")?;
        let ms = g["durationMs"].as_u64().ok_or("INVALID_GENERATION")?;
        let value = crate::voice_edit::Edit {
            output_gain: Some(gain),
            pieces: vec![crate::voice_edit::Piece {
                source_start_ms: Some(0),
                source_end_ms: Some(ms),
                duration_ms: ms,
                gain: 1.0,
                envelope: None,
                effects: vec![],
            }],
        };
        crate::voice_edit::render(
            &r.root,
            g["path"].as_str().ok_or("INVALID_GENERATION")?,
            Some(&value),
            &crate::media::binary(app, "ffmpeg")?,
            flag,
        )
        .await?;
        edit = Some(value);
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id || s.project.revision != r.revision {
        return Err("STALE_REVISION".into());
    }
    let mut next = s.project.clone();
    next.format_version = next.format_version.max(23);
    next.generations
        .iter_mut()
        .find(|g| g["id"] == id)
        .ok_or("INVALID_GENERATION")?["dubbingPipeline"] =
        serde_json::json!({"stageIds":r.stages,"settings":r.options,"engine":"chatterbox-vc"});
    if let Some(edit) = edit {
        next.voice_edits.insert(id, edit);
    }
    let saved = s.replace(next, r.revision)?;
    app.emit("project-changed", saved).map_err(io_error)
}
