use crate::{
    domain::{id, io_error, Track},
    downloads, jobs, media, project, Core,
};
use serde::{Deserialize, Serialize};
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
    #[serde(default, rename = "fallbackUrls")]
    fallback_urls: Vec<String>,
    sha256: String,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub installing: bool,
    pub devices: serde_json::Value,
    pub unavailable_devices: serde_json::Value,
    pub cuda_version: Option<String>,
    pub device_probe_warning: Option<String>,
}
pub(crate) fn resources<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
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
    crate::model_storage::root(core).join("bandit-runtime")
}
pub(crate) fn python(root: &Path) -> PathBuf {
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
    // Keep model relocation from deleting a Python executable while a probe uses it.
    let permit = core.gate.clone().try_acquire_owned().ok();
    let installing = core.jobs.lock().map_err(io_error)?.values().any(|job| {
        job.saved.record.kind == "runtime"
            && ["running", "queued"].contains(&job.saved.record.status.as_str())
    });
    let ready = installed(&core);
    let inventory = if ready && permit.is_some() {
        probe(
            &python(&runtime(&core)),
            &[
                resources(&app)
                    .join("bandit_worker.py")
                    .to_string_lossy()
                    .into_owned(),
                "--info".into(),
            ],
            &AtomicBool::new(false),
            std::time::Duration::from_secs(30),
        )
        .await?
    } else {
        None
    };
    let warning = (ready && permit.is_some() && inventory.is_none())
        .then(|| "DEVICE_PROBE_FAILED".to_owned());
    let metadata: serde_json::Value = std::fs::read(runtime(&core).join("ready.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let inventory = inventory.unwrap_or_else(|| serde_json::json!({"devices":[{"id":"cpu","name":"CPU"}],"cudaVersion":metadata["cudaVersion"]}));
    let devices = inventory
        .get("devices")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    Ok(Status {
        installed: ready,
        installing,
        devices,
        unavailable_devices: inventory
            .get("unavailableDevices")
            .cloned()
            .unwrap_or(serde_json::json!([])),
        cuda_version: inventory
            .get("cudaVersion")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        device_probe_warning: warning,
    })
}

pub(crate) async fn fetch<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    urls: &[String],
    output: &Path,
    verification: (&str, u64),
    flag: &AtomicBool,
) -> Result<(), String> {
    let (expected, max) = verification;
    downloads::fetch(
        &downloads::client()?,
        &downloads::Spec {
            urls,
            sha256: expected,
            size: max,
        },
        output,
        flag,
        |event| match event {
            downloads::Event::Log(line) => jobs::update(core, app, key, |job| job.logs.push(line)),
            downloads::Event::Progress(bytes) => jobs::update(core, app, key, |job| {
                job.progress = Some(bytes as f64 / max.max(1) as f64)
            }),
        },
    )
    .await
}

async fn runtime_usable<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    cuda: bool,
    flag: &AtomicBool,
) -> Result<bool, String> {
    if !python(root).is_file() {
        return Ok(false);
    }
    let info = probe(
        &python(root),
        &[
            resources(app)
                .join("bandit_worker.py")
                .to_string_lossy()
                .into_owned(),
            "--runtime-info".into(),
        ],
        flag,
        std::time::Duration::from_secs(60),
    )
    .await?;
    Ok(info.is_some_and(|info| runtime_matches(&info, cuda)))
}

// Probes have no pause/resume protocol. Close stdin from the start and bound
// their entire lifetime, including driver initialization and process exit.
pub(crate) async fn probe(
    executable: &Path,
    args: &[String],
    flag: &AtomicBool,
    limit: std::time::Duration,
) -> Result<Option<serde_json::Value>, String> {
    let result = tokio::select! {
        _ = jobs::cancelled(flag) => return Err("CANCELLED".into()),
        result = tokio::time::timeout(limit, media::command(executable).args(args).env("PYTHONUNBUFFERED", "1").stdin(std::process::Stdio::null()).output()) => result,
    };
    Ok(result
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice(&output.stdout).ok()))
}

fn runtime_matches(info: &serde_json::Value, cuda: bool) -> bool {
    info["runtimeReady"] == true
        && info["torchVersion"] == "2.8.0"
        && info["cudaVersion"].as_str() == if cuda { Some("12.8") } else { None }
}

pub(crate) async fn process<R: tauri::Runtime>(
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
    let mut worker_error = None;
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
                    if value.get("progress").is_some_and(|progress|progress.is_null()) { job.progress=None; }
                    if let Some(progress)=value["progress"].as_f64() { job.progress=Some(progress.clamp(0.0,1.0)); }
                    if let Some(stage)=value["stage"].as_str() { job.stage=stage.into(); }
                    if let Some(error)=value["error"].as_str() { worker_error=Some(error.to_owned()); job.logs.push(line); }
                } else { job.logs.push(line); }
            }); }
        }
    }
    let status = tokio::select! { _=jobs::cancelled(flag) => { let _=child.kill().await; let _=child.wait().await; let _=logger.await; return Err("CANCELLED".into()); }, result=child.wait()=>result.map_err(io_error)? };
    let _ = logger.await;
    if status.success() {
        Ok(())
    } else {
        Err(worker_error.unwrap_or_else(|| "SEPARATION_FAILED".into()))
    }
}
pub(crate) fn finish<R: tauri::Runtime>(
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
        [
            "runtime",
            "separation",
            "speakerInstall",
            "ttsInstall",
            "tts",
            "speakers",
            "modelMove",
        ]
        .contains(&job.saved.record.kind.as_str())
            && ["queued", "running", "paused"].contains(&job.saved.record.status.as_str())
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
            jobs::update(&core,&app,&key,|job|{job.stage="dependenciesCheck".into();job.progress=None;});
            if runtime_usable(&app,&root,cuda,&flag).await? {
                jobs::update(&core,&app,&key,|job|job.logs.push("Existing Python/Bandit dependencies verified; installation reused.".into()));
            } else {
            jobs::update(&core,&app,&key,|job|job.stage="runtime".into());
            let archive=root.join("python.zip");
            fetch(&core,&app,&key,&["https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip".into()],&archive,("4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",11133606),&flag).await?;
            let extract_root=root.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut archive=zip::ZipArchive::new(std::fs::File::open(extract_root.join("python.zip")).map_err(io_error)?).map_err(io_error)?;
                for i in 0..archive.len() { let mut entry=archive.by_index(i).map_err(io_error)?; let path=entry.enclosed_name().ok_or("INVALID_PATH")?; if entry.is_dir(){continue;} let output=extract_root.join("python").join(path); if let Some(parent)=output.parent(){std::fs::create_dir_all(parent).map_err(io_error)?;} std::io::copy(&mut entry,&mut std::fs::File::create(output).map_err(io_error)?).map_err(io_error)?; }
                project::atomic_write(&extract_root.join("python/python312._pth"),b"python312.zip\n.\nLib/site-packages\nimport site\n")
            }).await.map_err(io_error)??;
            let pip=root.join("pip.whl");
            fetch(&core,&app,&key,&["https://files.pythonhosted.org/packages/b7/3f/945ef7ab14dc4f9d7f40288d2df998d1837ee0888ec3659c813487572faa/pip-25.2-py3-none-any.whl".into()],&pip,("6d67a2b4e7f14d8b31b8b52648866fa717f45a1eb70e83002f4331d07e953717",1752557),&flag).await?;
            let interpreter=python(&root); let target=root.join("python/Lib/site-packages").to_string_lossy().into_owned();
            let bootstrap="import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pip',run_name='__main__')";
            let mut args=vec!["-c".into(),bootstrap.into(),pip.to_string_lossy().into_owned(),"install".into(),"--no-user".into(),"--upgrade".into(),"--target".into(),target.clone(),"torch==2.8.0".into(),"torchaudio==2.8.0".into(),"--index-url".into(),if cuda{"https://download.pytorch.org/whl/cu128"}else{"https://download.pytorch.org/whl/cpu"}.into()];
            jobs::update(&core,&app,&key,|job|{job.stage="dependencies".into();job.progress=None;});
            process(&core,&app,&key,&interpreter,&args,&flag).await?;
            args=vec!["-c".into(),bootstrap.into(),pip.to_string_lossy().into_owned(),"install".into(),"--no-user".into(),"--target".into(),target,"--index-url".into(),"https://pypi.org/simple".into(),"--no-deps".into(),"--upgrade".into(),"-r".into(),resources(&app).join("runtime-requirements.txt").to_string_lossy().into_owned()];
            process(&core,&app,&key,&interpreter,&args,&flag).await?;
            if !runtime_usable(&app,&root,cuda,&flag).await? { return Err("RUNTIME_INSTALL_FAILED".into()); }
            }
            let model:Model=serde_json::from_slice(&std::fs::read(resources(&app).join("bandit-model.json")).map_err(io_error)?).map_err(io_error)?;
            jobs::update(&core,&app,&key,|job|{job.stage="model".into();job.progress=Some(0.0);});
            let mut urls=vec![model.url]; urls.extend(model.fallback_urls);
            fetch(&core,&app,&key,&urls,&root.join("checkpoint-multi.ckpt"),(&model.sha256,model.size),&flag).await?;
            jobs::update(&core,&app,&key,|job|{job.stage="devicesCheck".into();job.progress=None;job.logs.push("Model verified. Checking compute devices (maximum 30 seconds).".into());});
            let inventory=probe(&python(&root),&[resources(&app).join("bandit_worker.py").to_string_lossy().into_owned(),"--info".into()],&flag,std::time::Duration::from_secs(30)).await?;
            jobs::update(&core,&app,&key,|job|job.logs.push(match inventory { Some(ref info)=>format!("Compute devices checked: {info}"),None=>"Device detection did not complete successfully within 30 seconds. Installation is ready for CPU; refresh devices from Audio to retry GPU detection.".into() }));
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            project::atomic_write(&root.join("ready.json"),&serde_json::to_vec(&serde_json::json!({"version":1,"cudaVersion":if cuda {Some("12.8")} else {None}})).map_err(io_error)?)
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
        [
            "runtime",
            "separation",
            "speakerInstall",
            "ttsInstall",
            "tts",
            "speakers",
            "modelMove",
        ]
        .contains(&job.saved.record.kind.as_str())
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
            let mut next=s.project.clone();next.format_version=next.format_version.max(2);
            next.tracks.retain(|track|track.kind!="audio");
            if let Some(original)=next.tracks.iter_mut().find(|track|track.kind=="original"){original.mute=true;original.solo=false;}else{next.tracks.push(Track{id:"original".into(),kind:"original".into(),language:next.languages.source.clone(),mute:true,solo:false,gain:1.0,role:None,path:None,duration_ms:None,source_path:None,generation_id:None,regions:vec![],regions_enabled:None});}
            for role in ["speech","music","sfx"] { next.tracks.push(Track{id:id(),kind:"audio".into(),language:next.languages.source.clone(),mute:false,solo:false,gain:1.0,role:Some(role.into()),path:Some(format!("{relative}/{role}.wav")),duration_ms:Some(duration),source_path:Some(source_path.clone()),generation_id:Some(key.clone()),regions:vec![],regions_enabled:None}); }
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

#[cfg(test)]
mod tests {
    use super::runtime_matches;
    use std::{path::PathBuf, sync::atomic::AtomicBool, time::Duration};

    fn shell(script: &str) -> (PathBuf, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe".into(),
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    script.into(),
                ],
            )
        } else {
            ("sh".into(), vec!["-c".into(), script.into()])
        }
    }

    #[tokio::test]
    async fn probe_closes_stdin_and_collects_json_after_exit() {
        let (executable, args) = shell(if cfg!(windows) {
            "[Console]::In.ReadToEnd() | Out-Null; [Console]::Out.Write('{\"runtimeReady\":true}')"
        } else {
            "cat >/dev/null; printf '%s' '{\"runtimeReady\":true}'"
        });
        let info = super::probe(
            &executable,
            &args,
            &AtomicBool::new(false),
            Duration::from_secs(10),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(info["runtimeReady"], true);
    }

    #[tokio::test]
    async fn stalled_probe_has_a_deadline_and_can_be_cancelled() {
        let (executable, args) = shell(if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "exec sleep 30"
        });
        let started = std::time::Instant::now();
        assert!(super::probe(
            &executable,
            &args,
            &AtomicBool::new(false),
            Duration::from_millis(100)
        )
        .await
        .unwrap()
        .is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            super::probe(
                &executable,
                &args,
                &AtomicBool::new(true),
                Duration::from_secs(30)
            )
            .await
            .unwrap_err(),
            "CANCELLED"
        );
    }
    #[test]
    fn retry_reuses_only_a_complete_environment_for_the_requested_variant() {
        let cpu =
            serde_json::json!({"runtimeReady":true,"torchVersion":"2.8.0","cudaVersion":null});
        let old_cuda =
            serde_json::json!({"runtimeReady":true,"torchVersion":"2.8.0","cudaVersion":"12.6"});
        let cuda =
            serde_json::json!({"runtimeReady":true,"torchVersion":"2.8.0","cudaVersion":"12.8"});
        assert!(runtime_matches(&cpu, false));
        assert!(!runtime_matches(&cpu, true));
        assert!(!runtime_matches(&old_cuda, true));
        assert!(runtime_matches(&cuda, true));
        assert!(!runtime_matches(&cuda, false));
        assert!(!runtime_matches(
            &serde_json::json!({"runtimeReady":false,"torchVersion":"2.8.0","cudaVersion":"12.8"}),
            true
        ));
        assert!(!runtime_matches(
            &serde_json::json!({"runtimeReady":true,"torchVersion":"2.7.0","cudaVersion":"12.8"}),
            true
        ));
    }
}
