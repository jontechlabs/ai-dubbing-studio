mod client;
pub mod protocol;
#[cfg(test)]
mod tests;
use crate::{domain::io_error, project};
pub use client::stdio;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
const WAIT: Duration = Duration::from_secs(180);

#[derive(Serialize, Deserialize, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub tool: String,
    pub arguments: Value,
}
struct Pending {
    request: Request,
    owner: String,
    rpc: Value,
    claimed: bool,
    deadline: Instant,
    reply: mpsc::Sender<Result<Value, String>>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    id: String,
    tool: String,
    status: String,
}
pub struct Controller<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    directory: PathBuf,
    enabled: AtomicBool,
    ready: AtomicBool,
    port: Mutex<Option<u16>>,
    token: Mutex<String>,
    connections: AtomicUsize,
    pending: Mutex<HashMap<String, Pending>>,
    cancelled: Mutex<HashMap<(String, String), Instant>>,
    audit: Mutex<Vec<Audit>>,
}
impl<R: tauri::Runtime> Controller<R> {
    pub fn new(app: tauri::AppHandle<R>, directory: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            app,
            directory,
            enabled: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            port: Mutex::new(None),
            token: Mutex::new(String::new()),
            connections: AtomicUsize::new(0),
            pending: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            audit: Mutex::new(vec![]),
        })
    }
    pub fn restore(self: &Arc<Self>) {
        if std::fs::read(self.directory.join("mcp-enabled")).is_ok_and(|v| v == b"1") {
            // A failed automatic start stays visibly disabled and can be retried.
            let _ = self.start();
        }
    }
    pub fn status(&self) -> Value {
        let path = self.directory.join("mcp-endpoint.json");
        let executable = std::env::current_exe().unwrap_or_default();
        let toml=format!("[mcp_servers.ai_dubbing_studio]\ncommand = {}\nargs = [\"--mcp\", \"--endpoint\", {}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\n",serde_json::to_string(&executable).unwrap_or_default(),serde_json::to_string(&path).unwrap_or_default());
        json!({"enabled":self.enabled.load(Ordering::SeqCst),"ready":self.ready.load(Ordering::SeqCst),
            "port":*self.port.lock().unwrap(),"pending":self.pending.lock().unwrap().len(),
            "audit":self.audit.lock().unwrap().clone(),
            "configuration":{"mcpServers":{"ai-dubbing-studio":{"command":executable,"args":["--mcp","--endpoint",path]}}},"configurationToml":toml})
    }
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }
    pub fn set_enabled(self: &Arc<Self>, enabled: bool) -> Result<Value, String> {
        if enabled {
            self.start()?;
        } else {
            self.stop();
        }
        project::atomic_write(
            &self.directory.join("mcp-enabled"),
            if enabled { b"1" } else { b"0" },
        )?;
        Ok(self.status())
    }
    fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut port = self.port.lock().map_err(io_error)?;
        if self.enabled.load(Ordering::SeqCst) {
            return Ok(());
        }
        let path = self.directory.join("mcp-endpoint.json");
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(endpoint) = serde_json::from_slice::<Endpoint>(&bytes) {
                if client::exchange(&endpoint, json!({"op":"ping"})).is_ok() {
                    return Err("MCP_OTHER_INSTANCE".into());
                }
            }
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(io_error)?;
        listener.set_nonblocking(true).map_err(io_error)?;
        let local = listener.local_addr().map_err(io_error)?.port();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let endpoint = Endpoint {
            port: local,
            token: token.clone(),
            pid: std::process::id(),
        };
        project::atomic_write(&path, &serde_json::to_vec(&endpoint).map_err(io_error)?)?;
        *self.token.lock().map_err(io_error)? = token.clone();
        *port = Some(local);
        self.enabled.store(true, Ordering::SeqCst);
        let core = self.clone();
        std::thread::spawn(move || {
            while core.enabled.load(Ordering::SeqCst)
                && core.token.lock().is_ok_and(|v| *v == token)
            {
                match listener.accept() {
                    Ok((stream, address)) if address.ip().is_loopback() => {
                        if core.connections.fetch_add(1, Ordering::SeqCst) >= 32 {
                            core.connections.fetch_sub(1, Ordering::SeqCst);
                            continue;
                        }
                        let worker = core.clone();
                        std::thread::spawn(move || {
                            worker.serve(stream);
                            worker.connections.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25))
                    }
                    _ => break,
                }
            }
        });
        Ok(())
    }
    pub fn stop(&self) {
        let mut port = self.port.lock().ok();
        self.enabled.store(false, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending.lock() {
            for (_, request) in pending.drain() {
                let _ = request.reply.send(Err("MCP_DISABLED".into()));
            }
        }
        if let Some(port) = port.as_mut() {
            **port = None;
        }
        let path = self.directory.join("mcp-endpoint.json");
        if let Ok(bytes) = std::fs::read(&path) {
            if serde_json::from_slice::<Endpoint>(&bytes).is_ok_and(|v| {
                v.pid == std::process::id()
                    && self.token.lock().is_ok_and(|token| v.token == *token)
            }) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    fn audit(&self, id: &str, tool: &str, status: &str) {
        if let Ok(mut rows) = self.audit.lock() {
            if let Some(row) = rows.iter_mut().find(|v| v.id == id) {
                row.status = status.into();
            } else {
                rows.insert(
                    0,
                    Audit {
                        id: id.into(),
                        tool: tool.into(),
                        status: status.into(),
                    },
                );
                rows.truncate(30);
            }
        }
    }
    fn execute(
        &self,
        owner: &str,
        rpc: Value,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Err("MCP_DISABLED".into());
        }
        if !self.ready.load(Ordering::SeqCst) {
            return Err("MCP_UI_NOT_READY".into());
        }
        let schema = protocol::tool(tool).ok_or("MCP_UNKNOWN_TOOL")?;
        if !protocol::validate(&schema["inputSchema"], &arguments) {
            return Err("MCP_INVALID_ARGUMENTS".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let request = Request {
            id: id.clone(),
            tool: tool.into(),
            arguments,
        };
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(io_error)?;
            let cancelled = self.cancelled.lock().map_err(io_error)?;
            if cancelled.contains_key(&(owner.into(), "*".into()))
                || cancelled.contains_key(&(owner.into(), rpc.to_string()))
            {
                return Err("MCP_CANCELLED".into());
            }
            if pending.len() >= 16 {
                return Err("MCP_BUSY".into());
            }
            if pending.values().any(|p| p.owner == owner && p.rpc == rpc) {
                return Err("MCP_DUPLICATE_REQUEST".into());
            }
            pending.insert(
                id.clone(),
                Pending {
                    request,
                    owner: owner.into(),
                    rpc,
                    claimed: false,
                    deadline: Instant::now() + WAIT,
                    reply: sender,
                },
            );
        }
        self.audit(&id, tool, "queued");
        if self.app.emit("mcp-request", &id).is_err() {
            self.pending.lock().map_err(io_error)?.remove(&id);
            return Err("MCP_UI_NOT_READY".into());
        }
        let result = receiver
            .recv_timeout(WAIT)
            .unwrap_or(Err("MCP_TIMEOUT".into()));
        self.pending.lock().map_err(io_error)?.remove(&id);
        self.audit(
            &id,
            tool,
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
        );
        result
    }
    pub fn claim(&self, id: &str) -> Result<Option<Request>, String> {
        let mut pending = self.pending.lock().map_err(io_error)?;
        if !self.enabled.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let Some(row) = pending.get_mut(id) else {
            return Ok(None);
        };
        if row.claimed || row.deadline <= Instant::now() {
            return Ok(None);
        }
        row.claimed = true;
        self.audit(id, &row.request.tool, "running");
        Ok(Some(row.request.clone()))
    }
    pub fn live(&self, id: &str) -> bool {
        self.enabled.load(Ordering::SeqCst)
            && self.pending.lock().is_ok_and(|rows| {
                rows.get(id)
                    .is_some_and(|row| row.claimed && row.deadline > Instant::now())
            })
    }
    pub fn complete(&self, id: &str, result: Option<Value>, error: Option<String>) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(row) = pending.remove(id) {
                let _ = row.reply.send(match error {
                    Some(error) => Err(error),
                    None => Ok(result.unwrap_or(Value::Null)),
                });
            }
        }
    }
    fn cancel(&self, owner: &str, rpc: Option<&Value>) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Ok(mut cancelled) = self.cancelled.lock() {
                cancelled.retain(|_, at| at.elapsed() < WAIT * 2);
                if cancelled.len() >= 1024 {
                    if let Some(key) = cancelled
                        .iter()
                        .min_by_key(|(_, at)| *at)
                        .map(|(key, _)| key.clone())
                    {
                        cancelled.remove(&key);
                    }
                }
                cancelled.insert(
                    (owner.into(), rpc.map_or("*".into(), Value::to_string)),
                    Instant::now(),
                );
            }
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, row)| row.owner == owner && rpc.is_none_or(|rpc| *rpc == row.rpc))
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(row) = pending.remove(&id) {
                    let _ = row.reply.send(Err("MCP_CANCELLED".into()));
                }
            }
        }
    }
    fn serve(&self, mut stream: TcpStream) {
        let result = (|| -> Result<Value, String> {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .map_err(io_error)?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(io_error)?;
            let mut bytes = vec![];
            BufReader::new(stream.try_clone().map_err(io_error)?)
                .take(protocol::MAX_BYTES + 1)
                .read_until(b'\n', &mut bytes)
                .map_err(io_error)?;
            if bytes.len() as u64 > protocol::MAX_BYTES || !bytes.ends_with(b"\n") {
                return Err("MCP_INVALID_REQUEST".into());
            }
            let message: Value =
                serde_json::from_slice(&bytes).map_err(|_| "MCP_INVALID_REQUEST")?;
            if !self.enabled.load(Ordering::SeqCst)
                || message["token"].as_str().is_none_or(|token| {
                    self.token.lock().is_err() || self.token.lock().unwrap().as_str() != token
                })
            {
                return Err("MCP_AUTH_FAILED".into());
            }
            if message["op"] == "ping" {
                return Ok(json!({"running":true}));
            }
            let owner = message["owner"]
                .as_str()
                .filter(|v| v.len() <= 128)
                .ok_or("MCP_INVALID_REQUEST")?;
            if message["op"] == "cancel" {
                self.cancel(owner, message.get("requestId"));
                return Ok(Value::Null);
            }
            let tool = message["tool"].as_str().ok_or("MCP_INVALID_REQUEST")?;
            self.execute(
                owner,
                message["requestId"].clone(),
                tool,
                message["arguments"].clone(),
            )
        })();
        let response = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        let _ = serde_json::to_writer(&mut stream, &response);
        let _ = stream.write_all(b"\n");
    }
}
impl<R: tauri::Runtime> Drop for Controller<R> {
    fn drop(&mut self) {
        self.stop();
    }
}
