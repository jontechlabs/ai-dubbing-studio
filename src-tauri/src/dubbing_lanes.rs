//! Logical dubbing lanes share the final dubbing bus but have independent
//! occupancy, gain/mute/solo and immutable selected takes.
use crate::domain::Project;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
pub const MAIN: &str = "main";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lane {
    pub id: String,
    pub name: String,
    pub mute: bool,
    pub solo: bool,
    pub gain: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
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
        || s.lanes.len() > 32
        || s.lanes[0].id != MAIN
        || s.assignments.len() > 100000
    {
        return Err(invalid());
    }
    crate::domain::valid_relative(&s.source_path).map_err(|_| invalid())?;
    let mut ids = HashSet::new();
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
    }
    if s.assignments
        .iter()
        .any(|(id, l)| id.is_empty() || id.len() > 128 || !ids.contains(l.as_str()))
    {
        return Err(invalid());
    }
    Ok(())
}
