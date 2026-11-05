use super::*;
use crate::tts_batch::tests as fixture;

fn request(p: &Project, root: &Path) -> Request {
    let (_, items) = plan(
        p,
        root,
        &Selection {
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
fn saved(core: &Core, r: &Request) -> String {
    let key = crate::domain::id();
    let folder = folder(core, &key).unwrap();
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("request.json"), serde_json::to_vec(r).unwrap()).unwrap();
    key
}
#[tokio::test]
async fn history_survives_empty_job_cache_and_retries_update_one_original_entry() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["good", "fail", "last"]);
    let r = request(&p, &root);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        r,
        None,
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "failed");
    let p = project::load(&root).unwrap();
    let old = p.generations.clone();
    let old_audio: Vec<_> = old
        .iter()
        .map(|g| std::fs::read(root.join(g["path"].as_str().unwrap())).unwrap())
        .collect();
    let reopened = fixture::core(&root, p);
    assert!(reopened.jobs.lock().unwrap().is_empty());
    let before = list(&reopened, 0, 20, false).unwrap();
    assert_eq!(before.matching, 1);
    let first = &before.items[0];
    assert_eq!(first.report_id, key);
    assert_eq!(first.status, "failed");
    assert_eq!((first.progress.succeeded, first.progress.failed), (2, 1));
    assert!(first.created_at.as_ref().is_some_and(|v| date(v).is_some()));
    std::fs::write(root.join("retry"), b"fixed").unwrap();
    let retried = retry_with_launch(
        reopened.clone(),
        app.handle().clone(),
        &key,
        RetrySelection {
            scope: "failed".into(),
            line_ids: vec![],
        },
        Some(fixture::worker(&root)),
    )
    .unwrap();
    assert_eq!(
        fixture::finished(&reopened, &retried).await.status,
        "succeeded"
    );
    let after = list(&reopened, 0, 20, false).unwrap();
    assert_eq!(after.matching, 1);
    assert_eq!(after.items[0].report_id, key);
    assert_eq!(after.items[0].created_at, first.created_at);
    assert_eq!(after.items[0].retry_count, 1);
    assert_eq!(after.items[0].status, "succeeded");
    assert_eq!(list(&reopened, 0, 20, true).unwrap().matching, 0);
    let p = project::load(&root).unwrap();
    for (g, bytes) in old.iter().zip(old_audio) {
        assert!(p.generations.contains(g));
        assert_eq!(
            std::fs::read(root.join(g["path"].as_str().unwrap())).unwrap(),
            bytes
        );
    }
    let reopened_again = fixture::core(&root, p);
    assert_eq!(
        list(&reopened_again, 0, 20, false).unwrap().items[0].retry_count,
        1
    );
    assert_eq!(
        std::fs::read_to_string(root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .count(),
        4
    );
}
#[test]
fn legacy_dates_pagination_project_language_isolation_and_corruption_are_read_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["one"]);
    let mut r = request(&p, &root);
    let core = fixture::core(&root, p);
    let legacy = saved(&core, &r);
    let file = folder(&core, &legacy).unwrap().join("request.json");
    let bytes = std::fs::read(&file).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("created_at"));
    let first = list(&core, 0, 20, false).unwrap();
    assert!(first.items[0].created_at.is_some());
    r.created_at = Some("2020-01-01T00:00:00Z".into());
    saved(&core, &r);
    r.created_at = Some("2019-01-01T00:00:00Z".into());
    saved(&core, &r);
    r.language = "en".into();
    saved(&core, &r);
    r.language = "fr".into();
    r.project_id = "other-project".into();
    saved(&core, &r);
    let broken = folder(&core, &crate::domain::id()).unwrap();
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("request.json"), b"broken").unwrap();
    let all = list(&core, 0, 20, false).unwrap();
    assert_eq!(all.matching, 3);
    assert_eq!(all.unreadable, 1);
    assert_eq!(all.items[0].report_id, legacy);
    assert_eq!(all.items[0].created_at, first.items[0].created_at);
    assert_eq!(
        list(&core, 1, 1, false).unwrap().items[0]
            .created_at
            .as_deref(),
        Some("2020-01-01T00:00:00.000Z")
    );
    assert!(list(&core, 0, 0, false).is_err());
    assert!(list(&core, 0, 101, false).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
}
#[tokio::test]
async fn partial_batch_after_restart_is_interrupted_and_keeps_unprocessed_lines() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["good", "TTS_DRAMA_RAM_REQUIRED", "last"]);
    let r = request(&p, &root);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        r,
        None,
        Some(fixture::worker(&root)),
    )
    .unwrap();
    fixture::finished(&core, &key).await;
    let reopened = fixture::core(&root, project::load(&root).unwrap());
    let history = list(&reopened, 0, 20, true).unwrap();
    assert_eq!(history.items[0].status, "interrupted");
    assert_eq!(
        (
            history.items[0].progress.succeeded,
            history.items[0].progress.failed,
            history.items[0].progress.completed
        ),
        (1, 1, 2)
    );
    assert!(history.items[0].active_job_id.is_none());
    assert_eq!(
        report(&reopened, &history.items[0].report_id, 0, 25, true)
            .unwrap()
            .matching,
        2
    );
}
