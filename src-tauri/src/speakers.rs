use crate::{
    domain::{id, io_error, Project, SpeakerAnalysis, SpeakerLine, VoiceReference},
    jobs, media, project, separation, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::Emitter;

#[derive(Deserialize)]
struct File {
    name: String,
    url: String,
    size: u64,
    sha256: String,
    kind: String,
}
#[derive(Deserialize)]
struct Manifest {
    files: Vec<File>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub scope: crate::character_review::Scope,
    pub root: PathBuf,
    pub project_id: String,
    pub source_path: String,
    pub threshold: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    installed: bool,
    installing: bool,
    size_bytes: u64,
}
pub(crate) fn root(core: &Core) -> PathBuf {
    crate::model_storage::root(core).join("speaker-runtime")
}
fn manifest<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Manifest, String> {
    serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("speaker-model.json")).map_err(io_error)?,
    )
    .map_err(io_error)
}
pub(crate) fn installed(core: &Core) -> bool {
    let root = root(core);
    separation::python(&root).is_file()
        && root.join("ready.json").is_file()
        && root.join("speaker.onnx").is_file()
        && root.join("vad.onnx").is_file()
        && std::fs::read(root.join("ready.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .is_some_and(|v| v["portraitReady"] == true)
}
fn busy(core: &Core) -> bool {
    core.jobs.lock().is_ok_and(|jobs| {
        jobs.values().any(|job| {
            ["running", "queued", "paused"].contains(&job.saved.record.status.as_str())
                && [
                    "runtime",
                    "separation",
                    "speakerInstall",
                    "ttsInstall",
                    "tts",
                    "speakers",
                    "reference",
                    "referenceTranscription",
                    "modelMove",
                ]
                .contains(&job.saved.record.kind.as_str())
        })
    })
}
pub fn status<R: tauri::Runtime>(core: &Core, app: &tauri::AppHandle<R>) -> Result<Status, String> {
    Ok(Status {
        installed: installed(core),
        installing: core.jobs.lock().map_err(io_error)?.values().any(|job| {
            job.saved.record.kind == "speakerInstall"
                && ["running", "queued"].contains(&job.saved.record.status.as_str())
        }),
        size_bytes: manifest(app)?
            .files
            .iter()
            .map(|file| file.size)
            .sum::<u64>()
            + 11133606,
    })
}
fn extract(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(archive).map_err(io_error)?).map_err(io_error)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io_error)?;
        let name = entry.enclosed_name().ok_or("INVALID_PATH")?;
        if entry.is_dir() {
            continue;
        }
        let path = destination.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        std::io::copy(
            &mut entry,
            &mut std::fs::File::create(path).map_err(io_error)?,
        )
        .map_err(io_error)?;
    }
    Ok(())
}
pub fn install<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("RUNTIME_PLATFORM_UNSUPPORTED".into());
    }
    if busy(&core) {
        return Err("BUSY".into());
    }
    let key = jobs::create(&core, &app, "speakerInstall", String::new(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .speaker_install = true;
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|job|{job.status="running".into();job.stage="runtime".into();});
            let root=root(&core);std::fs::create_dir_all(root.join("python/Lib/site-packages")).map_err(io_error)?;let _=std::fs::remove_file(root.join("ready.json"));
            let archive=root.join("python.zip");
            separation::fetch(&core,&app,&key,&["https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip".into()],&archive,("4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",11133606),&flag).await?;
            let destination=root.join("python");tauri::async_runtime::spawn_blocking(move||extract(&archive,&destination)).await.map_err(io_error)??;
            project::atomic_write(&root.join("python/python312._pth"),b"python312.zip\n.\nLib/site-packages\nimport site\n")?;
            for file in manifest(&app)?.files {
                crate::domain::valid_relative(&file.name)?;
                jobs::update(&core,&app,&key,|job|{job.stage=if file.kind=="model"{"speakerModel"}else{"dependencies"}.into();job.progress=Some(0.0);job.logs.push(format!("Installing verified file: {}",file.name));});
                let archive=root.join(&file.name);
                separation::fetch(&core,&app,&key,&[file.url],&archive,(&file.sha256,file.size),&flag).await?;
                if file.kind=="wheel" {let destination=root.join("python/Lib/site-packages");tauri::async_runtime::spawn_blocking(move||extract(&archive,&destination)).await.map_err(io_error)??;}
            }
            jobs::update(&core,&app,&key,|job|{job.stage="dependenciesCheck".into();job.progress=None;});
            let result=separation::probe(&separation::python(&root),&[separation::resources(&app).join("speaker_worker.py").to_string_lossy().into_owned(),"--info".into()],&flag,Duration::from_secs(30)).await?;
            if result.is_none_or(|info|info["runtimeReady"]!=true || info["version"]!="1.13.8" || info["portraitReady"]!=true){return Err("SPEAKER_RUNTIME_FAILED".into());}
            project::atomic_write(&root.join("ready.json"),br#"{"version":"1.13.8","portraitReady":true}"#)
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}

pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    threshold: f64,
) -> Result<String, String> {
    enqueue_scope(
        core,
        app,
        threshold,
        crate::character_review::Scope::default(),
    )
}

pub fn validate_scope(
    p: &Project,
    scope: &crate::character_review::Scope,
) -> Result<(u64, u64, String, Vec<SpeakerLine>), String> {
    let duration = p.media.as_ref().ok_or("MEDIA_MISSING")?.info.duration_ms;
    let (start, end) = match (scope.start_ms, scope.end_ms) {
        (None, None) => (0, duration),
        (Some(a), Some(b)) if a < b && b <= duration => (a, b),
        _ => return Err("SPEAKER_RANGE_INVALID".into()),
    };
    let track = crate::audio_patch::source_track(p, scope.track_id.as_deref())?;
    if let Some(id) = &scope.reference_character_id {
        let owner = p
            .characters
            .iter()
            .find(|c| &c.id == id)
            .ok_or("INVALID_CHARACTER")?;
        if owner.references.is_empty() {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
    }
    let lines = p
        .dialogues
        .iter()
        .filter(|l| l.start_ms < end && l.end_ms > start)
        .map(|l| SpeakerLine {
            id: l.id.clone(),
            start_ms: l.start_ms,
            end_ms: l.end_ms,
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err("NO_DIALOGUES".into());
    }
    Ok((start, end, track.id, lines))
}

pub fn enqueue_scope<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    threshold: f64,
    scope: crate::character_review::Scope,
) -> Result<String, String> {
    if !installed(&core) {
        return Err("SPEAKER_RUNTIME_REQUIRED".into());
    }
    if busy(&core) || jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    if !threshold.is_finite() || !(0.45..=0.8).contains(&threshold) {
        return Err("INVALID_PROJECT".into());
    }
    let (request, snapshot, lines, start, end, track_id) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let (start, end, track_id, lines) = validate_scope(&s.project, &scope)?;
        (
            Request {
                root: s.root.clone(),
                project_id: s.project.id.clone(),
                source_path: s.project.media.as_ref().unwrap().path.clone(),
                threshold,
                scope,
            },
            s.project.clone(),
            lines,
            start,
            end,
            track_id,
        )
    };
    let key = jobs::create(&core, &app, "speakers", request.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .unwrap()
        .saved
        .speaker_request = Some(request.clone());
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let relative = format!("characters/analysis-{key}");
        let folder = request.root.join(&relative);
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="audioExtract".into();});
            project::ensure_directory(&request.root,"characters")?;
            std::fs::create_dir(&folder).map_err(io_error)?;
            let audio=folder.join("input.wav");
            crate::audio_patch::snippet(&core,&app,&key,&snapshot,&request.root,crate::audio_patch::Snippet{track_id:&track_id,start_ms:start,end_ms:end,channels:1,rate:16000,levels:crate::audio_patch::SnippetLevels::Reference},&audio,&flag).await?;
            let input_lines=folder.join("lines.json");
            project::atomic_write(&input_lines,&serde_json::to_vec(&lines).map_err(io_error)?)?;
            let mut args=vec![separation::resources(&app).join("speaker_worker.py").to_string_lossy().into_owned(),"--runtime".into(),root(&core).to_string_lossy().into_owned(),"--input".into(),audio.to_string_lossy().into_owned(),"--lines".into(),input_lines.to_string_lossy().into_owned(),"--output".into(),folder.to_string_lossy().into_owned(),"--threshold".into(),threshold.to_string(),"--offset-ms".into(),start.to_string()];
            if let Some(id)=&request.scope.reference_character_id {
                let owner=snapshot.characters.iter().find(|c|&c.id==id).ok_or("INVALID_CHARACTER")?;
                let mut paths=vec![];
                for (i,r) in owner.references.iter().take(32).enumerate() {
                    let input=project::asset(&request.root,&r.path)?;
                    let output=folder.join(format!("enrollment-{i}.wav"));
                    separation::process(&core,&app,&key,&media::binary(&app,"ffmpeg")?,&["-nostdin".into(),"-hide_banner".into(),"-v".into(),"error".into(),"-protocol_whitelist".into(),"file,pipe".into(),"-i".into(),input.to_string_lossy().into_owned(),"-t".into(),"20".into(),"-ac".into(),"1".into(),"-ar".into(),"16000".into(),"-c:a".into(),"pcm_s16le".into(),"-n".into(),output.to_string_lossy().into_owned()],&flag).await?;
                    paths.push(output.to_string_lossy().into_owned());
                }
                let file=folder.join("enrollments.json");project::atomic_write(&file,&serde_json::to_vec(&paths).map_err(io_error)?)?;
                args.extend(["--references".into(),file.to_string_lossy().into_owned(),"--reference-character".into(),id.clone()]);
            }
            jobs::update(&core,&app,&key,|j|{j.stage="speakerEmbeddings".into();j.progress=Some(0.0);});
            separation::process(&core,&app,&key,&separation::python(&root(&core)),&args,&flag).await?;
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            let result:serde_json::Value=serde_json::from_slice(&std::fs::read(folder.join("result.json")).map_err(io_error)?).map_err(io_error)?;
            let mut clusters=result["clusters"].clone();
            for c in clusters.as_array_mut().ok_or("SPEAKER_ANALYSIS_FAILED")? {
                let file=c["referenceFile"].as_str().ok_or("SPEAKER_ANALYSIS_FAILED")?;
                let speaker=c["speaker"].as_u64().ok_or("SPEAKER_ANALYSIS_FAILED")?;
                if speaker>=32 || file!=format!("reference-{speaker}.wav"){return Err("SPEAKER_ANALYSIS_FAILED".into());}
                let path=format!("{relative}/{file}");project::asset(&request.root,&path)?;c["referencePath"]=path.into();
            }
            let mut analysis:SpeakerAnalysis=serde_json::from_value(serde_json::json!({"id":key,"sourcePath":request.source_path,"lines":lines,"clusters":clusters,"assignments":result["assignments"],"scope":request.scope,"audioSnapshot":crate::character_review::audio_snapshot(&snapshot,request.scope.reference_character_id.as_deref()),"originalAssignments":snapshot.dialogues.iter().filter(|l|lines.iter().any(|row|row.id==l.id)).map(|l|(l.id.clone(),l.character_id.clone())).collect::<std::collections::HashMap<_,_>>()})).map_err(io_error)?;
            let assigned=analysis.assignments.iter().map(|a|a.dialogue_id.as_str()).collect::<std::collections::HashSet<_>>();
            if assigned.len()!=lines.len() || analysis.assignments.len()!=lines.len() || lines.iter().any(|l|!assigned.contains(l.id.as_str())){return Err("SPEAKER_ANALYSIS_FAILED".into());}
            crate::character_review::propose_portraits(&core,&app,&key,&snapshot,&request.root,&folder,&relative,&mut analysis,&flag).await?;
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            let mut session=core.session.lock().map_err(io_error)?;
            let s=session.as_mut().ok_or("NO_PROJECT")?;
            if s.root!=request.root || s.project.id!=request.project_id || s.project.media.as_ref().is_none_or(|m|m.path!=request.source_path) || crate::character_review::audio_snapshot(&s.project,request.scope.reference_character_id.as_deref())!=crate::character_review::audio_snapshot(&snapshot,request.scope.reference_character_id.as_deref()) || lines.iter().any(|l|!s.project.dialogues.iter().any(|v|v.id==l.id && v.start_ms==l.start_ms && v.end_ms==l.end_ms && (!request.scope.replace_assigned || snapshot.dialogues.iter().find(|old|old.id==l.id).is_some_and(|old|old.character_id==v.character_id)))) {return Err("STALE_REVISION".into());}
            let mut next=s.project.clone();next.format_version=next.format_version.max(20);next.speaker_analysis=Some(analysis);
            let saved=s.replace(next,s.project.revision)?;let _=app.emit("project-changed",saved);
            let _=std::fs::remove_file(audio);
            Ok(())
        }.await;
        if result.is_err()
            && folder
                .canonicalize()
                .is_ok_and(|path| path.starts_with(request.root.join("characters")))
        {
            let _ = std::fs::remove_dir_all(&folder);
        }
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSpan {
    pub start_ms: u64,
    pub end_ms: u64,
}
pub struct ReferenceFile {
    pub path: String,
    pub range: Option<ReferenceSpan>,
}
impl From<String> for ReferenceFile {
    fn from(path: String) -> Self {
        Self { path, range: None }
    }
}
pub fn validate_span(span: &ReferenceSpan, duration: u64) -> Result<(), String> {
    if span.end_ms > duration
        || span.end_ms <= span.start_ms
        || !(1000..=20000).contains(&(span.end_ms - span.start_ms))
    {
        return Err("INVALID_REFERENCE_RANGE".into());
    }
    Ok(())
}
pub enum ReferenceTarget {
    Character(String),
    Dialogue {
        line_id: Option<String>,
        options: Box<crate::tts::Options>,
    },
}

pub async fn reference<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    target: ReferenceTarget,
    line_id: Option<String>,
    file: Option<ReferenceFile>,
    label: String,
) -> Result<Project, String> {
    if busy(&core) || jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let (root, project_id, revision, input, start, duration, transcript, snapshot) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        match &target {
            ReferenceTarget::Character(id) => {
                if !s.project.characters.iter().any(|c| &c.id == id) {
                    return Err("INVALID_CHARACTER".into());
                }
            }
            ReferenceTarget::Dialogue { line_id, options } => {
                options.validate()?;
                if line_id
                    .as_ref()
                    .is_some_and(|id| !s.project.dialogues.iter().any(|l| &l.id == id))
                {
                    return Err("NO_DIALOGUES".into());
                }
            }
        }
        if let Some(ref line_id) = line_id {
            let line = s
                .project
                .dialogues
                .iter()
                .find(|line| &line.id == line_id)
                .ok_or("NO_DIALOGUES")?;
            let track = crate::audio_patch::source_track(&s.project, None)?;
            let input = PathBuf::from(track.id);
            (
                s.root.clone(),
                s.project.id.clone(),
                s.project.revision,
                input,
                line.start_ms,
                (line.end_ms - line.start_ms).min(20000),
                s.project
                    .source_cues
                    .iter()
                    .filter(|cue| line.source_cue_ids.contains(&cue.id))
                    .map(|cue| cue.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                Some(s.project.clone()),
            )
        } else {
            let input = PathBuf::from(&file.as_ref().ok_or("INVALID_PATH")?.path)
                .canonicalize()
                .map_err(io_error)?;
            if !input.is_file() {
                return Err("INVALID_PATH".into());
            }
            (
                s.root.clone(),
                s.project.id.clone(),
                s.project.revision,
                input,
                file.as_ref()
                    .and_then(|f| f.range.as_ref())
                    .map_or(0, |s| s.start_ms),
                file.as_ref()
                    .and_then(|f| f.range.as_ref())
                    .map_or(20000, |s| s.end_ms.saturating_sub(s.start_ms)),
                String::new(),
                None,
            )
        }
    };
    if let Some(span) = file.as_ref().and_then(|f| f.range.as_ref()) {
        validate_span(span, u64::MAX)?;
        let info = media::probe_audio(&app, &input).await?;
        validate_span(span, info.duration_ms)?;
    }
    if duration < 500 {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    let folder = project::ensure_directory(&root, "characters")?;
    let key = id();
    let relative = format!("characters/reference-{key}.wav");
    let output = folder.join(format!("reference-{key}.wav"));
    if let Some(p) = snapshot {
        let flag = std::sync::atomic::AtomicBool::new(false);
        let result = tokio::time::timeout(
            Duration::from_secs(60),
            crate::audio_patch::snippet(
                &core,
                &app,
                "",
                &p,
                &root,
                crate::audio_patch::Snippet {
                    track_id: input.to_str().ok_or("INVALID_AUDIO_TRANSFER")?,
                    start_ms: start,
                    end_ms: start + duration,
                    channels: 1,
                    rate: 24000,
                    levels: crate::audio_patch::SnippetLevels::Reference,
                },
                &output,
                &flag,
            ),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            let _ = std::fs::remove_file(&output);
            return Err("REFERENCE_FAILED".into());
        }
    } else {
        let result = tokio::time::timeout(
            Duration::from_secs(60),
            media::command(&media::binary(&app, "ffmpeg")?)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-nostdin",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-i",
                ])
                .arg(&input)
                .args([
                    "-map",
                    "0:a:0",
                    "-ss",
                    &format!("{:.3}", start as f64 / 1000.0),
                    "-t",
                    &format!("{:.3}", duration as f64 / 1000.0),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "24000",
                    "-c:a",
                    "pcm_s16le",
                    "-n",
                ])
                .arg(&output)
                .output(),
        )
        .await;
        let Ok(Ok(result)) = result else {
            let _ = std::fs::remove_file(&output);
            return Err("REFERENCE_FAILED".into());
        };
        if !result.status.success() {
            let _ = std::fs::remove_file(&output);
            return Err("REFERENCE_FAILED".into());
        }
    }
    let result = (|| {
        let duration = crate::audio_files::reference_duration(&output)?;
        if matches!(target, ReferenceTarget::Dialogue { .. }) && duration < 1000 {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        let mut session = core.session.lock().map_err(io_error)?;
        let s = session.as_mut().ok_or("NO_PROJECT")?;
        if s.root != root || s.project.id != project_id || s.project.revision != revision {
            return Err("STALE_REVISION".into());
        }
        let mut next = s.project.clone();
        next.format_version = next.format_version.max(3);
        let label = if let Some(span) = file.as_ref().and_then(|f| f.range.as_ref()) {
            format!(
                "{} · {:.3}–{:.3} s",
                if label.trim().is_empty() {
                    "Audio"
                } else {
                    &label
                },
                span.start_ms as f64 / 1000.0,
                span.end_ms as f64 / 1000.0
            )
        } else {
            label
        };
        let reference = VoiceReference {
            id: key.clone(),
            label: if label.trim().is_empty() {
                "Neutral".into()
            } else {
                label
            },
            path: relative,
            duration_ms: duration,
            transcript,
            source_dialogue_id: line_id,
        };
        match target {
            ReferenceTarget::Character(character_id) => {
                let character = next
                    .characters
                    .iter_mut()
                    .find(|c| c.id == character_id)
                    .ok_or("INVALID_CHARACTER")?;
                character.references.push(reference);
                if character.default_reference_id.is_none() {
                    character.default_reference_id = Some(key);
                }
            }
            ReferenceTarget::Dialogue {
                line_id,
                mut options,
            } => {
                next.format_version = next.format_version.max(9);
                options.reference_mode = "file".into();
                options.reference_id = Some(key);
                next.voice_references.push(reference);
                if let Some(line_id) = line_id {
                    next.dialogues
                        .iter_mut()
                        .find(|l| l.id == line_id)
                        .ok_or("NO_DIALOGUES")?
                        .voice_settings = Some(*options);
                }
            }
        }
        s.replace(next, s.project.revision)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&output);
    }
    result
}
