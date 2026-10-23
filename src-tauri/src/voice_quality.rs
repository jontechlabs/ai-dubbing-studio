use serde_json::Value;
use std::sync::OnceLock;
fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../workers/voice-quality.json"))
            .expect("bundled quality catalog")
    })
}
pub(crate) fn validate(variant: &str, value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let values = value.as_object().ok_or("INVALID_TTS_QUALITY")?;
    let params = catalog()["variants"][variant]["parameters"]
        .as_object()
        .ok_or("INVALID_TTS_QUALITY")?;
    for (key, value) in values {
        let bounds = params.get(key).ok_or("INVALID_TTS_QUALITY")?;
        let number = value.as_f64().ok_or("INVALID_TTS_QUALITY")?;
        if !number.is_finite()
            || number < bounds["min"].as_f64().unwrap()
            || number > bounds["max"].as_f64().unwrap()
            || (bounds["step"] == 1 && number.fract() != 0.0)
        {
            return Err("INVALID_TTS_QUALITY".into());
        }
    }
    Ok(())
}
// Only explicitly chosen values override the pinned engine's existing defaults.
pub(crate) fn gguf_options(input: &Value) -> Result<Vec<(&'static str, String)>, String> {
    let variant = input["variantId"].as_str().ok_or("INVALID_TTS_REQUEST")?;
    let quality = input.get("quality").filter(|value| !value.is_null());
    validate(variant, quality)?;
    Ok([
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("topK", "top_k"),
        ("repetitionPenalty", "repetition_penalty"),
    ]
    .into_iter()
    .filter_map(|(key, flag)| {
        quality.and_then(|v| v.get(key)).map(|v| {
            let text = if key == "topK" {
                (v.as_f64().unwrap() as u32).to_string()
            } else {
                v.to_string()
            };
            (flag, text)
        })
    })
    .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn profiles_and_invalid_controls_are_bounded_by_variant() {
        for (id, spec) in catalog()["variants"].as_object().unwrap() {
            for preset in spec["presets"].as_object().unwrap().values() {
                validate(id, Some(preset)).unwrap();
            }
        }
        for invalid in [
            json!({"inferenceSteps":31}),
            json!({"inferenceSteps":4.5}),
            json!({"cfgStrength":true}),
            json!({"cfgStrength":0}),
            json!([]),
            json!({"unknown":1}),
        ] {
            assert!(validate("voxcpm2-bf16", Some(&invalid)).is_err());
        }
        assert!(validate("cosy3-official", Some(&json!({"temperature":0.8}))).is_err());
    }
    #[test]
    fn gguf_uses_real_request_names_and_preserves_omitted_defaults() {
        assert!(gguf_options(&json!({"variantId":"fish-s2-gguf-q8"}))
            .unwrap()
            .is_empty());
        assert_eq!(gguf_options(&json!({"variantId":"qwen3-06b-gguf-q8","quality":{"topP":0.9,"temperature":0.7,"repetitionPenalty":1.1}})).unwrap(),vec![("temperature","0.7".into()),("top_p","0.9".into()),("repetition_penalty","1.1".into())]);
        assert_eq!(
            gguf_options(&json!({"variantId":"fish-s2-gguf-q8","quality":{"topK":30.0}})).unwrap(),
            vec![("top_k", "30".into())]
        );
    }
}
