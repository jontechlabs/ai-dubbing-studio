//! Expand an explicit speaker script into ordinary independent dialogues/lanes.
//! No source separation or native multi-speaker model support is assumed.
use crate::{
    domain::{id, io_error, Cue, Dialogue, Project},
    dubbing_lanes::{Lane, State, MAIN, MAX_LANES},
    project, tts, tts_batch, Core,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};
use tauri::Emitter;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Slot {
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Speaker {
    pub speaker: u32,
    pub name: String,
    pub character_id: Option<String>,
    pub reference_mode: String,
    pub reference_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub script: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub slots: Option<Vec<Slot>>,
    pub speakers: Vec<Speaker>,
    pub options: tts::Options,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Generation {
    pub line_ids: Vec<String>,
    pub take_count: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub speaker: u32,
    pub label: String,
    pub text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTurn {
    #[serde(flatten)]
    pub turn: Turn,
    #[serde(flatten)]
    pub slot: Slot,
}
#[derive(Serialize)]
pub struct Preview {
    pub turns: Vec<PreviewTurn>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub project: Project,
    pub line_ids: Vec<String>,
}

fn parse(script: &str) -> Result<Vec<Turn>, String> {
    let invalid = || "SCRIPT_INVALID".to_owned();
    if script.len() > 65_536 {
        return Err(invalid());
    }
    let mut turns: Vec<Turn> = vec![];
    for raw in script.lines() {
        let line = raw.trim();
        if line.to_ascii_lowercase().starts_with("[speaker") {
            let end = line.find(']').ok_or_else(invalid)?;
            let header = &line[1..end];
            let (number, label) = header
                .get(8..)
                .ok_or_else(invalid)?
                .split_once(':')
                .map_or((header.get(8..).ok_or_else(invalid)?, ""), |(n, l)| {
                    (n, l.trim())
                });
            if !header.to_ascii_lowercase().starts_with("speaker ")
                || number.is_empty()
                || number.starts_with('0')
                || !number.bytes().all(|b| b.is_ascii_digit())
                || label.chars().count() > 80
                || (header.contains(':') && label.is_empty())
            {
                return Err(invalid());
            }
            let speaker = number.parse::<u32>().map_err(|_| invalid())?;
            if !(1..=99).contains(&speaker) {
                return Err(invalid());
            }
            turns.push(Turn {
                speaker,
                label: label.into(),
                text: line[end + 1..].trim().into(),
            });
        } else if !line.is_empty() {
            let turn = turns.last_mut().ok_or_else(invalid)?;
            if !turn.text.is_empty() {
                turn.text.push('\n');
            }
            turn.text.push_str(line);
        }
    }
    if turns.is_empty()
        || turns.len() > 128
        || turns
            .iter()
            .map(|t| t.speaker)
            .collect::<HashSet<_>>()
            .len()
            > 16
        || turns.iter().any(|t| {
            t.text.trim().is_empty()
                || t.text.chars().count() > 1000
                || t.text.to_ascii_lowercase().contains("[speaker")
        })
    {
        return Err(invalid());
    }
    Ok(turns)
}

fn plan(p: &Project, root: &Path, o: &Options) -> Result<(Project, Vec<String>, Preview), String> {
    p.validate()?;
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let turns = parse(&o.script)?;
    let slots = match &o.slots {
        Some(s) if s.len() == turns.len() => s.clone(),
        Some(_) => return Err("SCRIPT_TIMING_INVALID".into()),
        None => {
            if !(100..=120_000).contains(&o.duration_ms) {
                return Err("SCRIPT_TIMING_INVALID".into());
            }
            (0..turns.len())
                .map(|i| {
                    let start = (i as u64)
                        .checked_mul(o.duration_ms)
                        .and_then(|v| o.start_ms.checked_add(v))
                        .ok_or("SCRIPT_TIMING_INVALID")?;
                    Ok(Slot {
                        start_ms: start,
                        end_ms: start
                            .checked_add(o.duration_ms)
                            .ok_or("SCRIPT_TIMING_INVALID")?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?
        }
    };
    let used: HashSet<_> = turns.iter().map(|t| t.speaker).collect();
    let speakers: HashMap<_, _> = o.speakers.iter().map(|s| (s.speaker, s)).collect();
    if speakers.len() != o.speakers.len()
        || speakers.len() != used.len()
        || used.iter().any(|s| !speakers.contains_key(s))
    {
        return Err("SCRIPT_REFERENCE_REQUIRED".into());
    }
    for s in &o.speakers {
        if s.name.trim().is_empty()
            || s.name.chars().count() > 80
            || s.reference_id.is_empty()
            || !["custom", "file", "library"].contains(&s.reference_mode.as_str())
            || s.character_id
                .as_ref()
                .is_some_and(|id| !p.characters.iter().any(|c| &c.id == id))
        {
            return Err("SCRIPT_REFERENCE_REQUIRED".into());
        }
        let reference = if s.reference_mode == "library" {
            s.character_id
                .as_deref()
                .and_then(|c| crate::voice_library::reference(p, c, Some(&s.reference_id)))
        } else {
            p.voice_reference(
                if s.reference_mode == "file" {
                    None
                } else {
                    s.character_id.as_deref()
                },
                &s.reference_id,
            )
        };
        let r = reference.ok_or("SCRIPT_REFERENCE_REQUIRED")?;
        if !(1000..=20_000).contains(&r.duration_ms) {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        project::asset(root, &r.path)?;
    }
    for (i, (turn, slot)) in turns.iter().zip(&slots).enumerate() {
        let duration = slot
            .end_ms
            .checked_sub(slot.start_ms)
            .ok_or("SCRIPT_TIMING_INVALID")?;
        if !(100..=120_000).contains(&duration)
            || slot.end_ms > media.info.duration_ms.min(86_400_000)
        {
            return Err("SCRIPT_TIMING_INVALID".into());
        }
        if turns.iter().zip(&slots).take(i).any(|(other, s)| {
            other.speaker == turn.speaker && s.start_ms < slot.end_ms && slot.start_ms < s.end_ms
        }) {
            return Err("SCRIPT_SPEAKER_OVERLAP".into());
        }
    }
    let mut next = p.clone();
    next.format_version = next.format_version.max(32).max(o.options.required_format());
    if crate::dubbing_lanes::current(&next).is_none() {
        next.dubbing_lanes = Some(State {
            source_path: media.path.clone(),
            lanes: vec![Lane {
                id: MAIN.into(),
                name: "Doublage 1".into(),
                mute: false,
                solo: false,
                gain: 1.0,
                character_id: None,
                character_name: None,
            }],
            assignments: HashMap::new(),
            by_character: None,
        });
    }
    let state = next.dubbing_lanes.as_mut().unwrap();
    if state.lanes.len() + used.len() > MAX_LANES {
        return Err("DUBBING_LANES_LIMIT".into());
    }
    if state.lanes.len() + used.len() > 32 {
        next.format_version = next.format_version.max(33);
    }
    let mut lanes = HashMap::new();
    for s in &o.speakers {
        let lane_id = id();
        state.lanes.push(Lane {
            id: lane_id.clone(),
            name: s.name.trim().into(),
            mute: false,
            solo: false,
            gain: 1.0,
            character_id: None,
            character_name: None,
        });
        lanes.insert(s.speaker, lane_id);
    }
    let mut line_ids = vec![];
    let mut preview = Preview { turns: vec![] };
    for (turn, slot) in turns.into_iter().zip(slots) {
        let s = speakers[&turn.speaker];
        let mut settings = o.options.clone();
        settings.reference_mode = s.reference_mode.clone();
        settings.reference_id = Some(s.reference_id.clone());
        // A script supplies independent references; source-contour guidance from
        // an unrelated selected dialogue must never leak into new interventions.
        settings.intonation_guide = None;
        settings.validate()?;
        next.format_version = next.format_version.max(settings.required_format());
        let cue_id = id();
        next.target_cues.push(Cue {
            id: cue_id.clone(),
            start_ms: slot.start_ms,
            end_ms: slot.end_ms,
            text: turn.text.clone(),
        });
        let line_id = id();
        next.dialogues.push(Dialogue {
            id: line_id.clone(),
            start_ms: slot.start_ms,
            end_ms: slot.end_ms,
            source_cue_ids: vec![],
            target_cue_ids: vec![cue_id],
            tts_text: None,
            character_id: s.character_id.clone(),
            status: "ungenerated".into(),
            warnings: vec![],
            selected_generation_ids: HashMap::new(),
            voice_settings: Some(settings.clone()),
            review_tags: vec![],
            excluded_from_dubbing: None,
        });
        let state = next.dubbing_lanes.as_mut().unwrap();
        state
            .assignments
            .insert(line_id.clone(), lanes[&turn.speaker].clone());
        if let Some(routing) = &mut state.by_character {
            routing.manual_line_ids.push(line_id.clone());
        }
        tts::prepare_request(&next, root, line_id.clone(), settings)?;
        line_ids.push(line_id);
        preview.turns.push(PreviewTurn { turn, slot });
    }
    next.dialogues.sort_by_key(|l| l.start_ms);
    next.target_cues.sort_by_key(|l| l.start_ms);
    next.validate()?;
    Ok((next, line_ids, preview))
}

pub fn preview(core: &Core, options: &Options) -> Result<Preview, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let session = guard.as_ref().ok_or("NO_PROJECT")?;
    plan(&session.project, &session.root, options).map(|(_, _, preview)| preview)
}
pub fn create<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    project_id: &str,
    revision: u64,
    options: &Options,
) -> Result<Created, String> {
    if tts::busy(core) {
        return Err("BUSY".into());
    }
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.project.id != project_id || s.project.revision != revision {
        return Err("STALE_REVISION".into());
    }
    let (next, line_ids, _) = plan(&s.project, &s.root, options)?;
    let project = s.replace(next, revision)?;
    let _ = app.emit("project-changed", &project);
    Ok(Created { project, line_ids })
}
fn requests(
    p: &Project,
    root: &Path,
    selection: &Generation,
) -> Result<Vec<tts_batch::Item>, String> {
    let count = crate::tts_trials::count(Some(selection.take_count))?;
    if selection.line_ids.is_empty()
        || selection.line_ids.len() > 128
        || selection.line_ids.iter().collect::<HashSet<_>>().len() != selection.line_ids.len()
    {
        return Err("INVALID_TTS_BATCH".into());
    }
    let mut items = vec![];
    for line_id in &selection.line_ids {
        let line = p
            .dialogues
            .iter()
            .find(|l| &l.id == line_id && l.excluded_from_dubbing != Some(true))
            .ok_or("NO_DIALOGUES")?;
        let options = line
            .voice_settings
            .as_ref()
            .ok_or("SCRIPT_REFERENCE_REQUIRED")?;
        for take_index in 0..count {
            let mut options = options.clone();
            options.seed = options.seed.wrapping_add(take_index);
            let mut request = tts::prepare_request(p, root, line_id.clone(), options)?;
            request.batch_item_id = Some(id());
            items.push(tts_batch::Item {
                take_index,
                origin_index: None,
                request,
                status: "pending".into(),
                error: None,
            });
        }
    }
    Ok(items)
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    project_id: &str,
    revision: u64,
    selection: &Generation,
) -> Result<String, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.project.id != project_id || s.project.revision != revision {
            return Err("STALE_REVISION".into());
        }
        let items = requests(&s.project, &s.root, selection)?;
        if items
            .iter()
            .any(|i| !tts::runtime_installed(&core, &i.request.options))
        {
            return Err("TTS_RUNTIME_REQUIRED".into());
        }
        tts_batch::Request {
            take_count: Some(selection.take_count),
            created_at: None,
            origin_batch_id: None,
            root: s.root.clone(),
            approved_only: false,
            unapproved_only: false,
            project_id: s.project.id.clone(),
            language: s.project.languages.target.clone(),
            items,
            skipped: 0,
        }
    };
    tts_batch::start(core, app, request, None)
}

#[cfg(test)]
#[path = "scripted_dubbing_tests.rs"]
mod tests;
