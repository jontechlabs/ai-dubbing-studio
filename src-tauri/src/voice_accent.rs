use crate::tts::Options;

fn spec(id: &str) -> Option<serde_json::Value> {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../workers/voice-accents.json")).ok()?;
    catalog["accents"]
        .as_array()?
        .iter()
        .find(|a| a["id"] == id)
        .cloned()
}
pub(crate) fn validate(options: &Options, language: Option<&str>) -> Result<(), String> {
    let id = options.accent.as_deref().unwrap_or("auto");
    if id == "auto" {
        return Ok(());
    }
    let value = spec(id).ok_or("TTS_ACCENT_UNSUPPORTED")?;
    if options.variant().starts_with("qwen3") || language.is_some_and(|l| value["language"] != l) {
        return Err("TTS_ACCENT_UNSUPPORTED".into());
    }
    Ok(())
}
pub(crate) fn fish_prompt(text: &str, options: &Options) -> String {
    let mut tags = vec![];
    if let Some(value) = options.accent.as_deref().and_then(spec) {
        if let Some(instruction) = value["fishInstruction"].as_str() {
            tags.push(format!("[{instruction}]"));
        }
    }
    if let Some(mood) = options.mood.as_deref().filter(|m| *m != "default") {
        if let Some(instruction) = crate::voice_mood::fish_instruction(mood) {
            tags.push(format!("[{instruction}]"));
        }
    }
    if tags.is_empty() {
        text.to_owned()
    } else {
        format!("{} {text}", tags.join(" "))
    }
}
