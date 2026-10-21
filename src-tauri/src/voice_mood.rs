use std::sync::OnceLock;

fn catalog() -> &'static serde_json::Value {
    static CATALOG: OnceLock<serde_json::Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../workers/voice-moods.json"))
            .expect("bundled mood catalog")
    })
}
pub(crate) fn spec(id: Option<&str>) -> Option<&'static serde_json::Value> {
    catalog()["moods"].get(id.unwrap_or("default"))
}
pub(crate) fn format_version(id: Option<&str>) -> u32 {
    spec(id)
        .and_then(|value| value["minProjectVersion"].as_u64())
        .unwrap_or(15) as u32
}
pub(crate) fn fish_instruction(id: &str) -> Option<&'static str> {
    spec(Some(id))
        .and_then(|value| value["fishInstruction"].as_str())
        .filter(|s| !s.is_empty())
}
