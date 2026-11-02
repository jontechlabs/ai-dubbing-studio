use super::*;
use crate::tts_batch::tests::{assert_worker_exited, core, finished, fixture, options, worker};
use serde_json::Value;
use std::path::Path;

fn request(root: &Path, p: &crate::domain::Project, total: u32) -> Request {
    Request {
        root: root.into(),
        project_id: p.id.clone(),
        revision: p.revision,
        plan: Plan::Voice {
            line_id: p.dialogues[0].id.clone(),
            options: options(),
        },
        count: total,
        completed: 0,
        pipeline: None,
    }
}
fn calls(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("calls.jsonl"))
        .unwrap()
        .split_inclusive('\n')
        .filter(|line| line.ends_with('\n'))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
#[test]
fn count_bounds_and_distinct_wrapping_seeds() {
    assert_eq!(count(None).unwrap(), 1);
    for n in 1..=4 {
        assert_eq!(count(Some(n)).unwrap(), n);
    }
    for n in [0, 5, u32::MAX] {
        assert_eq!(count(Some(n)).unwrap_err(), "INVALID_TTS_TAKE_COUNT");
    }
    assert_eq!(
        (0..4).map(|i| seed(u32::MAX - 1, i)).collect::<Vec<_>>(),
        [u32::MAX - 1, u32::MAX, 0, 1]
    );
}
#[tokio::test]
async fn four_takes_share_one_worker_keep_settings_and_sources_and_release_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root, &["Bonjour"]);
    let reference = std::fs::read(root.join("characters/ref.wav")).unwrap();
    let req = request(&root, &p, 4);
    let original = p.clone();
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let key =
        resume_with_launch(core.clone(), app.handle().clone(), req, Some(worker(&root))).unwrap();
    let job = finished(&core, &key).await;
    assert_eq!(job.status, "succeeded", "{:?}", job.error);
    let rows = calls(&root);
    assert_eq!(rows.len(), 4);
    assert_eq!(
        rows.iter()
            .map(|v| v["seed"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [7, 8, 9, 10]
    );
    assert!(rows.iter().all(|v| v["workerPid"] == rows[0]["workerPid"]));
    assert_worker_exited(rows[0]["workerPid"].as_u64().unwrap());
    let guard = core.session.lock().unwrap();
    let p = &guard.as_ref().unwrap().project;
    assert_eq!(p.generations.len(), 4);
    let ids: std::collections::HashSet<_> = p
        .generations
        .iter()
        .map(|g| g["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(
        p.dialogues[0].selected_generation_ids["fr"],
        p.generations.last().unwrap()["id"].as_str().unwrap()
    );
    assert_eq!(
        serde_json::to_value(&p.dialogues[0].voice_settings).unwrap(),
        serde_json::to_value(&original.dialogues[0].voice_settings).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&p.source_cues).unwrap(),
        serde_json::to_value(&original.source_cues).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&p.target_cues).unwrap(),
        serde_json::to_value(&original.target_cues).unwrap()
    );
    assert_eq!(
        std::fs::read(root.join("characters/ref.wav")).unwrap(),
        reference
    );
    assert_eq!(job.batch.unwrap().completed, 4);
    assert_eq!(core.gate.available_permits(), 1);
}
#[tokio::test]
async fn failure_preserves_completed_take_and_retry_only_generates_the_remaining_seeds() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root, &["Bonjour"]);
    let req = request(&root, &p, 4);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let launch = worker(&root);
    let text = std::fs::read_to_string(&launch.script)
        .unwrap()
        .replace("if r['text']=='fail'", "if r['seed']==8");
    std::fs::write(&launch.script, text).unwrap();
    let key = resume_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        Some(tts::WorkerLaunch {
            python: launch.python.clone(),
            script: launch.script.clone(),
            model: launch.model.clone(),
        }),
    )
    .unwrap();
    assert_eq!(finished(&core, &key).await.status, "failed");
    let preserved = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .generations
        .clone();
    assert_eq!(preserved.len(), 1);
    let saved = core
        .jobs
        .lock()
        .unwrap()
        .get(&key)
        .unwrap()
        .saved
        .tts_trials
        .clone()
        .unwrap();
    assert_eq!(saved.completed, 1);
    std::fs::write(root.join("retry"), b"retry").unwrap();
    let key = resume_with_launch(core.clone(), app.handle().clone(), saved, Some(launch)).unwrap();
    assert_eq!(finished(&core, &key).await.status, "succeeded");
    let guard = core.session.lock().unwrap();
    let p = &guard.as_ref().unwrap().project;
    assert_eq!(p.generations.len(), 4);
    assert_eq!(p.generations[0], preserved[0]);
    assert_eq!(
        calls(&root)
            .iter()
            .map(|v| v["seed"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [7, 8, 8, 9, 10]
    );
}
#[tokio::test]
async fn cancellation_and_external_edits_never_launch_later_alternatives() {
    for cancel in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let p = fixture(&root, &["Bonjour"]);
        let req = request(&root, &p, 4);
        let core = core(&root, p);
        let app = tauri::test::mock_app();
        let launch = worker(&root);
        let text = std::fs::read_to_string(&launch.script)
            .unwrap()
            .replace("if r['text']=='slow'", "if r['seed']==8");
        let text = if cancel {
            text
        } else {
            text.replace("time.sleep(20)", "time.sleep(0.5)")
        };
        std::fs::write(&launch.script, text).unwrap();
        let key =
            resume_with_launch(core.clone(), app.handle().clone(), req, Some(launch)).unwrap();
        for _ in 0..200 {
            if root.join("calls.jsonl").exists() && calls(&root).len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if cancel {
            core.jobs
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .cancel
                .store(true, Ordering::Relaxed);
        } else {
            let mut guard = core.session.lock().unwrap();
            let s = guard.as_mut().unwrap();
            s.project.revision += 1;
            s.project.dialogues[0].tts_text = Some("Changed while generating".into());
        }
        let job = finished(&core, &key).await;
        assert_eq!(job.status, if cancel { "cancelled" } else { "failed" });
        if !cancel {
            assert_eq!(job.error.as_deref(), Some("STALE_REVISION"));
        }
        assert_eq!(calls(&root).len(), 2);
        let p = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        assert_eq!(p.generations.len(), if cancel { 1 } else { 2 });
        let saved = core
            .jobs
            .lock()
            .unwrap()
            .get(&key)
            .unwrap()
            .saved
            .tts_trials
            .clone()
            .unwrap();
        assert_eq!(saved.completed, 1);
        if !cancel {
            assert_eq!(
                resume_with_launch(core.clone(), app.handle().clone(), saved, None).unwrap_err(),
                "STALE_REVISION"
            );
        }
        assert_eq!(core.gate.available_permits(), 1);
        assert_worker_exited(calls(&root)[1]["workerPid"].as_u64().unwrap());
    }
}
