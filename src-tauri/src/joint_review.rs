//! A review belongs to one exact text/take/edit/placement snapshot.
use crate::domain::{Dialogue, Project};
use serde_json::{json, Value};

pub fn selected<'a>(p: &'a Project, line: &Dialogue) -> Option<&'a Value> {
    let id = line.selected_generation_ids.get(&p.languages.target)?;
    p.generations.iter().find(|g| {
        g["kind"] == "tts"
            && g["id"] == *id
            && g["dialogueId"] == line.id
            && g["language"] == p.languages.target
    })
}
pub fn snapshot(p: &Project, line: &Dialogue) -> Value {
    let g = selected(p, line);
    let mode = g.and_then(|g| g["options"]["referenceMode"].as_str());
    let character = p
        .characters
        .iter()
        .find(|c| Some(&c.id) == line.character_id.as_ref());
    let reference = g.filter(|g| g.get("takeOrigin").is_none() && mode != Some("current")).and_then(|g| {
        let id = g["referenceId"].as_str();
        match mode {
            Some("file") => p.voice_references.iter().find(|r| Some(r.id.as_str()) == id),
            Some("library") => crate::voice_library::reference(p, line.character_id.as_deref()?, id),
            _ => {
                let c = character?;
                let wanted = id.or_else(|| if mode == Some("custom") { g["options"]["referenceId"].as_str() } else { c.default_reference_id.as_deref() });
                c.references.iter().find(|r| Some(r.id.as_str()) == wanted)
            }
        }
    }).map(|r| json!({"id":r.id,"path":r.path,"transcript":r.transcript,"defaultId":if mode==Some("character") {character.and_then(|c| c.default_reference_id.as_ref())}else{None}}));
    let edit = g.and_then(|g| g["id"].as_str()).and_then(|id| p.voice_edits.get(id)).map(|e| json!({
        "outputGain":e.output_gain.unwrap_or(1.0),
        "pieces":e.pieces.iter().map(|piece|json!({"sourceStartMs":piece.source_start_ms,"sourceEndMs":piece.source_end_ms,"durationMs":piece.duration_ms,"gain":piece.gain,"envelope":piece.envelope.clone().unwrap_or_default(),"effects":piece.effects})).collect::<Vec<_>>()
    }));
    let timing = p
        .dubbing_timing
        .as_ref()
        .filter(|t| Some(&t.source_path) == p.media.as_ref().map(|m| &m.path));
    json!({"sourceCues":line.source_cue_ids.iter().filter_map(|id|p.source_cues.iter().find(|c|&c.id==id)).collect::<Vec<_>>(),"targetCues":line.target_cue_ids.iter().filter_map(|id|p.target_cues.iter().find(|c|&c.id==id)).collect::<Vec<_>>(),"ttsText":line.tts_text,"pronunciation":p.pronunciation,"startMs":line.start_ms,"endMs":line.end_ms,"characterId":line.character_id,"sourcePath":p.media.as_ref().map(|m|&m.path),"generation":g,"reference":reference,"edit":edit,
      "offsetMs":timing.and_then(|t|t.offsets_ms.get(&line.id)).and_then(|v|v.get(&p.languages.target)).copied().unwrap_or(0),
      "durationMs":timing.and_then(|t|t.durations_ms.get(&line.id)).and_then(|v|v.get(&p.languages.target))})
}
// JS serializes integral floats as integers. Ignore JSON numeric representation,
// while preserving exact keys, array order and every audible parameter.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, a)| b.get(k).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}
pub fn clean(p: &mut Project) {
    let source: std::collections::HashMap<_, _> =
        p.source_cues.iter().map(|c| (&c.id, &c.text)).collect();
    let target: std::collections::HashMap<_, _> =
        p.target_cues.iter().map(|c| (&c.id, &c.text)).collect();
    let lines: std::collections::HashMap<_, _> = p.dialogues.iter().map(|l| (&l.id, l)).collect();
    let text = |ids: &[String], cues: &std::collections::HashMap<&String, &String>| {
        ids.iter()
            .map(|id| cues.get(id).map_or("", |s| s.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let approvals = p
        .translation_approvals
        .iter()
        .filter_map(|(id, a)| {
            let line = lines.get(id)?;
            if line.excluded_from_dubbing == Some(true) {
                return None;
            }
            if a.source_language != p.languages.source
                || a.target_language != p.languages.target
                || a.source_text != text(&line.source_cue_ids, &source)
                || a.target_text.trim().is_empty()
                || a.target_text != text(&line.target_cue_ids, &target)
            {
                return None;
            }
            let take = selected(p, line);
            if take.is_some() && line.status != "validated" {
                return None;
            }
            let current = snapshot(p, line);
            if let Some(saved) = &a.joint {
                if !same(saved, &current) {
                    return None;
                }
            } else if take.is_some_and(|g| {
                g["text"] != crate::tts::text(p, line)
                    || g["startMs"] != line.start_ms
                    || g["endMs"] != line.end_ms
                    || g["characterId"] != json!(line.character_id)
                    || g["sourcePath"] != json!(p.media.as_ref().map(|m| &m.path))
            }) {
                return None;
            }
            let mut a = a.clone();
            a.joint = Some(current);
            Some((id.clone(), a))
        })
        .collect();
    p.translation_approvals = approvals;
    if !p.translation_approvals.is_empty() {
        p.format_version = p.format_version.max(24);
    }
    for line in &mut p.dialogues {
        if line.status == "validated" && !p.translation_approvals.contains_key(&line.id) {
            line.status = "review".into();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/joint-review.json")).unwrap()
    }
    #[test]
    fn exclusion_preserves_subtitles_takes_and_placement_but_removes_mix_clips_and_lip_batch_items()
    {
        let mut p = fixture();
        p.media=Some(serde_json::from_value(json!({"id":"media","path":"media/source.mp4","previewPath":null,"audioStreamIndex":1,"originalName":"source.mp4","durationMs":2000,"streams":[]})).unwrap());
        p.generations[0]["sourcePath"] = json!("media/source.mp4");
        assert_eq!(crate::mix::clips(&p).len(), 1);
        let source = serde_json::to_value(&p.source_cues).unwrap();
        let target = serde_json::to_value(&p.target_cues).unwrap();
        let takes = p.generations.clone();
        p.dialogues[0].excluded_from_dubbing = Some(true);
        p.clean_translation_approvals();
        p.validate().unwrap();
        assert!(crate::mix::clips(&p).is_empty());
        assert!(p.translation_approvals.is_empty());
        assert_eq!(p.generations, takes);
        assert_eq!(serde_json::to_value(&p.source_cues).unwrap(), source);
        assert_eq!(serde_json::to_value(&p.target_cues).unwrap(), target);
        let selection:crate::inpaint_batch::Selection=serde_json::from_value(json!({"scope":"all","lineIds":[],"force":true,"useSavedCrops":true,"useCommonCrop":true,"options":{"lineId":"line1","generationId":"take1","device":"cuda:0","face":{"x":0.0,"y":0.0,"width":0.5,"height":0.5},"endX":0.0,"endY":0.0,"mask":{"x":0.1,"y":0.3,"width":0.4,"height":0.2},"feather":0.1,"blend":1.0,"style":"anime","seed":0}})).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let (preview, items) = crate::inpaint_batch::plan(&p, tmp.path(), &selection).unwrap();
        assert_eq!(preview.requested, 0);
        assert!(items.is_empty());
        p.dialogues[0].excluded_from_dubbing = None;
        assert_eq!(crate::mix::clips(&p).len(), 1);
        assert_eq!(p.generations, takes);
    }
    #[test]
    fn js_snapshot_survives_native_defaults_numeric_encoding_and_reload() {
        let mut p = fixture();
        p.validate().unwrap();
        let expected = p.translation_approvals["line1"].joint.as_ref().unwrap();
        assert!(same(expected, &snapshot(&p, &p.dialogues[0])));
        p.clean_translation_approvals();
        assert_eq!(p.translation_approvals.len(), 1);
        let tmp = tempfile::tempdir().unwrap();
        let root = crate::project::create_root(tmp.path(), "Joint").unwrap();
        crate::project::save(&root, &p).unwrap();
        let loaded = crate::project::load(&root).unwrap();
        assert_eq!(loaded.dialogues[0].status, "validated");
        assert_eq!(loaded.translation_approvals.len(), 1);
    }
    #[test]
    fn text_take_audio_fades_effects_and_placement_changes_withdraw_common_review() {
        for (pointer, value) in [
            ("/sourceCues/0/text", json!("Changed")),
            ("/targetCues/0/text", json!("Changed")),
            ("/dialogues/0/ttsText", json!("Bonsoir")),
            ("/pronunciation", json!({"Bonjour":"Bonsoir"})),
            ("/voiceEdits/take1/outputGain", json!(1.75)),
            ("/voiceEdits/take1/pieces/0/gain", json!(0)),
            ("/voiceEdits/take1/pieces/0/durationMs", json!(1750)),
            ("/generations/0/path", json!("generations/other.wav")),
            ("/dialogues/0/startMs", json!(1)),
            ("/dialogues/0/status", json!("review")),
            ("/dialogues/0/selectedGenerationIds", json!({})),
        ] {
            let mut value_ = serde_json::to_value(fixture()).unwrap();
            *value_.pointer_mut(pointer).unwrap() = value;
            let mut p: Project = serde_json::from_value(value_).unwrap();
            p.clean_translation_approvals();
            assert!(p.translation_approvals.is_empty(), "{pointer}");
            assert_ne!(p.dialogues[0].status, "validated");
        }
        for edit in [
            json!({"envelope":[{"atMs":0,"level":0},{"atMs":1500,"level":1}]}),
            json!({"effects":[{"kind":"reverb","enabled":true,"parameters":{}}]}),
        ] {
            let mut p = fixture();
            let mut value = serde_json::to_value(&p).unwrap();
            value["voiceEdits"]["take1"]["pieces"][0]
                .as_object_mut()
                .unwrap()
                .extend(edit.as_object().unwrap().clone());
            p = serde_json::from_value(value).unwrap();
            p.clean_translation_approvals();
            assert!(p.translation_approvals.is_empty());
        }
        let mut p = fixture();
        p.dubbing_timing = Some(crate::domain::DubbingTiming {
            source_path: "source.mp4".into(),
            offsets_ms: std::collections::HashMap::from([(
                "line1".into(),
                std::collections::HashMap::from([("fr".into(), 100)]),
            )]),
            durations_ms: Default::default(),
        });
        // Timing for another media is inactive and does not change this take.
        p.clean_translation_approvals();
        assert_eq!(p.translation_approvals.len(), 1);
    }
    #[test]
    fn legacy_reviews_migrate_only_if_the_voice_was_already_validated() {
        let mut p = fixture();
        p.format_version = 23;
        p.translation_approvals.get_mut("line1").unwrap().joint = None;
        p.clean_translation_approvals();
        assert_eq!(p.format_version, 24);
        assert_eq!(p.translation_approvals.len(), 1);
        for status in ["generated", "review"] {
            let mut p = fixture();
            p.translation_approvals.get_mut("line1").unwrap().joint = None;
            p.dialogues[0].status = status.into();
            p.clean_translation_approvals();
            assert!(p.translation_approvals.is_empty());
        }
    }
    #[test]
    fn new_take_does_not_inherit_text_only_approval_and_history_restores_the_review() {
        let mut p = fixture();
        p.dialogues[0].selected_generation_ids.clear();
        p.dialogues[0].status = "ungenerated".into();
        p.translation_approvals.get_mut("line1").unwrap().joint =
            Some(snapshot(&p, &p.dialogues[0]));
        p.clean_translation_approvals();
        assert_eq!(p.translation_approvals.len(), 1);
        let tmp = tempfile::tempdir().unwrap();
        let root = crate::project::create_root(tmp.path(), "Review history").unwrap();
        crate::project::save(&root, &p).unwrap();
        let mut session = crate::project::Session::new(root, p.clone());
        p.dialogues[0]
            .selected_generation_ids
            .insert("fr".into(), "take1".into());
        p.dialogues[0].status = "generated".into();
        let saved = session.replace(p, 0).unwrap();
        assert!(saved.translation_approvals.is_empty());
        assert_eq!(saved.generations.len(), 1);
        assert_eq!(
            session.history(false).unwrap().translation_approvals.len(),
            1
        );
        assert!(session
            .history(true)
            .unwrap()
            .translation_approvals
            .is_empty());
    }
}
