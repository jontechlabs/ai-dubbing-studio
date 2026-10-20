use super::{protocol, Endpoint};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
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
        .set_read_timeout(Some(Duration::from_secs(if request["op"] == "ping" {
            2
        } else {
            190
        })))
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
pub fn stdio(path: &Path) -> Result<(), String> {
    endpoint(path)?;
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let owner = uuid::Uuid::new_v4().to_string();
    let mut session = protocol::Session::default();
    let active = Arc::new(AtomicUsize::new(0));
    let input = std::io::stdin();
    let mut input = input.lock();
    let mut workers = vec![];
    loop {
        let mut line = vec![];
        let read = (&mut input)
            .take(protocol::MAX_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "MCP_STDIN_FAILED")?;
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
                if let Ok(endpoint) = endpoint(path) {
                    let _ = exchange(
                        &endpoint,
                        json!({"op":"cancel","owner":owner,"requestId":id}),
                    );
                }
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
            let path = path.to_path_buf();
            let output = output.clone();
            let owner = owner.clone();
            let active = active.clone();
            let mut snapshot = session.clone();
            workers.push(std::thread::spawn(move || {
                let id = request["id"].clone();
                if let Some(response) = snapshot.handle(request, |tool, arguments| {
                    exchange(
                        &endpoint(&path)?,
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
    if let Ok(endpoint) = endpoint(path) {
        let _ = exchange(&endpoint, json!({"op":"cancel","owner":owner}));
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}
