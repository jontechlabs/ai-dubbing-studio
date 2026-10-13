use reqwest::Client;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) struct Spec<'a> {
    pub urls: &'a [String],
    pub sha256: &'a str,
    pub size: u64,
}
pub(crate) enum Event {
    Log(String),
    Progress(u64),
}
pub(crate) fn client() -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .user_agent(concat!(
            "AI-Dubbing-Studio/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/jontechlabs/ai-dubbing-studio)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|error| format!("IO_ERROR: {error}"))
}
async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn cached(path: &Path, spec: &Spec<'_>, flag: &AtomicBool) -> Result<bool, String> {
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("IO_ERROR: {error}")),
    };
    if file
        .metadata()
        .await
        .map_err(|error| format!("IO_ERROR: {error}"))?
        .len()
        != spec.size
    {
        return Ok(false);
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        let count = tokio::select! { _ = cancelled(flag) => return Err("CANCELLED".into()), result = file.read(&mut buffer) => result.map_err(|error| format!("IO_ERROR: {error}"))?, };
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()) == spec.sha256)
}
struct Failure {
    code: &'static str,
    detail: String,
    retry: bool,
}
impl Failure {
    fn new(code: &'static str, detail: impl ToString, retry: bool) -> Self {
        Self {
            code,
            detail: detail.to_string(),
            retry,
        }
    }
}
async fn attempt(
    client: &Client,
    url: &str,
    temp: &Path,
    spec: &Spec<'_>,
    flag: &AtomicBool,
    observe: &impl Fn(Event),
) -> Result<(), Failure> {
    let mut response = tokio::select! {
        _ = cancelled(flag) => return Err(Failure::new("CANCELLED", "Cancelled", false)),
        result = client.get(url).send() => result.map_err(|error| Failure::new("DOWNLOAD_FAILED", error.without_url(), true))?,
    };
    let status = response.status();
    if !status.is_success() {
        return Err(Failure::new(
            "DOWNLOAD_FAILED",
            format!("HTTP {status}"),
            status.is_server_error() || matches!(status.as_u16(), 408 | 429),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > spec.size)
    {
        return Err(Failure::new(
            "DOWNLOAD_FAILED",
            "Unexpected file size",
            false,
        ));
    }
    let mut file = tokio::fs::File::create(temp)
        .await
        .map_err(|error| Failure::new("IO_ERROR", error, false))?;
    let mut digest = Sha256::new();
    let mut count = 0_u64;
    let mut last = 0_u64;
    loop {
        let bytes = tokio::select! {
            _ = cancelled(flag) => return Err(Failure::new("CANCELLED", "Cancelled", false)),
            result = response.chunk() => result.map_err(|error| Failure::new("DOWNLOAD_FAILED", error.without_url(), true))?,
        };
        let Some(bytes) = bytes else {
            break;
        };
        count += bytes.len() as u64;
        if count > spec.size {
            return Err(Failure::new(
                "DOWNLOAD_FAILED",
                "Unexpected file size",
                false,
            ));
        }
        digest.update(&bytes);
        file.write_all(&bytes)
            .await
            .map_err(|error| Failure::new("IO_ERROR", error, false))?;
        if count - last >= (spec.size / 100).max(65536) {
            observe(Event::Progress(count));
            last = count;
        }
    }
    if count != spec.size {
        return Err(Failure::new("DOWNLOAD_FAILED", "Incomplete download", true));
    }
    if format!("{:x}", digest.finalize()) != spec.sha256 {
        return Err(Failure::new(
            "MODEL_CHECKSUM_FAILED",
            "SHA-256 mismatch",
            false,
        ));
    }
    file.sync_all()
        .await
        .map_err(|error| Failure::new("IO_ERROR", error, false))?;
    Ok(())
}
pub(crate) async fn fetch(
    client: &Client,
    spec: &Spec<'_>,
    output: &Path,
    flag: &AtomicBool,
    observe: impl Fn(Event),
) -> Result<(), String> {
    if cached(output, spec, flag).await? {
        observe(Event::Log("Verified cached file; download skipped.".into()));
        observe(Event::Progress(spec.size));
        return Ok(());
    }
    let temp = output.with_extension("download");
    let mut last_error = "DOWNLOAD_FAILED";
    for url in spec.urls {
        for number in 1..=2 {
            observe(Event::Log(format!(
                "Download source: {url} (attempt {number}/2)"
            )));
            observe(Event::Progress(0));
            match attempt(client, url, &temp, spec, flag, &observe).await {
                Ok(()) => {
                    if let Err(error) = tokio::fs::rename(&temp, output).await {
                        let _ = tokio::fs::remove_file(&temp).await;
                        return Err(format!("IO_ERROR: {error}"));
                    }
                    observe(Event::Log(
                        "Download verified: exact size and SHA-256.".into(),
                    ));
                    observe(Event::Progress(spec.size));
                    return Ok(());
                }
                Err(error) => {
                    let _ = tokio::fs::remove_file(&temp).await;
                    if error.code == "CANCELLED" {
                        return Err("CANCELLED".into());
                    }
                    observe(Event::Log(format!("Download failed: {}", error.detail)));
                    last_error = error.code;
                    if error.code == "IO_ERROR" {
                        return Err(format!("IO_ERROR: {}", error.detail));
                    }
                    if !error.retry || number == 2 {
                        break;
                    }
                    tokio::select! { _ = cancelled(flag) => return Err("CANCELLED".into()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                }
            }
        }
    }
    Err(last_error.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
        thread,
    };

    fn server(replies: Vec<(u16, Vec<u8>)>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let start = std::time::Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && start.elapsed() < Duration::from_secs(5) =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("HTTP test server: {error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|value| value == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                }
                requests.push(String::from_utf8(request).unwrap());
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
            requests
        });
        (base, handle)
    }
    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn http() -> Client {
        Client::builder()
            .user_agent("AI-Dubbing-Studio-test")
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn forbidden_source_falls_back_to_verified_download() {
        let body = b"official checkpoint".to_vec();
        let (base, server) = server(vec![(403, vec![]), (200, body.clone())]);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("weights.ckpt");
        let urls = vec![format!("{base}/api"), format!("{base}/mirror")];
        let digest = hash(&body);
        fetch(
            &http(),
            &Spec {
                urls: &urls,
                sha256: &digest,
                size: body.len() as u64,
            },
            &output,
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(output).unwrap(), body);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("user-agent: AI-Dubbing-Studio-test"));
        assert!(requests[1].starts_with("GET /mirror "));
    }
    #[tokio::test]
    async fn checksum_failure_preserves_previous_file_until_fallback_succeeds() {
        let body = b"good".to_vec();
        let (base, server) = server(vec![(200, b"evil".to_vec()), (200, body.clone())]);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("weights.ckpt");
        std::fs::write(&output, b"old!").unwrap();
        let urls = vec![format!("{base}/bad"), format!("{base}/good")];
        let digest = hash(&body);
        fetch(
            &http(),
            &Spec {
                urls: &urls,
                sha256: &digest,
                size: 4,
            },
            &output,
            &AtomicBool::new(false),
            |event| {
                if matches!(event, Event::Log(ref line) if line.contains("SHA-256 mismatch")) {
                    assert_eq!(std::fs::read(&output).unwrap(), b"old!");
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(output).unwrap(), body);
        assert_eq!(server.join().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn wrong_sizes_never_replace_existing_file() {
        let (base, server) = server(vec![
            (200, b"x".to_vec()),
            (200, b"x".to_vec()),
            (200, b"oversized".to_vec()),
        ]);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("weights.ckpt");
        std::fs::write(&output, b"old!").unwrap();
        let urls = vec![format!("{base}/short"), format!("{base}/long")];
        let digest = hash(b"good");
        assert_eq!(
            fetch(
                &http(),
                &Spec {
                    urls: &urls,
                    sha256: &digest,
                    size: 4
                },
                &output,
                &AtomicBool::new(false),
                |_| {}
            )
            .await
            .unwrap_err(),
            "DOWNLOAD_FAILED"
        );
        assert_eq!(std::fs::read(&output).unwrap(), b"old!");
        assert!(!output.with_extension("download").exists());
        assert_eq!(server.join().unwrap().len(), 3);
    }
    #[tokio::test]
    async fn verified_cache_needs_no_network() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("weights.ckpt");
        std::fs::write(&output, b"good").unwrap();
        let digest = hash(b"good");
        fetch(
            &http(),
            &Spec {
                urls: &[],
                sha256: &digest,
                size: 4,
            },
            &output,
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn temporary_server_error_retries_same_source() {
        let body = b"good".to_vec();
        let (base, server) = server(vec![(503, vec![]), (200, body.clone())]);
        let directory = tempfile::tempdir().unwrap();
        let urls = vec![base];
        let digest = hash(&body);
        fetch(
            &http(),
            &Spec {
                urls: &urls,
                sha256: &digest,
                size: 4,
            },
            &directory.path().join("weights.ckpt"),
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(server.join().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn cancellation_stops_waiting_for_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let urls = vec![format!("http://{}", listener.local_addr().unwrap())];
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("weights.ckpt");
        let flag = Arc::new(AtomicBool::new(false));
        let server_flag = flag.clone();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            server_flag.store(true, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(150));
        });
        let digest = hash(b"good");
        let started = std::time::Instant::now();
        assert_eq!(
            fetch(
                &http(),
                &Spec {
                    urls: &urls,
                    sha256: &digest,
                    size: 4
                },
                &output,
                &flag,
                |_| {}
            )
            .await
            .unwrap_err(),
            "CANCELLED"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!output.exists());
        assert!(!output.with_extension("download").exists());
        server.join().unwrap();
    }
}
