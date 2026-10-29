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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_from_dubbing: Option<bool>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_settings: Option<crate::tts::Options>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRegion {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub gain: f64,
    pub mute: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub id: String,
    pub kind: String,
    pub language: String,
    pub mute: bool,
    pub solo: bool,
    pub gain: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<AudioRegion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regions_enabled: Option<bool>,
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
pub struct VoiceReference {
    pub id: String,
    pub label: String,
    pub path: String,
    pub duration_ms: u64,
    pub transcript: String,
    pub source_dialogue_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub name: String,
    pub color: String,
    pub references: Vec<VoiceReference>,
    pub default_reference_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerLine {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerAssignment {
    pub dialogue_id: String,
    pub speaker: Option<u32>,
    pub similarity: Option<f64>,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerCluster {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait: Option<crate::character_review::Portrait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocal_register: Option<crate::character_review::VocalRegister>,
    pub speaker: u32,
    pub reference_path: String,
    pub duration_ms: u64,
    pub reference_dialogue_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerAnalysis {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<crate::character_review::Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_snapshot: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_assignments: Option<HashMap<String, Option<String>>>,
    pub id: String,
    pub source_path: String,
    pub lines: Vec<SpeakerLine>,
    pub assignments: Vec<SpeakerAssignment>,
    pub clusters: Vec<SpeakerCluster>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub character_profiles: HashMap<String, crate::character_review::Profile>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub voice_edits: HashMap<String, crate::voice_edit::Edit>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub translation_approvals: HashMap<String, TranslationApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dubbing_timing: Option<DubbingTiming>,
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
    pub characters: Vec<Character>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub voice_references: Vec<VoiceReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_analysis: Option<SpeakerAnalysis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_preferences: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle_display: Option<String>,
    pub generations: Vec<serde_json::Value>,
    pub pronunciation: HashMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DubbingTiming {
    pub source_path: String,
    pub offsets_ms: HashMap<String, HashMap<String, i64>>,
    #[serde(default)]
    pub durations_ms: HashMap<String, HashMap<String, u64>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationApproval {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joint: Option<serde_json::Value>,
    pub source_language: String,
    pub target_language: String,
    pub source_text: String,
    pub target_text: String,
}
impl Project {
    pub fn clean_translation_approvals(&mut self) {
        crate::joint_review::clean(self);
    }

    pub fn new(name: String, source: String, target: String) -> Self {
        Self {
            character_profiles: HashMap::new(),
            voice_edits: HashMap::new(),
            translation_approvals: HashMap::new(),
            dubbing_timing: None,
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
            voice_references: vec![],
            speaker_analysis: None,
            model_preferences: None,
            subtitle_display: None,
            generations: vec![],
            pronunciation: HashMap::new(),
        }
    }
    pub fn voice_reference(&self, owner: Option<&str>, id: &str) -> Option<&VoiceReference> {
        let references = match owner {
            Some(owner) => &self.characters.iter().find(|c| c.id == owner)?.references,
            None => &self.voice_references,
        };
        references.iter().find(|r| r.id == id)
    }
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=24).contains(&self.format_version) {
            return Err("UNSUPPORTED_PROJECT_VERSION".into());
        }
        if !self.translation_approvals.is_empty()
            && (self.format_version < 10
                || self.translation_approvals.iter().any(|(id, a)| {
                    !self.dialogues.iter().any(|l| &l.id == id)
                        || a.source_language.is_empty()
                        || a.target_language.is_empty()
                        || a.target_text.trim().is_empty()
                        || a.joint.as_ref().is_some_and(|v| {
                            self.format_version < 24
                                || !v.is_object()
                                || v.to_string().len() > 512_000
                        })
                }))
        {
            return Err("INVALID_PROJECT".into());
        }
        if let Some(timing) = &self.dubbing_timing {
            if timing
                .durations_ms
                .values()
                .flat_map(|v| v.values())
                .any(|duration| !(1..=120000).contains(duration))
            {
                return Err("INVALID_PROJECT".into());
            }
            if self.format_version < 7
                || timing
                    .offsets_ms
                    .values()
                    .flat_map(|v| v.values())
                    .any(|offset| offset.unsigned_abs() > 86_400_000)
            {
                return Err("INVALID_PROJECT".into());
            }
            valid_relative(&timing.source_path)?;
        }
        if self.id.is_empty() || self.name.trim().is_empty() {
            return Err("INVALID_PROJECT".into());
        }
        if self
            .subtitle_display
            .as_deref()
            .is_some_and(|mode| !["off", "source", "target", "both"].contains(&mode))
        {
            return Err("INVALID_PROJECT".into());
        }
        let mut reference_ids = std::collections::HashSet::new();
        for reference in &self.voice_references {
            valid_relative(&reference.path)?;
            if self.format_version < 9
                || !reference.path.starts_with("characters/")
                || reference.id.is_empty()
                || !reference_ids.insert(&reference.id)
                || !(1000..=20000).contains(&reference.duration_ms)
            {
                return Err("INVALID_REFERENCE_AUDIO".into());
            }
        }
        if let Some(preferences) = &self.model_preferences {
            if self.format_version < 16
                && preferences["ttsProviderId"]
                    .as_str()
                    .is_some_and(|id| ["voxcpm2", "chatterbox"].contains(&id))
            {
                return Err("UNSUPPORTED_PROJECT_VERSION".into());
            }
            if !preferences["voiceVariantId"].is_null() {
                let valid = match preferences["ttsProviderId"].as_str() {
                    Some("cosyvoice3") => ["cosy3-official", "cosy3-gguf-q4"]
                        .contains(&preferences["voiceVariantId"].as_str().unwrap_or("")),
                    Some("fish-s2") => [
                        "fish-s2-fp8",
                        "fish-s2-gguf-q8",
                        "fish-s2-gguf-q6",
                        "fish-s2-gguf-q4",
                        "fish-s2-bf16",
                    ]
                    .contains(&preferences["voiceVariantId"].as_str().unwrap_or("")),
                    Some("fish-drama3") => ["drama3-comfy-fp8"]
                        .contains(&preferences["voiceVariantId"].as_str().unwrap_or("")),
                    Some("voxcpm2") => preferences["voiceVariantId"] == "voxcpm2-bf16",
                    Some("chatterbox") => {
                        preferences["voiceVariantId"] == "chatterbox-multilingual-v3"
                    }
                    Some("qwen3-tts") => [
                        "qwen3-06b-bf16",
                        "qwen3-17b-bf16",
                        "qwen3-17b-gguf-q5",
                        "qwen3-06b-gguf-q8",
                        "qwen3-17b-gguf-q8",
                    ]
                    .contains(&preferences["voiceVariantId"].as_str().unwrap_or("")),
                    _ => false,
                };
                if !valid {
                    return Err("INVALID_PROJECT".into());
                }
            }
            if !preferences["ttsProviderId"].is_null()
                && !preferences["ttsProviderId"].as_str().is_some_and(|id| {
                    [
                        "cosyvoice3",
                        "fish-s2",
                        "fish-drama3",
                        "qwen3-tts",
                        "voxcpm2",
                        "chatterbox",
                    ]
                    .contains(&id)
                })
            {
                return Err("INVALID_PROJECT".into());
            }
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
            if d.excluded_from_dubbing.is_some() && self.format_version < 24 {
                return Err("INVALID_PROJECT".into());
            }
            if let Some(settings) = &d.voice_settings {
                if self.format_version < 5 {
                    return Err("INVALID_TTS_REQUEST".into());
                }
                settings.validate()?;
            }
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
        if self.tracks.iter().any(|t| {
            !t.gain.is_finite()
                || !(0.0..=4.0).contains(&t.gain)
                || (t.gain > 2.0 && self.format_version < 18)
        }) {
            return Err("INVALID_PROJECT".into());
        }
        for track in &self.tracks {
            if track
                .name
                .as_ref()
                .is_some_and(|n| n.is_empty() || n.chars().count() > 160 || n.contains('\0'))
            {
                return Err("INVALID_PROJECT".into());
            }
            if track.kind == "dubbing"
                && (self.format_version < 6 || track.id != "dubbing" || track.path.is_some())
            {
                return Err("INVALID_PROJECT".into());
            }
            if !track.regions.is_empty() || track.regions_enabled.is_some() {
                let limit = track
                    .duration_ms
                    .or_else(|| self.media.as_ref().map(|media| media.info.duration_ms))
                    .ok_or("INVALID_AUDIO_REGION")?;
                let mut ids = std::collections::HashSet::new();
                let mut previous_end = 0;
                if self.format_version < 4
                    || !["audio", "original", "dubbing"].contains(&track.kind.as_str())
                    || track.regions.len() > 10000
                {
                    return Err("INVALID_AUDIO_REGION".into());
                }
                for region in &track.regions {
                    if region.id.is_empty()
                        || !ids.insert(&region.id)
                        || region.start_ms < previous_end
                        || region.end_ms <= region.start_ms
                        || region.end_ms > limit
                        || !region.gain.is_finite()
                        || !(0.0..=2.0).contains(&region.gain)
                    {
                        return Err("INVALID_AUDIO_REGION".into());
                    }
                    previous_end = region.end_ms;
                }
            }
            if let Some(path) = &track.path {
                valid_relative(path)?;
            }
            if track.kind == "audio"
                && (track.path.is_none()
                    || track
                        .role
                        .as_deref()
                        .is_none_or(|role| !["speech", "music", "sfx"].contains(&role))
                        && !(self.format_version >= 18
                            && self
                                .generations
                                .iter()
                                .any(|g| g["kind"] == "audioEffects" && g["trackId"] == track.id))
                    || track.duration_ms.is_none_or(|duration| duration == 0))
            {
                return Err("INVALID_PROJECT".into());
            }
        }
        let mut characters = std::collections::HashSet::new();
        for character in &self.characters {
            if character.id.is_empty()
                || character.name.trim().is_empty()
                || !characters.insert(&character.id)
                || character.color.len() != 7
                || !character.color.starts_with('#')
                || !character.color[1..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err("INVALID_CHARACTER".into());
            }
            let mut references = std::collections::HashSet::new();
            for reference in &character.references {
                valid_relative(&reference.path)?;
                if !reference.path.starts_with("characters/")
                    || reference.id.is_empty()
                    || !references.insert(&reference.id)
                    || !(500..=20000).contains(&reference.duration_ms)
                {
                    return Err("INVALID_REFERENCE_AUDIO".into());
                }
            }
            if character
                .default_reference_id
                .as_ref()
                .is_some_and(|id| !references.contains(id))
            {
                return Err("INVALID_REFERENCE_AUDIO".into());
            }
        }
        if self.dialogues.iter().any(|line| {
            line.character_id
                .as_ref()
                .is_some_and(|id| !characters.contains(id))
        }) {
            return Err("INVALID_CHARACTER".into());
        }
        if let Some(analysis) = &self.speaker_analysis {
            valid_relative(&analysis.source_path)?;
            for cluster in &analysis.clusters {
                valid_relative(&cluster.reference_path)?;
                if !cluster.reference_path.starts_with("characters/")
                    || !(1000..=20000).contains(&cluster.duration_ms)
                {
                    return Err("INVALID_REFERENCE_AUDIO".into());
                }
            }
        }
        crate::tts::validate_generations(self)?;
        crate::voice_capture::validate(self)?;
        crate::dubbing_pipeline::validate_project(self)?;
        crate::prosody::validate(self)?;
        crate::voice_edit::validate(self)?;
        crate::audio_fx_job::validate_project(self)?;
        crate::inpaint::validate(self)?;
        crate::audio_patch::validate(self)?;
        crate::character_review::validate(self)?;
        crate::voice_library::validate(self)?;
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
