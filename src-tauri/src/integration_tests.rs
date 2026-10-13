use crate::{
    domain::{MediaAsset, MediaStream, Project},
    embedded, jobs, media, project, subtitles, waveform, Core,
};
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
async fn validates_real_stem_wav_and_reload_mixer_metadata() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Stem metadata").unwrap();
    let output = root.join("stems/speech.wav");
    assert!(media::command(&tool("ffmpeg"))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "0.3",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le"
        ])
        .arg(&output)
        .status()
        .await
        .unwrap()
        .success());
    assert_eq!(crate::audio_files::wav_frames(&output).unwrap(), 14400);
    let mut p = Project::new("Stem metadata".into(), "en".into(), "fr".into());
    p.format_version = 2;
    p.tracks=serde_json::from_value(serde_json::json!([{"id":"speech","kind":"audio","role":"speech","path":"stems/speech.wav","durationMs":300,"sourcePath":"media/film.mkv","language":"en","mute":false,"solo":true,"gain":0.4}])).unwrap();
    project::save(&root, &p).unwrap();
    let saved = project::load(&root).unwrap();
    assert_eq!(saved.tracks[0].path.as_deref(), Some("stems/speech.wav"));
    assert_eq!(saved.tracks[0].gain, 0.4);
    assert!(saved.tracks[0].solo);
    let mut invalid = saved.clone();
    invalid.tracks[0].path = Some("../outside.wav".into());
    assert!(invalid.validate().is_err());
    std::fs::write(root.join("stems/bad.wav"), b"Not a waveform").unwrap();
    assert!(crate::audio_files::wav_frames(&root.join("stems/bad.wav")).is_err());
}

#[tokio::test]
async fn separation_requires_installed_runtime_and_preserves_project() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Missing runtime").unwrap();
    let p = Project::new("Missing runtime".into(), "en".into(), "fr".into());
    project::save(&root, &p).unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().to_path_buf(),
    });
    let app = tauri::test::mock_app();
    assert!(
        !crate::separation::status(core.clone(), app.handle().clone())
            .await
            .unwrap()
            .installed
    );
    assert_eq!(
        crate::separation::enqueue(core.clone(), app.handle().clone(), "cpu".into()).unwrap_err(),
        "RUNTIME_REQUIRED"
    );
    assert_eq!(project::load(&root).unwrap().revision, 0);
    assert!(core.jobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn waveform_uses_selected_track_preserves_delay_and_reuses_cache() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Waveform").unwrap();
    let input = root.join("media/audio.mkv");
    let status = media::command(&tool("ffmpeg"))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=8000:cl=mono",
            "-itsoffset",
            "0.2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=8000",
            "-f",
            "lavfi",
            "-i",
            "color=size=64x64:rate=10",
            "-map",
            "0:a:0",
            "-map",
            "1:a:0",
            "-map",
            "2:v:0",
            "-c:v",
            "libx264",
            "-c:a",
            "pcm_s16le",
            "-t",
            "2",
        ])
        .arg(&input)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let info = media::probe_executable(&tool("ffprobe"), &input)
        .await
        .unwrap();
    let mut p = Project::new("Waveform".into(), "en".into(), "fr".into());
    p.media = Some(MediaAsset {
        id: crate::domain::id(),
        path: "media/audio.mkv".into(),
        preview_path: None,
        audio_stream_index: Some(1),
        info,
    });
    project::save(&root, &p).unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().to_path_buf(),
    });
    let app = tauri::test::mock_app();
    let tone = waveform::get(core.clone(), app.handle().clone(), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tone.audio_stream_index, 1);
    assert!(tone.peaks[..8].iter().all(|peak| *peak < 0.001));
    assert!(tone.peaks[12..].iter().any(|peak| *peak > 0.1));
    let cached = waveform::get(core.clone(), app.handle().clone(), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tone.peaks, cached.peaks);
    assert_eq!(core.jobs.lock().unwrap().len(), 1);
    {
        let mut session = core.session.lock().unwrap();
        session
            .as_mut()
            .unwrap()
            .project
            .media
            .as_mut()
            .unwrap()
            .audio_stream_index = Some(0);
    }
    let silence = waveform::get(core.clone(), app.handle().clone(), None)
        .await
        .unwrap()
        .unwrap();
    assert!(silence.peaks.iter().all(|peak| *peak == 0.0));
    assert_eq!(std::fs::read_dir(root.join("cache")).unwrap().count(), 2);
    assert_eq!(project::load(&root).unwrap().revision, 0);
    assert!(waveform::decode(&tool("ffmpeg"), &input, 99, 2000, |_| {})
        .await
        .unwrap_err()
        .starts_with("WAVEFORM_FAILED"));
}

#[tokio::test]
async fn queued_waveform_can_be_cancelled_without_blocking_project_edits() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Cancel waveform").unwrap();
    let input = root.join("media/audio.mkv");
    assert!(media::command(&tool("ffmpeg"))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440",
            "-f",
            "lavfi",
            "-i",
            "color=size=64x64:rate=10",
            "-map",
            "0:a:0",
            "-map",
            "1:v:0",
            "-c:v",
            "libx264",
            "-t",
            "0.4"
        ])
        .arg(&input)
        .status()
        .await
        .unwrap()
        .success());
    let info = media::probe_executable(&tool("ffprobe"), &input)
        .await
        .unwrap();
    let mut p = Project::new("Cancel waveform".into(), "en".into(), "fr".into());
    p.media = Some(MediaAsset {
        id: crate::domain::id(),
        path: "media/audio.mkv".into(),
        preview_path: None,
        audio_stream_index: Some(0),
        info,
    });
    project::save(&root, &p).unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().to_path_buf(),
    });
    let app = tauri::test::mock_app();
    let permit = core.gate.clone().acquire_owned().await.unwrap();
    let work = tauri::async_runtime::spawn(waveform::get(core.clone(), app.handle().clone(), None));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(job) = core.jobs.lock().unwrap().values().next() {
                job.cancel.store(true, Ordering::Relaxed);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!jobs::active_processing(&core));
    {
        let mut session = core.session.lock().unwrap();
        let session = session.as_mut().unwrap();
        let mut edited = session.project.clone();
        edited.name = "Edited while decoding".into();
        session.replace(edited, 0).unwrap();
    }
    assert_eq!(work.await.unwrap().unwrap_err(), "CANCELLED");
    drop(permit);
    assert_eq!(project::load(&root).unwrap().name, "Edited while decoding");
    assert_eq!(std::fs::read_dir(root.join("cache")).unwrap().count(), 0);
}

#[tokio::test]
async fn extracts_both_mkv_text_tracks_and_preserves_dialogue_edits() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Embedded subtitles").unwrap();
    let source = temporary.path().join("ja.srt");
    let target = temporary.path().join("fr.srt");
    std::fs::write(
        &source,
        "1\n00:00:00,200 --> 00:00:01,600\nこんにちは\n二行目\n",
    )
    .unwrap();
    std::fs::write(
        &target,
        "1\n00:00:00,200 --> 00:00:01,600\nBonjour !\nDeuxième ligne\n",
    )
    .unwrap();
    let input = root.join("media/two-tracks.mkv");
    let status = media::command(&tool("ffmpeg"))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=320x180:rate=24",
            "-i",
        ])
        .arg(&source)
        .arg("-i")
        .arg(&target)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "1:0",
            "-map",
            "2:0",
            "-c:v",
            "libx264",
            "-c:s:0",
            "srt",
            "-c:s:1",
            "ass",
            "-metadata:s:s:0",
            "language=jpn",
            "-metadata:s:s:1",
            "language=fra",
            "-t",
            "2",
        ])
        .arg(&input)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let info = media::probe_executable(&tool("ffprobe"), &input)
        .await
        .unwrap();
    assert_eq!(
        info.streams.iter().filter(|s| s.kind == "subtitle").count(),
        2
    );
    let source_index = info
        .streams
        .iter()
        .find(|s| s.language == "jpn")
        .unwrap()
        .index;
    let target_index = info
        .streams
        .iter()
        .find(|s| s.language == "fra")
        .unwrap()
        .index;
    let mut p = Project::new("Embedded subtitles".into(), "ja".into(), "fr".into());
    p.media = Some(MediaAsset {
        id: crate::domain::id(),
        path: "media/two-tracks.mkv".into(),
        preview_path: None,
        audio_stream_index: None,
        info,
    });
    project::save(&root, &p).unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().to_owned(),
    });
    let app = tauri::test::mock_app();
    let first = embedded::import(core.clone(), app.handle().clone(), source_index, "source")
        .await
        .unwrap();
    assert_eq!(first.source_cues[0].text, "こんにちは\n二行目");
    assert_eq!(first.source_cues[0].start_ms, 200);
    let dialogue_id = first.dialogues[0].id.clone();
    {
        let mut session = core.session.lock().unwrap();
        let s = session.as_mut().unwrap();
        let mut edited = s.project.clone();
        edited.dialogues[0].tts_text = Some("Prononciation indépendante".into());
        s.replace(edited, s.project.revision).unwrap();
    }
    let translated = embedded::import(core.clone(), app.handle().clone(), target_index, "target")
        .await
        .unwrap();
    assert!(translated.target_cues[0].text.contains("Bonjour !"));
    assert!(translated.target_cues[0].text.contains("Deuxième ligne"));
    assert_eq!(translated.target_cues[0].start_ms, 200);
    assert_eq!(translated.dialogues[0].id, dialogue_id);
    assert_eq!(
        translated.dialogues[0].tts_text.as_deref(),
        Some("Prononciation indépendante")
    );
    assert_eq!(project::load(&root).unwrap().revision, translated.revision);
    assert_eq!(
        std::fs::read_dir(root.join("subtitles")).unwrap().count(),
        2
    );
    assert!(core
        .jobs
        .lock()
        .unwrap()
        .values()
        .all(|job| job.saved.record.status == "succeeded"));
    assert_eq!(
        embedded::import(core.clone(), app.handle().clone(), 0, "target")
            .await
            .unwrap_err(),
        "INVALID_SUBTITLE_TRACK"
    );
    {
        let mut session = core.session.lock().unwrap();
        let streams = &mut session
            .as_mut()
            .unwrap()
            .project
            .media
            .as_mut()
            .unwrap()
            .info
            .streams;
        streams.push(MediaStream {
            index: 50,
            kind: "subtitle".into(),
            codec: "hdmv_pgs_subtitle".into(),
            language: "eng".into(),
            title: String::new(),
            bitmap: true,
            channels: None,
            width: None,
            height: None,
        });
        streams.push(MediaStream {
            index: 51,
            kind: "subtitle".into(),
            codec: "subrip".into(),
            language: "eng".into(),
            title: String::new(),
            bitmap: false,
            channels: None,
            width: None,
            height: None,
        });
    }
    assert_eq!(
        embedded::import(core.clone(), app.handle().clone(), 50, "target")
            .await
            .unwrap_err(),
        "BITMAP_SUBTITLES"
    );
    assert!(
        embedded::import(core.clone(), app.handle().clone(), 51, "target")
            .await
            .unwrap_err()
            .starts_with("SUBTITLE_EXTRACTION_FAILED")
    );
    let unchanged = project::load(&root).unwrap();
    assert_eq!(unchanged.revision, translated.revision);
    assert_eq!(
        unchanged.target_cues[0].text,
        translated.target_cues[0].text
    );
    assert_eq!(
        std::fs::read_dir(root.join("subtitles")).unwrap().count(),
        2
    );
}

#[tokio::test]
async fn cancels_queued_subtitle_extraction_without_changing_the_project() {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Cancel extraction").unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/demo.mp4"),
        root.join("media/demo.mp4"),
    )
    .unwrap();
    let mut info = media::probe_executable(&tool("ffprobe"), &root.join("media/demo.mp4"))
        .await
        .unwrap();
    info.streams.push(MediaStream {
        index: 5,
        kind: "subtitle".into(),
        codec: "subrip".into(),
        language: "fra".into(),
        title: String::new(),
        bitmap: false,
        channels: None,
        width: None,
        height: None,
    });
    let mut p = Project::new("Cancel extraction".into(), "ja".into(), "fr".into());
    p.media = Some(MediaAsset {
        id: crate::domain::id(),
        path: "media/demo.mp4".into(),
        preview_path: None,
        audio_stream_index: Some(1),
        info,
    });
    project::save(&root, &p).unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().to_owned(),
    });
    let app = tauri::test::mock_app();
    let permit = core.gate.clone().acquire_owned().await.unwrap();
    let task_core = core.clone();
    let app_handle = app.handle().clone();
    let task =
        tokio::spawn(async move { embedded::import(task_core, app_handle, 5, "target").await });
    let flag = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(flag) = core
                .jobs
                .lock()
                .unwrap()
                .values()
                .next()
                .map(|job| job.cancel.clone())
            {
                break flag;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    flag.store(true, Ordering::Relaxed);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        "CANCELLED"
    );
    drop(permit);
    assert_eq!(project::load(&root).unwrap().revision, 0);
    assert_eq!(
        std::fs::read_dir(root.join("subtitles")).unwrap().count(),
        0
    );
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
        lightweight: true,
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
