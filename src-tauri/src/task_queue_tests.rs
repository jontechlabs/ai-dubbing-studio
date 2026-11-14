use super::*;
use std::{path::Path, sync::Mutex};
fn spec(name: &str, separate: bool, dub: bool) -> Spec {
    Spec{name:name.into(),selection:tts_batch::Selection{take_count:Some(2),scope:"all".into(),approved_only:false,unapproved_only:false,line_ids:vec![],force:true,
        options:serde_json::from_value(json!({"variantId":"cosy3-official","device":"cpu","referenceMode":"current","referenceId":null,"mode":"crossLingual","speed":1,"seed":7})).unwrap()},
        separation:separate.then(||Separation{model_id:"mel-band-roformer-kim".into(),source_track_id:"original".into(),device:"cpu".into(),window_seconds:4,vocals:true,music:true,mute_source:false}),dubbing:dub,continue_on_error:true}
}
async fn fixture() -> (tempfile::TempDir, Arc<Core>) {
    let (dir, root, mut p) = crate::mix::tests::fixture().await;
    let mut line = p.dialogues[0].clone();
    line.id = "line2".into();
    line.start_ms = 3000;
    line.end_ms = 4000;
    line.source_cue_ids = vec!["s2".into()];
    line.target_cue_ids = vec!["t2".into()];
    line.selected_generation_ids.clear();
    line.status = "ungenerated".into();
    p.source_cues.push(
        serde_json::from_value(
            json!({"id":"s2","startMs":3000,"endMs":4000,"text":"Good evening"}),
        )
        .unwrap(),
    );
    p.target_cues.push(
        serde_json::from_value(json!({"id":"t2","startMs":3000,"endMs":4000,"text":"Bonsoir"}))
            .unwrap(),
    );
    p.dialogues.push(line);
    let core = crate::mix::tests::core(&root, p);
    core.queue.lock().unwrap().data.paused = true;
    (dir, core)
}
fn wave(path: &Path, ms: u64) {
    let bytes = (ms * 48 * 4) as u32;
    let mut data = vec![];
    data.extend(b"RIFF");
    data.extend((bytes + 36).to_le_bytes());
    data.extend(b"WAVEfmt ");
    data.extend(16u32.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(2u16.to_le_bytes());
    data.extend(48000u32.to_le_bytes());
    data.extend(192000u32.to_le_bytes());
    data.extend(4u16.to_le_bytes());
    data.extend(16u16.to_le_bytes());
    data.extend(b"data");
    data.extend(bytes.to_le_bytes());
    data.extend(5000i16.to_le_bytes().repeat(bytes as usize / 2));
    std::fs::write(path, data).unwrap();
}
struct Protocol<R: tauri::Runtime> {
    native: Native<R>,
    events: Arc<Mutex<Vec<String>>>,
    fail_line: Option<String>,
    real_tts: bool,
}
impl<R: tauri::Runtime> Clone for Protocol<R> {
    fn clone(&self) -> Self {
        Self {
            native: self.native.clone(),
            events: self.events.clone(),
            fail_line: self.fail_line.clone(),
            real_tts: self.real_tts,
        }
    }
}
impl<R: tauri::Runtime> Engine for Protocol<R> {
    async fn separate(&self, e: &Entry, row: &Row) -> Result<String, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("separate:{}:{}", e.spec.name, row.line_id));
        if self.fail_line.as_deref() == Some(&row.line_id) {
            return Err("AUDIO_TOOLBOX_INVALID_AUDIO".into());
        }
        let s = e.spec.separation.as_ref().unwrap();
        let options = audio_toolbox::Options {
            model_id: s.model_id.clone(),
            source_track_id: s.source_track_id.clone(),
            start_ms: row.start_ms,
            end_ms: row.end_ms,
            device: s.device.clone(),
            prompt: String::new(),
            window_seconds: s.window_seconds,
        };
        let p = current(&self.native.core, e)?;
        let snapshot = audio_toolbox::snapshot(&p, &e.root, &options)?;
        let key = jobs::create(
            &self.native.core,
            &self.native.app,
            "audioToolbox",
            e.project_id.clone(),
            None,
        );
        {
            let mut jobs = self.native.core.jobs.lock().unwrap();
            let j = jobs.get_mut(&key).unwrap();
            j.saved.toolbox_request = Some(audio_toolbox::Request {
                root: e.root.clone(),
                project_id: e.project_id.clone(),
                source_path: p.media.unwrap().path,
                options,
                snapshot,
            });
            j.saved.record.status = "succeeded".into();
        }
        let folder = e.root.join(format!("cache/audio-toolbox/{key}"));
        std::fs::create_dir_all(&folder).unwrap();
        wave(&folder.join("vocals.wav"), row.end_ms - row.start_ms);
        wave(&folder.join("instrumental.wav"), row.end_ms - row.start_ms);
        project::atomic_write(&folder.join("result.json"), b"{\"commonGain\":1}").unwrap();
        Ok(key)
    }
    async fn apply(&self, e: &Entry, job: &str) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("apply:{}", e.spec.name));
        self.native.apply(e, job).await
    }
    async fn dub(&self, e: &Entry, run: &DubRun) -> Result<Option<String>, String> {
        self.events
            .lock()
            .unwrap()
            .push(format!("dub:{}:{}", e.spec.name, run.line_ids.join(",")));
        if !self.real_tts {
            let key = jobs::create(
                &self.native.core,
                &self.native.app,
                "ttsBatch",
                e.project_id.clone(),
                None,
            );
            self.native
                .core
                .jobs
                .lock()
                .unwrap()
                .get_mut(&key)
                .unwrap()
                .saved
                .record
                .status = "succeeded".into();
            return Ok(Some(key));
        }
        let p = current(&self.native.core, e)?;
        let selection = dubbing_selection(&p, e, run)?;
        let (preview, items) = tts_batch::plan(&p, &e.root, &selection)?;
        let mut request = tts_batch::Request {
            take_count: selection.take_count,
            created_at: None,
            origin_batch_id: None,
            root: e.root.clone(),
            approved_only: false,
            unapproved_only: false,
            project_id: e.project_id.clone(),
            language: p.languages.target,
            items,
            skipped: preview.existing,
        };
        tts_batch::queue_ids(&mut request, &format!("{}:{}", e.id, run.id));
        tts_batch::resume_with_launch(
            self.native.core.clone(),
            self.native.app.clone(),
            request,
            Some(tts_batch::tests::worker(&e.root)),
        )
        .map(Some)
    }
    async fn wait(&self, e: &Entry, job: &str) -> Result<(), String> {
        self.native.wait(e, job).await
    }
}
fn add_paused<R: tauri::Runtime>(core: &Arc<Core>, app: &tauri::AppHandle<R>, s: Spec) -> String {
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    add(core.clone(), app.clone(), p.id, p.revision, s).unwrap()
}
async fn run<R: tauri::Runtime>(core: Arc<Core>, app: tauri::AppHandle<R>, engine: Protocol<R>) {
    {
        let mut q = core.queue.lock().unwrap();
        q.data.paused = false;
        q.worker = true;
    }
    tokio::time::timeout(Duration::from_secs(60), pump(core, app, engine))
        .await
        .unwrap();
}
#[tokio::test]
async fn fifo_routes_real_audio_then_runs_hot_batch_protocol_and_preserves_sources_and_takes() {
    let (_dir, core) = fixture().await;
    let app = tauri::test::mock_app();
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    let root = core.session.lock().unwrap().as_ref().unwrap().root.clone();
    let source = std::fs::read(root.join(&p.media.as_ref().unwrap().path)).unwrap();
    let original_take = std::fs::read(root.join("generations/voice.wav")).unwrap();
    let first = add_paused(&core, app.handle(), spec("A", true, true));
    let mut second = spec("B", false, true);
    second.selection.take_count = Some(1);
    second.selection.scope = "selected".into();
    second.selection.line_ids = vec!["line".into()];
    add_paused(&core, app.handle(), second);
    let events = Arc::new(Mutex::new(vec![]));
    let engine = Protocol {
        native: Native {
            core: core.clone(),
            app: app.handle().clone(),
        },
        events: events.clone(),
        fail_line: None,
        real_tts: true,
    };
    run(core.clone(), app.handle().clone(), engine.clone()).await;
    let view = status(&core).unwrap();
    assert!(view.entries.iter().all(|e| e.status == "succeeded"));
    assert_eq!(
        *events.lock().unwrap(),
        [
            "separate:A:line",
            "apply:A",
            "separate:A:line2",
            "apply:A",
            "dub:A:line,line2",
            "dub:B:line"
        ]
    );
    let saved = project::load(&root).unwrap();
    assert_eq!(
        saved
            .generations
            .iter()
            .filter(|g| g["kind"] == "tts")
            .count(),
        6
    );
    assert_eq!(
        saved.generations.iter().find(|g| g["id"] == "voice"),
        p.generations.iter().find(|g| g["id"] == "voice")
    );
    assert_eq!(
        std::fs::read(root.join(&p.media.unwrap().path)).unwrap(),
        source
    );
    assert_eq!(
        std::fs::read(root.join("generations/voice.wav")).unwrap(),
        original_take
    );
    let patches: Vec<_> = saved
        .generations
        .iter()
        .filter(|g| g["kind"] == "audioPatch")
        .collect();
    assert_eq!(patches.len(), 4);
    assert!(patches
        .iter()
        .any(|g| g["startMs"] == 3000 && g["endMs"] == 4000));
    let calls = std::fs::read_to_string(root.join("calls.jsonl")).unwrap();
    let calls: Vec<Value> = calls
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(calls.len(), 5);
    assert_eq!(calls[0]["workerPid"], calls[3]["workerPid"]);
    let e = entry(&core, &first).unwrap();
    let a = dubbing_selection(&saved, &e, &e.dubbing_runs[0]).unwrap();
    assert!(saved
        .tracks
        .iter()
        .any(|t| Some(&t.id) == a.options.reference_track_id.as_ref()
            && t.role.as_deref() == Some("speech")));
    assert_eq!(core.gate.available_permits(), 1);
    // Simulate losing the child ID after dispatch but before the queue checkpoint.
    // Stable batch item identities must prevent duplicate takes even with force.
    {
        let mut q = core.queue.lock().unwrap();
        q.active = Some(first.clone());
        q.cancel = Arc::new(AtomicBool::new(false));
    }
    let mut lost = e.dubbing_runs[0].clone();
    lost.job_id = None;
    let job = engine.dub(&e, &lost).await.unwrap().unwrap();
    engine.wait(&e, &job).await.unwrap();
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .generations
            .iter()
            .filter(|g| g["kind"] == "tts")
            .count(),
        6
    );
    assert_eq!(
        std::fs::read_to_string(root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .count(),
        5
    );
    core.queue.lock().unwrap().active = None;
}
#[tokio::test]
async fn failed_separation_never_enters_dubbing_and_stop_policy_pauses_following_tasks() {
    for proceed in [true, false] {
        let (_dir, core) = fixture().await;
        let app = tauri::test::mock_app();
        let mut s = spec("A", true, true);
        s.continue_on_error = proceed;
        add_paused(&core, app.handle(), s);
        add_paused(&core, app.handle(), spec("B", false, true));
        let events = Arc::new(Mutex::new(vec![]));
        let engine = Protocol {
            native: Native {
                core: core.clone(),
                app: app.handle().clone(),
            },
            events: events.clone(),
            fail_line: Some("line2".into()),
            real_tts: false,
        };
        run(core.clone(), app.handle().clone(), engine).await;
        let view = status(&core).unwrap();
        if proceed {
            assert_eq!(view.entries[0].status, "partial");
            assert!(events.lock().unwrap().contains(&"dub:A:line".into()));
            assert_eq!(view.entries[1].status, "succeeded");
        } else {
            assert_eq!(view.entries[0].status, "failed");
            assert!(view.paused);
            assert_eq!(view.entries[1].status, "pending");
            assert!(!events.lock().unwrap().iter().any(|e| e.starts_with("dub:")));
        }
    }
}
#[tokio::test]
async fn persistent_reordering_removal_restart_and_compact_pagination_are_explicit() {
    let (_dir, core) = fixture().await;
    let app = tauri::test::mock_app();
    let a = add_paused(&core, app.handle(), spec("A", true, false));
    let b = add_paused(&core, app.handle(), spec("B", false, true));
    control(core.clone(), app.handle().clone(), "up", Some(&b)).unwrap();
    assert_eq!(status(&core).unwrap().entries[0].id, b);
    control(core.clone(), app.handle().clone(), "down", Some(&b)).unwrap();
    assert_eq!(status(&core).unwrap().entries[0].id, a);
    control(core.clone(), app.handle().clone(), "cancel", Some(&b)).unwrap();
    assert_eq!(status(&core).unwrap().entries[1].status, "cancelled");
    update(&core, app.handle(), &a, |e| {
        e.status = "running".into();
        e.rows[0].status = "succeeded".into();
        e.rows[0].job_id = Some("completed-cache".into());
    })
    .unwrap();
    let restored = restore(&core.data_dir);
    assert!(restored.data.paused);
    assert!(!restored.worker);
    assert_eq!(restored.data.entries[0].status, "interrupted");
    assert_eq!(
        restored.data.entries[0].rows[0].job_id.as_deref(),
        Some("completed-cache")
    );
    let compact = serde_json::to_value(status(&core).unwrap()).unwrap();
    assert!(compact["entries"][0].get("basis").is_none());
    assert!(compact["entries"][0].get("rows").is_none());
    let page = details(&core, &a, 1, 1).unwrap();
    assert_eq!(page["total"], 2);
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["spec"]["selection"]["lineIds"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(details(&core, &a, 0, 201).is_err());
    control(core.clone(), app.handle().clone(), "remove", Some(&b)).unwrap();
    assert_eq!(status(&core).unwrap().entries.len(), 1);
}
#[tokio::test]
async fn stale_text_prevents_dispatch_but_manual_tags_do_not_change_the_captured_audio_context() {
    let (_dir, core) = fixture().await;
    let app = tauri::test::mock_app();
    let key = add_paused(&core, app.handle(), spec("A", false, true));
    let e = entry(&core, &key).unwrap();
    {
        let mut guard = core.session.lock().unwrap();
        let p = &mut guard.as_mut().unwrap().project;
        p.format_version = 29;
        p.dialogues[0].review_tags = vec!["retranslate".into()];
    }
    checked(&core, &e).unwrap();
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .target_cues[0]
        .text = "Changed".into();
    assert_eq!(checked(&core, &e).unwrap_err(), "STALE_REVISION");
    let events = Arc::new(Mutex::new(vec![]));
    let engine = Protocol {
        native: Native {
            core: core.clone(),
            app: app.handle().clone(),
        },
        events: events.clone(),
        fail_line: None,
        real_tts: false,
    };
    run(core.clone(), app.handle().clone(), engine).await;
    assert_eq!(status(&core).unwrap().entries[0].status, "failed");
    assert!(events.lock().unwrap().is_empty());
}
#[tokio::test]
async fn cancelling_a_real_batch_protocol_releases_the_gate_and_keeps_the_next_entry_waiting() {
    let (_dir, core) = fixture().await;
    let app = tauri::test::mock_app();
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .target_cues[0]
        .text = "slow".into();
    let first = add_paused(&core, app.handle(), spec("slow", false, true));
    add_paused(&core, app.handle(), spec("next", false, true));
    let root = core.session.lock().unwrap().as_ref().unwrap().root.clone();
    let engine = Protocol {
        native: Native {
            core: core.clone(),
            app: app.handle().clone(),
        },
        events: Arc::new(Mutex::new(vec![])),
        fail_line: None,
        real_tts: true,
    };
    {
        let mut q = core.queue.lock().unwrap();
        q.data.paused = false;
        q.worker = true;
    }
    let child = tokio::spawn(pump(core.clone(), app.handle().clone(), engine));
    tokio::time::timeout(Duration::from_secs(40), async {
        while !root.join("calls.jsonl").is_file() {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    control(core.clone(), app.handle().clone(), "pause", None).unwrap();
    control(core.clone(), app.handle().clone(), "cancel", Some(&first)).unwrap();
    tokio::time::timeout(Duration::from_secs(20), child)
        .await
        .unwrap()
        .unwrap();
    let q = status(&core).unwrap();
    assert_eq!(q.entries[0].status, "cancelled");
    assert_eq!(q.entries[1].status, "pending");
    assert_eq!(core.gate.available_permits(), 1);
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .generations
            .iter()
            .filter(|g| g["kind"] == "tts")
            .count(),
        1
    );
}
