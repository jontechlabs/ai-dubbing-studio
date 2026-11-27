use super::*;
use crate::{mix, project};
use serde_json::{json, Value};
async fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Project) {
    let (dir, root, mut p) = mix::tests::fixture().await;
    let spec: Value =
        serde_json::from_str(include_str!("../../resources/character-lanes-fixture.json")).unwrap();
    p.characters = serde_json::from_value(spec["characters"].clone()).unwrap();
    p.dialogues = serde_json::from_value(spec["dialogues"].clone()).unwrap();
    p.validate().unwrap();
    (dir, root, p)
}
fn enabled(p: &Project) -> Project {
    configure(
        p,
        &Options {
            enabled: true,
            preserve_manual: true,
        },
    )
    .unwrap()
}
#[tokio::test]
async fn matches_shared_fixture_and_keeps_both_simultaneous_selected_takes_and_original_audio() {
    let (_dir, root, mut p) = fixture().await;
    let before = p.generations.clone();
    let bytes = std::fs::read(root.join("generations/voice.wav")).unwrap();
    let result = enabled(&p);
    let spec: Value =
        serde_json::from_str(include_str!("../../resources/character-lanes-fixture.json")).unwrap();
    assert!(crate::joint_review::same(
        &serde_json::to_value(&result.dubbing_lanes).unwrap(),
        &spec["expected"]
    ));
    let mut repeat = result.clone();
    normalize(&mut repeat).unwrap();
    assert!(crate::joint_review::same(
        &serde_json::to_value(&repeat.dubbing_lanes).unwrap(),
        &spec["expected"]
    ));
    assert_eq!(repeat.generations, before);
    let mut occupied = p.clone();
    occupied.format_version = 32;
    occupied.dubbing_lanes=Some(serde_json::from_value(json!({"sourcePath":p.media.as_ref().unwrap().path,"lanes":[{"id":"main","name":"Doublage 1","gain":1,"mute":false,"solo":false},{"id":"existing","name":"Alice","gain":1.75,"mute":true,"solo":false}],"assignments":{"line2":"existing"}})).unwrap());
    let occupied = enabled(&occupied);
    assert_eq!(lane(&occupied, "line2"), "existing");
    assert_ne!(lane(&occupied, "line"), "existing");
    assert!(occupied.dubbing_lanes.as_ref().unwrap().lanes[1].mute);
    p.dialogues[0]
        .selected_generation_ids
        .insert("fr".into(), "voice".into());
    p.dialogues[1]
        .selected_generation_ids
        .insert("fr".into(), "voice2".into());
    let mut take = p.generations[0].clone();
    take["id"] = json!("voice2");
    take["dialogueId"] = json!("line2");
    p.generations.push(take);
    p = enabled(&p);
    let clips = mix::clips(&p);
    assert_eq!(clips.len(), 2);
    assert!(clips
        .iter()
        .all(|c| c.slot_ms == 1500 && c.duration_ms() == 1500));
    assert_eq!(
        std::fs::read(root.join("generations/voice.wav")).unwrap(),
        bytes
    );
}
#[tokio::test]
async fn session_commits_route_new_dialogues_and_character_renames_without_recreating_tracks() {
    let (_dir, root, p) = fixture().await;
    let p = enabled(&p);
    let mut session = project::Session::new(root.clone(), p.clone());
    let mut edited = p.clone();
    edited.characters[0].name = "Alicia".into();
    edited.dialogues[2].character_id = Some("alpha".into());
    let saved = session.replace(edited, p.revision).unwrap();
    assert_eq!(lane(&saved, "line3"), "character-1");
    assert_eq!(saved.dubbing_lanes.as_ref().unwrap().lanes.len(), 3);
    assert_eq!(
        saved.dubbing_lanes.as_ref().unwrap().lanes[1].name,
        "Alicia"
    );
    let mut custom = saved.clone();
    custom.dubbing_lanes.as_mut().unwrap().lanes[1].name = "Voix grave".into();
    custom.characters[0].name = "Alice finale".into();
    let saved = session.replace(custom, saved.revision).unwrap();
    assert_eq!(
        saved.dubbing_lanes.as_ref().unwrap().lanes[1].name,
        "Voix grave"
    );
    let reopened = project::load(&root).unwrap();
    assert_eq!(
        serde_json::to_value(&reopened.dubbing_lanes).unwrap(),
        serde_json::to_value(&saved.dubbing_lanes).unwrap()
    );
    let undone = session.history(false).unwrap();
    assert_eq!(
        undone.dubbing_lanes.as_ref().unwrap().lanes[1].name,
        "Alicia"
    );
}
#[tokio::test]
async fn manual_main_override_is_durable_across_character_changes_and_can_return_to_automatic() {
    let (_dir, root, p) = fixture().await;
    let p = enabled(&p);
    let mut p = assign(&p, &["line".into()], Some(MAIN)).unwrap();
    p.dialogues[0].character_id = Some("beta".into());
    normalize(&mut p).unwrap();
    assert_eq!(lane(&p, "line"), MAIN);
    project::save(&root, &p).unwrap();
    let p = project::load(&root).unwrap();
    assert_eq!(lane(&p, "line"), MAIN);
    let p = assign(&p, &["line".into()], None).unwrap();
    assert_eq!(lane(&p, "line"), "character-2");
    let mut p = configure(
        &p,
        &Options {
            enabled: false,
            preserve_manual: true,
        },
    )
    .unwrap();
    p.dialogues[0].character_id = Some("alpha".into());
    normalize(&mut p).unwrap();
    assert_eq!(lane(&p, "line"), "character-2");
    let p = enabled(&p);
    assert_eq!(lane(&p, "line"), "character-1");
    assert!(assign(&p, &["missing".into()], Some(MAIN)).is_err());
}
#[tokio::test]
async fn large_character_sets_are_bounded_and_invalid_routes_never_replace_saved_data() {
    let (_dir, root, mut p) = fixture().await;
    p.characters = (0..40)
        .map(|i| {
            let mut c = p.characters[0].clone();
            c.id = format!("c{i}");
            c.name = format!("Personnage {i}");
            c
        })
        .collect();
    p.dialogues = p
        .characters
        .iter()
        .map(|c| {
            let mut l = p.dialogues[0].clone();
            l.id = format!("l{}", c.id);
            l.character_id = Some(c.id.clone());
            l
        })
        .collect();
    let mut enabled = configure(
        &p,
        &Options {
            enabled: true,
            preserve_manual: true,
        },
    )
    .unwrap();
    assert_eq!(enabled.dubbing_lanes.as_ref().unwrap().lanes.len(), 41);
    project::save(&root, &enabled).unwrap();
    let bytes = std::fs::read(root.join("project.json")).unwrap();
    enabled.dubbing_lanes.as_mut().unwrap().lanes[2].character_id = Some("c0".into());
    assert!(project::save(&root, &enabled).is_err());
    assert_eq!(std::fs::read(root.join("project.json")).unwrap(), bytes);
    p.characters = (0..256)
        .map(|i| {
            let mut c = p.characters[0].clone();
            c.id = format!("c{i}");
            c
        })
        .collect();
    p.dialogues = p
        .characters
        .iter()
        .map(|c| {
            let mut l = p.dialogues[0].clone();
            l.id = format!("l{}", c.id);
            l.character_id = Some(c.id.clone());
            l
        })
        .collect();
    assert_eq!(
        configure(
            &p,
            &Options {
                enabled: true,
                preserve_manual: true
            }
        )
        .unwrap_err(),
        "DUBBING_LANES_LIMIT"
    );
    assert!(p.dubbing_lanes.is_none());
}
