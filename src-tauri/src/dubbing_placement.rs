//! Newly selected/edited performances keep their duration and onset. Move only
//! their lane when occupied; the selected source WAVs are always immutable.
use crate::{domain::Project, dubbing_lanes as lanes, mix};
use std::collections::HashMap;
#[cfg(test)]
#[path = "dubbing_placement_tests.rs"]
mod tests;

pub fn resolve(before: &Project, next: &mut Project) -> Result<(), String> {
    let Some(media) = &next.media else {
        return Ok(());
    };
    let source = media.path.clone();
    let language = next.languages.target.clone();
    let generations: HashMap<_, _> = next
        .generations
        .iter()
        .filter_map(|g| g["id"].as_str().map(|id| (id, g)))
        .collect();
    if let Some(timing) = next
        .dubbing_timing
        .as_mut()
        .filter(|t| t.source_path == source)
    {
        let old_lines: HashMap<_, _> = before.dialogues.iter().map(|l| (&l.id, l)).collect();
        let old_timing = before
            .dubbing_timing
            .as_ref()
            .filter(|t| t.source_path == source);
        for line in &next.dialogues {
            let Some(old) = old_lines.get(&line.id) else {
                continue;
            };
            let selected = line
                .selected_generation_ids
                .get(&language)
                .and_then(|id| generations.get(id.as_str()));
            let derived_from = selected.and_then(|g| {
                if g["takeOrigin"]["type"] == "conversion" {
                    g["takeOrigin"]["sourceGenerationId"].as_str()
                } else {
                    g["prosodyTransfer"]["sourceGenerationId"].as_str()
                }
            });
            if derived_from.is_some()
                && derived_from
                    == old
                        .selected_generation_ids
                        .get(&language)
                        .map(String::as_str)
            {
                continue;
            }
            if line.selected_generation_ids.contains_key(&language)
                && old.selected_generation_ids.get(&language)
                    != line.selected_generation_ids.get(&language)
            {
                if let (Some(saved), Some(values)) = (
                    old_timing
                        .and_then(|t| t.durations_ms.get(&line.id))
                        .and_then(|v| v.get(&language)),
                    timing.durations_ms.get_mut(&line.id),
                ) {
                    if values.get(&language) == Some(saved) {
                        values.remove(&language);
                    }
                }
            }
        }
    }
    let old: HashMap<_, _> = mix::clips(before)
        .into_iter()
        .map(|c| (c.line_id.clone(), c))
        .collect();
    let mut clips = mix::clips(next);
    clips.sort_by_key(|c| {
        let changed = old.get(&c.line_id).is_none_or(|o| {
            o.id != c.id
                || o.start_ms() != c.start_ms()
                || o.duration_ms() != c.duration_ms()
                || o.lane_id != c.lane_id
        });
        (changed, c.start_ms())
    });
    let mut occupied: HashMap<String, Vec<(u64, u64)>> = HashMap::new();
    for clip in clips {
        let start = clip.start_ms();
        let end = start + clip.duration_ms();
        if end <= start {
            continue;
        }
        let free = |id: &str| {
            !occupied
                .get(id)
                .is_some_and(|rows| rows.iter().any(|&(a, b)| a < end && start < b))
        };
        let mut destination = lanes::lane(next, &clip.line_id).to_string();
        if !free(&destination) {
            let current = lanes::current(next)
                .and_then(|s| s.lanes.iter().find(|l| l.id == destination))
                .cloned()
                .unwrap_or(lanes::Lane {
                    id: lanes::MAIN.into(),
                    name: "Doublage 1".into(),
                    mute: false,
                    solo: false,
                    gain: 1.0,
                    character_id: None,
                    character_name: None,
                });
            let available = lanes::current(next)
                .and_then(|state| {
                    state.lanes.iter().find(|l| {
                        l.id != destination
                            && l.mute == current.mute
                            && l.solo == current.solo
                            && l.gain == current.gain
                            && (!state.by_character.as_ref().is_some_and(|r| r.enabled)
                                || l.character_id == current.character_id)
                            && free(&l.id)
                    })
                })
                .map(|l| l.id.clone());
            if lanes::current(next).is_none() {
                next.format_version = next.format_version.max(32);
                next.dubbing_lanes = Some(lanes::State {
                    source_path: source.clone(),
                    lanes: vec![current.clone()],
                    assignments: HashMap::new(),
                    by_character: None,
                });
            }
            let state = next.dubbing_lanes.as_mut().unwrap();
            destination = match available {
                Some(id) => id,
                None => {
                    if state.lanes.len() >= lanes::MAX_LANES {
                        return Err("DUBBING_LANES_LIMIT".into());
                    }
                    if state.lanes.len() >= 32 {
                        next.format_version = next.format_version.max(33);
                    }
                    let id = crate::domain::id();
                    state.lanes.push(lanes::Lane {
                        id: id.clone(),
                        name: format!("Doublage {}", state.lanes.len() + 1),
                        character_id: None,
                        character_name: None,
                        ..current
                    });
                    id
                }
            };
            if destination == lanes::MAIN {
                state.assignments.remove(&clip.line_id);
            } else {
                state
                    .assignments
                    .insert(clip.line_id.clone(), destination.clone());
            }
            if let Some(routing) = &mut state.by_character {
                if !routing.manual_line_ids.contains(&clip.line_id) {
                    routing.manual_line_ids.push(clip.line_id.clone());
                }
            }
        }
        occupied.entry(destination).or_default().push((start, end));
    }
    Ok(())
}
