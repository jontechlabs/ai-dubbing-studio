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
fn root(core: &Core) -> PathBuf {
    core.data_dir.join("speaker-runtime")
}
fn manifest<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Manifest, String> {
    serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("speaker-model.json")).map_err(io_error)?,
    )
    .map_err(io_error)
}
fn installed(core: &Core) -> bool {
    let root = root(core);
    separation::python(&root).is_file()
        && root.join("ready.json").is_file()
        && root.join("speaker.onnx").is_file()
        && root.join("vad.onnx").is_file()
}
fn busy(core: &Core) -> bool {
    core.jobs.lock().is_ok_and(|jobs| {
        jobs.values().any(|job| {
            ["running", "queued", "paused"].contains(&job.saved.record.status.as_str())
                && [
                    "runtime",
                    "separation",
                    "speakerInstall",
                    "speakers",
                    "reference",
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
            if result.is_none_or(|info|info["runtimeReady"]!=true || info["version"]!="1.13.8"){return Err("SPEAKER_RUNTIME_FAILED".into());}
            project::atomic_write(&root.join("ready.json"),br#"{"version":"1.13.8"}"#)
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}
fn audio_source(project: &Project, root: &Path) -> Result<(PathBuf, u32), String> {
    if let Some(track) = project.tracks.iter().find(|track| {
        track.role.as_deref() == Some("speech")
            && track.source_path == project.media.as_ref().map(|media| media.path.clone())
    }) {
        return Ok((
            project::asset(root, track.path.as_deref().ok_or("MEDIA_MISSING")?)?,
            0,
        ));
    }
    let media = project.media.as_ref().ok_or("MEDIA_MISSING")?;
    Ok((
        project::asset(root, &media.path)?,
        media.audio_stream_index.ok_or("NO_AUDIO")?,
    ))
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    threshold: f64,
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
    let (request, lines, input, index) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.project.dialogues.is_empty() {
            return Err("NO_DIALOGUES".into());
        }
        let (input, index) = audio_source(&s.project, &s.root)?;
        (
            Request {
                root: s.root.clone(),
                project_id: s.project.id.clone(),
                source_path: s.project.media.as_ref().unwrap().path.clone(),
                threshold,
            },
            s.project
                .dialogues
                .iter()
                .map(|line| SpeakerLine {
                    id: line.id.clone(),
                    start_ms: line.start_ms,
                    end_ms: line.end_ms,
                })
                .collect::<Vec<_>>(),
            input,
            index,
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
            jobs::update(&core,&app,&key,|job|{job.status="running".into();job.stage="audioExtract".into();});
            project::ensure_directory(&request.root,"characters")?;std::fs::create_dir(&folder).map_err(io_error)?;let audio=folder.join("input.wav");let input_lines=folder.join("lines.json");project::atomic_write(&input_lines,&serde_json::to_vec(&lines).map_err(io_error)?)?;
            separation::process(&core,&app,&key,&media::binary(&app,"ffmpeg")?,&["-hide_banner".into(),"-loglevel".into(),"error".into(),"-nostdin".into(),"-copyts".into(),"-start_at_zero".into(),"-protocol_whitelist".into(),"file,pipe".into(),"-i".into(),input.to_string_lossy().into_owned(),"-map".into(),format!("0:{index}"),"-vn".into(),"-ac".into(),"1".into(),"-ar".into(),"16000".into(),"-af".into(),"aresample=16000:first_pts=0".into(),"-c:a".into(),"pcm_s16le".into(),"-n".into(),audio.to_string_lossy().into_owned()],&flag).await?;
            jobs::update(&core,&app,&key,|job|{job.stage="speakerEmbeddings".into();job.progress=Some(0.0);});
            separation::process(&core,&app,&key,&separation::python(&root(&core)),&[separation::resources(&app).join("speaker_worker.py").to_string_lossy().into_owned(),"--runtime".into(),root(&core).to_string_lossy().into_owned(),"--input".into(),audio.to_string_lossy().into_owned(),"--lines".into(),input_lines.to_string_lossy().into_owned(),"--output".into(),folder.to_string_lossy().into_owned(),"--threshold".into(),threshold.to_string()],&flag).await?;
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            let result:serde_json::Value=serde_json::from_slice(&std::fs::read(folder.join("result.json")).map_err(io_error)?).map_err(io_error)?;
            let mut clusters=result["clusters"].clone();for cluster in clusters.as_array_mut().ok_or("SPEAKER_ANALYSIS_FAILED")? {let file=cluster["referenceFile"].as_str().ok_or("SPEAKER_ANALYSIS_FAILED")?;let path=format!("{relative}/{file}");project::asset(&request.root,&path)?;cluster["referencePath"]=path.into();}
            let analysis:SpeakerAnalysis=serde_json::from_value(serde_json::json!({"id":key,"sourcePath":request.source_path,"lines":result["lines"],"clusters":clusters,"assignments":result["assignments"]})).map_err(io_error)?;
            let mut session=core.session.lock().map_err(io_error)?;let s=session.as_mut().ok_or("NO_PROJECT")?;if s.root!=request.root || s.project.id!=request.project_id || s.project.media.as_ref().is_none_or(|media|media.path!=request.source_path){return Err("STALE_REVISION".into());}
            let mut next=s.project.clone();next.format_version=3;next.speaker_analysis=Some(analysis);let saved=s.replace(next,s.project.revision)?;let _=app.emit("project-changed",saved);let _=std::fs::remove_file(audio);Ok(())
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

pub async fn reference<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    character_id: String,
    line_id: Option<String>,
    path: Option<String>,
    label: String,
) -> Result<Project, String> {
    let imported = line_id.is_none();
    if busy(&core) || jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let (root, project_id, input, index, start, duration, transcript) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if !s
            .project
            .characters
            .iter()
            .any(|character| character.id == character_id)
        {
            return Err("INVALID_CHARACTER".into());
        }
        if let Some(ref line_id) = line_id {
            let line = s
                .project
                .dialogues
                .iter()
                .find(|line| &line.id == line_id)
                .ok_or("NO_DIALOGUES")?;
            let (input, index) = audio_source(&s.project, &s.root)?;
            (
                s.root.clone(),
                s.project.id.clone(),
                input,
                index,
                line.start_ms,
                (line.end_ms - line.start_ms).min(20000),
                s.project
                    .source_cues
                    .iter()
                    .filter(|cue| line.source_cue_ids.contains(&cue.id))
                    .map(|cue| cue.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        } else {
            let input = PathBuf::from(path.ok_or("INVALID_PATH")?)
                .canonicalize()
                .map_err(io_error)?;
            if !input.is_file() {
                return Err("INVALID_PATH".into());
            }
            (
                s.root.clone(),
                s.project.id.clone(),
                input,
                0,
                0,
                20000,
                String::new(),
            )
        }
    };
    if duration < 500 {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    let folder = project::ensure_directory(&root, "characters")?;
    let key = id();
    let relative = format!("characters/reference-{key}.wav");
    let output = folder.join(format!("reference-{key}.wav"));
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
                &if imported {
                    "0:a:0".into()
                } else {
                    format!("0:{index}")
                },
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
    .await
    .map_err(|_| "REFERENCE_FAILED")?
    .map_err(io_error)?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&output);
        return Err("REFERENCE_FAILED".into());
    }
    let duration = crate::audio_files::reference_duration(&output)?;
    let mut session = core.session.lock().map_err(io_error)?;
    let s = session.as_mut().ok_or("NO_PROJECT")?;
    if s.root != root || s.project.id != project_id {
        return Err("STALE_REVISION".into());
    }
    let mut next = s.project.clone();
    next.format_version = 3;
    let character = next
        .characters
        .iter_mut()
        .find(|character| character.id == character_id)
        .ok_or("INVALID_CHARACTER")?;
    character.references.push(VoiceReference {
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
    });
    if character.default_reference_id.is_none() {
        character.default_reference_id = Some(key);
    }
    s.replace(next, s.project.revision)
}
