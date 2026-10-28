use super::*;
use crate::project;
use serde_json::json;
use std::{collections::HashMap, sync::Mutex};
fn options() -> Options {
    serde_json::from_value(json!({"lineId":"line","tts":{"device":"cpu","referenceMode":"current","referenceId":null,"mode":"crossLingual","speed":1,"seed":0},"conversion":{"generationId":"pipeline","referenceId":"","characterId":null,"referenceMode":"current","device":"cpu"},"guideStrength":0})).unwrap()
}
fn project() -> Project {
    let mut p = Project::new("Pipeline".into(), "ja".into(), "fr".into());
    p.format_version = 23;
    p.dialogues=serde_json::from_value(json!([{"id":"line","startMs":1000,"endMs":3000,"sourceCueIds":[],"targetCueIds":[],"ttsText":"Bonjour.","characterId":null,"status":"ungenerated","warnings":[],"selectedGenerationIds":{}}])).unwrap();
    p
}
#[test]
fn provenance_is_bounded_and_survives_deleting_intermediate_takes() {
    let mut p = project();
    p.generations.push(json!({"id":"final","kind":"tts","dialogueId":"line","dubbingPipeline":{"engine":"chatterbox-vc","stageIds":["raw","final"],"settings":options()}}));
    validate_project(&p).unwrap();
    for value in [
        json!(["raw", "raw"]),
        json!(["raw", "missing"]),
        json!(["final"]),
        json!(["a", "b", "final"]),
    ] {
        let mut q = p.clone();
        q.generations[0]["dubbingPipeline"]["stageIds"] = value;
        assert!(validate_project(&q).is_err());
    }
    let mut q = p.clone();
    q.format_version = 22;
    assert!(validate_project(&q).is_err());
    let mut q = p.clone();
    q.generations[0]["dubbingPipeline"]["settings"]["guideStrength"] = json!(2);
    assert!(validate_project(&q).is_err());
}
#[test]
fn stage_checkpoint_preserves_prior_takes_and_rejects_unexpected_edits_or_revision() {
    let temp = tempfile::tempdir().unwrap();
    let p = project();
    let root = temp.path().canonicalize().unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.clone(),
        model_dir: Mutex::new(root.join("models")),
    });
    let app = tauri::test::mock_app();
    let key = jobs::create(&core, app.handle(), "ttsPipeline", p.id.clone(), None);
    let mut r = Request {
        root,
        project_id: p.id.clone(),
        revision: p.revision,
        options: options(),
        stages: vec![],
    };
    {
        let mut guard = core.session.lock().unwrap();
        let s = guard.as_mut().unwrap();
        s.project
            .generations
            .push(json!({"id":"raw","kind":"tts","dialogueId":"line"}));
        s.project.revision += 1;
    }
    advance(&core, app.handle(), &key, &mut r, &p).unwrap();
    assert_eq!(r.stages, vec!["raw"]);
    let persisted = core.jobs.lock().unwrap().get(&key).unwrap().saved.clone();
    let reloaded: jobs::PersistedJob =
        serde_json::from_value(serde_json::to_value(persisted).unwrap()).unwrap();
    assert_eq!(reloaded.dubbing_pipeline.unwrap().stages, vec!["raw"]);
    let before = snapshot(&core, &r).unwrap();
    {
        let mut guard = core.session.lock().unwrap();
        let s = guard.as_mut().unwrap();
        s.project.generations[0]["changed"] = json!(true);
        s.project
            .generations
            .push(json!({"id":"conversion","kind":"tts","dialogueId":"line"}));
        s.project.revision += 1;
    }
    assert_eq!(
        advance(&core, app.handle(), &key, &mut r, &before).unwrap_err(),
        "STALE_REVISION"
    );
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .generations[0]["id"],
        "raw"
    );
    r.revision += 1;
    assert_eq!(snapshot(&core, &r).err().unwrap(), "STALE_REVISION");
}
#[tokio::test]
async fn cancellation_before_first_stage_never_loads_models_or_changes_the_project() {
    let temp = tempfile::tempdir().unwrap();
    let p = project();
    let root = temp.path().canonicalize().unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.clone(),
        model_dir: Mutex::new(root.join("models")),
    });
    let app = tauri::test::mock_app();
    let key = jobs::create(&core, app.handle(), "ttsPipeline", p.id.clone(), None);
    let r = Request {
        root,
        project_id: p.id.clone(),
        revision: 0,
        options: options(),
        stages: vec![],
    };
    assert_eq!(
        run(&core, app.handle(), &key, r, &AtomicBool::new(true))
            .await
            .unwrap_err(),
        "CANCELLED"
    );
    assert!(core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .generations
        .is_empty());
}
