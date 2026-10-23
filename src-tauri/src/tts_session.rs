use crate::{
    domain::{id, io_error},
    jobs, media,
    tts::WorkerLaunch,
    Core,
};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::mpsc,
    task::JoinHandle,
};

/// Owns one process for one lot. Never shared between jobs or selected devices.
#[derive(Default)]
pub(crate) struct Session {
    pub compatible: bool,
    gguf: Option<Gguf>,
    child: Option<Child>,
    input: Option<ChildStdin>,
    events: Option<mpsc::Receiver<(bool, String)>>,
    pumps: Vec<JoinHandle<()>>,
}
struct Gguf {
    device: serde_json::Value,
    url: String,
    id: String,
    client: reqwest::Client,
    _config: tempfile::NamedTempFile,
}
impl Session {
    pub fn gguf_device(&self) -> Option<serde_json::Value> {
        self.gguf.as_ref().map(|s| s.device.clone())
    }
    pub fn has_gguf(&self) -> bool {
        self.gguf.is_some()
    }
    pub async fn close(&mut self) {
        self.input.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.gguf.take();
        self.events.take();
        for pump in self.pumps.drain(..) {
            pump.abort();
            let _ = pump.await;
        }
    }
    pub async fn close_logged<R: tauri::Runtime>(
        &mut self,
        core: &Core,
        app: &tauri::AppHandle<R>,
        key: &str,
    ) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        // stdout completion and the final stderr traceback can arrive in either order.
        // Release the process first, then drain its remaining diagnostics with a bound.
        if let Some(events) = self.events.as_mut() {
            let drain = async {
                while let Some((_, line)) = events.recv().await {
                    jobs::update(core, app, key, |j| j.logs.push(line));
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
        }
        self.close().await;
    }
    async fn start(&mut self, launch: &WorkerLaunch) -> Result<(), String> {
        let adapter = launch
            .script
            .parent()
            .ok_or("INVALID_PATH")?
            .join("batch_worker.py");
        let args = if adapter.is_file() {
            vec![
                adapter.to_string_lossy().into_owned(),
                "--engine".into(),
                launch
                    .script
                    .file_stem()
                    .ok_or("INVALID_PATH")?
                    .to_string_lossy()
                    .into_owned(),
            ]
        } else if cfg!(test) {
            vec![
                launch.script.to_string_lossy().into_owned(),
                "--batch".into(),
            ]
        } else {
            return Err("TTS_RUNTIME_FAILED".into());
        };
        self.spawn(&launch.python, &args)
    }
    fn spawn(&mut self, executable: &Path, args: &[String]) -> Result<(), String> {
        let mut child = media::command(executable)
            .args(args)
            .kill_on_drop(true)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8:backslashreplace")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(io_error)?;
        self.input = child.stdin.take();
        let (tx, rx) = mpsc::channel(256);
        macro_rules! pump {
            ($stream:expr,$stderr:expr) => {{
                let tx = tx.clone();
                let stream = $stream.ok_or("PROCESS_FAILED")?;
                self.pumps.push(tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut bytes = Vec::new();
                    loop {
                        bytes.clear();
                        match reader.read_until(b'\n', &mut bytes).await {
                            Ok(0) => break,
                            Ok(_) => {
                                if tx
                                    .send((
                                        $stderr,
                                        String::from_utf8_lossy(&bytes)
                                            .trim_end_matches(['\r', '\n'])
                                            .to_owned(),
                                    ))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(e) => {
                                let _ = tx.send((true, format!("Worker pipe error: {e}"))).await;
                                break;
                            }
                        }
                    }
                }));
            }};
        }
        pump!(child.stdout.take(), false);
        pump!(child.stderr.take(), true);
        self.child = Some(child);
        self.events = Some(rx);
        Ok(())
    }
    pub async fn generate<R: tauri::Runtime>(
        &mut self,
        core: &Arc<Core>,
        app: &tauri::AppHandle<R>,
        key: &str,
        launch: &WorkerLaunch,
        path: &Path,
        flag: &AtomicBool,
    ) -> Result<(), String> {
        let result=async {
            if self.child.is_none() { self.start(launch).await?; }
            let request_id=id();
            let mut message=serde_json::to_vec(&serde_json::json!({"requestId":request_id,"path":path})).map_err(io_error)?;message.push(b'\n');
            self.input.as_mut().ok_or("PROCESS_FAILED")?.write_all(&message).await.map_err(io_error)?;
            let mut worker_error=None;
            loop {
                tokio::select! {
                    _=jobs::cancelled(flag)=>return Err("CANCELLED".into()),
                    event=self.events.as_mut().ok_or("PROCESS_FAILED")?.recv()=>{
                        let Some((stderr,line))=event else {
                            let status=self.child.as_mut().ok_or("PROCESS_FAILED")?.wait().await.map_err(io_error)?;
                            jobs::update(core,app,key,|j|j.logs.push(format!("Batch worker exited during {}: {status}",j.stage)));
                            return Err(worker_error.unwrap_or_else(|| match status.code().map(|c|c as u32) {Some(0xC0000005|0xC0000409|0xC000001D)=>"TTS_NATIVE_CRASH",_=>"TTS_ENGINE_FAILED"}.into()));
                        };
                        if !stderr { if let Ok(value)=serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(done)=value.get("requestDone") {
                                if done.as_str()!=Some(&request_id){return Err("TTS_ENGINE_FAILED".into());}
                                return value["error"].as_str().map_or(Ok(()),|e|Err(e.into()));
                            }
                            jobs::update(core,app,key,|j|{
                                if let Some(stage)=value["stage"].as_str(){j.stage=stage.into();}
                                if value.get("progress").is_some(){j.progress=value["progress"].as_f64().map(|n|n.clamp(0.,1.));}
                                if let Some(log)=value["log"].as_str(){j.logs.push(log.into());}
                                if let Some(error)=value["error"].as_str(){worker_error=Some(error.to_owned());j.logs.push(error.into());}
                            }); continue;
                        }}
                        jobs::update(core,app,key,|j|j.logs.push(line));
                    }
                }
            }
        }.await;
        if result.is_err() {
            self.close_logged(core, app, key).await;
        }
        result
    }
    pub async fn finish<R: tauri::Runtime>(
        &mut self,
        core: &Core,
        app: &tauri::AppHandle<R>,
        key: &str,
    ) {
        jobs::update(core, app, key, |j| {
            j.stage = "ttsRelease".into();
            j.logs.push("Batch ended: closing the private inference process and releasing its GPU context and host model weights.".into());
        });
        // Await process death before the batch relinquishes the shared inference gate.
        self.close_logged(core, app, key).await;
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn gguf<R: tauri::Runtime>(
        &mut self,
        core: &Arc<Core>,
        app: &tauri::AppHandle<R>,
        key: &str,
        executable: &Path,
        model: &Path,
        family: &str,
        device: &serde_json::Value,
        input: &serde_json::Value,
        raw: &Path,
        flag: &AtomicBool,
    ) -> Result<(), String> {
        if self.gguf.is_none() {
            let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(io_error)?;
            let port = socket.local_addr().map_err(io_error)?.port();
            let device_id = device["id"].as_str().ok_or("DEVICE_UNAVAILABLE")?;
            let (backend, index) = device_id.split_once(':').unwrap_or(("cpu", "0"));
            let model_id = id();
            let config = serde_json::json!({"host":"127.0.0.1","port":port,"backend":backend,"device":index.parse::<u32>().map_err(io_error)?,"threads":6,"lazy_load":true,"max_loaded_models":1,"models":[{"id":model_id,"family":family,"path":model,"task":"tts","mode":"offline"}]});
            let file = tempfile::NamedTempFile::new().map_err(io_error)?;
            std::fs::write(file.path(), serde_json::to_vec(&config).map_err(io_error)?)
                .map_err(io_error)?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .build()
                .map_err(io_error)?;
            self.gguf = Some(Gguf {
                device: device.clone(),
                url: format!("http://127.0.0.1:{port}"),
                id: model_id,
                client,
                _config: file,
            });
            let args = vec![
                "--config".into(),
                self.gguf
                    .as_ref()
                    .unwrap()
                    ._config
                    .path()
                    .to_string_lossy()
                    .into_owned(),
            ];
            drop(socket);
            self.spawn(executable, &args)?;
            let ready = async {
                loop {
                    if self
                        .child
                        .as_mut()
                        .ok_or("PROCESS_FAILED")?
                        .try_wait()
                        .map_err(io_error)?
                        .is_some()
                    {
                        return Err("TTS_ENGINE_FAILED".to_owned());
                    }
                    let server = self.gguf.as_ref().unwrap();
                    if let Ok(response) = server
                        .client
                        .get(format!("{}/v1/models", server.url))
                        .timeout(Duration::from_secs(2))
                        .send()
                        .await
                    {
                        if let Ok(value) = response.json::<serde_json::Value>().await {
                            if value["data"]
                                .as_array()
                                .is_some_and(|list| list.iter().any(|m| m["id"] == server.id))
                            {
                                return Ok(());
                            }
                        }
                    }
                    tokio::select! {_=jobs::cancelled(flag)=>return Err("CANCELLED".into()),_=tokio::time::sleep(Duration::from_millis(100))=>{}}
                }
            };
            tokio::time::timeout(Duration::from_secs(30), ready)
                .await
                .map_err(|_| "TTS_TIMEOUT")??;
        } else {
            jobs::update(core, app, key, |j| {
                j.logs
                    .push("GGUF: reusing the private batch server and loaded model.".into())
            });
        }
        let server = self.gguf.as_ref().ok_or("PROCESS_FAILED")?;
        let language =
            crate::voice_engines::qwen_language(input["language"].as_str().unwrap_or("fr"))?;
        let mut body = serde_json::json!({"model":server.id,"input":input["promptText"],"voice_ref":input["referenceAudio"],"seed":input["seed"].to_string(),"max_tokens":2048,"response_format":"wav"});
        if family == "qwen3_tts" {
            body["language"] = language.into();
            body["options"] =
                serde_json::json!({"x_vector_only_mode":input["mode"]=="crossLingual"});
        }
        if body["options"].is_null() {
            body["options"] = serde_json::json!({});
        }
        for (name, value) in crate::voice_quality::gguf_options(input)? {
            body["options"][name] = value.into();
        }
        if input["mode"] == "zeroShot" {
            body["reference_text"] = input["referenceTranscript"].clone();
        }
        let operation = async {
            let mut response = server
                .client
                .post(format!("{}/v1/audio/speech", server.url))
                .json(&body)
                .send()
                .await
                .map_err(io_error)?;
            if !response.status().is_success() {
                return Err("TTS_ENGINE_FAILED".to_owned());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(io_error)? {
                if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
                    return Err("TTS_EMPTY_AUDIO".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            std::fs::write(raw, bytes).map_err(io_error)
        };
        tokio::pin!(operation);
        loop {
            tokio::select! {
                _=jobs::cancelled(flag)=>return Err("CANCELLED".into()),
                result=&mut operation=>return result,
                event=self.events.as_mut().ok_or("PROCESS_FAILED")?.recv()=>{
                    let Some((_,line))=event else{return Err("TTS_ENGINE_FAILED".into());};
                    jobs::update(core,app,key,|j|j.logs.push(line));
                }
            }
        }
    }
}
