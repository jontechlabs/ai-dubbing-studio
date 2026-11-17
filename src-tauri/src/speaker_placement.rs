//! Place verified separator outputs as immutable, independently editable takes.
//! Planning and all file conversions complete before one revision-checked commit.
use super::*;
use crate::dubbing_lanes::{Lane, State, MAIN, MAX_LANES};
use std::collections::HashMap;
#[cfg(test)]
#[path = "speaker_placement_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Placement {
    pub output_id: String,
    pub label: String,
    pub character_id: Option<String>,
    pub source_text: String,
    pub target_text: String,
    pub lane_id: Option<String>,
    pub lane_name: String,
}
struct Output {
    output_id: String,
    reference: String,
    take: String,
    offset_ms: u64,
    duration_ms: u64,
}
fn dialogue(start: u64, end: u64) -> crate::domain::Dialogue {
    serde_json::from_value(json!({"id":id(),"startMs":start,"endMs":end,"sourceCueIds":[],"targetCueIds":[],"ttsText":null,"characterId":null,"status":"ungenerated","warnings":[],"selectedGenerationIds":{}})).unwrap()
}
pub(super) fn placed(p: &Project, key: &str) -> Vec<String> {
    p.generations
        .iter()
        .filter(|g| {
            g["takeOrigin"]["type"] == "separation" && g["takeOrigin"]["separationId"] == key
        })
        .filter_map(|g| g["takeOrigin"]["outputId"].as_str().map(str::to_owned))
        .collect()
}
fn plan(
    p: &Project,
    r: &Request,
    m: &Model,
    key: &str,
    language: &str,
    assignments: Vec<Placement>,
) -> Result<(Project, Vec<Output>), String> {
    p.validate()?;
    if assignments.is_empty()
        || assignments.len() > m.speakers
        || ![p.languages.source.as_str(), p.languages.target.as_str()].contains(&language)
    {
        return Err("SPEAKER_SEPARATION_OPTIONS".into());
    }
    let mut next = p.clone();
    next.format_version = next.format_version.max(34);
    if crate::dubbing_lanes::current(&next).is_none() {
        next.dubbing_lanes = Some(State {
            source_path: r.source_path.clone(),
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
    let old = next
        .speaker_dubbings
        .iter()
        .position(|g| g.separation_id == key);
    let mut group = if let Some(index) = old {
        next.speaker_dubbings[index].clone()
    } else {
        let parent_id = if let Some(parent) = &r.options.line_id {
            parent.clone()
        } else {
            let parent = dialogue(r.options.start_ms, r.options.end_ms);
            let parent_id = parent.id.clone();
            next.dialogues.push(parent);
            parent_id
        };
        crate::speaker_dubbing::Group {
            id: id(),
            parent_id,
            separation_id: key.into(),
            model_id: m.id.clone(),
            source_path: r.source_path.clone(),
            source_track_id: r.options.source_track_id.clone(),
            start_ms: r.options.start_ms,
            end_ms: r.options.end_ms,
            created_at: crate::domain::now(),
            active: true,
            voices: vec![],
        }
    };
    if group.source_path != r.source_path
        || group.start_ms != r.options.start_ms
        || group.end_ms != r.options.end_ms
    {
        return Err("STALE_REVISION".into());
    }
    let already = placed(p, key);
    let mut seen = HashSet::new();
    let mut outputs = vec![];
    for a in assignments {
        if !m.outputs.contains(&a.output_id)
            || !seen.insert(a.output_id.clone())
            || a.label.trim().is_empty()
            || a.label.chars().count() > 200
            || a.source_text.chars().count() > 20000
            || a.target_text.chars().count() > 20000
            || a.character_id
                .as_ref()
                .is_some_and(|id| !p.characters.iter().any(|c| &c.id == id))
        {
            return Err("SPEAKER_SEPARATION_OPTIONS".into());
        }
        if already.contains(&a.output_id) {
            return Err("SPEAKER_SEPARATION_ALREADY_APPLIED".into());
        }
        let voice = if let Some(voice) = group.voices.iter().find(|v| v.output_id == a.output_id) {
            voice.clone()
        } else {
            let mut line = dialogue(group.start_ms, group.end_ms);
            line.character_id = a.character_id.clone();
            let line_id = line.id.clone();
            next.dialogues.push(line);
            let voice = crate::speaker_dubbing::Voice {
                line_id,
                output_id: a.output_id.clone(),
                label: a.label.clone(),
                audio_path: format!("stems/isolated-{}.wav", id()),
                source_text: a.source_text.clone(),
                translations: HashMap::from([(p.languages.target.clone(), a.target_text.clone())]),
            };
            group.voices.push(voice.clone());
            voice
        };
        let line = next
            .dialogues
            .iter_mut()
            .find(|l| l.id == voice.line_id)
            .ok_or("INVALID_PROJECT")?;
        if line.start_ms < group.start_ms || line.end_ms > group.end_ms {
            return Err("SPEAKER_SEPARATION_OPTIONS".into());
        }
        let take_id = id();
        let take = format!("generations/{take_id}.wav");
        let duration = line.end_ms - line.start_ms;
        line.selected_generation_ids
            .insert(p.languages.target.clone(), take_id.clone());
        line.status = "review".into();
        let text = if let Some(text) = &line.tts_text {
            text.clone()
        } else {
            voice
                .translations
                .get(&p.languages.target)
                .cloned()
                .unwrap_or_default()
        };
        next.generations.push(json!({"kind":"tts","id":take_id,"dialogueId":line.id,"path":take,"createdAt":crate::domain::now(),"sourcePath":r.source_path,"startMs":line.start_ms,"endMs":line.end_ms,"text":text,"language":p.languages.target,"characterId":line.character_id,"durationMs":duration,"sampleRate":24000,"providerId":"speaker-separation","modelId":m.id,"options":{"device":"cpu","referenceMode":"current","referenceId":null,"mode":"crossLingual","speed":1.0,"seed":0},"referenceTranscript":voice.source_text,"device":"cpu","deviceName":"Isolated source audio","peakVramMb":0,"inputHash":format!("separation:{key}:{}",a.output_id),"takeOrigin":{"type":"separation","separationId":key,"outputId":a.output_id,"sourceTrackId":r.options.source_track_id,"sourceLanguage":language}}));
        let state = next.dubbing_lanes.as_mut().unwrap();
        let lane = if let Some(lane) = a.lane_id {
            if !state.lanes.iter().any(|l| l.id == lane) {
                return Err("INVALID_DUBBING_LANES".into());
            }
            lane
        } else {
            if state.lanes.len() >= MAX_LANES
                || a.lane_name.trim().is_empty()
                || a.lane_name.chars().count() > 80
            {
                return Err("INVALID_DUBBING_LANES".into());
            }
            let lane = id();
            state.lanes.push(Lane {
                id: lane.clone(),
                name: a.lane_name.trim().into(),
                mute: false,
                solo: false,
                gain: 1.0,
                character_id: None,
                character_name: None,
            });
            lane
        };
        if lane == MAIN {
            state.assignments.remove(&voice.line_id);
        } else {
            state.assignments.insert(voice.line_id.clone(), lane);
        }
        if let Some(routing) = &mut state.by_character {
            if !routing.manual_line_ids.contains(&voice.line_id) {
                routing.manual_line_ids.push(voice.line_id.clone());
            }
        }
        outputs.push(Output {
            output_id: a.output_id,
            reference: voice.audio_path,
            take,
            offset_ms: line.start_ms - group.start_ms,
            duration_ms: duration,
        });
    }
    for g in &mut next.speaker_dubbings {
        if g.parent_id == group.parent_id {
            g.active = false;
        }
    }
    group.active = true;
    if let Some(index) = old {
        next.speaker_dubbings[index] = group;
    } else {
        next.speaker_dubbings.push(group);
    }
    next.validate()?;
    Ok((next, outputs))
}
pub async fn place<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    key: String,
    audio_language: String,
    assignments: Vec<Placement>,
) -> Result<Project, String> {
    if jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let r = request(&core, &key)?;
    let p = current(&core, &r)?;
    if snapshot(&p, &r.root, &r.options)? != r.snapshot {
        return Err("STALE_REVISION".into());
    }
    let m = model(&app, &r.options.model_id)?;
    let (next, outputs) = plan(&p, &r, &m, &key, &audio_language, assignments)?;
    project::ensure_directory(&r.root, "stems")?;
    project::ensure_directory(&r.root, "generations")?;
    let executable = crate::media::binary(&app, "ffmpeg")?;
    let mut assets = NewAssets::default();
    for output in outputs {
        let input = project::asset(
            &r.root,
            &format!("cache/speaker-separation/{key}/{}.wav", output.output_id),
        )?;
        if crate::audio_files::pcm_frames(&input, 1, 48000, "SPEAKER_SEPARATION_INVALID_AUDIO")?
            != (r.options.end_ms - r.options.start_ms) * 48
        {
            return Err("SPEAKER_SEPARATION_INVALID_AUDIO".into());
        }
        let reference = r.root.join(&output.reference);
        if !reference.exists() {
            assets.paths.push(reference.clone());
            std::fs::copy(&input, &reference).map_err(io_error)?;
        }
        let target = r.root.join(&output.take);
        assets.paths.push(target.clone());
        let filter=format!("atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS,aresample=24000,apad=whole_len={},atrim=end_sample={}",output.offset_ms*48,(output.offset_ms+output.duration_ms)*48,output.duration_ms*24,output.duration_ms*24);
        let status = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            crate::media::command(&executable)
                .args(["-v", "error", "-nostdin", "-n", "-i"])
                .arg(&input)
                .args([
                    "-af",
                    &filter,
                    "-ac",
                    "1",
                    "-ar",
                    "24000",
                    "-c:a",
                    "pcm_s16le",
                ])
                .arg(&target)
                .output(),
        )
        .await
        .map_err(|_| "SPEAKER_SEPARATION_INVALID_AUDIO")?
        .map_err(io_error)?;
        if !status.status.success()
            || crate::audio_files::pcm_frames(
                &target,
                1,
                24000,
                "SPEAKER_SEPARATION_INVALID_AUDIO",
            )? != output.duration_ms * 24
        {
            return Err("SPEAKER_SEPARATION_INVALID_AUDIO".into());
        }
    }
    let mut guard = core.session.lock().map_err(io_error)?;
    let session = guard.as_mut().ok_or("NO_PROJECT")?;
    if session.root != r.root
        || session.project.id != p.id
        || session.project.revision != p.revision
    {
        return Err("STALE_REVISION".into());
    }
    let saved = session.replace(next, p.revision)?;
    assets.keep = true;
    let _ = app.emit("project-changed", &saved);
    Ok(saved)
}
