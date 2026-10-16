use super::*;
use crate::audio_patch::{self, Snippet};
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
        include_retouched: true,
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
            include_retouched: true,
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
async fn moved_dubbing_changes_mkv_onset_without_changing_subtitles_or_original_take() {
    let (_temporary, root, mut p) = fixture().await;
    let before =
        serde_json::to_value((&p.source_cues, &p.target_cues, &p.dialogues, &p.generations))
            .unwrap();
    let voice = fs::read(root.join("generations/voice.wav")).unwrap();
    p.format_version = 7;
    p.dubbing_timing = Some(crate::domain::DubbingTiming {
        durations_ms: Default::default(),
        source_path: "media/source.mkv".into(),
        offsets_ms: [("line".into(), [("fr".into(), 500)].into_iter().collect())]
            .into_iter()
            .collect(),
    });
    for track in &mut p.tracks {
        track.mute = track.kind != "dubbing";
        if track.kind == "dubbing" {
            track.regions.clear();
            track.gain = 1.0;
        }
    }
    assert_eq!(clips(&p)[0].start, 1500 * 24);
    assert_eq!(clips(&p)[0].slot_ms, 2000);
    let app = tauri::test::mock_app();
    let app = app.handle().clone();
    let core = core(&root, p.clone());
    let request = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        output: root.join("exports/shifted.mkv"),
        options: Options {
            include_retouched: true,
            include_original: false,
            source_subtitles: true,
            target_subtitles: true,
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
    let samples = pcm(&request.output, "0:a:0").await;
    let level = |ms: usize| {
        samples[ms * 96..(ms + 10) * 96]
            .iter()
            .copied()
            .sum::<f32>()
            / 960.0
    };
    assert!(level(1100).abs() < 0.0001);
    assert!((level(1700) - 0.2).abs() < 0.001);
    assert!(level(3200).abs() < 0.0001);
    assert_eq!(
        serde_json::to_value((&p.source_cues, &p.target_cues, &p.dialogues, &p.generations))
            .unwrap(),
        before
    );
    assert_eq!(fs::read(root.join("generations/voice.wav")).unwrap(), voice);
    project::save(&root, &p).unwrap();
    assert_eq!(clips(&project::load(&root).unwrap())[0].start, 1500 * 24);
    let mut invalid = p.clone();
    invalid.format_version = 6;
    assert_eq!(invalid.validate().unwrap_err(), "INVALID_PROJECT");
    p.dubbing_timing
        .as_mut()
        .unwrap()
        .offsets_ms
        .get_mut("line")
        .unwrap()
        .insert("fr".into(), -500);
    assert_eq!(clips(&p)[0].start, 500 * 24);
    p.dubbing_timing
        .as_mut()
        .unwrap()
        .durations_ms
        .insert("line".into(), [("fr".into(), 2500)].into_iter().collect());
    let extended = clips(&p);
    assert!(extended[0].exact_duration);
    assert_eq!(extended[0].frames, 2500 * 24);
    let fitted = crate::voice_fit::take_with_duration(
        &root,
        &extended[0].path,
        extended[0].slot_ms,
        extended[0].exact_duration,
        &tool("ffmpeg"),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(
        audio_files::pcm_frames(&fitted, 1, 24000, "test").unwrap(),
        2500 * 24
    );
    project::save(&root, &p).unwrap();
    assert_eq!(clips(&project::load(&root).unwrap())[0].frames, 2500 * 24);
    p.dubbing_timing.as_mut().unwrap().source_path = "media/replaced.mkv".into();
    assert_eq!(clips(&p)[0].start, 1000 * 24);
    assert!(!clips(&p)[0].exact_duration);
}
#[tokio::test]
async fn assembly_adds_overlapping_takes_at_current_dialogue_start_and_rejects_missing_files() {
    let (_temporary, root, p) = fixture().await;
    let mut selected = clips(&p);
    selected.push(Clip {
        exact_duration: false,
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
    assert_eq!(fs::read(&source).unwrap(), original);

    let stretched = crate::voice_fit::take_with_duration(
        &root,
        "generations/tones.wav",
        3000,
        true,
        &tool("ffmpeg"),
        &flag,
    )
    .await
    .unwrap();
    assert_eq!(
        audio_files::pcm_frames(&stretched, 1, 24000, "test").unwrap(),
        72000
    );
    let extended = pcm(&stretched, "0:a:0").await;
    let frequency = |start: usize, end: usize| {
        let mono: Vec<_> = extended[start * 96..end * 96]
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
    assert!((frequency(300, 1800) - 440.0).abs() < 8.0);
    assert!(
        (frequency(2600, 2800) - 880.0).abs() < 25.0,
        "stretched tail {}",
        frequency(2600, 2800)
    );
    assert_ne!(stretched, source.canonicalize().unwrap());
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
            include_retouched: true,
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
            include_retouched: true,
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

async fn transfer_fixture(
    operation: &str,
) -> (
    tempfile::TempDir,
    PathBuf,
    Arc<Core>,
    tauri::App<tauri::test::MockRuntime>,
    Project,
) {
    let (temp, root, p) = fixture().await;
    let core = core(&root, p.clone());
    let app = tauri::test::mock_app();
    let request = audio_patch::Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        options: audio_patch::Options {
            source_track_id: "original".into(),
            target_track_id: "music".into(),
            start_ms: 1000,
            end_ms: 2000,
            operation: operation.into(),
        },
    };
    audio_patch::transfer(&core, app.handle(), "", &request, &AtomicBool::new(false))
        .await
        .unwrap();
    let edited = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    (temp, root, core, app, edited)
}
#[allow(clippy::too_many_arguments)]
async fn snippet_level(
    core: &Arc<Core>,
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    root: &Path,
    p: &Project,
    track: &str,
    start: u64,
    end: u64,
    fader: bool,
) -> f32 {
    let output = root.join("exports/snippet.wav");
    audio_patch::snippet(
        core,
        app,
        "",
        p,
        root,
        Snippet {
            track_id: track,
            start_ms: start,
            end_ms: end,
            channels: 2,
            rate: 48000,
            fader,
        },
        &output,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    let data = pcm(&output, "0:a:0").await;
    assert_eq!(data.len(), ((end - start) * 48 * 2) as usize);
    // The fixture's mono DC signal was upmixed with sqrt(1/2); compare in its
    // original calibration units while retaining stereo in every rendered file.
    data[data.len() / 2] / std::f32::consts::FRAC_1_SQRT_2
}
#[tokio::test]
async fn copy_and_move_ranges_match_playback_reference_and_export_envelopes() {
    for operation in ["copy", "move"] {
        let (_temp, root, core, app, p) = transfer_fixture(operation).await;
        assert_eq!(p.format_version, 8);
        p.validate().unwrap();
        assert_eq!(
            audio_patch::all(&p).unwrap().len(),
            if operation == "copy" { 1 } else { 2 }
        );
        let source = snippet_level(
            &core,
            app.handle(),
            &root,
            &p,
            "original",
            1100,
            1900,
            false,
        )
        .await;
        assert!((source - if operation == "copy" { 0.03 } else { 0.0 }).abs() < 0.001);
        assert!(
            (snippet_level(&core, app.handle(), &root, &p, "music", 1100, 1900, false).await
                - 0.13)
                .abs()
                < 0.001
        );
        assert!(
            (snippet_level(&core, app.handle(), &root, &p, "music", 1100, 1900, true).await
                - 0.065)
                .abs()
                < 0.001
        );
        assert!(
            (snippet_level(&core, app.handle(), &root, &p, "music", 2500, 2900, false).await - 0.1)
                .abs()
                < 0.001
        );
        // Saved assets and the operation survive reopening; source files retain their level.
        let loaded = project::load(&root).unwrap();
        assert_eq!(
            audio_patch::all(&loaded).unwrap().len(),
            audio_patch::all(&p).unwrap().len()
        );
        let original = pcm(&root.join("media/source.mkv"), "0:a:0").await;
        assert!((original[120000] - 0.03 * std::f32::consts::FRAC_1_SQRT_2).abs() < 0.001);
    }
}
#[tokio::test]
async fn swap_captures_both_ranges_before_replacing_either_track() {
    let (_temp, root, core, app, p) = transfer_fixture("swap").await;
    assert!(
        (snippet_level(
            &core,
            app.handle(),
            &root,
            &p,
            "original",
            1100,
            1900,
            false
        )
        .await
            - 0.1)
            .abs()
            < 0.001
    );
    assert!(
        (snippet_level(&core, app.handle(), &root, &p, "music", 1100, 1900, false).await - 0.03)
            .abs()
            < 0.001
    );
    // A second transfer sees the already edited track, rather than the original WAV.
    let r = audio_patch::Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        options: audio_patch::Options {
            source_track_id: "music".into(),
            target_track_id: "original".into(),
            start_ms: 1200,
            end_ms: 1800,
            operation: "move".into(),
        },
    };
    audio_patch::transfer(&core, app.handle(), "", &r, &AtomicBool::new(false))
        .await
        .unwrap();
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    assert!(
        (snippet_level(
            &core,
            app.handle(),
            &root,
            &p,
            "original",
            1300,
            1700,
            false
        )
        .await
            - 0.13)
            .abs()
            < 0.001
    );
    assert!(
        snippet_level(&core, app.handle(), &root, &p, "music", 1300, 1700, false)
            .await
            .abs()
            < 0.0001
    );
}
#[tokio::test]
async fn stale_or_cancelled_transfer_does_not_change_project_or_leave_assets() {
    let (_temp, root, p) = fixture().await;
    let core = core(&root, p.clone());
    let app = tauri::test::mock_app();
    let mut r = audio_patch::Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision + 1,
        options: audio_patch::Options {
            source_track_id: "original".into(),
            target_track_id: "music".into(),
            start_ms: 1000,
            end_ms: 2000,
            operation: "move".into(),
        },
    };
    assert_eq!(
        audio_patch::transfer(&core, app.handle(), "", &r, &AtomicBool::new(false))
            .await
            .unwrap_err(),
        "STALE_REVISION"
    );
    r.revision = p.revision;
    assert_eq!(
        audio_patch::transfer(&core, app.handle(), "", &r, &AtomicBool::new(true))
            .await
            .unwrap_err(),
        "CANCELLED"
    );
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .revision,
        p.revision
    );
    assert_eq!(fs::read_dir(root.join("stems")).unwrap().count(), 1);
}
#[tokio::test]
async fn reference_selection_defaults_to_speech_and_accepts_music_or_original() {
    let (_temp, _root, mut p) = fixture().await;
    assert_eq!(audio_patch::source_track(&p, None).unwrap().id, "original");
    p.model_preferences =
        Some(serde_json::json!({"ttsProviderId":null,"referenceTrackId":"music"}));
    assert_eq!(audio_patch::source_track(&p, None).unwrap().id, "music");
    assert_eq!(
        audio_patch::source_track(&p, Some("original")).unwrap().id,
        "original"
    );
    assert!(audio_patch::source_track(&p, Some("dubbing")).is_err());
    p.tracks.push(serde_json::from_value(serde_json::json!({"id":"speech","kind":"audio","role":"speech","path":"stems/speech.wav","language":"ja","mute":false,"solo":false,"gain":1})).unwrap());
    p.model_preferences = None;
    assert_eq!(audio_patch::source_track(&p, None).unwrap().id, "speech");
}
fn inpaint_options() -> crate::inpaint::Options {
    serde_json::from_value(serde_json::json!({"lineId":"line","generationId":"voice","device":"cuda:0","face":{"x":0.1,"y":0.1,"width":0.6,"height":0.8},"endX":0.2,"endY":0.15,"mask":{"x":0.2,"y":0.5,"width":0.6,"height":0.4},"feather":0.15,"blend":0.8,"style":"anime","seed":7})).unwrap()
}
#[tokio::test]
async fn translated_face_crop_and_alpha_overlay_use_valid_ffmpeg_expressions() {
    let (_temp, root, _p) = fixture().await;
    let o = inpaint_options();
    o.validate().unwrap();
    let face = root.join("cache/face.png");
    let crop = crate::inpaint::crop_expression(&o, 1000);
    ffmpeg(
        &[
            "-i",
            root.join("media/source.mkv").to_str().unwrap(),
            "-vf",
            &crop,
            "-frames:v",
            "1",
            "-update",
            "1",
        ],
        &face,
    )
    .await;
    let overlay = crate::inpaint::overlay_expression(&o, 1000, 160, 90);
    ffmpeg(
        &[
            "-i",
            root.join("media/source.mkv").to_str().unwrap(),
            "-loop",
            "1",
            "-i",
            face.to_str().unwrap(),
            "-filter_complex",
            &overlay,
            "-map",
            "[out]",
            "-an",
            "-t",
            "0.2",
            "-c:v",
            "libx264",
        ],
        &root.join("cache/composite.mp4"),
    )
    .await;
    let info = media::probe_executable(&tool("ffprobe"), &root.join("cache/composite.mp4"))
        .await
        .unwrap();
    assert_eq!(info.duration_ms, 200);
    let mut invalid = o;
    invalid.device = "cpu".into();
    assert_eq!(invalid.validate().unwrap_err(), "INPAINT_CUDA_REQUIRED");
    invalid.device = "cuda:0".into();
    invalid.end_x = 0.9;
    assert!(invalid.validate().is_err());
}

#[tokio::test]
async fn retouched_variants_reencode_only_when_selected_and_refuse_stale_timing() {
    use sha2::Digest;
    let (_temp, root, mut p) = fixture().await;
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=160x90:r=25:d=1.48",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
        ],
        &root.join("generations/lips-edit.mp4"),
    )
    .await;
    let fingerprint = format!(
        "{:x}",
        sha2::Sha256::digest(b"media/source.mkv|fr|voice|1000|2000|false")
    );
    p.format_version = 8;
    p.generations.push(serde_json::json!({"kind":"lipVideo","id":"edit","dialogueId":"line","generationId":"voice","sourcePath":"media/source.mkv","language":"fr","path":"generations/lips-edit.mp4","startMs":1000,"durationMs":1480,"slotMs":2000,"exactDuration":false,"fingerprint":fingerprint,"enabled":true,"options":inpaint_options(),"createdAt":"2026-10-16T00:00:00Z","modelRevision":"fixture"}));
    p.validate().unwrap();
    assert_eq!(crate::inpaint::active(&p).unwrap().len(), 1);
    let app = tauri::test::mock_app();
    let core = core(&root, p.clone());
    let output = root.join("exports/retouched.mkv");
    let options = Options {
        include_retouched: true,
        include_original: true,
        source_subtitles: true,
        target_subtitles: true,
        codec: "flac".into(),
        allow_incomplete: false,
    };
    let request = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        output: output.clone(),
        options: options.clone(),
    };
    export(
        &core,
        app.handle(),
        "",
        &request,
        &p,
        &Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    for (time, red) in [("0.5", false), ("1.2", true), ("2.8", false)] {
        let sample = media::command(&tool("ffmpeg"))
            .args(["-v", "error", "-ss", time, "-i"])
            .arg(&output)
            .args([
                "-an",
                "-vf",
                "scale=1:1",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .output()
            .await
            .unwrap();
        assert!(sample.status.success());
        assert_eq!(sample.stdout.len(), 3);
        assert!(
            if red {
                sample.stdout[0] > 190 && sample.stdout[2] < 80
            } else {
                sample.stdout[2] > 190 && sample.stdout[0] < 80
            },
            "{:?}",
            sample.stdout
        );
    }
    p.dubbing_timing = Some(
        serde_json::from_value(
            serde_json::json!({"sourcePath":"media/source.mkv","offsetsMs":{"line":{"fr":100}}}),
        )
        .unwrap(),
    );
    assert_eq!(crate::inpaint::active(&p).unwrap_err(), "INPAINT_STALE");
    assert!(validate(&p, &options).is_err());
    let original = Options {
        include_retouched: false,
        ..options
    };
    assert!(validate(&p, &original).is_ok());
}
