use super::*;
use crate::domain::{Cue, VoiceReference};
use std::{collections::HashMap, sync::Mutex, time::Duration};

fn options() -> tts::Options {
    serde_json::from_value(serde_json::json!({"variantId":"cosy3-official","device":"cpu","referenceMode":"file","referenceId":"ref","mode":"crossLingual","speed":1.2,"seed":7,"mood":"stressed","accent":"fr-FR"})).unwrap()
}
fn fixture(root: &Path, texts: &[&str]) -> Project {
    std::fs::create_dir_all(root.join("characters")).unwrap();
    let mut p = Project::new("Batch".into(), "ja".into(), "fr".into());
    p.format_version = 9;
    p.target_cues = texts
        .iter()
        .enumerate()
        .map(|(i, t)| Cue {
            id: format!("t{i}"),
            start_ms: i as u64 * 3000,
            end_ms: i as u64 * 3000 + 2000,
            text: (*t).into(),
        })
        .collect();
    p.dialogues = crate::subtitles::align(&[], &p.target_cues);
    p.voice_references.push(VoiceReference {
        id: "ref".into(),
        label: "Reference".into(),
        path: "characters/ref.wav".into(),
        duration_ms: 2000,
        transcript: "Bonjour".into(),
        source_dialogue_id: None,
    });
    std::fs::write(
        root.join("characters/ref.wav"),
        b"reference is replaced by the protocol fixture",
    )
    .unwrap();
    p
}
fn core(root: &Path, p: Project) -> Arc<Core> {
    Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.into(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.into(),
        model_dir: Mutex::new(root.into()),
    })
}
fn selection() -> Selection {
    Selection {
        scope: "all".into(),
        approved_only: false,
        unapproved_only: false,
        line_ids: vec![],
        force: false,
        options: options(),
    }
}
fn worker(root: &Path) -> tts::WorkerLaunch {
    let script = root.join("batch-worker.py");
    std::fs::write(&script,r#"import json,sys,wave,struct,time,os
from pathlib import Path
def generate(r):
    folder=Path(r['outputPath']).parent.parent
    r['workerPid']=os.getpid()
    with open(folder/'calls.jsonl','a',encoding='utf-8') as f: f.write(json.dumps(r)+'\n')
    if r['text']=='slow' and not (folder/'retry').exists():
        open(r['outputPath'],'wb').write(b'partial');print(json.dumps({'stage':'ttsGenerate','progress':0.2}),flush=True);time.sleep(20)
    if r['text']=='fail' and not (folder/'retry').exists():
        sys.stderr.buffer.write(b'batch error details: \xff\n');sys.stderr.flush()
        raise ValueError('TTS_EMPTY_AUDIO')
    if r['text'].startswith('TTS_DRAMA_') and not (folder/'retry').exists():
        raise ValueError(r['text'])
    with wave.open(r['outputPath'],'wb') as out:
        out.setparams((1,2,24000,0,'NONE','not compressed'));out.writeframes(struct.pack('<h',1000)*28800)
    json.dump({'device':r['device'],'deviceName':'Protocol test','peakVramMb':0},open(r['resultPath'],'w'))
if '--batch' in sys.argv:
    for line in sys.stdin:
        command=json.loads(line)
        try:
            generate(json.load(open(command['path'],encoding='utf-8-sig')))
            print(json.dumps({'requestDone':command['requestId']}),flush=True)
        except Exception as error:
            print(json.dumps({'requestDone':command['requestId'],'error':str(error)}),flush=True)
            break
else:
    generate(json.load(open(sys.argv[-1],encoding='utf-8-sig')))
"#).unwrap();
    tts::WorkerLaunch {
        python: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
        script,
        model: root.join("model"),
    }
}
async fn finished(core: &Core, key: &str) -> jobs::Job {
    for _ in 0..300 {
        let job = core
            .jobs
            .lock()
            .unwrap()
            .get(key)
            .unwrap()
            .saved
            .record
            .clone();
        if !["running", "queued"].contains(&job.status.as_str()) {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("batch did not finish")
}
fn request(p: &Project, root: &Path) -> Request {
    let (preview, items) = plan(p, root, &selection()).unwrap();
    Request {
        root: root.into(),
        approved_only: false,
        unapproved_only: false,
        project_id: p.id.clone(),
        language: "fr".into(),
        items,
        skipped: preview.untranslated + preview.existing + preview.blocked.len(),
    }
}

fn assert_worker_exited(pid: u64) {
    let script = r#"import os,sys,ctypes
pid=int(sys.argv[1])
if os.name=='nt':
    handle=ctypes.windll.kernel32.OpenProcess(0x1000,False,pid)
    if handle:
        code=ctypes.c_ulong();ctypes.windll.kernel32.GetExitCodeProcess(handle,ctypes.byref(code));ctypes.windll.kernel32.CloseHandle(handle)
        sys.exit(1 if code.value==259 else 0)
else:
    try:os.kill(pid,0)
    except ProcessLookupError:sys.exit(0)
    sys.exit(1)
"#;
    assert!(
        std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
            .args(["-c", script, &pid.to_string()])
            .status()
            .unwrap()
            .success(),
        "worker still alive after terminal job state"
    );
}

fn approve(p: &mut Project, index: usize) {
    let line = &p.dialogues[index];
    p.format_version = 10;
    p.translation_approvals.insert(
        line.id.clone(),
        crate::domain::TranslationApproval {
            source_language: p.languages.source.clone(),
            target_language: p.languages.target.clone(),
            source_text: String::new(),
            target_text: p.target_cues[index].text.clone(),
        },
    );
}
#[test]
fn approved_only_intersects_all_or_selection_and_force_does_not_bypass_approval() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let mut p = fixture(root, &["Un", "Deux", "Trois", ""]);
    approve(&mut p, 0);
    approve(&mut p, 2);
    let mut s = selection();
    s.approved_only = true;
    s.force = true;
    let (preview, items) = plan(&p, root, &s).unwrap();
    assert_eq!(preview.ready.len(), 2);
    assert_eq!(preview.unapproved, 1);
    assert_eq!(preview.untranslated, 1);
    assert_eq!(items.len(), 2);
    s.scope = "selected".into();
    s.line_ids = vec![p.dialogues[0].id.clone(), p.dialogues[1].id.clone()];
    let (preview, _) = plan(&p, root, &s).unwrap();
    assert_eq!(preview.ready, vec![p.dialogues[0].id.clone()]);
    assert_eq!(preview.unapproved, 1);
    p.target_cues[0].text = "Correction".into();
    let (preview, _) = plan(&p, root, &s).unwrap();
    assert!(preview.ready.is_empty());
    assert_eq!(preview.unapproved, 2);
    s.approved_only = false;
    assert_eq!(plan(&p, root, &s).unwrap().0.ready.len(), 2);
}
#[tokio::test]
async fn withdrawn_approval_stops_a_resumed_batch_before_loading_the_model() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let mut p = fixture(&root, &["Un", "Deux"]);
    approve(&mut p, 0);
    approve(&mut p, 1);
    let mut req = request(&p, &root);
    req.approved_only = true;
    p.translation_approvals.remove(&p.dialogues[0].id);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let launch = worker(&root);
    let key =
        start_with_launch(core.clone(), app.handle().clone(), req, None, Some(launch)).unwrap();
    let job = finished(&core, &key).await;
    assert_eq!(
        job.error.as_deref(),
        Some("TTS_BATCH_TRANSLATION_UNAPPROVED")
    );
    assert!(!root.join("calls.jsonl").exists());
    assert_eq!(core.gate.available_permits(), 1);
}
#[test]
fn unapproved_only_includes_stale_approvals_but_excludes_validated_and_untranslated_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let mut p = fixture(root, &["Un", "Deux", "Trois", "<i> </i>"]);
    approve(&mut p, 0);
    approve(&mut p, 2);
    p.target_cues[2].text = "Correction après validation".into();
    p.dialogues[3].tts_text = Some("Une prononciation seule ne suffit pas".into());
    let mut s = selection();
    s.unapproved_only = true;
    s.force = true;
    let (preview, _) = plan(&p, root, &s).unwrap();
    assert_eq!(
        preview.ready,
        vec![p.dialogues[1].id.clone(), p.dialogues[2].id.clone()]
    );
    assert_eq!(
        (preview.approved, preview.unapproved, preview.untranslated),
        (1, 0, 1)
    );
    assert_eq!(
        preview.requested,
        preview.ready.len() + preview.approved + preview.untranslated
    );
    s.scope = "selected".into();
    s.line_ids = vec![
        p.dialogues[0].id.clone(),
        p.dialogues[1].id.clone(),
        p.dialogues[1].id.clone(),
    ];
    assert_eq!(
        plan(&p, root, &s).unwrap().0.ready,
        vec![p.dialogues[1].id.clone()]
    );
    s.approved_only = true;
    assert_eq!(
        plan(&p, root, &s).err().as_deref(),
        Some("INVALID_TTS_BATCH")
    );
    // Existing callers and saved batches omit the new flag and retain their original policy.
    let mut legacy = serde_json::to_value(selection()).unwrap();
    legacy.as_object_mut().unwrap().remove("unapprovedOnly");
    let legacy: Selection = serde_json::from_value(legacy).unwrap();
    assert!(!legacy.unapproved_only);
    assert_eq!(plan(&p, root, &legacy).unwrap().0.ready.len(), 3);
    let mut saved = serde_json::to_value(request(&p, root)).unwrap();
    saved.as_object_mut().unwrap().remove("unapproved_only");
    assert!(
        !serde_json::from_value::<Request>(saved)
            .unwrap()
            .unapproved_only
    );
}
#[tokio::test]
async fn approval_added_after_enqueue_stops_a_resumed_unapproved_batch_before_loading_the_model() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let mut p = fixture(&root, &["Un", "Deux"]);
    let mut req = request(&p, &root);
    req.unapproved_only = true;
    approve(&mut p, 0);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let mut conflicting = req.clone();
    conflicting.approved_only = true;
    assert_eq!(
        resume_with_launch(core.clone(), app.handle().clone(), conflicting, None)
            .err()
            .as_deref(),
        Some("INVALID_TTS_BATCH")
    );
    assert!(core.jobs.lock().unwrap().is_empty());
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    let job = finished(&core, &key).await;
    assert_eq!(job.error.as_deref(), Some("TTS_BATCH_TRANSLATION_APPROVED"));
    assert!(!root.join("calls.jsonl").exists());
    assert_eq!(core.gate.available_permits(), 1);
    assert!(load(&core, &key).unwrap().unapproved_only);
}
#[tokio::test]
async fn successful_lot_reuses_one_process_and_releases_it_before_terminal_status() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root, &["Bonjour", "Bonsoir", "Salut"]);
    let req = request(&p, &root);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    assert_eq!(finished(&core, &key).await.status, "succeeded");
    let calls = std::fs::read_to_string(root.join("calls.jsonl")).unwrap();
    let pids: Vec<_> = calls
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["workerPid"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert_eq!(pids.len(), 3);
    assert!(pids.iter().all(|p| *p == pids[0]));
    assert_worker_exited(pids[0]);
}
#[tokio::test]
async fn unapproved_batch_only_executes_eligible_lines_and_persists_the_filter() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let mut p = fixture(&root, &["Validée", "À valider", ""]);
    approve(&mut p, 0);
    let approvals = p.translation_approvals.clone();
    let mut selection = selection();
    selection.unapproved_only = true;
    let (preview, items) = plan(&p, &root, &selection).unwrap();
    let req = Request {
        unapproved_only: true,
        items,
        skipped: preview.approved + preview.untranslated,
        ..request(&p, &root)
    };
    let expected = p.dialogues[1].id.clone();
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        Some(preview),
        Some(worker(&root)),
    )
    .unwrap();
    let job = finished(&core, &key).await;
    assert_eq!(job.status, "succeeded");
    let progress = job.batch.unwrap();
    assert_eq!(
        (progress.total, progress.succeeded, progress.skipped),
        (1, 1, 2)
    );
    let calls = std::fs::read_to_string(root.join("calls.jsonl")).unwrap();
    assert_eq!(calls.lines().count(), 1);
    let call: serde_json::Value = serde_json::from_str(calls.trim()).unwrap();
    assert_eq!(call["text"], "À valider");
    assert_worker_exited(call["workerPid"].as_u64().unwrap());
    let saved = project::load(&root).unwrap();
    assert_eq!(saved.generations.len(), 1);
    assert_eq!(saved.generations[0]["dialogueId"], expected);
    assert_eq!(
        serde_json::to_value(saved.translation_approvals).unwrap(),
        serde_json::to_value(approvals).unwrap()
    );
    assert!(load(&core, &key).unwrap().unapproved_only);
}

#[test]
fn selection_excludes_untranslated_even_with_tts_text_and_force_preserves_existing_file() {
    let tmp = tempfile::tempdir().unwrap();
    let root_path = tmp.path().canonicalize().unwrap();
    let root = root_path.as_path();
    let mut p = fixture(root, &["Bonjour", "<i> </i>", "Salut"]);
    p.dialogues[1].tts_text = Some("Manual pronunciation alone is not a translation".into());
    let line = &p.dialogues[0];
    let generation = serde_json::json!({"kind":"tts","id":"old","dialogueId":line.id,"language":"fr","text":tts::text(&p,line),"startMs":line.start_ms,"endMs":line.end_ms,"characterId":null,"sourcePath":null,"options":options(),"referenceId":"ref","referenceTranscript":"Bonjour","path":"generations/old.wav"});
    std::fs::create_dir(root.join("generations")).unwrap();
    std::fs::write(root.join("generations/old.wav"), b"old take").unwrap();
    p.generations.push(generation);
    p.dialogues[0]
        .selected_generation_ids
        .insert("fr".into(), "old".into());
    let mut s = selection();
    s.scope = "selected".into();
    s.unapproved_only = true;
    s.line_ids = vec![
        p.dialogues[0].id.clone(),
        p.dialogues[1].id.clone(),
        p.dialogues[0].id.clone(),
    ];
    let (preview, items) = plan(&p, root, &s).unwrap();
    assert_eq!(preview.requested, 2);
    assert_eq!(preview.untranslated, 1);
    assert_eq!(preview.existing, 1);
    assert!(items.is_empty());
    s.force = true;
    assert_eq!(plan(&p, root, &s).unwrap().1.len(), 1);
    assert_eq!(
        std::fs::read(root.join("generations/old.wav")).unwrap(),
        b"old take"
    );
    p.target_cues[0].text = "Changed".into();
    s.force = false;
    assert_eq!(plan(&p, root, &s).unwrap().1.len(), 1);
    s.line_ids.push("unknown".into());
    assert!(plan(&p, root, &s).is_err());
}
#[test]
fn common_reference_is_snapshotted_even_before_line_settings_are_assigned_and_invalid_inputs_are_reported(
) {
    let tmp = tempfile::tempdir().unwrap();
    let mut p = fixture(tmp.path(), &["Bonjour", "Salut"]);
    let (preview, items) = plan(&p, tmp.path(), &selection()).unwrap();
    assert_eq!(preview.ready.len(), 2);
    assert!(tts::matches_request(&p, &items[0].request));
    p.voice_references[0].transcript = "Correction".into();
    assert!(!tts::matches_request(&p, &items[0].request));
    let mut s = selection();
    s.options.reference_id = Some("missing".into());
    let (preview, items) = plan(&p, tmp.path(), &s).unwrap();
    assert!(items.is_empty());
    assert_eq!(preview.blocked.len(), 2);
}
#[tokio::test]
async fn sequential_batch_keeps_successes_and_retries_only_failures_with_original_configuration() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root, &["Bonjour", "fail", "Salut"]);
    let req = request(&p, &root);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    let job = finished(&core, &key).await;
    assert_eq!(job.status, "failed");
    assert!(job
        .logs
        .iter()
        .any(|line| line.contains("batch error details:")));
    let progress = job.batch.unwrap();
    assert_eq!((progress.succeeded, progress.failed), (2, 1));
    let first_count = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .generations
        .len();
    assert_eq!(first_count, 2);
    let req = load(&core, &key).unwrap();
    assert_eq!(req.items.iter().filter(|i| i.status == "failed").count(), 1);
    std::fs::write(root.join("retry"), b"retry").unwrap();
    let retry =
        resume_with_launch(core.clone(), app.handle().clone(), req, Some(worker(&root))).unwrap();
    assert_eq!(finished(&core, &retry).await.status, "succeeded");
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 3);
    assert_eq!(p.format_version, 15);
    assert!(p
        .dialogues
        .iter()
        .all(|l| l.voice_settings.as_ref().unwrap().accent.as_deref() == Some("fr-FR")));
    let calls = std::fs::read_to_string(root.join("calls.jsonl")).unwrap();
    assert_eq!(calls.lines().count(), 4);
    for call in calls.lines() {
        let v: serde_json::Value = serde_json::from_str(call).unwrap();
        assert_eq!(v["seed"], 7);
        assert_eq!(v["speed"], 1.2);
        assert_eq!(v["device"], "cpu");
        assert_eq!(v["mood"], "stressed");
        assert_eq!(v["accent"], "fr-FR");
    }
    let files = std::fs::read_dir(root.join("generations")).unwrap().count();
    assert_eq!(files, 3);
    let mut session = core.session.lock().unwrap();
    let s = session.as_mut().unwrap();
    assert_eq!(s.history(false).unwrap().generations.len(), 2);
    assert!(s.history(false).unwrap().generations.is_empty());
    assert_eq!(s.history(true).unwrap().generations.len(), 2);
    assert_eq!(s.history(true).unwrap().generations.len(), 3);
}
#[tokio::test]
async fn drama_resource_guards_stop_remaining_lines_and_can_resume_after_correction() {
    for error in [
        "TTS_DRAMA_RAM_REQUIRED",
        "TTS_DRAMA_VRAM_REQUIRED",
        "TTS_DRAMA_DISK_REQUIRED",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let p = fixture(&root, &["Bonjour", error, "Salut"]);
        let req = request(&p, &root);
        let core = core(&root, p);
        let app = tauri::test::mock_app();
        let key = start_with_launch(
            core.clone(),
            app.handle().clone(),
            req,
            None,
            Some(worker(&root)),
        )
        .unwrap();
        let job = finished(&core, &key).await;
        assert_eq!(job.status, "failed");
        let progress = job.batch.unwrap();
        assert_eq!(
            (
                progress.succeeded,
                progress.failed,
                progress.completed,
                progress.total
            ),
            (1, 1, 2, 3)
        );
        assert_eq!(
            std::fs::read_to_string(root.join("calls.jsonl"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        let req = load(&core, &key).unwrap();
        assert_eq!(req.items[1].error.as_deref(), Some(error));
        assert_eq!(req.items[2].status, "pending");
        std::fs::write(root.join("retry"), b"resources available").unwrap();
        let retry =
            resume_with_launch(core.clone(), app.handle().clone(), req, Some(worker(&root)))
                .unwrap();
        assert_eq!(finished(&core, &retry).await.status, "succeeded");
        assert_eq!(project::load(&root).unwrap().generations.len(), 3);
    }
}
#[tokio::test]
async fn cancel_and_interrupted_journal_resume_without_duplicate_committed_takes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root, &["Bonjour", "slow", "Salut"]);
    let req = request(&p, &root);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    for _ in 0..300 {
        let current = core
            .jobs
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .saved
            .record
            .clone();
        if current.batch.as_ref().is_some_and(|b| b.succeeded == 1)
            && current.stage == "ttsGenerate"
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    core.jobs
        .lock()
        .unwrap()
        .get(&key)
        .unwrap()
        .cancel
        .store(true, Ordering::Relaxed);
    assert_eq!(finished(&core, &key).await.status, "cancelled");
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .generations
            .len(),
        1
    );
    let calls = std::fs::read_to_string(root.join("calls.jsonl")).unwrap();
    let pids: Vec<_> = calls
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["workerPid"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert_eq!(pids.len(), 2);
    assert_eq!(pids[0], pids[1]);
    assert_worker_exited(pids[0]);
    // Simulate the narrow crash window after a WAV/project commit but before its journal outcome.
    std::fs::write(
        folder(&core, &key).unwrap().join("results.jsonl"),
        b"{\"index\":",
    )
    .unwrap();
    let req = load(&core, &key).unwrap();
    assert!(req.items.iter().all(|i| i.status == "pending"));
    std::fs::write(root.join("retry"), b"retry").unwrap();
    let retry =
        resume_with_launch(core.clone(), app.handle().clone(), req, Some(worker(&root))).unwrap();
    assert_eq!(finished(&core, &retry).await.status, "succeeded");
    assert_eq!(project::load(&root).unwrap().generations.len(), 3);
    assert_eq!(
        std::fs::read_dir(root.join("generations")).unwrap().count(),
        3
    );
}
