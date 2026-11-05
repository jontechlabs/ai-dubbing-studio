use super::tests as fixture;
use super::*;
use std::time::Duration;
fn selection(count: u32) -> Selection {
    Selection {
        take_count: Some(count),
        scope: "all".into(),
        line_ids: vec![],
        force: true,
        approved_only: false,
        unapproved_only: false,
        options: fixture::options(),
    }
}
fn request(p: &Project, root: &Path, s: &Selection) -> Request {
    let (preview, items) = plan(p, root, s).unwrap();
    Request {
        take_count: s.take_count,
        created_at: None,
        origin_batch_id: None,
        root: root.into(),
        project_id: p.id.clone(),
        language: p.languages.target.clone(),
        approved_only: s.approved_only,
        unapproved_only: s.unapproved_only,
        items,
        skipped: preview.existing * s.take_count.unwrap_or(1) as usize,
    }
}
fn worker(root: &Path) -> tts::WorkerLaunch {
    let launch = fixture::worker(root);
    let source=std::fs::read_to_string(&launch.script).unwrap()
      .replace("r['text']=='fail'", "(r['text']=='fail' or (r['text']=='seed-fail' and r['seed']==8))")
      .replace("r['text']=='slow'", "(r['text']=='slow' or (r['text']=='slow-seed' and r['seed']==8))")
      .replace("    if r['text'].startswith('TTS_DRAMA_')", "    if r['text']=='edit-during':\n        while not (folder/'release').exists(): time.sleep(0.02)\n    if r['text'].startswith('TTS_DRAMA_')");
    std::fs::write(&launch.script, source).unwrap();
    launch
}
fn calls(root: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(root.join("calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}
async fn wait_calls(root: &Path, n: usize) {
    for _ in 0..300 {
        if calls(root).len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("worker did not reach requested take");
}
#[test]
fn counts_one_to_four_unique_ids_seed_wrapping_and_legacy_input_are_bounded() {
    let tmp = tempfile::tempdir().unwrap();
    let p = fixture::fixture(tmp.path(), &["one", "two"]);
    for count in 1..=4 {
        let mut s = selection(count);
        s.options.seed = u32::MAX;
        let (preview, items) = plan(&p, tmp.path(), &s).unwrap();
        assert_eq!(preview.ready.len(), 2);
        assert_eq!(items.len(), 2 * count as usize);
        assert_eq!(
            items
                .iter()
                .map(|i| i.request.batch_item_id.clone())
                .collect::<HashSet<_>>()
                .len(),
            items.len()
        );
        for group in items.chunks(count as usize) {
            for (n, item) in group.iter().enumerate() {
                assert_eq!(item.take_index, n as u32);
                assert_eq!(item.request.options.seed, u32::MAX.wrapping_add(n as u32));
            }
        }
    }
    for count in [0, 5, u32::MAX] {
        assert_eq!(
            plan(&p, tmp.path(), &selection(count)).err().unwrap(),
            "INVALID_TTS_TAKE_COUNT"
        );
    }
    let mut value = serde_json::to_value(selection(1)).unwrap();
    value.as_object_mut().unwrap().remove("takeCount");
    let legacy: Selection = serde_json::from_value(value).unwrap();
    assert_eq!(plan(&p, tmp.path(), &legacy).unwrap().1.len(), 2);
}
#[tokio::test]
async fn four_takes_per_dialogue_reuse_one_worker_select_last_and_keep_previous_wavs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["one", "two"]);
    let first = request(&p, &root, &selection(1));
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        first,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "succeeded");
    let p = project::load(&root).unwrap();
    let before = p.generations.clone();
    let audio: Vec<_> = before
        .iter()
        .map(|g| std::fs::read(root.join(g["path"].as_str().unwrap())).unwrap())
        .collect();
    let next = request(&p, &root, &selection(4));
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        next,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    let job = fixture::finished(&core, &key).await;
    assert_eq!(job.status, "succeeded");
    assert_eq!(job.batch.unwrap().succeeded, 8);
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 10);
    for (g, bytes) in before.iter().zip(audio) {
        assert!(p.generations.contains(g));
        assert_eq!(
            std::fs::read(root.join(g["path"].as_str().unwrap())).unwrap(),
            bytes
        );
    }
    for line in &p.dialogues {
        let id = &line.selected_generation_ids["fr"];
        let g = p.generations.iter().find(|g| g["id"] == *id).unwrap();
        assert_eq!(g["options"]["seed"], 10);
    }
    let c = calls(&root);
    assert_eq!(c.len(), 10);
    assert_eq!(
        c[2..]
            .iter()
            .map(|c| c["workerPid"].as_u64().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    fixture::assert_worker_exited(c.last().unwrap()["workerPid"].as_u64().unwrap());
}
#[tokio::test]
async fn exact_failed_take_retries_after_restart_without_regenerating_siblings() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["seed-fail"]);
    let r = request(&p, &root, &selection(4));
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        r,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "failed");
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 3);
    let before = p.generations.clone();
    let reopened = fixture::core(&root, p);
    let report = review::report(&reopened, &key, 0, 20, false).unwrap();
    assert_eq!(report.progress.take_count, Some(4));
    assert_eq!(
        report
            .items
            .iter()
            .map(|r| r.take_index)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    assert_eq!(report.items[1].status, "failed");
    for indices in [vec![0], vec![1, 0], vec![100]] {
        let selection = review::RetrySelection {
            scope: "selected".into(),
            line_ids: vec![],
            item_indices: indices,
        };
        assert_eq!(
            review::retry_with_launch(
                reopened.clone(),
                app.handle().clone(),
                &key,
                selection,
                Some(worker(&root))
            )
            .unwrap_err(),
            "INVALID_TTS_BATCH"
        );
        assert!(reopened.jobs.lock().unwrap().is_empty());
    }
    std::fs::write(root.join("retry"), b"fixed").unwrap();
    let next = review::retry_with_launch(
        reopened.clone(),
        app.handle().clone(),
        &key,
        review::RetrySelection {
            scope: "selected".into(),
            line_ids: vec![],
            item_indices: vec![1],
        },
        Some(worker(&root)),
    )
    .unwrap();
    assert_eq!(
        fixture::finished(&reopened, &next).await.status,
        "succeeded"
    );
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 4);
    for g in before {
        assert!(p.generations.contains(&g));
    }
    assert_eq!(
        calls(&root)
            .iter()
            .map(|c| c["seed"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![7, 8, 9, 10, 8]
    );
    let h = review::history::list(&reopened, 0, 20, false).unwrap();
    assert_eq!(h.matching, 1);
    assert_eq!(h.items[0].retry_count, 1);
    assert_eq!(h.items[0].progress.succeeded, 4);
}
#[tokio::test]
async fn cancelled_middle_take_is_resumable_without_repeating_completed_takes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["slow-seed"]);
    let r = request(&p, &root, &selection(4));
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        r,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    wait_calls(&root, 2).await;
    core.jobs
        .lock()
        .unwrap()
        .get(&key)
        .unwrap()
        .cancel
        .store(true, Ordering::Relaxed);
    assert_eq!(fixture::finished(&core, &key).await.status, "cancelled");
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 1);
    let original = p.generations[0].clone();
    let reopened = fixture::core(&root, p);
    std::fs::write(root.join("retry"), b"fixed").unwrap();
    let key = review::retry_with_launch(
        reopened.clone(),
        app.handle().clone(),
        &key,
        review::RetrySelection {
            scope: "unfinished".into(),
            line_ids: vec![],
            item_indices: vec![],
        },
        Some(worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&reopened, &key).await.status, "succeeded");
    let p = project::load(&root).unwrap();
    assert_eq!(p.generations.len(), 4);
    assert!(p.generations.contains(&original));
    assert_eq!(calls(&root).iter().filter(|c| c["seed"] == 7).count(), 1);
}
#[tokio::test]
async fn approved_only_is_checked_once_per_dialogue_while_own_new_takes_revoke_review() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let mut p = fixture::fixture(&root, &["approved"]);
    fixture::approve(&mut p, 0);
    let mut s = selection(4);
    s.approved_only = true;
    let r = request(&p, &root, &s);
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        r,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "succeeded");
    assert_eq!(project::load(&root).unwrap().generations.len(), 4);
}
#[tokio::test]
async fn external_text_edit_during_first_take_is_not_accepted_as_a_sibling_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture::fixture(&root, &["edit-during"]);
    let r = request(&p, &root, &selection(4));
    let core = fixture::core(&root, p);
    let app = tauri::test::mock_app();
    let key = start_with_launch(
        core.clone(),
        app.handle().clone(),
        r,
        None,
        Some(worker(&root)),
    )
    .unwrap();
    wait_calls(&root, 1).await;
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project
        .target_cues[0]
        .text = "Manual correction".into();
    std::fs::write(root.join("release"), b"continue").unwrap();
    assert_eq!(fixture::finished(&core, &key).await.status, "failed");
    let p = project::load(&root).unwrap();
    assert_eq!(p.target_cues[0].text, "Manual correction");
    assert!(!p.dialogues[0].selected_generation_ids.contains_key("fr"));
    assert_eq!(calls(&root).len(), 1);
}
