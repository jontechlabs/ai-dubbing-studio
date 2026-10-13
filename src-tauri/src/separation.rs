use crate::{
    domain::{id, io_error, Track},
    jobs, media, project, Core,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize)]
struct Model {
    url: String,
    sha256: String,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub installing: bool,
    pub devices: serde_json::Value,
}
fn resources<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let packaged = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("workers");
    if packaged.join("bandit_worker.py").is_file() {
        packaged
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../workers")
    }
}
fn runtime(core: &Core) -> PathBuf {
    core.data_dir.join("bandit-runtime")
}
fn python(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3"
    })
}
fn installed(core: &Core) -> bool {
    let root = runtime(core);
    python(&root).is_file()
        && root.join("ready.json").is_file()
        && root.join("checkpoint-multi.ckpt").is_file()
}

pub async fn status<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<Status, String> {
    let installing = core.jobs.lock().map_err(io_error)?.values().any(|job| {
        job.saved.record.kind == "runtime"
            && ["running", "queued"].contains(&job.saved.record.status.as_str())
    });
    let ready = installed(&core);
    let devices = if ready {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            media::command(&python(&runtime(&core)))
                .arg(resources(&app).join("bandit_worker.py"))
                .arg("--info")
                .output(),
        )
        .await;
        result
            .ok()
            .and_then(Result::ok)
            .filter(|result| result.status.success())
            .and_then(|result| serde_json::from_slice::<serde_json::Value>(&result.stdout).ok())
            .and_then(|value| value.get("devices").cloned())
            .unwrap_or(serde_json::json!([]))
    } else {
        serde_json::json!([])
    };
    Ok(Status {
        installed: ready
            && devices
                .as_array()
                .is_some_and(|devices| !devices.is_empty()),
        installing,
        devices,
    })
}

async fn fetch<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    url: &str,
    output: &Path,
    verification: (&str, u64),
    flag: &AtomicBool,
) -> Result<(), String> {
    let (expected, max) = verification;
    let request = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(io_error)?
        .get(url)
        .send();
    let mut response = tokio::select! { _ = jobs::cancelled(flag) => return Err("CANCELLED".into()), result=request => result.map_err(io_error)?.error_for_status().map_err(io_error)?, };
    let temporary = output.with_extension("download");
    let result = async {
        let mut file = tokio::fs::File::create(&temporary).await.map_err(io_error)?;
        let mut hash = Sha256::new(); let mut count=0_u64; let mut last=0_u64;
        while let Some(bytes) = tokio::select! { _ = jobs::cancelled(flag) => return Err("CANCELLED".into()), bytes = response.chunk() => bytes.map_err(io_error)? } {
            count += bytes.len() as u64;
            if count > max { return Err("DOWNLOAD_FAILED".into()); }
            hash.update(&bytes); file.write_all(&bytes).await.map_err(io_error)?;
            if count-last > (max/100).max(65536) { last=count; jobs::update(core, app, key, |job| job.progress=Some(count as f64 / max.max(1) as f64)); }
        }
        file.sync_all().await.map_err(io_error)?; drop(file);
        if format!("{:x}",hash.finalize()) != expected { return Err("MODEL_CHECKSUM_FAILED".into()); }
        tokio::fs::rename(&temporary,output).await.map_err(io_error)?;
        Ok(())
    }.await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

async fn process<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    executable: &Path,
    args: &[String],
    flag: &AtomicBool,
) -> Result<(), String> {
    let mut child = media::command(executable)
        .args(args)
        .env("PYTHONUNBUFFERED", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("PROCESS_FAILED")?).lines();
    let mut input = child.stdin.take().ok_or("PROCESS_FAILED")?;
    let paused = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(key)
        .ok_or("INVALID_PROJECT")?
        .paused
        .clone();
    let mut previous_pause = false;
    let mut clock = tokio::time::interval(std::time::Duration::from_millis(250));
    let stderr = child.stderr.take().ok_or("PROCESS_FAILED")?;
    let (log_core, log_app, log_key) = (core.clone(), app.clone(), key.to_owned());
    let logger = tauri::async_runtime::spawn(async move {
        let mut errors = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = errors.next_line().await {
            jobs::update(&log_core, &log_app, &log_key, |job| job.logs.push(line));
        }
    });
    loop {
        tokio::select! {
            _ = clock.tick() => {
                let current_pause = paused.load(Ordering::Relaxed);
                if current_pause != previous_pause {
                    let _ = input.write_all(if current_pause { b"pause\n" } else { b"resume\n" }).await;
                    previous_pause = current_pause;
                }
            },
            _ = jobs::cancelled(flag) => { let _=child.kill().await; let _=child.wait().await; let _=logger.await; return Err("CANCELLED".into()); },
            line = lines.next_line() => { let Some(line)=line.map_err(io_error)? else { break }; jobs::update(core,app,key,|job| {
                if let Ok(value)=serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(progress)=value["progress"].as_f64() { job.progress=Some(progress.clamp(0.0,1.0)); }
                    if let Some(stage)=value["stage"].as_str() { job.stage=stage.into(); }
                    if value.get("error").is_some() { job.logs.push(line); }
                } else { job.logs.push(line); }
            }); }
        }
    }
    let status = tokio::select! { _=jobs::cancelled(flag) => { let _=child.kill().await; let _=child.wait().await; let _=logger.await; return Err("CANCELLED".into()); }, result=child.wait()=>result.map_err(io_error)? };
    let _ = logger.await;
    if status.success() {
        Ok(())
    } else {
        Err("SEPARATION_FAILED".into())
    }
}
fn finish<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    result: &Result<(), String>,
) {
    jobs::update(core, app, key, |job| match result {
        Ok(()) => {
            job.status = "succeeded".into();
            job.stage = "done".into();
            job.progress = Some(1.0);
        }
        Err(error) => {
            job.status = if error == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            job.error = Some(error.clone());
        }
    });
}

pub fn install<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    cuda: bool,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("RUNTIME_PLATFORM_UNSUPPORTED".into());
    }
    if core.jobs.lock().map_err(io_error)?.values().any(|job| {
        ["runtime", "separation"].contains(&job.saved.record.kind.as_str())
            && ["queued", "running"].contains(&job.saved.record.status.as_str())
    }) {
        return Err("BUSY".into());
    }
    let key = jobs::create(&core, &app, "runtime", String::new(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .runtime_cuda = Some(cuda);
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()), permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|job|{job.status="running".into();job.stage="runtime".into();});
            let root=runtime(&core); std::fs::create_dir_all(root.join("python/Lib/site-packages")).map_err(io_error)?;
            let _=std::fs::remove_file(root.join("ready.json"));
            let archive=root.join("python.zip");
            fetch(&core,&app,&key,"https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",&archive,("4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",11133606),&flag).await?;
            let extract_root=root.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut archive=zip::ZipArchive::new(std::fs::File::open(extract_root.join("python.zip")).map_err(io_error)?).map_err(io_error)?;
                for i in 0..archive.len() { let mut entry=archive.by_index(i).map_err(io_error)?; let path=entry.enclosed_name().ok_or("INVALID_PATH")?; if entry.is_dir(){continue;} let output=extract_root.join("python").join(path); if let Some(parent)=output.parent(){std::fs::create_dir_all(parent).map_err(io_error)?;} std::io::copy(&mut entry,&mut std::fs::File::create(output).map_err(io_error)?).map_err(io_error)?; }
                project::atomic_write(&extract_root.join("python/python312._pth"),b"python312.zip\n.\nLib/site-packages\nimport site\n")
            }).await.map_err(io_error)??;
            let pip=root.join("pip.whl");
            fetch(&core,&app,&key,"https://files.pythonhosted.org/packages/b7/3f/945ef7ab14dc4f9d7f40288d2df998d1837ee0888ec3659c813487572faa/pip-25.2-py3-none-any.whl",&pip,("6d67a2b4e7f14d8b31b8b52648866fa717f45a1eb70e83002f4331d07e953717",1752557),&flag).await?;
            let interpreter=python(&root); let target=root.join("python/Lib/site-packages").to_string_lossy().into_owned();
            let bootstrap="import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pip',run_name='__main__')";
            let mut args=vec!["-c".into(),bootstrap.into(),pip.to_string_lossy().into_owned(),"install".into(),"--no-user".into(),"--upgrade".into(),"--target".into(),target.clone(),"torch==2.8.0".into(),"torchaudio==2.8.0".into(),"--index-url".into(),if cuda{"https://download.pytorch.org/whl/cu126"}else{"https://download.pytorch.org/whl/cpu"}.into()];
            jobs::update(&core,&app,&key,|job|{job.stage="dependencies".into();job.progress=None;});
            process(&core,&app,&key,&interpreter,&args,&flag).await?;
            args=vec!["-c".into(),bootstrap.into(),pip.to_string_lossy().into_owned(),"install".into(),"--no-user".into(),"--target".into(),target,"--index-url".into(),"https://pypi.org/simple".into(),"--no-deps".into(),"--upgrade".into(),"-r".into(),resources(&app).join("runtime-requirements.txt").to_string_lossy().into_owned()];
            process(&core,&app,&key,&interpreter,&args,&flag).await?;
            let model:Model=serde_json::from_slice(&std::fs::read(resources(&app).join("bandit-model.json")).map_err(io_error)?).map_err(io_error)?;
            jobs::update(&core,&app,&key,|job|{job.stage="model".into();job.progress=Some(0.0);});
            fetch(&core,&app,&key,&model.url,&root.join("checkpoint-multi.ckpt"),(&model.sha256,model.size),&flag).await?;
            process(&core,&app,&key,&interpreter,&[resources(&app).join("bandit_worker.py").to_string_lossy().into_owned(),"--info".into()],&flag).await?;
            project::atomic_write(&root.join("ready.json"),br#"{"version":1}"#)
        }.await;
        finish(&core, &app, &key, &result);
    });
    Ok(output)
}

pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    device: String,
) -> Result<String, String> {
    if core.jobs.lock().map_err(io_error)?.values().any(|job| {
        ["runtime", "separation"].contains(&job.saved.record.kind.as_str())
            && ["queued", "running", "paused"].contains(&job.saved.record.status.as_str())
    }) {
        return Err("BUSY".into());
    }
    if !installed(&core) {
        return Err("RUNTIME_REQUIRED".into());
    }
    if device != "auto"
        && device != "cpu"
        && !device
            .strip_prefix("cuda:")
            .is_some_and(|index| index.parse::<u32>().is_ok())
    {
        return Err("DEVICE_UNAVAILABLE".into());
    }
    let (root, project_id, input, index, source_path) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let media = s.project.media.as_ref().ok_or("MEDIA_MISSING")?;
        (
            s.root.clone(),
            s.project.id.clone(),
            project::asset(&s.root, &media.path)?,
            media.audio_stream_index.ok_or("NO_AUDIO")?,
            media.path.clone(),
        )
    };
    let key = jobs::create(&core, &app, "separation", project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .separation = Some(jobs::SeparationRequest {
        root: root.clone(),
        project_id: project_id.clone(),
        source_path: source_path.clone(),
        audio_index: index,
        device: device.clone(),
    });
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let relative = format!("stems/{key}");
        let folder = root.join(&relative);
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()), permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            jobs::update(&core,&app,&key,|job|{job.status="running".into();job.stage="audioExtract".into();});
            project::ensure_directory(&root,"stems")?;std::fs::create_dir(&folder).map_err(io_error)?;
            let audio=folder.join("input.wav");
            process(&core,&app,&key,&media::binary(&app,"ffmpeg")?,&["-hide_banner".into(),"-loglevel".into(),"error".into(),"-nostdin".into(),"-copyts".into(),"-start_at_zero".into(),"-protocol_whitelist".into(),"file,pipe".into(),"-i".into(),input.to_string_lossy().into_owned(),"-map".into(),format!("0:{index}"),"-vn".into(),"-ac".into(),"2".into(),"-ar".into(),"48000".into(),"-af".into(),"aresample=48000:first_pts=0".into(),"-c:a".into(),"pcm_s16le".into(),"-n".into(),audio.to_string_lossy().into_owned()],&flag).await?;
            jobs::update(&core,&app,&key,|job|{job.stage="separate".into();job.progress=Some(0.0);});
            process(&core,&app,&key,&python(&runtime(&core)),&[resources(&app).join("bandit_worker.py").to_string_lossy().into_owned(),"--input".into(),audio.to_string_lossy().into_owned(),"--output".into(),folder.to_string_lossy().into_owned(),"--model".into(),runtime(&core).join("checkpoint-multi.ckpt").to_string_lossy().into_owned(),"--device".into(),device.clone()],&flag).await?;
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            let frames=crate::audio_files::wav_frames(&folder.join("speech.wav"))?;
            for role in ["music","sfx"] { if crate::audio_files::wav_frames(&folder.join(format!("{role}.wav")))? != frames { return Err("SEPARATION_FAILED".into()); } }
            let duration=frames/48;
            jobs::update(&core,&app,&key,|job|job.stage="commit".into());
            let mut session=core.session.lock().map_err(io_error)?;let s=session.as_mut().ok_or("NO_PROJECT")?;
            if s.root!=root || s.project.id!=project_id || s.project.media.as_ref().is_none_or(|media|media.path!=source_path || media.audio_stream_index!=Some(index)){return Err("STALE_REVISION".into());}
            let mut next=s.project.clone();next.format_version=2;
            next.tracks.retain(|track|track.kind!="audio");
            if let Some(original)=next.tracks.iter_mut().find(|track|track.kind=="original"){original.mute=true;original.solo=false;}else{next.tracks.push(Track{id:"original".into(),kind:"original".into(),language:next.languages.source.clone(),mute:true,solo:false,gain:1.0,role:None,path:None,duration_ms:None,source_path:None,generation_id:None});}
            for role in ["speech","music","sfx"] { next.tracks.push(Track{id:id(),kind:"audio".into(),language:next.languages.source.clone(),mute:false,solo:false,gain:1.0,role:Some(role.into()),path:Some(format!("{relative}/{role}.wav")),duration_ms:Some(duration),source_path:Some(source_path.clone()),generation_id:Some(key.clone())}); }
            next.generations.push(serde_json::json!({"id":key,"kind":"separation","provider":"bandit-v2-multilingual","sourcePath":source_path,"audioStreamIndex":index,"device":device,"createdAt":crate::domain::now(),"directory":relative}));
            let saved=s.replace(next,s.project.revision)?;let _=app.emit("project-changed",saved);let _=std::fs::remove_file(audio);Ok(())
        }.await;
        if result.is_err()
            && folder.is_dir()
            && folder
                .canonicalize()
                .is_ok_and(|path| path.starts_with(root.join("stems")))
        {
            let _ = std::fs::remove_dir_all(&folder);
        }
        finish(&core, &app, &key, &result);
    });
    Ok(output)
}
