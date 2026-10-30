//! Re-run Bandit on a bounded edited audio section, then explicitly apply layers.
use crate::{
    audio_patch, character_review,
    domain::{io_error, Project},
    jobs, project, separation, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub source_track_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub device: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub source_path: String,
    pub options: Options,
    pub audio_snapshot: serde_json::Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub options: Options,
    pub stale: bool,
    pub applied: bool,
    pub roles: Vec<String>,
}
pub fn destinations(p: &Project) -> Result<HashMap<String, String>, String> {
    let source = &p.media.as_ref().ok_or("MEDIA_MISSING")?.path;
    ["speech", "music", "sfx"]
        .into_iter()
        .map(|role| {
            p.tracks
                .iter()
                .find(|t| t.role.as_deref() == Some(role) && t.source_path.as_ref() == Some(source))
                .map(|t| (role.to_owned(), t.id.clone()))
                .ok_or("LOCAL_SEPARATION_STEMS_REQUIRED".into())
        })
        .collect()
}
pub fn validate(p: &Project, o: &Options) -> Result<(), String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if o.end_ms <= o.start_ms
        || o.end_ms > media.info.duration_ms
        || !(100..=60000).contains(&(o.end_ms - o.start_ms))
    {
        return Err("LOCAL_SEPARATION_RANGE".into());
    }
    if o.device != "auto"
        && o.device != "cpu"
        && !o
            .device
            .strip_prefix("cuda:")
            .is_some_and(|v| v.parse::<u32>().is_ok())
    {
        return Err("DEVICE_UNAVAILABLE".into());
    }
    audio_patch::source_track(p, Some(&o.source_track_id))?;
    destinations(p)?;
    Ok(())
}
pub fn plan(
    p: &Project,
    o: &Options,
    operation_id: &str,
    paths: &HashMap<String, String>,
) -> Result<Vec<audio_patch::Patch>, String> {
    validate(p, o)?;
    let source = audio_patch::source_track(p, Some(&o.source_track_id))?;
    let targets = destinations(p)?;
    let mut result = vec![];
    for role in ["speech", "music", "sfx"] {
        let track_id = targets.get(role).unwrap();
        result.push(audio_patch::Patch {
            kind: "audioPatch".into(),
            id: crate::domain::id(),
            operation_id: operation_id.into(),
            operation: "separation".into(),
            source_path: p.media.as_ref().unwrap().path.clone(),
            track_id: track_id.clone(),
            source_track_id: source.id.clone(),
            start_ms: o.start_ms,
            end_ms: o.end_ms,
            mode: if source.kind == "original" || track_id == &source.id {
                "replace"
            } else {
                "add"
            }
            .into(),
            path: Some(paths.get(role).ok_or("SEPARATION_FAILED")?.clone()),
            gain: 1.0,
        });
    }
    if source.kind != "original" && !targets.values().any(|id| id == &source.id) {
        result.push(audio_patch::Patch {
            kind: "audioPatch".into(),
            id: crate::domain::id(),
            operation_id: operation_id.into(),
            operation: "separation".into(),
            source_path: p.media.as_ref().unwrap().path.clone(),
            track_id: source.id.clone(),
            source_track_id: source.id,
            start_ms: o.start_ms,
            end_ms: o.end_ms,
            mode: "silence".into(),
            path: None,
            gain: 1.0,
        });
    }
    if audio_patch::all(p)?.len() + result.len() > 128 {
        return Err("AUDIO_TRANSFER_LIMIT".into());
    }
    Ok(result)
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    if !separation::installed(&core) {
        return Err("RUNTIME_REQUIRED".into());
    }
    let (request, snapshot) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        validate(&s.project, &options)?;
        (
            Request {
                root: s.root.clone(),
                project_id: s.project.id.clone(),
                source_path: s.project.media.as_ref().unwrap().path.clone(),
                options,
                audio_snapshot: character_review::audio_snapshot(&s.project, None),
            },
            s.project.clone(),
        )
    };
    let key = jobs::create(&core, &app, "separation", request.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .local_separation = Some(request.clone());
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let folder = request.root.join(format!("stems/local-{key}"));
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="audioExtract".into();j.progress=None;});
            project::ensure_directory(&request.root,"stems")?;std::fs::create_dir(&folder).map_err(io_error)?;
            let input=folder.join("input.wav");
            audio_patch::snippet(&core,&app,&key,&snapshot,&request.root,audio_patch::Snippet{track_id:&request.options.source_track_id,start_ms:request.options.start_ms,end_ms:request.options.end_ms,channels:2,rate:48000,levels:crate::audio_patch::SnippetLevels::Regions},&input,&flag).await?;
            jobs::update(&core,&app,&key,|j|{j.stage="localSeparation".into();j.progress=Some(0.0);j.logs.push("Local separation preview only. No project track or original source is overwritten.".into());});
            separation::process(&core,&app,&key,&separation::python(&separation::runtime(&core)),&[separation::resources(&app).join("bandit_worker.py").to_string_lossy().into_owned(),"--input".into(),input.to_string_lossy().into_owned(),"--output".into(),folder.to_string_lossy().into_owned(),"--model".into(),separation::runtime(&core).join("checkpoint-multi.ckpt").to_string_lossy().into_owned(),"--device".into(),request.options.device.clone()],&flag).await?;
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            let expected=(request.options.end_ms-request.options.start_ms)*48;
            for role in ["speech","music","sfx"] {if crate::audio_files::wav_frames(&folder.join(format!("{role}.wav")))?!=expected{return Err("SEPARATION_FAILED".into());}}
            project::atomic_write(&folder.join("ready.json"),&serde_json::to_vec(&serde_json::json!({"frames":expected})).map_err(io_error)?)?;
            let _=std::fs::remove_file(input);
            jobs::update(&core,&app,&key,|j|{j.stage="localSeparationPreview".into();j.progress=Some(1.0);});
            Ok(())
        }.await;
        if result.is_err()
            && folder
                .canonicalize()
                .is_ok_and(|path| path.starts_with(request.root.join("stems")))
        {
            let _ = std::fs::remove_dir_all(&folder);
        }
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}
fn request(core: &Core, id: &str) -> Result<Request, String> {
    let jobs = core.jobs.lock().map_err(io_error)?;
    let job = jobs.get(id).ok_or("INVALID_JOB")?;
    if job.saved.record.status != "succeeded" {
        return Err("LOCAL_SEPARATION_NOT_READY".into());
    }
    job.saved
        .local_separation
        .clone()
        .ok_or("INVALID_JOB".into())
}
fn current<'a>(s: &'a crate::project::Session, r: &Request) -> Result<&'a Project, String> {
    if s.root != r.root
        || s.project.id != r.project_id
        || s.project
            .media
            .as_ref()
            .is_none_or(|m| m.path != r.source_path)
    {
        return Err("STALE_REVISION".into());
    }
    Ok(&s.project)
}
pub fn result(core: &Core, id: &str) -> Result<Proposal, String> {
    let r = request(core, id)?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    let p = current(s, &r)?;
    Ok(Proposal {
        id: id.into(),
        options: r.options,
        stale: character_review::audio_snapshot(p, None) != r.audio_snapshot,
        applied: p
            .generations
            .iter()
            .any(|g| g["kind"] == "audioPatch" && g["operationId"] == id),
        roles: vec!["speech".into(), "music".into(), "sfx".into()],
    })
}
pub fn path<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    id: &str,
    role: &str,
) -> Result<String, String> {
    if !["speech", "music", "sfx"].contains(&role) {
        return Err("INVALID_PATH".into());
    }
    let r = request(core, id)?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    current(s, &r)?;
    let file = project::asset(&r.root, &format!("stems/local-{id}/{role}.wav"))?;
    if !file.is_file() {
        return Err("MEDIA_MISSING".into());
    }
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(io_error)?;
    Ok(file.to_string_lossy().into_owned())
}
pub async fn apply<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<Project, String> {
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let r = request(&core, &id)?;
    let p = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        current(s, &r)?.clone()
    };
    if p.generations
        .iter()
        .any(|g| g["kind"] == "audioPatch" && g["operationId"] == id)
    {
        return Err("LOCAL_SEPARATION_APPLIED".into());
    }
    if character_review::audio_snapshot(&p, None) != r.audio_snapshot {
        return Err("STALE_REVISION".into());
    }
    let paths = ["speech", "music", "sfx"]
        .into_iter()
        .map(|role| {
            (
                role.to_owned(),
                format!("stems/patch-{}.wav", crate::domain::id()),
            )
        })
        .collect::<HashMap<_, _>>();
    let layers = plan(&p, &r.options, &id, &paths)?;
    let mut copied = vec![];
    let result = (|| {
        for (role, path) in &paths {
            let source = project::asset(&r.root, &format!("stems/local-{id}/{role}.wav"))?;
            if crate::audio_files::wav_frames(&source)?
                != (r.options.end_ms - r.options.start_ms) * 48
            {
                return Err("SEPARATION_FAILED".into());
            }
            let destination = r.root.join(path);
            std::fs::copy(&source, &destination).map_err(io_error)?;
            copied.push(destination);
        }
        let mut guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_mut().ok_or("NO_PROJECT")?;
        current(s, &r)?;
        if s.project.revision != p.revision {
            return Err("STALE_REVISION".into());
        }
        let mut next = p.clone();
        next.format_version = next.format_version.max(20);
        for patch in layers {
            next.generations
                .push(serde_json::to_value(patch).map_err(io_error)?);
        }
        let saved = s.replace(next, p.revision)?;
        let _ = app.emit("project-changed", &saved);
        Ok(saved)
    })();
    if result.is_err() {
        for file in copied {
            let _ = std::fs::remove_file(file);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Project {
        let mut p = Project::new("Local separation".into(), "ja".into(), "fr".into());
        p.format_version = 20;
        p.media=Some(serde_json::from_value(serde_json::json!({"id":"video","path":"media/video.mkv","previewPath":null,"audioStreamIndex":1,"originalName":"video.mkv","durationMs":120000,"streams":[]})).unwrap());
        for role in ["speech", "music", "sfx"] {
            p.tracks.push(serde_json::from_value(serde_json::json!({"id":role,"kind":"audio","role":role,"path":format!("stems/{role}.wav"),"sourcePath":"media/video.mkv","durationMs":120000,"language":"ja","gain":1,"mute":false,"solo":false})).unwrap());
        }
        p
    }
    fn options(source: &str) -> Options {
        Options {
            source_track_id: source.into(),
            start_ms: 1000,
            end_ms: 3000,
            device: "cpu".into(),
        }
    }
    fn paths() -> HashMap<String, String> {
        ["speech", "music", "sfx"]
            .into_iter()
            .map(|r| (r.into(), format!("stems/patch-{r}.wav")))
            .collect()
    }
    #[test]
    fn original_replaces_three_stem_regions_without_changing_source() {
        let p = fixture();
        let before = serde_json::to_value(&p).unwrap();
        let layers = plan(&p, &options("original"), "operation", &paths()).unwrap();
        assert_eq!(layers.len(), 3);
        assert!(layers
            .iter()
            .all(|p| p.mode == "replace" && p.start_ms == 1000 && p.end_ms == 3000));
        assert_eq!(serde_json::to_value(&p).unwrap(), before);
    }
    #[test]
    fn music_source_replaces_music_and_adds_recovered_voice_effects() {
        let p = fixture();
        let layers = plan(&p, &options("music"), "operation", &paths()).unwrap();
        assert_eq!(
            layers.iter().find(|l| l.track_id == "music").unwrap().mode,
            "replace"
        );
        assert!(layers
            .iter()
            .filter(|l| l.track_id != "music")
            .all(|l| l.mode == "add"));
    }
    #[test]
    fn custom_source_is_silenced_only_inside_interval() {
        let mut p = fixture();
        let mut custom = p.tracks[0].clone();
        custom.id = "custom".into();
        custom.role = None;
        p.tracks.push(custom);
        let layers = plan(&p, &options("custom"), "operation", &paths()).unwrap();
        assert_eq!(layers.len(), 4);
        assert_eq!(layers[3].mode, "silence");
        assert_eq!(layers[3].track_id, "custom");
        assert!(layers[3].path.is_none());
        assert!(layers[..3].iter().all(|l| l.mode == "add"));
    }
    #[test]
    fn range_devices_missing_stems_and_layer_limit_fail_before_rendering() {
        let mut p = fixture();
        for (start, end) in [(1000, 1000), (1000, 1099), (0, 60001), (119000, 121000)] {
            let mut o = options("music");
            o.start_ms = start;
            o.end_ms = end;
            assert_eq!(validate(&p, &o).unwrap_err(), "LOCAL_SEPARATION_RANGE");
        }
        let mut o = options("music");
        o.device = "cuda:garbage".into();
        assert_eq!(validate(&p, &o).unwrap_err(), "DEVICE_UNAVAILABLE");
        p.tracks.retain(|t| t.role.as_deref() != Some("sfx"));
        assert_eq!(
            validate(&p, &options("music")).unwrap_err(),
            "LOCAL_SEPARATION_STEMS_REQUIRED"
        );
    }
    #[test]
    fn saved_local_request_and_format_twenty_are_backward_readable() {
        let p = fixture();
        let dir = tempfile::tempdir().unwrap();
        let root = project::create_root(dir.path(), "Format 20").unwrap();
        project::save(&root, &p).unwrap();
        assert_eq!(project::load(&root).unwrap().format_version, 20);
        let app = tauri::test::mock_app();
        let core = Core {
            data_dir: dir.path().to_path_buf(),
            model_dir: std::sync::Mutex::new(dir.path().to_path_buf()),
            session: std::sync::Mutex::new(Some(project::Session::new(root, p.clone()))),
            jobs: std::sync::Mutex::new(HashMap::new()),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let core = Arc::new(core);
        let id = jobs::create(&core, app.handle(), "separation", p.id.clone(), None);
        let saved = core.jobs.lock().unwrap().get(&id).unwrap().saved.clone();
        let old: jobs::PersistedJob =
            serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
        assert!(old.local_separation.is_none());
    }
    #[tokio::test]
    async fn preview_apply_is_atomic_rejects_stale_or_truncated_files_and_undo_keeps_originals() {
        use std::io::Write;
        let p = fixture();
        let temp = tempfile::tempdir().unwrap();
        let root = project::create_root(temp.path(), "Séparation locale 日本語").unwrap();
        let core = Arc::new(Core {
            data_dir: temp.path().to_path_buf(),
            model_dir: std::sync::Mutex::new(temp.path().to_path_buf()),
            session: std::sync::Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
            jobs: std::sync::Mutex::new(HashMap::new()),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
        });
        let app = tauri::test::mock_app();
        let id = jobs::create(&core, app.handle(), "separation", p.id.clone(), None);
        {
            let mut jobs = core.jobs.lock().unwrap();
            let job = jobs.get_mut(&id).unwrap();
            job.saved.record.status = "succeeded".into();
            job.saved.local_separation = Some(Request {
                root: root.clone(),
                project_id: p.id.clone(),
                source_path: p.media.as_ref().unwrap().path.clone(),
                options: options("music"),
                audio_snapshot: character_review::audio_snapshot(&p, None),
            });
        }
        let folder = root.join(format!("stems/local-{id}"));
        std::fs::create_dir(&folder).unwrap();
        fn wav(path: &std::path::Path) {
            let frames = 96000_u32;
            let data = frames * 4;
            let mut file = std::fs::File::create(path).unwrap();
            file.write_all(b"RIFF").unwrap();
            file.write_all(&(36 + data).to_le_bytes()).unwrap();
            file.write_all(b"WAVEfmt ").unwrap();
            file.write_all(&16_u32.to_le_bytes()).unwrap();
            for n in [1_u16, 2_u16] {
                file.write_all(&n.to_le_bytes()).unwrap();
            }
            for n in [48000_u32, 192000_u32] {
                file.write_all(&n.to_le_bytes()).unwrap();
            }
            for n in [4_u16, 16_u16] {
                file.write_all(&n.to_le_bytes()).unwrap();
            }
            file.write_all(b"data").unwrap();
            file.write_all(&data.to_le_bytes()).unwrap();
            file.write_all(&vec![0; data as usize]).unwrap();
        }
        for role in ["speech", "music", "sfx"] {
            wav(&folder.join(format!("{role}.wav")));
        }
        assert!(!result(&core, &id).unwrap().stale);
        assert!(core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .generations
            .is_empty());
        core.session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .project
            .tracks[0]
            .gain = 0.5;
        assert!(result(&core, &id).unwrap().stale);
        assert_eq!(
            apply(core.clone(), app.handle().clone(), id.clone())
                .await
                .unwrap_err(),
            "STALE_REVISION"
        );
        core.session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .project
            .tracks[0]
            .gain = 1.0;
        std::fs::write(folder.join("music.wav"), b"truncated").unwrap();
        assert!(apply(core.clone(), app.handle().clone(), id.clone())
            .await
            .is_err());
        assert!(core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .generations
            .is_empty());
        wav(&folder.join("music.wav"));
        let saved = apply(core.clone(), app.handle().clone(), id.clone())
            .await
            .unwrap();
        assert_eq!(saved.generations.len(), 3);
        assert_eq!(
            saved.media.as_ref().unwrap().path,
            p.media.as_ref().unwrap().path
        );
        assert_eq!(
            apply(core.clone(), app.handle().clone(), id.clone())
                .await
                .unwrap_err(),
            "LOCAL_SEPARATION_APPLIED"
        );
        let mut guard = core.session.lock().unwrap();
        let s = guard.as_mut().unwrap();
        s.history(false).unwrap();
        assert!(s.project.generations.is_empty());
        s.history(true).unwrap();
        assert_eq!(s.project.generations.len(), 3);
        assert!(folder.join("music.wav").is_file());
    }
}
