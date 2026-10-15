use super::*;
use std::sync::Mutex;
fn tool(name: &str) -> PathBuf {
    if cfg!(windows) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{name}.exe"))
    } else {
        PathBuf::from(name)
    }
}
async fn ffmpeg(args: &[&str], output: &Path) {
    let result = media::command(&tool("ffmpeg"))
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-filter_complex_threads",
            "1",
        ])
        .args(args)
        .args(["-threads", "1"])
        .arg(output)
        .output()
        .await
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
async fn fixture() -> (tempfile::TempDir, PathBuf, Project) {
    let temporary = tempfile::tempdir().unwrap();
    let root = project::create_root(temporary.path(), "Mixed voices é").unwrap();
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=25:d=4",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.03:s=48000:d=4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "pcm_s16le",
            "-ac",
            "2",
        ],
        &root.join("media/source.mkv"),
    )
    .await;
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.1:s=48000:d=4",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
        ],
        &root.join("stems/music.wav"),
    )
    .await;
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.2:s=24000:d=1.5",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
        ],
        &root.join("generations/voice.wav"),
    )
    .await;
    let mut p = Project::new("Mix".into(), "ja".into(), "fr".into());
    p.format_version = 6;
    p.media = Some(crate::domain::MediaAsset {
        id: "movie".into(),
        path: "media/source.mkv".into(),
        preview_path: None,
        audio_stream_index: Some(1),
        info: media::probe_executable(&tool("ffprobe"), &root.join("media/source.mkv"))
            .await
            .unwrap(),
    });
    p.source_cues = serde_json::from_value(
        serde_json::json!([{"id":"s","startMs":1000,"endMs":3000,"text":"Hello"}]),
    )
    .unwrap();
    p.target_cues = serde_json::from_value(
        serde_json::json!([{"id":"t","startMs":1000,"endMs":3000,"text":"Bonjour"}]),
    )
    .unwrap();
    p.dialogues=serde_json::from_value(serde_json::json!([{"id":"line","startMs":1000,"endMs":3000,"sourceCueIds":["s"],"targetCueIds":["t"],"ttsText":null,"characterId":null,"status":"generated","warnings":[],"selectedGenerationIds":{"fr":"voice"}}])).unwrap();
    p.generations = vec![
        serde_json::json!({"id":"voice","kind":"tts","dialogueId":"line","providerId":"cosyvoice3","modelId":"cosy3-official","path":"generations/voice.wav","createdAt":"2026-10-15T00:00:00Z","sourcePath":"media/source.mkv","startMs":1000,"endMs":3000,"text":"Bonjour","language":"fr","characterId":null,"durationMs":1500,"sampleRate":24000,"options":{"device":"cpu","referenceMode":"current","referenceId":null,"mode":"crossLingual","speed":1,"seed":7},"referenceTranscript":"","device":"cpu","deviceName":"CPU","peakVramMb":0,"inputHash":"fixture"}),
    ];
    p.tracks=serde_json::from_value(serde_json::json!([
        {"id":"original","kind":"original","language":"ja","mute":true,"solo":false,"gain":1},
        {"id":"music","kind":"audio","role":"music","path":"stems/music.wav","sourcePath":"media/source.mkv","durationMs":4000,"language":"ja","mute":false,"solo":false,"gain":0.5},
        {"id":"dubbing","kind":"dubbing","language":"fr","mute":false,"solo":false,"gain":0.8,"regions":[{"id":"quiet","startMs":1500,"endMs":1800,"gain":1,"mute":true},{"id":"low","startMs":2000,"endMs":2300,"gain":0.25,"mute":false}]}
    ])).unwrap();
    p.validate().unwrap();
    (temporary, root, p)
}
fn core(root: &Path, p: Project) -> Arc<Core> {
    Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.into(), p))),
        jobs: Mutex::new(std::collections::HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.into(),
        model_dir: Mutex::new(root.join("models")),
    })
}
async fn pcm(path: &Path, stream: &str) -> Vec<f32> {
    let result = media::command(&tool("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map", stream, "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(result.status.success());
    result
        .stdout
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}
async fn hash(path: &Path, stream: &str) -> String {
    let result = media::command(&tool("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map", stream, "-c", "copy", "-f", "hash", "-hash", "sha256", "pipe:1",
        ])
        .output()
        .await
        .unwrap();
    assert!(result.status.success());
    String::from_utf8(result.stdout).unwrap()
}
#[tokio::test]
async fn mkv_contains_synchronized_mix_original_and_both_subtitles_with_unchanged_video() {
    let (_temporary, root, p) = fixture().await;
    let app = tauri::test::mock_app();
    let app = app.handle().clone();
    let core = core(&root, p.clone());
    let options = Options {
        include_original: true,
        source_subtitles: true,
        target_subtitles: true,
        codec: "flac".into(),
        allow_incomplete: false,
    };
    let output = root.join("exports/dubbed.mkv");
    let request = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        output: output.clone(),
        options,
    };
    let key = jobs::create(&core, &app, "mkvExport", p.id.clone(), None);
    export(
        &core,
        &app,
        &key,
        &request,
        &p,
        &Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap_or_else(|error| {
        panic!(
            "{error}: {:?}",
            core.jobs
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .saved
                .record
                .logs
        )
    });
    let result = media::probe_executable(&tool("ffprobe"), &output)
        .await
        .unwrap();
    assert_eq!(
        result
            .streams
            .iter()
            .map(|s| s.kind.as_str())
            .collect::<Vec<_>>(),
        ["video", "audio", "audio", "subtitle", "subtitle"]
    );
    assert_eq!(result.streams[1].language, "fra");
    assert_eq!(result.streams[2].language, "jpn");
    assert_eq!(result.streams[4].language, "fra");
    assert_eq!(
        hash(&root.join("media/source.mkv"), "0:v:0").await,
        hash(&output, "0:v:0").await
    );
    assert_eq!(
        hash(&root.join("media/source.mkv"), "0:a:0").await,
        hash(&output, "0:a:1").await
    );
    let samples = pcm(&output, "0:a:0").await;
    let average = |ms: usize| {
        samples[ms * 48 * 2..(ms + 10) * 48 * 2]
            .iter()
            .copied()
            .sum::<f32>()
            / 960.0
    };
    // Bandit mono fixture was upmixed with FFmpeg's sqrt(1/2) coefficient.
    let bed = 0.1f32 * std::f32::consts::FRAC_1_SQRT_2 * 0.5;
    for (ms, expected) in [
        (500, bed),
        (1200, bed + 0.16),
        (1600, bed),
        (2100, bed + 0.04),
        (2400, bed + 0.16),
        (2800, bed),
    ] {
        assert!(
            (average(ms) - expected).abs() < 0.001,
            "{ms}: {} expected {expected}",
            average(ms)
        );
    }
    assert_eq!(samples.len(), 4000 * 48 * 2);
    assert_eq!(fs::read_dir(root.join("exports")).unwrap().count(), 1);
    project::save(&root, &p).unwrap();
    assert_eq!(project::load(&root).unwrap().format_version, 6);
}
#[tokio::test]
async fn silence_export_and_cancel_keep_sources_and_existing_destinations() {
    let (_temporary, root, mut p) = fixture().await;
    let app = tauri::test::mock_app();
    let app = app.handle().clone();
    let core = core(&root, p.clone());
    assert_eq!(
        destination(&root, &p, &root.join("media/source.mkv")).unwrap_err(),
        "INVALID_PATH"
    );
    let voice = fs::read(root.join("generations/voice.wav")).unwrap();
    for track in &mut p.tracks {
        track.mute = true;
    }
    let output = root.join("exports/silent.mkv");
    let mut request = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: 0,
        output: output.clone(),
        options: Options {
            include_original: false,
            source_subtitles: false,
            target_subtitles: false,
            codec: "flac".into(),
            allow_incomplete: false,
        },
    };
    let key = jobs::create(&core, &app, "mkvExport", p.id.clone(), None);
    export(
        &core,
        &app,
        &key,
        &request,
        &p,
        &Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert!(pcm(&output, "0:a:0")
        .await
        .iter()
        .all(|s| s.abs() < 0.000001));
    let previous = fs::read(&output).unwrap();
    p.tracks[2].mute = false;
    assert_eq!(
        export(
            &core,
            &app,
            &key,
            &request,
            &p,
            &Arc::new(AtomicBool::new(true))
        )
        .await
        .unwrap_err(),
        "CANCELLED"
    );
    assert_eq!(fs::read(&output).unwrap(), previous);
    assert_eq!(fs::read(root.join("generations/voice.wav")).unwrap(), voice);
    assert_eq!(fs::read_dir(root.join("exports")).unwrap().count(), 1);
    p.dialogues[0].selected_generation_ids.clear();
    assert_eq!(
        validate(&p, &request.options).unwrap_err(),
        "MIX_REVIEW_REQUIRED"
    );
    request.options.allow_incomplete = true;
    validate(&p, &request.options).unwrap();
}
#[tokio::test]
async fn assembly_adds_overlapping_takes_at_current_dialogue_start_and_rejects_missing_files() {
    let (_temporary, root, p) = fixture().await;
    let mut selected = clips(&p);
    selected.push(Clip {
        start: 36000,
        ..selected[0].clone()
    });
    let output = root.join("exports/voice.f32");
    assemble(
        &root,
        &selected,
        4000,
        &output,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    let data = fs::read(&output).unwrap();
    let at = |ms: usize| f32::from_le_bytes(data[ms * 24 * 4..ms * 24 * 4 + 4].try_into().unwrap());
    for (ms, expected) in [(0, 0.0), (1100, 0.2), (1700, 0.4), (2700, 0.2), (3500, 0.0)] {
        assert!((at(ms) - expected).abs() < 0.0001);
    }
    selected[0].path = "generations/missing.wav".into();
    assert!(assemble(
        &root,
        &selected,
        4000,
        &output,
        &AtomicBool::new(false),
        |_| {}
    )
    .is_err());
}

#[tokio::test]
async fn fitted_voice_preserves_pitch_tail_original_and_exact_slot_length() {
    let (_temporary, root, _p) = fixture().await;
    let source = root.join("generations/tones.wav");
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.2*sin(2*PI*if(lt(t\\,1.6)\\,440\\,880)*t):s=24000:d=2",
            "-c:a",
            "pcm_s16le",
        ],
        &source,
    )
    .await;
    let original = fs::read(&source).unwrap();
    let flag = AtomicBool::new(false);
    let path = crate::voice_fit::take(&root, "generations/tones.wav", 1000, &tool("ffmpeg"), &flag)
        .await
        .unwrap();
    assert_eq!(
        audio_files::pcm_frames(&path, 1, 24000, "test").unwrap(),
        24000
    );
    let data = pcm(&path, "0:a:0").await;
    let frequency = |start: usize, end: usize| {
        let mono: Vec<_> = data[start * 48 * 2..end * 48 * 2]
            .iter()
            .step_by(2)
            .copied()
            .collect();
        mono.windows(2)
            .filter(|v| v[0] <= 0.0 && v[1] > 0.0)
            .count() as f64
            * 1000.0
            / (end - start) as f64
    };
    assert!((frequency(100, 600) - 440.0).abs() < 8.0);
    // The final syllable/tone must be moved into the slot, not simply cut off.
    assert!(
        (frequency(850, 950) - 880.0).abs() < 25.0,
        "tail frequency {}",
        frequency(850, 950)
    );
    assert_eq!(
        crate::voice_fit::take(&root, "generations/tones.wav", 1000, &tool("ffmpeg"), &flag)
            .await
            .unwrap(),
        path
    );
    let changed =
        crate::voice_fit::take(&root, "generations/tones.wav", 750, &tool("ffmpeg"), &flag)
            .await
            .unwrap();
    assert_ne!(changed, path);
    assert_eq!(
        audio_files::pcm_frames(&changed, 1, 24000, "test").unwrap(),
        18000
    );
    assert_eq!(
        crate::voice_fit::take(&root, "generations/tones.wav", 2500, &tool("ffmpeg"), &flag)
            .await
            .unwrap(),
        source.canonicalize().unwrap()
    );
    assert_eq!(
        crate::voice_fit::take(
            &root,
            "generations/tones.wav",
            1000,
            &tool("ffmpeg"),
            &AtomicBool::new(true)
        )
        .await
        .unwrap_err(),
        "CANCELLED"
    );
    assert_eq!(fs::read(source).unwrap(), original);
}

#[tokio::test]
async fn export_fits_to_next_take_and_flags_zero_slots() {
    let (_temporary, root, mut p) = fixture().await;
    p.tracks[1].mute = true;
    p.tracks[2].gain = 1.0;
    p.tracks[2].regions.clear();
    let mut second = p.dialogues[0].clone();
    second.id = "second".into();
    second.start_ms = 2000;
    second.end_ms = 2500;
    second
        .selected_generation_ids
        .insert("fr".into(), "second".into());
    p.dialogues.push(second);
    let mut generation = p.generations[0].clone();
    generation["id"] = "second".into();
    generation["dialogueId"] = "second".into();
    generation["path"] = "generations/second.wav".into();
    generation["durationMs"] = 500.into();
    generation["startMs"] = 2000.into();
    generation["endMs"] = 2500.into();
    p.generations.push(generation);
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.1:s=24000:d=0.5",
            "-c:a",
            "pcm_s16le",
        ],
        &root.join("generations/second.wav"),
    )
    .await;
    let selected = clips(&p);
    assert_eq!(selected[0].slot_ms, 1000);
    assert_eq!(selected[0].frames, 24000);
    let app = tauri::test::mock_app();
    let app = app.handle().clone();
    let core = core(&root, p.clone());
    let request = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: 0,
        output: root.join("exports/fitted.mkv"),
        options: Options {
            include_original: false,
            source_subtitles: false,
            target_subtitles: false,
            codec: "flac".into(),
            allow_incomplete: false,
        },
    };
    validate(&p, &request.options).unwrap();
    let key = jobs::create(&core, &app, "mkvExport", p.id.clone(), None);
    export(
        &core,
        &app,
        &key,
        &request,
        &p,
        &Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    let data = pcm(&request.output, "0:a:0").await;
    let average = |ms: usize| {
        data[ms * 48 * 2..(ms + 10) * 48 * 2]
            .iter()
            .copied()
            .sum::<f32>()
            / 960.0
    };
    for (ms, expected) in [
        (500, 0.0),
        (1300, 0.2),
        (1900, 0.2),
        (2100, 0.1),
        (2450, 0.1),
        (2600, 0.0),
    ] {
        assert!(
            (average(ms) - expected).abs() < 0.015,
            "{ms}: {} expected {expected}",
            average(ms)
        );
    }
    p.dialogues[1].start_ms = p.dialogues[0].start_ms;
    assert!(clips(&p).iter().all(|c| c.slot_ms == 0));
    assert_eq!(
        validate(&p, &request.options).unwrap_err(),
        "MIX_REVIEW_REQUIRED"
    );
}

#[tokio::test]
async fn export_job_captures_saved_levels_and_produces_aac_while_edits_continue() {
    let (_temporary, root, p) = fixture().await;
    let app = tauri::test::mock_app();
    let app = app.handle().clone();
    let core = core(&root, p.clone());
    let output = root.join("exports/snapshot.mkv");
    let key = enqueue(
        core.clone(),
        app,
        output.clone(),
        Options {
            include_original: false,
            source_subtitles: false,
            target_subtitles: true,
            codec: "aac".into(),
            allow_incomplete: false,
        },
    )
    .unwrap();
    {
        let mut session = core.session.lock().unwrap();
        let s = session.as_mut().unwrap();
        s.project.tracks[2].mute = true;
        s.project.tracks[1].mute = true;
        s.project.revision += 1;
    }
    let done = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let record = core
                .jobs
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .saved
                .record
                .clone();
            if ["succeeded", "failed", "cancelled"].contains(&record.status.as_str()) {
                break record;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(done.status, "succeeded", "{:?} {:?}", done.error, done.logs);
    let result = media::probe_executable(&tool("ffprobe"), &output)
        .await
        .unwrap();
    assert_eq!(
        result.streams.iter().filter(|s| s.kind == "audio").count(),
        1
    );
    assert_eq!(result.streams[1].codec, "aac");
    assert_eq!(result.streams[2].kind, "subtitle");
    assert!(result.duration_ms.abs_diff(4000) < 50);
    assert!(pcm(&output, "0:a:0")
        .await
        .iter()
        .any(|sample| sample.abs() > 0.01));
    let jobs = core.jobs.lock().unwrap();
    let request = jobs.get(&key).unwrap().saved.mix_request.as_ref().unwrap();
    assert_eq!(request.revision, p.revision);
    assert!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .tracks[2]
            .mute
    );
}
