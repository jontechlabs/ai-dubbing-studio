//! Independent, cue-free child dialogues. Original SRTs and takes remain intact.
use crate::domain::{Dialogue, Project};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Voice {
    pub line_id: String,
    pub output_id: String,
    pub label: String,
    pub audio_path: String,
    pub source_text: String,
    pub translations: HashMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub parent_id: String,
    pub separation_id: String,
    pub model_id: String,
    pub source_path: String,
    pub source_track_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub created_at: String,
    pub active: bool,
    pub voices: Vec<Voice>,
}
pub fn voice<'a>(p: &'a Project, line: &str) -> Option<(&'a Group, &'a Voice)> {
    p.speaker_dubbings
        .iter()
        .find_map(|g| g.voices.iter().find(|v| v.line_id == line).map(|v| (g, v)))
}
pub fn text(p: &Project, line: &Dialogue, source: bool) -> String {
    if let Some((_, v)) = voice(p, &line.id) {
        return if source {
            v.source_text.clone()
        } else {
            v.translations
                .get(&p.languages.target)
                .cloned()
                .unwrap_or_default()
        };
    }
    let (cues, ids) = if source {
        (&p.source_cues, &line.source_cue_ids)
    } else {
        (&p.target_cues, &line.target_cue_ids)
    };
    ids.iter()
        .filter_map(|id| cues.iter().find(|c| &c.id == id).map(|c| c.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn retain_after_alignment(previous: &Project, next: &mut Project) {
    let retained: HashSet<_> = previous
        .speaker_dubbings
        .iter()
        .flat_map(|g| {
            std::iter::once(g.parent_id.as_str()).chain(g.voices.iter().map(|v| v.line_id.as_str()))
        })
        .collect();
    for old in &previous.dialogues {
        if retained.contains(old.id.as_str()) && !next.dialogues.iter().any(|l| l.id == old.id) {
            let mut l = old.clone();
            l.source_cue_ids
                .retain(|id| next.source_cues.iter().any(|c| &c.id == id));
            l.target_cue_ids
                .retain(|id| next.target_cues.iter().any(|c| &c.id == id));
            next.dialogues.push(l);
        }
    }
}
pub fn validate(p: &Project) -> Result<(), String> {
    if p.speaker_dubbings.is_empty() {
        return Ok(());
    }
    let fail = || "SPEAKER_SEPARATION_OPTIONS".to_owned();
    if p.format_version < 25 || p.speaker_dubbings.len() > 4096 {
        return Err(fail());
    }
    let lines: HashMap<_, _> = p.dialogues.iter().map(|l| (l.id.as_str(), l)).collect();
    let parents: HashSet<_> = p
        .speaker_dubbings
        .iter()
        .map(|g| g.parent_id.as_str())
        .collect();
    let mut ids = HashSet::new();
    let mut children = HashSet::new();
    let mut active = HashSet::new();
    let string = |s: &str, max: usize| s.chars().count() <= max && !s.contains('\0');
    for g in &p.speaker_dubbings {
        if !lines.contains_key(g.parent_id.as_str())
            || g.id.is_empty()
            || !ids.insert(&g.id)
            || !string(&g.id, 128)
            || !string(&g.separation_id, 128)
            || !string(&g.source_path, 4096)
            || !string(&g.source_track_id, 128)
            || !string(&g.created_at, 100)
            || !["mossformer2-16k", "sepformer-2mix", "sepformer-3mix"]
                .contains(&g.model_id.as_str())
            || g.end_ms <= g.start_ms
            || !(100..=60000).contains(&(g.end_ms - g.start_ms))
            || g.voices.is_empty()
            || g.voices.len() > 3
            || (g.active && !active.insert(&g.parent_id))
        {
            return Err(fail());
        }
        let mut outputs = HashSet::new();
        for v in &g.voices {
            let l = lines.get(v.line_id.as_str()).ok_or_else(fail)?;
            let asset = v
                .audio_path
                .strip_prefix("stems/isolated-")
                .and_then(|s| s.strip_suffix(".wav"));
            if parents.contains(v.line_id.as_str())
                || !children.insert(&v.line_id)
                || !outputs.insert(&v.output_id)
                || !["voice-1", "voice-2", "voice-3"].contains(&v.output_id.as_str())
                || asset.is_none_or(|s| uuid::Uuid::parse_str(s).is_err())
                || !l.source_cue_ids.is_empty()
                || !l.target_cue_ids.is_empty()
                || l.start_ms < g.start_ms
                || l.end_ms > g.end_ms
                || !string(&v.label, 200)
                || !string(&v.source_text, 20000)
                || v.translations.len() > 100
                || v.translations.iter().any(|(k, s)| {
                    !(2..=16).contains(&k.len())
                        || !k.bytes().all(|c| c.is_ascii_alphabetic() || c == b'-')
                        || !string(s, 20000)
                })
            {
                return Err(fail());
            }
        }
    }
    Ok(())
}
pub struct State<'a> {
    pub children: HashMap<&'a str, &'a Group>,
    active_parents: HashSet<&'a str>,
    excluded: HashSet<&'a str>,
    source: Option<&'a str>,
}
impl<'a> State<'a> {
    pub fn new(p: &'a Project) -> Self {
        Self {
            children: p
                .speaker_dubbings
                .iter()
                .flat_map(|g| g.voices.iter().map(move |v| (v.line_id.as_str(), g)))
                .collect(),
            active_parents: p
                .speaker_dubbings
                .iter()
                .filter(|g| g.active && p.media.as_ref().is_some_and(|m| m.path == g.source_path))
                .map(|g| g.parent_id.as_str())
                .collect(),
            excluded: p
                .dialogues
                .iter()
                .filter(|l| l.excluded_from_dubbing == Some(true))
                .map(|l| l.id.as_str())
                .collect(),
            source: p.media.as_ref().map(|m| m.path.as_str()),
        }
    }
    pub fn enabled(&self, id: &str) -> bool {
        !self.excluded.contains(id)
            && !self.active_parents.contains(id)
            && self.children.get(id).is_none_or(|g| {
                g.active
                    && self.source == Some(g.source_path.as_str())
                    && !self.excluded.contains(g.parent_id.as_str())
            })
    }
    pub fn key<'b>(&'b self, id: &'b str) -> &'b str {
        self.children.get(id).map_or(id, |g| g.id.as_str())
    }
}
/// The same primitive backs cloning, prosody, ASR and source preview.
#[allow(clippy::too_many_arguments)]
pub async fn snippet<R: tauri::Runtime>(
    core: &std::sync::Arc<crate::Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    p: &Project,
    root: &std::path::Path,
    line_id: &str,
    mut spec: crate::audio_patch::Snippet<'_>,
    output: &std::path::Path,
    flag: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    if let Some((g, v)) = voice(p, line_id) {
        if p.media.as_ref().is_none_or(|m| m.path != g.source_path)
            || spec.start_ms < g.start_ms
            || spec.end_ms > g.end_ms
        {
            return Err("STALE_REVISION".into());
        }
        crate::project::asset(root, &v.audio_path)?;
        let mut temporary = p.clone();
        let track = crate::domain::Track {
            id: "isolated-source".into(),
            name: None,
            kind: "audio".into(),
            language: p.languages.source.clone(),
            mute: false,
            solo: false,
            gain: 1.0,
            regions: vec![],
            regions_enabled: None,
            role: Some("speech".into()),
            path: Some(v.audio_path.clone()),
            duration_ms: Some(g.end_ms - g.start_ms),
            source_path: Some(g.source_path.clone()),
            generation_id: None,
        };
        temporary.tracks.push(track);
        spec.track_id = "isolated-source";
        spec.start_ms -= g.start_ms;
        spec.end_ms -= g.start_ms;
        crate::audio_patch::snippet(core, app, key, &temporary, root, spec, output, flag).await
    } else {
        crate::audio_patch::snippet(core, app, key, p, root, spec, output, flag).await
    }
}
