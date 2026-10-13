use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path};
use uuid::Uuid;

pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStream {
    pub index: u32,
    pub kind: String,
    pub codec: String,
    pub language: String,
    pub title: String,
    pub channels: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bitmap: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub original_name: String,
    pub duration_ms: u64,
    pub streams: Vec<MediaStream>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub path: String,
    pub preview_path: Option<String>,
    pub audio_stream_index: Option<u32>,
    #[serde(flatten)]
    pub info: MediaInfo,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dialogue {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source_cue_ids: Vec<String>,
    pub target_cue_ids: Vec<String>,
    pub tts_text: Option<String>,
    pub character_id: Option<String>,
    pub status: String,
    pub warnings: Vec<String>,
    pub selected_generation_ids: HashMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: String,
    pub language: String,
    pub mute: bool,
    pub solo: bool,
    pub gain: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Languages {
    pub source: String,
    pub target: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub format_version: u32,
    pub app_version: String,
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub languages: Languages,
    pub media: Option<MediaAsset>,
    pub source_cues: Vec<Cue>,
    pub target_cues: Vec<Cue>,
    pub dialogues: Vec<Dialogue>,
    pub tracks: Vec<Track>,
    pub characters: Vec<serde_json::Value>,
    pub generations: Vec<serde_json::Value>,
    pub pronunciation: HashMap<String, String>,
}
impl Project {
    pub fn new(name: String, source: String, target: String) -> Self {
        Self {
            format_version: 1,
            app_version: env!("CARGO_PKG_VERSION").into(),
            id: id(),
            name,
            revision: 0,
            created_at: now(),
            updated_at: now(),
            languages: Languages { source, target },
            media: None,
            source_cues: vec![],
            target_cues: vec![],
            dialogues: vec![],
            tracks: vec![],
            characters: vec![],
            generations: vec![],
            pronunciation: HashMap::new(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if ![1, 2].contains(&self.format_version) {
            return Err("UNSUPPORTED_PROJECT_VERSION".into());
        }
        if self.id.is_empty() || self.name.trim().is_empty() {
            return Err("INVALID_PROJECT".into());
        }
        let valid_cues = |cues: &[Cue]| {
            let mut ids = std::collections::HashSet::new();
            cues.iter().all(|c| {
                !c.id.is_empty()
                    && c.end_ms > c.start_ms
                    && c.end_ms <= 9_007_199_254_740_991
                    && ids.insert(&c.id)
            })
        };
        if !valid_cues(&self.source_cues) || !valid_cues(&self.target_cues) {
            return Err("INVALID_CUE_RANGE".into());
        }
        let mut ids = std::collections::HashSet::new();
        for d in &self.dialogues {
            if d.end_ms <= d.start_ms
                || !ids.insert(&d.id)
                || d.source_cue_ids
                    .iter()
                    .any(|id| !self.source_cues.iter().any(|c| &c.id == id))
                || d.target_cue_ids
                    .iter()
                    .any(|id| !self.target_cues.iter().any(|c| &c.id == id))
                || !["ungenerated", "generated", "review", "validated", "error"]
                    .contains(&d.status.as_str())
            {
                return Err("INVALID_PROJECT".into());
            }
        }
        if let Some(media) = &self.media {
            valid_relative(&media.path)?;
            if let Some(path) = &media.preview_path {
                valid_relative(path)?;
            }
        }
        if self
            .tracks
            .iter()
            .any(|t| !t.gain.is_finite() || !(0.0..=2.0).contains(&t.gain))
        {
            return Err("INVALID_PROJECT".into());
        }
        for track in &self.tracks {
            if let Some(path) = &track.path {
                valid_relative(path)?;
            }
            if track.kind == "audio"
                && (track.path.is_none()
                    || track
                        .role
                        .as_deref()
                        .is_none_or(|role| !["speech", "music", "sfx"].contains(&role))
                    || track.duration_ms.is_none_or(|duration| duration == 0))
            {
                return Err("INVALID_PROJECT".into());
            }
        }
        Ok(())
    }
}
pub fn valid_relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains(':')
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("INVALID_PATH".into());
    }
    Ok(())
}
pub fn io_error(error: impl std::fmt::Display) -> String {
    format!("IO_ERROR: {error}")
}
