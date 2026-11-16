use super::*;
use std::time::Duration;
async fn fixture() -> (tempfile::TempDir, Arc<Core>, Options, tts::WorkerLaunch) {
    let (dir, root, mut p) = crate::mix::tests::fixture().await;
    p.format_version = 31;
    let mut line = p.dialogues[0].clone();
    line.id = "line2".into();
    line.selected_generation_ids
        .insert("fr".into(), "voice2".into());
    p.dialogues.push(line);
    let mut g = p.generations[0].clone();
    g["id"] = json!("voice2");
    g["dialogueId"] = json!("line2");
    g["path"] = json!("generations/voice2.wav");
    p.generations.push(g);
    std::fs::copy(
        root.join("generations/voice.wav"),
        root.join("generations/voice2.wav"),
    )
    .unwrap();
    p.dubbing_timing = Some(crate::domain::DubbingTiming {
        source_path: p.media.as_ref().unwrap().path.clone(),
        offsets_ms: std::collections::HashMap::from([(
            "line".into(),
            std::collections::HashMap::from([("fr".into(), 250)]),
        )]),
        durations_ms: std::collections::HashMap::from([(
            "line".into(),
            std::collections::HashMap::from([("fr".into(), 1250)]),
        )]),
    });
    project::save(&root, &p).unwrap();
    let core = crate::mix::tests::core(&root, p);
    let options:Options=serde_json::from_value(json!({"lineIds":["line","line2","line"],"reference":{"generationId":"batch","referenceMode":"generation","referenceId":"voice","referenceRange":{"startMs":250,"endMs":1250},"characterId":null,"device":"cpu"}})).unwrap();
    let script = root.join("conversion-worker.py");
    std::fs::write(&script,r#"import sys,json,wave,os,time,array
from pathlib import Path
root=Path(__file__).resolve().parent
def generate(r):
    with (root/'vc-calls.jsonl').open('a') as f:f.write(json.dumps(dict(pid=os.getpid(),source=r['sourceGenerationId'],referenceKey=r['referenceKey']))+'\n')
    if (root/'slow').exists():time.sleep(20)
    if r['sourceGenerationId']=='voice2' and (root/'fail-once').exists():
        (root/'fail-once').unlink();raise ValueError('VC_FAILED')
    with wave.open(r['sourceAudio'],'rb') as f:
        params=f.getparams();a=array.array('h',f.readframes(f.getnframes()))
    with wave.open(r['outputPath'],'wb') as f:
        f.setparams(params);f.writeframes(array.array('h',(int(x*.8) for x in a)).tobytes())
    Path(r['resultPath']).write_text(json.dumps(dict(device='cpu',deviceName='Protocol fixture',peakVramMb=0)))
if '--batch' in sys.argv:
    for line in sys.stdin:
        c=json.loads(line)
        try:
            generate(json.loads(Path(c['path']).read_text(encoding='utf-8-sig')))
            print(json.dumps(dict(requestDone=c['requestId'])),flush=True)
        except Exception as e:
            print(json.dumps(dict(requestDone=c['requestId'],error=str(e))),flush=True);break
else:generate(json.loads(Path(sys.argv[-1]).read_text(encoding='utf-8-sig')))
"#).unwrap();
    let launch = tts::WorkerLaunch {
        python: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
        script,
        model: root.join("model"),
    };
    (dir, core, options, launch)
}
fn request(core: &Core, o: Options) -> Request {
    let guard = core.session.lock().unwrap();
    let s = guard.as_ref().unwrap();
    let (_, items) = plan(&s.project, &s.root, &o).unwrap();
    Request {
        root: s.root.clone(),
        project_id: s.project.id.clone(),
        revision: s.project.revision,
        options: o,
        items,
        origin: None,
    }
}
async fn finished(core: &Core, key: &str) -> jobs::Job {
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            let j = core
                .jobs
                .lock()
                .unwrap()
                .get(key)
                .unwrap()
                .saved
                .record
                .clone();
            if !["queued", "running", "paused"].contains(&j.status.as_str()) {
                break j;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn selected_takes_share_a_resident_converter_and_preserve_old_audio_edits_and_timing() {
    let (_dir, core, o, launch) = fixture().await;
    let app = tauri::test::mock_app();
    let before = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    let root = core.session.lock().unwrap().as_ref().unwrap().root.clone();
    let bytes = std::fs::read(root.join("generations/voice.wav")).unwrap();
    let movie = std::fs::read(root.join("media/source.mkv")).unwrap();
    let key = enqueue(
        core.clone(),
        app.handle().clone(),
        request(&core, o),
        Some(launch),
    )
    .unwrap();
    let j = finished(&core, &key).await;
    assert_eq!(j.status, "succeeded", "{:?}", j.logs);
    assert_eq!(j.batch.unwrap().succeeded, 2);
    assert!(j.work_estimate.is_none());
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 4);
    assert_eq!(p.generations[..2], before.generations);
    assert_eq!(
        serde_json::to_value(&p.dubbing_timing).unwrap(),
        serde_json::to_value(&before.dubbing_timing).unwrap()
    );
    assert_eq!(
        std::fs::read(root.join("generations/voice.wav")).unwrap(),
        bytes
    );
    assert_eq!(std::fs::read(root.join("media/source.mkv")).unwrap(), movie);
    for (index, g) in p.generations.iter().skip(2).enumerate() {
        assert_eq!(g["takeOrigin"]["type"], "conversion");
        assert_eq!(g["voiceConversionBatchRootId"], key);
        assert_eq!(g["generationTiming"]["takeId"], g["id"]);
        assert_eq!(g["generationTiming"]["warmModel"], index > 0);
        assert_eq!(g["durationMs"], 1500);
        assert_eq!(
            p.dialogues[index].selected_generation_ids["fr"],
            g["id"].as_str().unwrap()
        );
    }
    let calls: Vec<Value> = std::fs::read_to_string(root.join("vc-calls.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["pid"], calls[1]["pid"]);
    assert_eq!(calls[0]["referenceKey"], calls[1]["referenceKey"]);
    // A missing journal outcome after the atomic WAV/project commit must not
    // cause a completed source to be converted again after a restart.
    std::fs::write(folder(&core, &key).unwrap().join("results.jsonl"), b"").unwrap();
    let report = report(&core, &key, 0, 20).unwrap();
    assert!(report["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["status"] == "succeeded"));
    assert_eq!(
        retry(core.clone(), app.handle().clone(), &key, &[]).unwrap_err(),
        "VC_BATCH_EMPTY"
    );
}
#[tokio::test]
async fn failures_are_durable_and_retry_rejects_changed_inputs_and_never_repeats_successes() {
    let (_dir, core, mut o, launch) = fixture().await;
    let app = tauri::test::mock_app();
    let root = core.session.lock().unwrap().as_ref().unwrap().root.clone();
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .voice_references
        .push(crate::domain::VoiceReference {
            id: "file-reference".into(),
            label: "Imported French reference".into(),
            path: "characters/file-reference.wav".into(),
            duration_ms: 1500,
            transcript: String::new(),
            source_dialogue_id: None,
        });
    o.reference.reference_mode = Some("reference".into());
    std::fs::create_dir_all(root.join("characters")).unwrap();
    std::fs::copy(
        root.join("generations/voice.wav"),
        root.join("characters/file-reference.wav"),
    )
    .unwrap();
    o.reference.reference_id = "file-reference".into();
    o.reference.reference_range = None;
    std::fs::write(root.join("fail-once"), b"fixture").unwrap();
    let key = enqueue(
        core.clone(),
        app.handle().clone(),
        request(&core, o),
        Some(launch),
    )
    .unwrap();
    assert_eq!(finished(&core, &key).await.status, "failed");
    let r = load(&core, &key).unwrap();
    assert_eq!(
        r.items[0].status,
        "succeeded",
        "{:?}",
        finished(&core, &key).await.logs
    );
    assert_eq!(r.items[1].error.as_deref(), Some("VC_FAILED"));
    let first = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .generations
        .last()
        .unwrap()
        .clone();
    let mut next = load(&core, &key).unwrap();
    next.items.retain(|i| i.status != "succeeded");
    next.items[0].status = "pending".into();
    next.items[0].error = None;
    next.origin = Some(key.clone());
    next.revision = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .revision;
    let launch = tts::WorkerLaunch {
        python: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
        script: root.join("conversion-worker.py"),
        model: root.join("model"),
    };
    let retry_key = enqueue(core.clone(), app.handle().clone(), next, Some(launch)).unwrap();
    assert_eq!(finished(&core, &retry_key).await.status, "succeeded");
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 4);
    assert!(p.generations.contains(&first));
    assert!(report(&core, &key, 0, 20).unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["status"] == "succeeded"));
    // New user edits invalidate frozen inputs for an unfinished row.
    let mut r = load(&core, &key).unwrap();
    r.items[1].status = "failed".into();
    r.items[1].generation_id = None;
    record(&core, &key, 1, &r.items[1]).unwrap();
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .generations
        .retain(|g| g["takeOrigin"]["sourceGenerationId"] != "voice2");
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .dialogues[1]
        .tts_text = Some("Changed".into());
    assert_eq!(
        retry(core.clone(), app.handle().clone(), &key, &["line2".into()]).unwrap_err(),
        "STALE_REVISION"
    );
}
#[tokio::test]
async fn cancellation_kills_the_private_worker_and_keeps_original_selection() {
    let (_dir, core, o, launch) = fixture().await;
    let app = tauri::test::mock_app();
    let root = core.session.lock().unwrap().as_ref().unwrap().root.clone();
    std::fs::write(root.join("slow"), b"fixture").unwrap();
    let before = project::load(&root).unwrap();
    let key = enqueue(
        core.clone(),
        app.handle().clone(),
        request(&core, o),
        Some(launch),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while !root.join("vc-calls.jsonl").is_file() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    core.jobs
        .lock()
        .unwrap()
        .get(&key)
        .unwrap()
        .cancel
        .store(true, Ordering::Relaxed);
    assert_eq!(finished(&core, &key).await.status, "cancelled");
    assert_eq!(core.gate.available_permits(), 1);
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations, before.generations);
    assert_eq!(
        p.dialogues[0].selected_generation_ids,
        before.dialogues[0].selected_generation_ids
    );
}
#[tokio::test]
async fn reference_ranges_copy_only_requested_pcm_and_planning_excludes_missing_takes() {
    let (_dir, core, mut o, _launch) = fixture().await;
    let root = core.session.lock().unwrap().as_ref().unwrap().root.clone();
    let source = root.join("generations/voice.wav");
    let before = std::fs::read(&source).unwrap();
    let target = root.join("trimmed.wav");
    trim_reference(&source, &target, 250, 1250, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(
        crate::audio_files::pcm_frames(&target, 1, 24000, "fixture").unwrap(),
        24000
    );
    assert_eq!(std::fs::read(&source).unwrap(), before);
    assert!(
        trim_reference(&source, &target, 0, 999, &AtomicBool::new(false))
            .await
            .is_err()
    );
    assert!(
        trim_reference(&source, &target, 1000, 2500, &AtomicBool::new(false))
            .await
            .is_err()
    );
    let mut p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    p.dialogues[1].selected_generation_ids.clear();
    let (preview, items) = plan(&p, &root, &o).unwrap();
    assert_eq!(preview.ready.len(), 1);
    assert_eq!(preview.blocked.len(), 1);
    assert_eq!(items.len(), 1);
    o.reference.reference_range = Some(vc::ReferenceRange {
        start_ms: 500,
        end_ms: 1700,
    });
    assert!(plan(&p, &root, &o).unwrap().0.ready.is_empty());
}
