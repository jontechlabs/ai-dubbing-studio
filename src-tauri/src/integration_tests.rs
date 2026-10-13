use crate::{domain::Project, jobs, media, project, subtitles, Core};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

fn tool(name: &str) -> PathBuf {
    if cfg!(windows) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{name}.exe"))
    } else {
        PathBuf::from(name)
    }
}
#[tokio::test]
async fn job_queue_import_cancel_and_retry_preserve_the_project() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Queue project").unwrap();
    let p = Project::new("Queue project".into(), "en".into(), "fr".into());
    project::save(&root, &p).unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().to_owned(),
    });
    let app = tauri::test::mock_app();
    let request = jobs::ImportRequest {
        path: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../public/demo.mp4")
            .canonicalize()
            .unwrap(),
        root,
        project_id: p.id.clone(),
        audio_index: Some(1),
        force_proxy: true,
        reuse: None,
    };
    let permit = core.gate.clone().acquire_owned().await.unwrap();
    let cancelled = jobs::enqueue(core.clone(), app.handle().clone(), request.clone());
    let flag: Arc<AtomicBool> = core
        .jobs
        .lock()
        .unwrap()
        .get(&cancelled)
        .unwrap()
        .cancel
        .clone();
    flag.store(true, Ordering::Relaxed);
    drop(permit);
    wait_for_job(&core, &cancelled).await;
    assert_eq!(
        core.jobs
            .lock()
            .unwrap()
            .get(&cancelled)
            .unwrap()
            .saved
            .record
            .status,
        "cancelled"
    );
    assert!(core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .media
        .is_none());
    let retry = jobs::enqueue(core.clone(), app.handle().clone(), request);
    wait_for_job(&core, &retry).await;
    let record = core
        .jobs
        .lock()
        .unwrap()
        .get(&retry)
        .unwrap()
        .saved
        .record
        .clone();
    assert_eq!(record.status, "succeeded", "{:?}", record.error);
    let session = core.session.lock().unwrap();
    let saved = &session.as_ref().unwrap().project;
    assert_eq!(saved.id, p.id);
    assert!(saved.media.as_ref().unwrap().preview_path.is_some());
    assert_eq!(
        project::load(&session.as_ref().unwrap().root)
            .unwrap()
            .revision,
        saved.revision
    );
    let jobs_file: Vec<jobs::PersistedJob> =
        serde_json::from_slice(&std::fs::read(temporary.path().join("jobs.json")).unwrap())
            .unwrap();
    assert!(jobs_file
        .iter()
        .any(|j| j.record.id == retry && j.record.status == "succeeded"));
}
async fn wait_for_job(core: &Core, id: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let state = core
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .unwrap()
            .saved
            .record
            .status
            .clone();
        if !["queued", "running"].contains(&state.as_str()) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "job timeout");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
#[tokio::test]
async fn imports_real_mkv_and_reloads_edited_subtitles() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("Japanese source.mkv");
    let status = media::command(&tool("ffmpeg"))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "0.6",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-metadata:s:a:0",
            "language=jpn",
        ])
        .arg(&source)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let info = media::probe_executable(&tool("ffprobe"), &source)
        .await
        .unwrap();
    assert!(info.duration_ms >= 500);
    assert_eq!(
        info.streams
            .iter()
            .find(|s| s.kind == "audio")
            .unwrap()
            .language,
        "jpn"
    );
    let root = project::create_root(temporary.path(), "Portable project").unwrap();
    let mut p = Project::new("Portable project".into(), "ja".into(), "fr".into());
    p.source_cues = subtitles::parse_srt("1\n00:00:00,010 --> 00:00:00,500\nこんにちは").unwrap();
    p.dialogues = subtitles::align(&p.source_cues, &[]);
    p.dialogues[0].tts_text = Some("Prononciation".into());
    project::save(&root, &p).unwrap();
    let target = subtitles::parse_srt("1\n00:00:00,010 --> 00:00:00,500\nBonjour !").unwrap();
    let updated = subtitles::reconcile(&p.dialogues, subtitles::align(&p.source_cues, &target));
    assert_eq!(updated[0].id, p.dialogues[0].id);
    assert_eq!(updated[0].tts_text.as_deref(), Some("Prononciation"));
    p.target_cues = target;
    p.dialogues = updated;
    p.revision += 1;
    project::save(&root, &p).unwrap();
    let loaded = project::load(&root).unwrap();
    assert_eq!(loaded.target_cues[0].text, "Bonjour !");
    assert_eq!(
        loaded.dialogues[0].tts_text.as_deref(),
        Some("Prononciation")
    );
}
