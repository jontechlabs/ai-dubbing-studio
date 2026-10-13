mod domain;
#[cfg(test)]
mod integration_tests;
mod jobs;
mod media;
mod project;
mod smoke;
mod subtitles;
pub fn smoke_test(path: &std::path::Path) -> Result<(), String> {
    smoke::run(path)
}

use domain::{io_error, MediaAsset, MediaInfo, Project};
use jobs::{Control, ImportRequest, Job, PersistedJob};
use project::Session;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

pub struct Core {
    session: Mutex<Option<Session>>,
    jobs: Mutex<HashMap<String, Control>>,
    gate: Arc<tokio::sync::Semaphore>,
    data_dir: PathBuf,
}
type Shared = Arc<Core>;
fn ensure_idle(core: &Core) -> Result<(), String> {
    if jobs::active_import(core) {
        Err("BUSY".into())
    } else {
        Ok(())
    }
}
fn attach(
    app: &tauri::AppHandle,
    core: &Core,
    root: PathBuf,
    p: Project,
) -> Result<Project, String> {
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(io_error)?;
    project::atomic_write(
        &core.data_dir.join("recent.txt"),
        root.to_string_lossy().as_bytes(),
    )?;
    *core.session.lock().map_err(io_error)? = Some(Session::new(root, p.clone()));
    Ok(p)
}
#[tauri::command]
async fn create_project(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    parent_path: String,
    name: String,
    source: String,
    target: String,
) -> Result<Project, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        let root = project::create_root(Path::new(&parent_path), &name)?;
        let p = Project::new(name, source, target);
        project::save(&root, &p)?;
        attach(&app, &core, root, p)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn open_project(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
) -> Result<Project, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        let root = PathBuf::from(path).canonicalize().map_err(io_error)?;
        let p = project::load(&root)?;
        attach(&app, &core, root, p)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn restore_project(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<Option<Project>, String> {
    let path = match std::fs::read_to_string(core.data_dir.join("recent.txt")) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    open_project(app, core, path).await.map(Some)
}
#[tauri::command]
async fn replace_project(
    core: State<'_, Shared>,
    project: Project,
    expected_revision: u64,
) -> Result<Project, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        core.session
            .lock()
            .map_err(io_error)?
            .as_mut()
            .ok_or("NO_PROJECT")?
            .replace(project, expected_revision)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn history(core: State<'_, Shared>, direction: String) -> Result<Project, String> {
    if !["undo", "redo"].contains(&direction.as_str()) {
        return Err("INVALID_PROJECT".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        core.session
            .lock()
            .map_err(io_error)?
            .as_mut()
            .ok_or("NO_PROJECT")?
            .history(direction == "redo")
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn probe_media(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
) -> Result<MediaInfo, String> {
    let core = core.inner().clone();
    let key = jobs::create(&core, &app, "probe", String::new(), None);
    let _permit = core.gate.clone().acquire_owned().await.map_err(io_error)?;
    let flag = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&key)
        .ok_or("INVALID_PROJECT")?
        .cancel
        .clone();
    jobs::update(&core, &app, &key, |j| {
        j.status = "running".into();
        j.logs.push(format!(
            "ffprobe args: -v error -protocol_whitelist file,pipe -of json -show_format -show_streams {path:?}"
        ));
    });
    let result = tokio::select! { _ = jobs::cancelled(&flag) => Err("CANCELLED".into()), result = media::probe(&app, Path::new(&path)) => result };
    jobs::update(&core, &app, &key, |j| match &result {
        Ok(_) => {
            j.status = "succeeded".into();
            j.progress = Some(1.0);
        }
        Err(e) => {
            j.status = if e == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            j.error = Some(e.clone());
        }
    });
    result
}
#[tauri::command]
fn import_media(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
    audio_stream_index: Option<u32>,
    force_proxy: bool,
) -> Result<String, String> {
    ensure_idle(&core)?;
    let source = PathBuf::from(path).canonicalize().map_err(io_error)?;
    if !source.is_file() {
        return Err("INVALID_PATH".into());
    }
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let request = ImportRequest {
        path: source,
        root: s.root.clone(),
        project_id: s.project.id.clone(),
        audio_index: audio_stream_index,
        force_proxy,
        reuse: None,
    };
    Ok(jobs::enqueue(core.inner().clone(), app, request))
}
#[tauri::command]
fn prepare_proxy(app: tauri::AppHandle, core: State<'_, Shared>) -> Result<String, String> {
    ensure_idle(&core)?;
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let media = s.project.media.clone().ok_or("MEDIA_MISSING")?;
    let request = ImportRequest {
        path: project::asset(&s.root, &media.path)?,
        root: s.root.clone(),
        project_id: s.project.id.clone(),
        audio_index: media.audio_stream_index,
        force_proxy: true,
        reuse: Some(media),
    };
    Ok(jobs::enqueue(core.inner().clone(), app, request))
}
#[tauri::command]
async fn import_subtitles(
    core: State<'_, Shared>,
    path: String,
    role: String,
) -> Result<Project, String> {
    if !["source", "target"].contains(&role.as_str()) {
        return Err("INVALID_PROJECT".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        let text = std::fs::read_to_string(&path).map_err(io_error)?;
        let cues = subtitles::parse_srt(&text)?;
        let mut session = core.session.lock().map_err(io_error)?;
        let s = session.as_mut().ok_or("NO_PROJECT")?;
        let mut next = s.project.clone();
        if role == "source" {
            next.source_cues = cues;
        } else {
            next.target_cues = cues;
        }
        next.dialogues = subtitles::reconcile(
            &next.dialogues,
            subtitles::align(&next.source_cues, &next.target_cues),
        );
        let name = format!("subtitles/{}_{}.srt", role, domain::id());
        project::atomic_write(&s.root.join(name), text.as_bytes())?;
        let revision = s.project.revision;
        s.replace(next, revision)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn media_path(core: State<'_, Shared>) -> Result<String, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let media = s.project.media.as_ref().ok_or("MEDIA_MISSING")?;
    project::asset(
        &s.root,
        media.preview_path.as_deref().unwrap_or(&media.path),
    )
    .map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
async fn export_subtitles(
    core: State<'_, Shared>,
    path: String,
    role: String,
) -> Result<(), String> {
    if !["source", "target"].contains(&role.as_str()) {
        return Err("INVALID_PROJECT".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let output = PathBuf::from(path);
        let parent = output
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map_err(io_error)?;
        if parent.starts_with(&s.root) && !parent.starts_with(s.root.join("exports")) {
            return Err("INVALID_PATH".into());
        }
        let content = subtitles::export_srt(if role == "source" {
            &s.project.source_cues
        } else {
            &s.project.target_cues
        });
        project::atomic_write(&output, content.as_bytes())
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn environment(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({ "platform": std::env::consts::OS, "ffmpeg": media::binary(&app, "ffmpeg").is_ok(), "ffprobe": media::binary(&app, "ffprobe").is_ok() })
}
#[tauri::command]
async fn export_report(
    core: State<'_, Shared>,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > 2_000_000 {
        return Err("INVALID_PROJECT".into());
    }
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|_| "INVALID_PROJECT".to_string())?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output = PathBuf::from(path);
        let parent = output
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map_err(io_error)?;
        if let Some(s) = core.session.lock().map_err(io_error)?.as_ref() {
            if parent.starts_with(&s.root) && !parent.starts_with(s.root.join("exports")) {
                return Err("INVALID_PATH".into());
            }
        }
        project::atomic_write(&output, content.as_bytes())
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn list_jobs(core: State<'_, Shared>) -> Result<Vec<Job>, String> {
    Ok(core
        .jobs
        .lock()
        .map_err(io_error)?
        .values()
        .map(|c| c.saved.record.clone())
        .collect())
}
#[tauri::command]
fn cancel_job(core: State<'_, Shared>, id: String) -> Result<(), String> {
    let jobs = core.jobs.lock().map_err(io_error)?;
    let job = jobs.get(&id).ok_or("INVALID_PROJECT")?;
    job.cancel.store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn retry_job(app: tauri::AppHandle, core: State<'_, Shared>, id: String) -> Result<String, String> {
    ensure_idle(&core)?;
    let request = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&id)
        .and_then(|c| c.saved.request.clone())
        .ok_or("INVALID_PROJECT")?;
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    if s.project.id != request.project_id || s.root != request.root {
        return Err("NO_PROJECT".into());
    }
    Ok(jobs::enqueue(core.inner().clone(), app, request))
}
#[tauri::command]
async fn load_demo(app: tauri::AppHandle, core: State<'_, Shared>) -> Result<Project, String> {
    let core = core.inner().clone();
    ensure_idle(&core)?;
    let root = core.data_dir.join("First light.dubproject");
    if root.exists() {
        let p = project::load(&root)?;
        return attach(&app, &core, root.canonicalize().map_err(io_error)?, p);
    }
    let root = project::create_root(&core.data_dir, "First light")?;
    let packaged = app
        .path()
        .resource_dir()
        .map_err(io_error)?
        .join("demo/demo.mp4");
    let source = if packaged.is_file() {
        packaged
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/demo.mp4")
    };
    tokio::fs::copy(source, root.join("media/demo.mp4"))
        .await
        .map_err(io_error)?;
    let info = media::probe(&app, &root.join("media/demo.mp4")).await?;
    let mut p = Project::new("First light · Demo".into(), "en".into(), "fr".into());
    p.media = Some(MediaAsset {
        id: domain::id(),
        path: "media/demo.mp4".into(),
        preview_path: None,
        audio_stream_index: Some(1),
        info,
    });
    p.source_cues = subtitles::parse_srt("1\n00:00:00,750 --> 00:00:03,250\nEvery story begins with a voice.\n\n2\n00:00:04,500 --> 00:00:07,000\nListen. Find the right rhythm.\n\n3\n00:00:08,250 --> 00:00:11,250\nMake room for another language.\n\n4\n00:00:12,500 --> 00:00:15,000\nNow, make it yours.")?;
    p.target_cues = subtitles::parse_srt("1\n00:00:00,750 --> 00:00:03,250\nChaque histoire commence par une voix.\n\n2\n00:00:04,500 --> 00:00:07,000\nÉcoutez. Trouvez le bon rythme.\n\n3\n00:00:08,250 --> 00:00:11,250\nFaites place à une autre langue.\n\n4\n00:00:12,500 --> 00:00:15,000\nÀ vous de lui donner vie.")?;
    p.dialogues = subtitles::align(&p.source_cues, &p.target_cues);
    project::save(&root, &p)?;
    attach(&app, &core, root, p)
}
pub fn run() {
    let args: Vec<_> = std::env::args_os().collect();
    let test_data = if args.get(1).is_some_and(|arg| arg == "--ui-test") {
        args.get(2).map(PathBuf::from)
    } else {
        None
    };
    let mut context = tauri::generate_context!();
    if test_data.is_some() {
        for window in &mut context.config_mut().app.windows {
            window.visible = false;
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = match &test_data {
                Some(path) => path.clone(),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let mut restored = HashMap::new();
            if let Ok(bytes) = std::fs::read(data_dir.join("jobs.json")) {
                if let Ok(records) = serde_json::from_slice::<Vec<PersistedJob>>(&bytes) {
                    for mut saved in records {
                        if ["queued", "running"].contains(&saved.record.status.as_str()) {
                            saved.record.status = "interrupted".into();
                        }
                        restored.insert(
                            saved.record.id.clone(),
                            Control {
                                saved,
                                cancel: Arc::new(AtomicBool::new(false)),
                            },
                        );
                    }
                }
            }
            app.manage(Arc::new(Core {
                session: Mutex::new(None),
                jobs: Mutex::new(restored),
                gate: Arc::new(tokio::sync::Semaphore::new(1)),
                data_dir,
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_project,
            open_project,
            restore_project,
            replace_project,
            history,
            probe_media,
            import_media,
            prepare_proxy,
            import_subtitles,
            media_path,
            export_subtitles,
            export_report,
            environment,
            list_jobs,
            cancel_job,
            retry_job,
            load_demo
        ])
        .run(context)
        .expect("Unable to start desktop application");
}
