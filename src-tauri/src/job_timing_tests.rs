use super::*;
use std::{collections::HashMap, sync::Mutex};

#[test]
fn clock_excludes_queue_and_does_not_restart_at_each_progress_message() {
    let start = Instant::now();
    let mut clock = ExecutionClock::default();
    clock.transition("queued", start);
    assert_eq!(
        clock
            .snapshot(start + Duration::from_secs(10), 100)
            .elapsed_ms,
        0
    );
    clock.transition("running", start + Duration::from_secs(10));
    for ms in 1..=10 {
        clock.transition(
            "running",
            start + Duration::from_secs(10) + Duration::from_micros(ms * 100),
        );
    }
    assert_eq!(
        clock
            .snapshot(start + Duration::from_secs(12), 1)
            .elapsed_ms,
        2000
    );
    // Wall time changes affect the observation timestamp, never measured work.
    assert_eq!(
        clock
            .snapshot(start + Duration::from_secs(13), 0)
            .elapsed_ms,
        3000
    );
}

#[test]
fn clock_excludes_multiple_pauses_and_retains_submillisecond_segments() {
    let start = Instant::now();
    let mut clock = ExecutionClock::default();
    clock.transition("running", start);
    clock.transition("paused", start + Duration::from_micros(1500));
    assert_eq!(
        clock
            .snapshot(start + Duration::from_secs(90), 0)
            .elapsed_ms,
        1
    );
    clock.transition("running", start + Duration::from_secs(100));
    clock.transition(
        "paused",
        start + Duration::from_secs(100) + Duration::from_micros(1500),
    );
    assert_eq!(
        clock
            .snapshot(start + Duration::from_secs(200), 0)
            .elapsed_ms,
        3
    );
    clock.transition("running", start + Duration::from_secs(300));
    assert_eq!(
        clock
            .snapshot(start + Duration::from_secs(301), 0)
            .elapsed_ms,
        1003
    );
}

#[test]
fn every_terminal_state_freezes_execution_even_if_late_logs_arrive() {
    let start = Instant::now();
    for status in ["succeeded", "failed", "cancelled", "interrupted"] {
        let mut clock = ExecutionClock::default();
        clock.transition("running", start);
        clock.transition(status, start + Duration::from_secs(2));
        clock.transition(status, start + Duration::from_secs(100));
        assert_eq!(
            clock
                .snapshot(start + Duration::from_secs(200), 0)
                .elapsed_ms,
            2000
        );
    }
}

fn fixture() -> (tempfile::TempDir, Arc<Core>) {
    let dir = tempfile::tempdir().unwrap();
    let core = Arc::new(Core {
        data_dir: dir.path().to_owned(),
        model_dir: Mutex::new(dir.path().to_owned()),
        session: Mutex::new(None),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
    });
    (dir, core)
}

#[test]
fn checkpoint_measures_silent_work_and_restart_never_counts_closed_app_time() {
    let (dir, core) = fixture();
    let app = tauri::test::mock_app();
    let key = create(&core, app.handle(), "tts", "project".into(), None);
    {
        let mut jobs = core.jobs.lock().unwrap();
        let c = jobs.get_mut(&key).unwrap();
        c.saved.record.status = "running".into();
        c.clock.elapsed = Duration::from_millis(1250);
        c.clock.running_since = Some(Instant::now() - Duration::from_millis(500));
        assert!(c.snapshot().timing.unwrap().elapsed_ms >= 1750);
    }
    persist(&core);
    let records: Vec<PersistedJob> =
        serde_json::from_slice(&std::fs::read(dir.path().join("jobs.json")).unwrap()).unwrap();
    let saved = records.into_iter().next().unwrap();
    let measured = saved.record.timing.as_ref().unwrap().elapsed_ms;
    assert!(measured >= 1750);
    let restored = Control::restore(saved);
    let snapshot = restored.snapshot_at(Instant::now() + Duration::from_secs(86400), u64::MAX);
    assert_eq!(snapshot.status, "interrupted");
    assert_eq!(snapshot.timing.unwrap().elapsed_ms, measured);
}

#[test]
fn old_jobs_remain_readable_with_unknown_timing() {
    let (_dir, core) = fixture();
    let app = tauri::test::mock_app();
    let key = create(&core, app.handle(), "tts", "project".into(), None);
    let saved = core.jobs.lock().unwrap().get(&key).unwrap().saved.clone();
    let mut json = serde_json::to_value(saved).unwrap();
    json["record"].as_object_mut().unwrap().remove("timing");
    let restored = Control::restore(serde_json::from_value(json).unwrap());
    assert_eq!(restored.snapshot().status, "interrupted");
    assert!(restored.snapshot().timing.is_none());
}

#[test]
fn retry_has_its_own_zero_clock_and_keeps_previous_duration() {
    let (_dir, core) = fixture();
    let app = tauri::test::mock_app();
    let first = create(&core, app.handle(), "ttsBatch", "project".into(), None);
    update(&core, app.handle(), &first, |job| {
        job.status = "running".into()
    });
    {
        let mut jobs = core.jobs.lock().unwrap();
        let c = jobs.get_mut(&first).unwrap();
        c.clock.running_since = Some(Instant::now() - Duration::from_secs(3));
    }
    update(&core, app.handle(), &first, |job| {
        job.status = "failed".into()
    });
    let retry = create(&core, app.handle(), "ttsBatch", "project".into(), None);
    let jobs = core.jobs.lock().unwrap();
    assert!(jobs[&first].snapshot().timing.unwrap().elapsed_ms >= 3000);
    assert_eq!(jobs[&retry].snapshot().timing.unwrap().elapsed_ms, 0);
}
