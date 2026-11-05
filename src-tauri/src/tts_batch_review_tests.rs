use super::*;
use crate::tts_batch::tests as fixture;

fn request(p: &Project, root: &Path) -> Request {
    let (_, items) = plan(
        p,
        root,
        &Selection {
            take_count: None,
            scope: "all".into(),
            line_ids: vec![],
            force: false,
            approved_only: false,
            unapproved_only: false,
            options: fixture::options(),
        },
    )
    .unwrap();
    Request {
        take_count: None,
        created_at: None,
        origin_batch_id: None,
        root: root.into(),
        project_id: p.id.clone(),
        language: p.languages.target.clone(),
        items,
        skipped: 0,
        approved_only: false,
        unapproved_only: false,
    }
}
#[tokio::test]
async fn selected_and_multiple_retries_update_the_original_report_and_never_repeat_successes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["good", "fail", "fail"]);
    let ids: Vec<_> = p.dialogues.iter().map(|l| l.id.clone()).collect();
    let req = request(&p, &root);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "failed");
    let original = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .generations[0]
        .clone();
    let audio = std::fs::read(root.join(original["path"].as_str().unwrap())).unwrap();
    let first = report(&core, &key, 0, 200, false).unwrap();
    assert_eq!((first.progress.succeeded, first.progress.failed), (1, 2));
    assert!(first.items[0]
        .created_at
        .as_ref()
        .is_some_and(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok()));
    let jobs = core.jobs.lock().unwrap().len();
    for bad in [vec![ids[0].clone()], vec![ids[1].clone(), "unknown".into()]] {
        assert_eq!(
            retry_with_launch(
                core.clone(),
                app.handle().clone(),
                &key,
                RetrySelection {
                    item_indices: vec![],
                    scope: "selected".into(),
                    line_ids: bad
                },
                Some(fixture::worker(&root))
            )
            .unwrap_err(),
            "INVALID_TTS_BATCH"
        );
        assert_eq!(core.jobs.lock().unwrap().len(), jobs);
    }
    std::fs::write(root.join("retry"), b"now succeeds").unwrap();
    {
        let mut guard = core.session.lock().unwrap();
        let s = guard.as_mut().unwrap();
        s.project.target_cues[1].text = "Corrected current text".into();
    }
    let retry = retry_with_launch(
        core.clone(),
        app.handle().clone(),
        &key,
        RetrySelection {
            item_indices: vec![],
            scope: "selected".into(),
            line_ids: vec![ids[1].clone(), ids[1].clone()],
        },
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &retry).await.status, "succeeded");
    let partial = report(&core, &retry, 0, 200, false).unwrap();
    assert_eq!(partial.report_id, key);
    assert_eq!(
        (partial.progress.succeeded, partial.progress.failed),
        (2, 1)
    );
    let retry2 = retry_with_launch(
        core.clone(),
        app.handle().clone(),
        &key,
        RetrySelection {
            item_indices: vec![],
            scope: "failed".into(),
            line_ids: vec![],
        },
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &retry2).await.status, "succeeded");
    assert_eq!(report(&core, &key, 0, 200, true).unwrap().matching, 0);
    let saved = project::load(&root).unwrap();
    assert_eq!(saved.generations.len(), 3);
    assert_eq!(saved.generations[0], original);
    assert_eq!(
        std::fs::read(root.join(original["path"].as_str().unwrap())).unwrap(),
        audio
    );
    let calls: Vec<serde_json::Value> = std::fs::read_to_string(root.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(calls.len(), 5);
    assert_eq!(calls.iter().filter(|c| c["text"] == "good").count(), 1);
    assert_eq!(calls[3]["text"], "Corrected current text");
    for call in calls {
        assert_eq!(call["speed"], 1.2);
        assert_eq!(call["seed"], 7);
        assert_eq!(call["mood"], "stressed");
    }
    let reopened = fixture::core(&root, saved);
    assert_eq!(
        report(&reopened, &retry2, 0, 25, false)
            .unwrap()
            .progress
            .succeeded,
        3
    );
}
#[tokio::test]
async fn fatal_errors_leave_unprocessed_lines_retryable_and_success_is_not_repeated() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["good", "TTS_DRAMA_RAM_REQUIRED", "last"]);
    let req = request(&p, &root);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "failed");
    let r = report(&core, &key, 0, 25, true).unwrap();
    assert_eq!(
        (r.progress.succeeded, r.progress.failed, r.matching),
        (1, 1, 2)
    );
    assert_eq!(r.items[1].status, "pending");
    std::fs::write(root.join("retry"), b"fixed").unwrap();
    let key2 = retry_with_launch(
        core.clone(),
        app.handle().clone(),
        &key,
        RetrySelection {
            item_indices: vec![],
            scope: "unfinished".into(),
            line_ids: vec![],
        },
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key2).await.status, "succeeded");
    assert_eq!(
        report(&core, &key, 0, 25, false)
            .unwrap()
            .progress
            .succeeded,
        3
    );
    assert_eq!(
        std::fs::read_to_string(root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .count(),
        4
    );
}
#[tokio::test]
async fn preflight_errors_are_reported_per_line_without_loading_a_worker() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["fail"]);
    let req = request(&p, &root);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(fixture::worker(&root)),
    )
    .unwrap();
    fixture::finished(&core, &key).await;
    let before = std::fs::read(root.join("calls.jsonl")).unwrap();
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .voice_references
        .clear();
    let next = retry_with_launch(
        core.clone(),
        app.handle().clone(),
        &key,
        RetrySelection {
            item_indices: vec![],
            scope: "failed".into(),
            line_ids: vec![],
        },
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &next).await.status, "failed");
    let r = report(&core, &key, 0, 25, true).unwrap();
    assert_eq!(r.progress.failed, 1);
    assert!(r.items[0].error.is_some());
    assert_ne!(r.items[0].error.as_deref(), Some("TTS_EMPTY_AUDIO"));
    assert_eq!(std::fs::read(root.join("calls.jsonl")).unwrap(), before);
}
#[tokio::test]
async fn reports_are_paginated_project_bound_and_read_only() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["fail", "fail"]);
    let req = request(&p, &root);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        req,
        None,
        Some(fixture::worker(&root)),
    )
    .unwrap();
    fixture::finished(&core, &key).await;
    let bytes = std::fs::read(folder(&core, &key).unwrap().join("results.jsonl")).unwrap();
    let r = report(&core, &key, 1, 1, true).unwrap();
    assert_eq!(r.items.len(), 1);
    assert_eq!(r.matching, 2);
    assert_eq!(r.offset, 1);
    assert!(report(&core, &key, 0, 201, true).is_err());
    assert!(report(&core, "../unsafe", 0, 25, true).is_err());
    assert_eq!(
        std::fs::read(folder(&core, &key).unwrap().join("results.jsonl")).unwrap(),
        bytes
    );
    core.session.lock().unwrap().as_mut().unwrap().project.id = "another project".into();
    assert_eq!(
        report(&core, &key, 0, 25, true).err().as_deref(),
        Some("STALE_REVISION")
    );
}
