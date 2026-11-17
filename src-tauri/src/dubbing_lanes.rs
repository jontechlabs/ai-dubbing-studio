//! Logical dubbing lanes share the final dubbing bus but have independent
//! occupancy, gain/mute/solo and immutable selected takes.
use crate::domain::Project;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[cfg(test)]
#[path = "dubbing_lanes_tests.rs"]
mod tests;
pub const MAIN: &str = "main";
pub const MAX_LANES: usize = 256;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CharacterRouting {
    pub enabled: bool,
    pub manual_line_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub enabled: bool,
    pub preserve_manual: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lane {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_name: Option<String>,
    pub id: String,
    pub name: String,
    pub mute: bool,
    pub solo: bool,
    pub gain: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_character: Option<CharacterRouting>,
    pub source_path: String,
    pub lanes: Vec<Lane>,
    pub assignments: HashMap<String, String>,
}
pub fn current(p: &Project) -> Option<&State> {
    p.dubbing_lanes
        .as_ref()
        .filter(|s| p.media.as_ref().is_some_and(|m| m.path == s.source_path))
}
pub fn lane<'a>(p: &'a Project, line: &str) -> &'a str {
    current(p)
        .and_then(|s| s.assignments.get(line))
        .map_or(MAIN, String::as_str)
}
pub fn gain(p: &Project, line: &str) -> f64 {
    let Some(s) = current(p) else {
        return 1.0;
    };
    let Some(l) = s.lanes.iter().find(|l| l.id == lane(p, line)) else {
        return 0.0;
    };
    if l.mute || s.lanes.iter().any(|l| l.solo && !l.mute) && !l.solo {
        0.0
    } else {
        l.gain
    }
}
pub fn validate(p: &Project) -> Result<(), String> {
    let Some(s) = &p.dubbing_lanes else {
        return Ok(());
    };
    let invalid = || "INVALID_DUBBING_LANES".to_owned();
    if p.format_version < 32
        || s.lanes.is_empty()
        || s.lanes.len()
            > if p.format_version >= 33 {
                MAX_LANES
            } else {
                32
            }
        || s.lanes[0].id != MAIN
        || s.assignments.len() > 100000
    {
        return Err(invalid());
    }
    crate::domain::valid_relative(&s.source_path).map_err(|_| invalid())?;
    let mut ids = HashSet::new();
    let mut characters = HashSet::new();
    for l in &s.lanes {
        if l.id.is_empty()
            || l.id.len() > 128
            || !ids.insert(l.id.as_str())
            || l.name.trim().is_empty()
            || l.name.chars().count() > 80
            || !l.gain.is_finite()
            || !(0.0..=3.0).contains(&l.gain)
        {
            return Err(invalid());
        }
        if l.character_id.is_some() || l.character_name.is_some() {
            if p.format_version < 33
                || l.id == MAIN
                || l.character_id
                    .as_ref()
                    .is_none_or(|id| id.is_empty() || id.len() > 128 || !characters.insert(id))
                || l.character_name
                    .as_ref()
                    .is_none_or(|n| n.trim().is_empty() || n.chars().count() > 80)
            {
                return Err(invalid());
            }
        }
    }
    if let Some(r) = &s.by_character {
        let mut seen = HashSet::new();
        if p.format_version < 33
            || r.manual_line_ids.len() > 100000
            || r.manual_line_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 128 || !seen.insert(id))
        {
            return Err(invalid());
        }
    }
    if s.assignments
        .iter()
        .any(|(id, l)| id.is_empty() || id.len() > 128 || !ids.contains(l.as_str()))
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn normalize(p: &mut Project) -> Result<(), String> {
    if !current(p)
        .and_then(|s| s.by_character.as_ref())
        .is_some_and(|r| r.enabled)
    {
        return Ok(());
    }
    validate(p)?;
    let mut state = p.dubbing_lanes.clone().unwrap();
    let characters: HashMap<_, _> = p.characters.iter().map(|c| (c.id.as_str(), c)).collect();
    let lines: HashMap<_, _> = p.dialogues.iter().map(|l| (l.id.as_str(), l)).collect();
    let routing = state.by_character.as_mut().unwrap();
    routing
        .manual_line_ids
        .retain(|id| lines.contains_key(id.as_str()));
    let manual: HashSet<_> = routing.manual_line_ids.iter().cloned().collect();
    let needed: HashSet<_> = p
        .dialogues
        .iter()
        .filter(|l| !manual.contains(&l.id))
        .filter_map(|l| l.character_id.as_deref())
        .filter(|id| characters.contains_key(id))
        .collect();
    let mut ids: HashSet<_> = state.lanes.iter().map(|l| l.id.clone()).collect();
    let mut linked = HashMap::new();
    let label = |name: &str| name.trim().chars().take(80).collect::<String>();
    for (index, lane) in state.lanes.iter_mut().enumerate() {
        let character = lane
            .character_id
            .as_deref()
            .and_then(|id| characters.get(id));
        if lane.character_id.is_some() && character.is_none() {
            lane.character_id = None;
            lane.character_name = None;
        }
        if let Some(c) = character {
            if Some(&lane.name) == lane.character_name.as_ref() {
                lane.name = label(&c.name);
            }
            lane.character_name = Some(label(&c.name));
            linked.insert(c.id.clone(), index);
        }
    }
    let mut owners: HashMap<String, HashSet<Option<String>>> = HashMap::new();
    state.assignments.retain(|id, lane| {
        let Some(line) = lines.get(id.as_str()) else {
            return false;
        };
        owners
            .entry(lane.clone())
            .or_default()
            .insert(line.character_id.clone());
        true
    });
    let mut names = HashMap::new();
    for c in &p.characters {
        *names.entry(c.name.as_str()).or_insert(0usize) += 1;
    }
    let mut serial = 1;
    for c in &p.characters {
        if !needed.contains(c.id.as_str()) || linked.contains_key(&c.id) {
            continue;
        }
        let available: Vec<_> = state
            .lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| l.id != MAIN && l.character_id.is_none())
            .collect();
        let named: Vec<_> = available
            .iter()
            .filter(|(_, l)| names[c.name.as_str()] == 1 && l.name == c.name)
            .map(|(i, _)| *i)
            .collect();
        let exclusive: Vec<_> = available
            .iter()
            .filter(|(_, l)| {
                owners
                    .get(&l.id)
                    .is_some_and(|set| set.len() == 1 && set.contains(&Some(c.id.clone())))
            })
            .map(|(i, _)| *i)
            .collect();
        let index = if named.len() == 1 {
            named[0]
        } else if exclusive.len() == 1 {
            exclusive[0]
        } else {
            if state.lanes.len() >= MAX_LANES {
                return Err("DUBBING_LANES_LIMIT".into());
            }
            while ids.contains(&format!("character-{serial}")) {
                serial += 1;
            }
            let id = format!("character-{serial}");
            serial += 1;
            ids.insert(id.clone());
            state.lanes.push(Lane {
                id,
                name: label(&c.name),
                mute: false,
                solo: false,
                gain: 1.0,
                character_id: None,
                character_name: None,
            });
            state.lanes.len() - 1
        };
        state.lanes[index].character_id = Some(c.id.clone());
        state.lanes[index].character_name = Some(label(&c.name));
        linked.insert(c.id.clone(), index);
    }
    for line in &p.dialogues {
        if manual.contains(&line.id) {
            continue;
        }
        if let Some(index) = line.character_id.as_ref().and_then(|id| linked.get(id)) {
            state
                .assignments
                .insert(line.id.clone(), state.lanes[*index].id.clone());
        } else {
            state.assignments.remove(&line.id);
        }
    }
    p.dubbing_lanes = Some(state);
    Ok(())
}
pub fn configure(p: &Project, o: &Options) -> Result<Project, String> {
    p.validate()?;
    let mut next = p.clone();
    next.format_version = next.format_version.max(33);
    if current(p).is_none() {
        next.dubbing_lanes = Some(State {
            source_path: p.media.as_ref().ok_or("MEDIA_MISSING")?.path.clone(),
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
    let manual = if o.preserve_manual {
        state
            .by_character
            .as_ref()
            .map(|r| r.manual_line_ids.clone())
            .unwrap_or_else(|| {
                let mut ids: Vec<_> = state.assignments.keys().cloned().collect();
                ids.sort();
                ids
            })
    } else {
        vec![]
    };
    state.by_character = Some(CharacterRouting {
        enabled: o.enabled,
        manual_line_ids: manual,
    });
    normalize(&mut next)?;
    next.validate()?;
    Ok(next)
}
pub fn assign(
    p: &Project,
    line_ids: &[String],
    destination: Option<&str>,
) -> Result<Project, String> {
    p.validate()?;
    let mut next = p.clone();
    let ids: HashSet<_> = line_ids.iter().map(String::as_str).collect();
    let valid: HashSet<_> = p.dialogues.iter().map(|l| l.id.as_str()).collect();
    if ids.is_empty() || ids.len() > 50000 || ids.iter().any(|id| !valid.contains(id)) {
        return Err("INVALID_DUBBING_LANES".into());
    }
    if current(p).is_none() {
        next.format_version = next.format_version.max(32);
        next.dubbing_lanes = Some(State {
            source_path: p.media.as_ref().ok_or("MEDIA_MISSING")?.path.clone(),
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
    if let Some(lane) = destination {
        if !state.lanes.iter().any(|l| l.id == lane) {
            return Err("INVALID_DUBBING_LANES".into());
        }
        for id in line_ids {
            if lane == MAIN {
                state.assignments.remove(id);
            } else {
                state.assignments.insert(id.clone(), lane.into());
            }
        }
        if let Some(r) = &mut state.by_character {
            for id in line_ids {
                if !r.manual_line_ids.contains(id) {
                    r.manual_line_ids.push(id.clone());
                }
            }
        }
    } else {
        let r = state
            .by_character
            .as_mut()
            .filter(|r| r.enabled)
            .ok_or("INVALID_DUBBING_LANES")?;
        r.manual_line_ids.retain(|id| !ids.contains(id.as_str()));
    }
    normalize(&mut next)?;
    next.validate()?;
    Ok(next)
}
