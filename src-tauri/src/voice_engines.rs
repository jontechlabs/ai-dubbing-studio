use crate::{domain::io_error, jobs, media, project, separation, tts, Core};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct File {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    pub provider_id: String,
    pub name: String,
    pub engine: String,
    pub revision: String,
    pub files: Vec<File>,
}
#[derive(Deserialize)]
struct Manifest {
    engine: File,
    variants: Vec<Variant>,
}
pub const IDS: &[&str] = &[
    "fish-s2-gguf-q8",
    "qwen3-06b-gguf-q8",
    "qwen3-17b-gguf-q8",
    "fish-s2-fp8",
    "drama3-comfy-fp8",
    "chatterbox-vc",
    "voxcpm2-bf16",
    "chatterbox-multilingual-v3",
];
pub(crate) fn multilingual(id: &str) -> bool {
    [
        "voxcpm2-bf16",
        "chatterbox-multilingual-v3",
        "chatterbox-vc",
    ]
    .contains(&id)
}
pub fn root(core: &Core) -> PathBuf {
    crate::model_storage::root(core).join("voice-engines")
}
fn manifest<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Manifest, String> {
    serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("voice-engines.json")).map_err(io_error)?,
    )
    .map_err(io_error)
}
pub fn variant<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> Result<Variant, String> {
    manifest(app)?
        .variants
        .into_iter()
        .find(|v| v.id == id)
        .ok_or("INVALID_TTS_REQUEST".into())
}
pub fn installed(core: &Core, id: &str) -> bool {
    IDS.contains(&id)
        && root(core).join(id).join("ready.json").is_file()
        && if id == "fish-s2-fp8" {
            separation::python(&root(core).join("fish-runtime")).is_file()
                && root(core).join(id).join("model.safetensors").is_file()
        } else if id == "drama3-comfy-fp8" {
            separation::python(&root(core).join("drama-runtime")).is_file()
                && root(core)
                    .join(id)
                    .join("drama3_fp8experts_bf16.safetensors")
                    .is_file()
                && root(core)
                    .join(id)
                    .join("drama3_codec.safetensors")
                    .is_file()
        } else if multilingual(id) {
            separation::python(&root(core).join("multilingual-runtime")).is_file()
                && root(core)
                    .join(id)
                    .join(if id == "voxcpm2-bf16" {
                        "model.safetensors"
                    } else if id == "chatterbox-vc" {
                        "s3gen.safetensors"
                    } else {
                        "t3_mtl23ls_v3.safetensors"
                    })
                    .is_file()
        } else {
            root(core).join("audiocpp/audiocpp_cli.exe").is_file()
                && root(core).join("audiocpp/audiocpp_server.exe").is_file()
                && root(core).join(id).join("model.gguf").is_file()
        }
}
pub fn parse_devices(output: &str) -> Vec<serde_json::Value> {
    output.lines().filter_map(|line|{
        let (prefix,rest)=line.split_once(' ')?;
        let (backend,index)=prefix.split_once(':')?;
        if !["Vulkan","CPU"].contains(&backend) || index.parse::<u32>().is_err(){return None;}
        let name=rest.split('"').nth(1)?;
        Some(serde_json::json!({"id":if backend=="CPU"{"cpu".into()}else{format!("vulkan:{index}")},"name":name,"discrete":rest.contains("[DGPU]") || (name.to_lowercase().contains("nvidia") && !rest.contains("[IGPU]"))}))
    }).collect()
}
pub async fn inventory(core: &Core) -> Vec<serde_json::Value> {
    let command = root(core).join("audiocpp/audiocpp_cli.exe");
    if !command.is_file() {
        return vec![];
    }
    match tokio::time::timeout(
        Duration::from_secs(30),
        media::command(&command).arg("--list-devices").output(),
    )
    .await
    {
        Ok(Ok(output)) if output.status.success() => {
            parse_devices(&String::from_utf8_lossy(&output.stdout))
        }
        _ => vec![],
    }
}
pub async fn status<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    include_cuda: bool,
) -> Result<serde_json::Value, String> {
    let permit = core.gate.clone().try_acquire_owned().ok();
    let devices = if permit.is_some() {
        inventory(&core).await
    } else {
        vec![]
    };
    let variants:Vec<_>=manifest(&app)?.variants.into_iter().map(|v|serde_json::json!({"id":v.id,"installed":installed(&core,&v.id),"sizeBytes":v.files.iter().map(|f|f.size).sum::<u64>()})).collect();
    let tensor = if installed(&core, "fish-s2-fp8") {
        Some(("fish-runtime", "fish_worker.py"))
    } else if installed(&core, "drama3-comfy-fp8") {
        Some(("drama-runtime", "drama_worker.py"))
    } else if IDS
        .iter()
        .any(|id| multilingual(id) && installed(&core, id))
    {
        Some(("multilingual-runtime", "multilingual_worker.py"))
    } else {
        None
    };
    let cuda = if include_cuda && permit.is_some() {
        if let Some((runtime, script)) = tensor {
            separation::probe(
                &separation::python(&root(&core).join(runtime)),
                &[
                    separation::resources(&app)
                        .join(script)
                        .to_string_lossy()
                        .into_owned(),
                    "--info".into(),
                ],
                &AtomicBool::new(false),
                Duration::from_secs(30),
            )
            .await?
            .unwrap_or_else(|| serde_json::json!({"devices":[]}))
        } else {
            serde_json::json!({"devices":[]})
        }
    } else {
        serde_json::json!({"devices":[]})
    };
    Ok(serde_json::json!({"variants":variants,"devices":devices,"cudaDevices":cuda["devices"]}))
}
pub fn install<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("RUNTIME_PLATFORM_UNSUPPORTED".into());
    }
    let selected = variant(&app, &id)?;
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let key = jobs::create(&core, &app, "ttsInstall", String::new(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .voice_install = Some(id.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?,};
            if selected.engine=="drama3" {
                let probe_core=core.clone();let probe_app=app.clone();
                let space=tauri::async_runtime::spawn_blocking(move||crate::voice_space::check(&probe_core,&probe_app)).await.map_err(io_error)??;
                if flag.load(Ordering::Relaxed) {return Err("CANCELLED".into());}
                jobs::update(&core,&app,&key,|j|j.logs.push(format!("Drama 3 before downloads: {}; available {:.2} GiB; estimated required {:.2} GiB (models, dependency archives, expansion and margin)",space.path,space.available_bytes as f64/1073741824.0,space.required_bytes as f64/1073741824.0)));
                if !space.enough {return Err("TTS_DRAMA_DISK_REQUIRED".into());}
            }
            if selected.engine=="multilingual" {
              let c=core.clone();let a=app.clone();let v=id.clone();
              let space=tauri::async_runtime::spawn_blocking(move||crate::voice_space::check_variant(&c,&a,&v)).await.map_err(io_error)??;
              jobs::update(&core,&app,&key,|j|j.logs.push(format!("{}: available {:.2} GiB; estimated required {:.2} GiB before dependency downloads",selected.name,space.available_bytes as f64/1073741824.0,space.required_bytes as f64/1073741824.0)));
              if !space.enough {return Err("TTS_DISK_REQUIRED".into());}
            }
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="runtime".into();});
            let folder=root(&core);std::fs::create_dir_all(folder.join(&id)).map_err(io_error)?;
            let _=std::fs::remove_file(folder.join(&id).join("ready.json"));
            if selected.engine=="audiocpp" {
                let file=manifest(&app)?.engine;let archive=folder.join(&file.name);
                separation::fetch(&core,&app,&key,&[file.url],&archive,(&file.sha256,file.size),&flag).await?;
                jobs::update(&core,&app,&key,|j|{j.stage="ttsExtract".into();j.progress=None;});
                let target=folder.join("audiocpp");let f=flag.clone();
                tauri::async_runtime::spawn_blocking(move||tts::extract(&archive,&target,&f)).await.map_err(io_error)??;
                if inventory(&core).await.is_empty(){return Err("TTS_RUNTIME_FAILED".into());}
            } else {
                install_python_profile(&core,&app,&key,&flag,&selected.engine).await?;
                if selected.engine=="drama3" {
                    separation::process(&core,&app,&key,&separation::python(&folder.join("drama-runtime")),&[separation::resources(&app).join("drama_worker.py").to_string_lossy().into_owned(),"--preflight".into(),folder.join(&id).to_string_lossy().into_owned()],&flag).await?;
                }
            }
            for file in selected.files {
                crate::domain::valid_relative(&file.name)?;
                jobs::update(&core,&app,&key,|j|{j.stage="ttsModel".into();j.progress=Some(0.0);j.logs.push(format!("{}: {}",selected.name,file.name));});
                separation::fetch(&core,&app,&key,&[file.url],&folder.join(&id).join(&file.name),(&file.sha256,file.size),&flag).await?;
            }
            if id=="chatterbox-multilingual-v3" {
                jobs::update(&core,&app,&key,|j|{j.stage="ttsExtract".into();j.progress=None;});
                let archive=folder.join(&id).join("pkuseg.zip");
                let target=folder.join(&id).join("pkuseg");
                let f=flag.clone();
                tauri::async_runtime::spawn_blocking(move||tts::extract(&archive,&target,&f)).await.map_err(io_error)??;
            }
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            project::atomic_write(&folder.join(&id).join("ready.json"),selected.revision.as_bytes())
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
pub(crate) async fn install_python_profile<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    flag: &Arc<AtomicBool>,
    profile: &str,
) -> Result<(), String> {
    let drama = profile == "drama3";
    let multilingual = profile == "multilingual";
    let toolbox = profile == "audio-toolbox";
    let folder = root(core).join(if toolbox {
        "audio-toolbox-runtime"
    } else if multilingual {
        "multilingual-runtime"
    } else if drama {
        "drama-runtime"
    } else {
        "fish-runtime"
    });
    std::fs::create_dir_all(folder.join("python/Lib/site-packages")).map_err(io_error)?;
    let archive = folder.join("python.zip");
    separation::fetch(
        core,
        app,
        key,
        &["https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip".into()],
        &archive,
        (
            "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
            11133606,
        ),
        flag,
    )
    .await?;
    let target = folder.join("python");
    let f = flag.clone();
    tauri::async_runtime::spawn_blocking(move || tts::extract(&archive, &target, &f))
        .await
        .map_err(io_error)??;
    project::atomic_write(
        &folder.join("python/python312._pth"),
        b"python312.zip\n.\nLib/site-packages\nimport site\n",
    )?;
    let runtime: serde_json::Value = serde_json::from_slice(
        &std::fs::read(separation::resources(app).join(if toolbox {
            "audio-toolbox-runtime.json"
        } else if multilingual {
            "multilingual-runtime.json"
        } else if drama {
            "drama-runtime.json"
        } else {
            "fish-runtime.json"
        }))
        .map_err(io_error)?,
    )
    .map_err(io_error)?;
    std::fs::create_dir_all(folder.join("wheels")).map_err(io_error)?;
    for file in runtime["files"].as_array().ok_or("TTS_RUNTIME_FAILED")? {
        let name = file["name"].as_str().ok_or("TTS_RUNTIME_FAILED")?;
        crate::domain::valid_relative(name)?;
        let archive = if let Some(bundled) = file["bundledPath"].as_str() {
            crate::domain::valid_relative(bundled)?;
            separation::resources(app).join(bundled)
        } else {
            let shared = tts::root(core).join("wheels").join(name);
            let spec = crate::downloads::Spec {
                urls: &[],
                sha256: file["sha256"].as_str().ok_or("TTS_RUNTIME_FAILED")?,
                size: file["size"].as_u64().ok_or("TTS_RUNTIME_FAILED")?,
            };
            if crate::downloads::cached(&shared, &spec, flag).await? {
                jobs::update(core, app, key, |j| {
                    j.logs
                        .push(format!("Reusing verified CosyVoice download: {name}"))
                });
                shared
            } else {
                let archive = folder.join("wheels").join(name);
                separation::fetch(
                    core,
                    app,
                    key,
                    &[file["url"].as_str().ok_or("TTS_RUNTIME_FAILED")?.into()],
                    &archive,
                    (
                        file["sha256"].as_str().ok_or("TTS_RUNTIME_FAILED")?,
                        file["size"].as_u64().ok_or("TTS_RUNTIME_FAILED")?,
                    ),
                    flag,
                )
                .await?;
                archive
            }
        };
        if !crate::downloads::cached(
            &archive,
            &crate::downloads::Spec {
                urls: &[],
                sha256: file["sha256"].as_str().ok_or("TTS_RUNTIME_FAILED")?,
                size: file["size"].as_u64().ok_or("TTS_RUNTIME_FAILED")?,
            },
            flag,
        )
        .await?
        {
            return Err("MODEL_CHECKSUM_FAILED".into());
        }
        jobs::update(core, app, key, |j| {
            j.stage = "ttsExtract".into();
            j.progress = None;
            j.logs.push(format!("Installing verified wheel: {name}"));
        });
        let target = folder.join("python/Lib/site-packages");
        let f = flag.clone();
        tauri::async_runtime::spawn_blocking(move || tts::extract(&archive, &target, &f))
            .await
            .map_err(io_error)??;
    }
    if drama {
        let archive = separation::resources(app).join("vendor/drama3/comfy-core.zip");
        let destination = folder.join("core");
        let f = flag.clone();
        tauri::async_runtime::spawn_blocking(move || tts::extract(&archive, &destination, &f))
            .await
            .map_err(io_error)??;
    }
    if toolbox {
        let archive = separation::resources(app).join("vendor/audio-toolbox/audiosep-core.zip");
        let destination = folder.join("audiosep");
        let f = flag.clone();
        tauri::async_runtime::spawn_blocking(move || tts::extract(&archive, &destination, &f))
            .await
            .map_err(io_error)??;
    }
    if separation::probe(
        &separation::python(&folder),
        &[
            separation::resources(app)
                .join(if toolbox {
                    "audio_toolbox_worker.py"
                } else if multilingual {
                    "multilingual_worker.py"
                } else if drama {
                    "drama_worker.py"
                } else {
                    "fish_worker.py"
                })
                .to_string_lossy()
                .into_owned(),
            "--runtime-info".into(),
        ],
        flag,
        Duration::from_secs(90),
    )
    .await?
    .is_none_or(|v| v["runtimeReady"] != true)
    {
        return Err("TTS_RUNTIME_FAILED".into());
    }
    Ok(())
}
pub async fn generate_gguf<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    input: &serde_json::Value,
    flag: &AtomicBool,
) -> Result<(), String> {
    generate_gguf_with_session(core, app, key, input, flag, None).await
}
pub(crate) async fn generate_gguf_with_session<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    input: &serde_json::Value,
    flag: &AtomicBool,
    mut hot: Option<&mut crate::tts_session::Session>,
) -> Result<(), String> {
    let mut effective = input.clone();
    for attempt in 0..2 {
        let result =
            generate_gguf_attempt(core, app, key, &effective, flag, hot.as_deref_mut()).await;
        if attempt == 0
            && crate::qwen_safety::is_qwen(input)
            && !flag.load(Ordering::Relaxed)
            && result
                .as_ref()
                .is_err_and(|e| crate::qwen_safety::retryable(e))
        {
            let metadata = std::fs::read(input["resultPath"].as_str().ok_or("INVALID_PATH")?)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            let device = metadata
                .as_ref()
                .and_then(|m| m["device"].as_str())
                .or_else(|| input["device"].as_str().filter(|d| *d != "auto"));
            let Some(device) = device else {
                return result;
            };
            effective = crate::qwen_safety::retry_input(input, device);
            if let Some(session) = hot.as_deref_mut() {
                session.close_logged(core, app, key).await;
            }
            if let Some(path) = input["outputPath"].as_str() {
                let _ = std::fs::remove_file(path);
            }
            jobs::update(core, app, key, |j| {
                j.stage = "ttsQwenRecovery".into();
                j.logs.push(format!("Qwen3 output rejected: {}. One bounded retry on the SAME device {device}, x-vector reference conditioning, seed {}. Original takes and requested settings retained; effective recovery is recorded.",result.as_ref().unwrap_err(),effective["seed"]));
            });
            continue;
        }
        return result;
    }
    Err("TTS_ENGINE_FAILED".into())
}
async fn generate_gguf_attempt<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    input: &serde_json::Value,
    flag: &AtomicBool,
    mut hot: Option<&mut crate::tts_session::Session>,
) -> Result<(), String> {
    let id = input["variantId"].as_str().ok_or("INVALID_TTS_REQUEST")?;
    let selected = variant(app, id)?;
    let model = root(core).join(id).join("model.gguf");
    let raw = PathBuf::from(input["outputPath"].as_str().ok_or("INVALID_PATH")?)
        .with_extension("raw.wav");
    let result = async {
        jobs::update(core, app, key, |j| {
            j.stage = "ttsVerify".into();
            j.progress = None;
        });
        let expected = selected.files.first().ok_or("TTS_RUNTIME_FAILED")?;
        let valid = if hot.as_ref().is_some_and(|s| s.has_gguf()) {
            true
        } else {
            crate::downloads::cached(
                &model,
                &crate::downloads::Spec {
                    urls: &[],
                    sha256: &expected.sha256,
                    size: expected.size,
                },
                flag,
            )
            .await?
        };
        if !valid {
            return Err("MODEL_CHECKSUM_FAILED".into());
        }
        let devices = if let Some(device) = hot.as_ref().and_then(|s| s.gguf_device()) {
            vec![device]
        } else {
            inventory(core).await
        };
        let requested = input["device"].as_str().unwrap_or("auto");
        let device = if requested == "auto" {
            devices
                .iter()
                .find(|d| d["discrete"] == true)
                .or_else(|| devices.iter().find(|d| d["id"] == "cpu"))
        } else {
            devices.iter().find(|d| d["id"] == requested)
        }
        .ok_or("DEVICE_UNAVAILABLE")?;
        let device_id = device["id"].as_str().ok_or("DEVICE_UNAVAILABLE")?;
        let (backend, index) = device_id.split_once(':').unwrap_or(("cpu", "0"));
        let mut args = vec![
            "--task".into(),
            "tts".into(),
            "--family".into(),
            if selected.provider_id == "fish-s2" {
                "fish_audio".into()
            } else {
                "qwen3_tts".into()
            },
            "--model".into(),
            model.to_string_lossy().into_owned(),
            "--backend".into(),
            backend.into(),
            "--device".into(),
            index.into(),
            "--threads".into(),
            "6".into(),
            "--text".into(),
            input["promptText"]
                .as_str()
                .or_else(|| input["text"].as_str())
                .ok_or("TTS_TEXT_REQUIRED")?
                .into(),
            "--voice-ref".into(),
            input["referenceAudio"]
                .as_str()
                .ok_or("TTS_REFERENCE_REQUIRED")?
                .into(),
            "--out".into(),
            raw.to_string_lossy().into_owned(),
            "--seed".into(),
            input["seed"].to_string(),
            "--max-tokens".into(),
            crate::qwen_safety::max_tokens(input).to_string(),
            "--log".into(),
        ];
        for (name, value) in crate::voice_quality::gguf_options(input)? {
            args.extend(["--request-option".into(), format!("{name}={value}")]);
        }
        if selected.provider_id == "qwen3-tts" {
            args.extend([
                "--language".into(),
                qwen_language(input["language"].as_str().unwrap_or("fr"))?.into(),
                "--request-option".into(),
                format!("x_vector_only_mode={}", input["mode"] == "crossLingual"),
            ]);
        }
        if input["mode"] == "zeroShot" {
            args.extend([
                "--reference-text".into(),
                input["referenceTranscript"].as_str().unwrap_or("").into(),
            ]);
        }
        let result_path=PathBuf::from(input["resultPath"].as_str().ok_or("INVALID_PATH")?);
        let metadata=serde_json::json!({"device":device_id,"deviceName":device["name"],"peakVramMb":0,"qwenRecovery":input["qwenRecovery"]});
        project::atomic_write(&result_path,&serde_json::to_vec(&metadata).map_err(io_error)?)?;
        jobs::update(core, app, key, |j| {
            j.stage = "ttsGenerate".into();
            if crate::qwen_safety::is_qwen(input){j.logs.push(format!("Qwen3 generation budget: {} codec frames; 120 s output maximum. Reference mode: {}.",crate::qwen_safety::max_tokens(input),input["mode"]));}
            j.progress = None;
            j.logs
                .push(format!("{} / {}", selected.name, device["name"]));
        });
        if let Some(session) = hot.as_deref_mut() {
            session
                .gguf(
                    core,
                    app,
                    key,
                    &root(core).join("audiocpp/audiocpp_server.exe"),
                    &model,
                    if selected.provider_id == "fish-s2" {
                        "fish_audio"
                    } else {
                        "qwen3_tts"
                    },
                    device,
                    input,
                    &raw,
                    flag,
                )
                .await?;
        } else {
            separation::process(
                core,
                app,
                key,
                &root(core).join("audiocpp/audiocpp_cli.exe"),
                &args,
                flag,
            )
            .await?;
        }
        let output = input["outputPath"].as_str().ok_or("INVALID_PATH")?;
        separation::process(
            core,
            app,
            key,
            &media::binary(app, "ffmpeg")?,
            &[
                "-v".into(),
                "error".into(),
                "-nostdin".into(),
                "-i".into(),
                raw.to_string_lossy().into_owned(),
                "-af".into(),
                format!(
                    "atempo={}",
                    input["speed"].as_f64().ok_or("INVALID_TTS_REQUEST")?
                ),
                "-ac".into(),
                "1".into(),
                "-ar".into(),
                "24000".into(),
                "-c:a".into(),
                "pcm_s16le".into(),
                "-n".into(),
                output.into(),
            ],
            flag,
        )
        .await?;
        let duration=crate::audio_files::pcm_frames(std::path::Path::new(output),1,24000,"TTS_EMPTY_AUDIO")?*1000/24000;
        jobs::update(core,app,key,|j|{j.stage="ttsValidateOutput".into();j.logs.push(format!("GGUF WAV validation: mono PCM16, 24000 Hz, duration {duration} ms."));});
        crate::qwen_safety::validate_duration(input,duration)

    }
    .await;
    let _ = std::fs::remove_file(raw);
    result
}

pub(crate) fn qwen_language(code: &str) -> Result<&'static str, String> {
    match code {
        "zh" => Ok("Chinese"),
        "en" => Ok("English"),
        "ja" => Ok("Japanese"),
        "ko" => Ok("Korean"),
        "de" => Ok("German"),
        "es" => Ok("Spanish"),
        "fr" => Ok("French"),
        "it" => Ok("Italian"),
        "ru" => Ok("Russian"),
        "pt" => Ok("Portuguese"),
        _ => Err("TTS_LANGUAGE_UNSUPPORTED".into()),
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn maps_language_codes_to_native_qwen_language_names() {
        assert_eq!(super::qwen_language("fr").unwrap(), "French");
        assert_eq!(super::qwen_language("ja").unwrap(), "Japanese");
        assert!(super::qwen_language("xx").is_err());
    }
    #[test]
    fn parses_native_gpu_indices_without_confusing_cuda_and_vulkan() {
        let devices=super::parse_devices("available_devices=3\nVulkan:0 \"Ryzen iGPU\" [IGPU]\nVulkan:1 \"NVIDIA RTX 5060 Ti\" [DGPU]\nCPU:0 \"Ryzen\" [CPU]\n");
        assert_eq!(devices.len(), 3);
        assert_eq!(devices[1]["id"], "vulkan:1");
        assert_eq!(devices[1]["discrete"], true);
        assert_eq!(devices[2]["id"], "cpu");
    }
}
