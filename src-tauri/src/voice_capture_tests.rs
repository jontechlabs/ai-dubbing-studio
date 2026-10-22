use super::*;
use std::{collections::HashMap, sync::Mutex};
fn pcm(ms: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend(((36 + ms * 48) as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(24000u32.to_le_bytes());
    bytes.extend(48000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(((ms * 48) as u32).to_le_bytes());
    for i in 0..ms * 24 {
        bytes.extend((((i as f64 * 0.03).sin() * 5000.0) as i16).to_le_bytes());
    }
    bytes
}
fn core(root: &Path) -> Arc<Core> {
    let mut p = Project::new("Recording".into(), "ja".into(), "fr".into());
    p.dialogues=serde_json::from_value(json!([{"id":"line","startMs":1000,"endMs":3000,"sourceCueIds":[],"targetCueIds":[],"ttsText":"Bonjour !","characterId":null,"status":"ungenerated","warnings":[],"selectedGenerationIds":{}}])).unwrap();
    project::save(root, &p).unwrap();
    Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.into(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.into(),
        model_dir: Mutex::new(root.join("models")),
    })
}
#[test]
fn recording_commits_new_takes_and_reloads_without_overwriting_originals() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let core = core(&root);
    let app = tauri::test::mock_app();
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    let save = |p: &Project| {
        save_microphone(
            core.clone(),
            app.handle().clone(),
            Capture {
                project_id: p.id.clone(),
                expected_revision: p.revision,
                line_id: "line".into(),
            },
            &pcm(1000),
        )
        .unwrap()
    };
    let p = save(&p);
    let first = p.generations[0].clone();
    let path = project::asset(&root, first["path"].as_str().unwrap()).unwrap();
    let original = std::fs::read(&path).unwrap();
    let p = save(&p);
    assert_eq!(p.generations.len(), 2);
    assert_eq!(p.generations[0], first);
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(p.format_version, 17);
    assert_eq!(project::load(&root).unwrap().generations, p.generations);
    let mut session = core.session.lock().unwrap();
    let s = session.as_mut().unwrap();
    let undo = s.history(false).unwrap();
    assert_eq!(undo.generations.len(), 1);
    assert_eq!(s.history(true).unwrap().generations.len(), 2);
}
#[test]
fn invalid_recording_and_stale_commit_never_change_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let core = core(&root);
    let app = tauri::test::mock_app();
    let p = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    for (bytes, revision) in [
        (pcm(10), p.revision),
        (pcm(120001), p.revision),
        (pcm(1000), p.revision + 1),
    ] {
        assert!(save_microphone(
            core.clone(),
            app.handle().clone(),
            Capture {
                project_id: p.id.clone(),
                expected_revision: revision,
                line_id: "line".into()
            },
            &bytes
        )
        .is_err());
        assert!(project::load(&root).unwrap().generations.is_empty());
    }
}
