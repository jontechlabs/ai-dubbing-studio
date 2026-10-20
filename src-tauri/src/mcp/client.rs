use super::{protocol, Endpoint};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

pub(super) fn exchange(endpoint: &Endpoint, mut request: Value) -> Result<Value, String> {
    if endpoint.port == 0 || endpoint.token.len() != 64 {
        return Err("MCP_INVALID_ENDPOINT".into());
    }
    request["token"] = Value::String(endpoint.token.clone());
    let address = SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "MCP_APP_NOT_RUNNING")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(
            if matches!(request["op"].as_str(), Some("ping" | "cancel")) {
                2
            } else {
                190
            },
        )))
        .map_err(|_| "MCP_IO_FAILED")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "MCP_IO_FAILED")?;
    serde_json::to_writer(&mut stream, &request).map_err(|_| "MCP_IO_FAILED")?;
    stream.write_all(b"\n").map_err(|_| "MCP_IO_FAILED")?;
    let mut bytes = vec![];
    BufReader::new(stream)
        .take(protocol::MAX_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "MCP_CONNECTION_LOST")?;
    if bytes.len() as u64 > protocol::MAX_BYTES {
        return Err("MCP_RESPONSE_TOO_LARGE".into());
    }
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| "MCP_INVALID_RESPONSE")?;
    if response["ok"] == true {
        Ok(response["value"].clone())
    } else {
        Err(response["error"]
            .as_str()
            .unwrap_or("MCP_CONNECTION_FAILED")
            .into())
    }
}
fn write(output: &Mutex<std::io::Stdout>, response: Value) {
    if let Ok(mut output) = output.lock() {
        let _ = serde_json::to_writer(&mut *output, &response);
        let _ = output.write_all(b"\n");
        let _ = output.flush();
    }
}
fn endpoint(path: &Path) -> Result<Endpoint, String> {
    let bytes = std::fs::read(path)
        .map_err(|_| "MCP_DISABLED: open the application and enable MCP in Settings")?;
    serde_json::from_slice(&bytes).map_err(|_| "MCP_INVALID_ENDPOINT".into())
}
struct HostMonitor(Arc<AtomicBool>);
impl HostMonitor {
    fn start(path: &Path, instance: &Endpoint) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let path = path.to_owned();
        let instance = instance.clone();
        std::thread::spawn(move || {
            while !flag.load(Ordering::Acquire) {
                let same = endpoint(&path).is_ok_and(|current| {
                    current.pid == instance.pid
                        && current.port == instance.port
                        && current.token == instance.token
                });
                if (!same || exchange(&instance, json!({"op":"ping"})).is_err())
                    && !flag.load(Ordering::Acquire)
                {
                    // This is the separate --mcp CLI process, never the GUI.
                    // Do not wait on a blocked stdin/stdout or RPC thread.
                    std::process::exit(1);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        Self(stopped)
    }
}
impl Drop for HostMonitor {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
pub fn stdio(path: &Path) -> Result<(), String> {
    let instance = endpoint(path)?;
    let _monitor = HostMonitor::start(path, &instance);
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let owner = uuid::Uuid::new_v4().to_string();
    let mut session = protocol::Session::default();
    let active = Arc::new(AtomicUsize::new(0));
    // Windows SSH or an AI client can keep stdin open after the GUI exits.
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let input = std::io::stdin();
        let mut input = input.lock();
        loop {
            let mut line = vec![];
            let result = (&mut input)
                .take(protocol::MAX_BYTES + 1)
                .read_until(b'\n', &mut line)
                .map(|read| (read, line))
                .map_err(|_| "MCP_STDIN_FAILED".to_owned());
            let finished = !matches!(result.as_ref(), Ok((read, _)) if *read > 0);
            if sender.send(result).is_err() || finished {
                break;
            }
        }
    });
    let mut workers = vec![];
    loop {
        let (read, line) = match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(value) => value?,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if read == 0 {
            break;
        }
        if read as u64 > protocol::MAX_BYTES {
            write(
                &output,
                protocol::error(Value::Null, -32600, "Message too large"),
            );
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: Value = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(_) => {
                write(
                    &output,
                    protocol::error(Value::Null, -32700, "Invalid JSON"),
                );
                continue;
            }
        };
        if request["method"] == "notifications/cancelled" && request.get("id").is_none() {
            if let Some(id) = request["params"].get("requestId") {
                let _ = exchange(
                    &instance,
                    json!({"op":"cancel","owner":owner,"requestId":id}),
                );
            }
            continue;
        }
        if ["tools/call", "resources/read"].contains(&request["method"].as_str().unwrap_or(""))
            && request.get("id").is_some()
        {
            if active.fetch_add(1, Ordering::SeqCst) >= 12 {
                active.fetch_sub(1, Ordering::SeqCst);
                write(
                    &output,
                    protocol::error(request["id"].clone(), -32000, "MCP_BUSY"),
                );
                continue;
            }
            let instance = instance.clone();
            let output = output.clone();
            let owner = owner.clone();
            let active = active.clone();
            let mut snapshot = session.clone();
            workers.push(std::thread::spawn(move || {
                let id = request["id"].clone();
                if let Some(response) = snapshot.handle(request, |tool, arguments| {
                    exchange(
                        &instance,
                        json!({"owner":owner,"requestId":id,"tool":tool,"arguments":arguments}),
                    )
                }) {
                    write(&output, response);
                }
                active.fetch_sub(1, Ordering::SeqCst);
            }));
            // Reap finished handles so a long-lived client does not accumulate them.
            let mut waiting = vec![];
            for worker in workers.drain(..) {
                if worker.is_finished() {
                    let _ = worker.join();
                } else {
                    waiting.push(worker);
                }
            }
            workers = waiting;
        } else if let Some(response) =
            session.handle(request, |_, _| Err("MCP_INVALID_REQUEST".into()))
        {
            write(&output, response);
        }
    }
    let _ = exchange(&instance, json!({"op":"cancel","owner":owner}));
    for worker in workers {
        // EOF ends this CLI process; a stalled RPC must not hold the exe open.
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
    Ok(())
}
