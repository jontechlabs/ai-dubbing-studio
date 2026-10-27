//! Bound Qwen's codec-frame loop without accepting a truncated runaway as a take.
use serde_json::{json, Value};
pub(crate) fn is_qwen(input: &Value) -> bool {
    input["variantId"]
        .as_str()
        .is_some_and(|id| id.starts_with("qwen3-"))
}
pub(crate) fn max_tokens(input: &Value) -> u64 {
    if !is_qwen(input) {
        return 2048;
    }
    let text = input["text"].as_str().unwrap_or("");
    let characters = text.chars().filter(|c| !c.is_whitespace()).count() as f64;
    let slot = input["slotMs"].as_u64().unwrap_or(0) as f64 / 1000.;
    // Generous dialogue/text allowance. The global 120 s output limit also
    // applies after slowing down with atempo. Qwen's codec uses 1920/24000 s.
    let seconds = (8. + characters / 4.).max(slot * 2.).clamp(15., 120.);
    let speed = input["speed"].as_f64().unwrap_or(1.).clamp(0.5, 2.);
    ((seconds * speed / 0.08).floor() as u64).clamp(8, 1500)
}
pub(crate) fn validate_duration(input: &Value, duration_ms: u64) -> Result<(), String> {
    if duration_ms == 0 {
        return Err("TTS_EMPTY_AUDIO".into());
    }
    if duration_ms > 120000 {
        return Err("TTS_OUTPUT_TOO_LONG".into());
    }
    if is_qwen(input) {
        let speed = input["speed"].as_f64().unwrap_or(1.).clamp(0.5, 2.);
        let near_limit = (max_tokens(input).saturating_sub(3) * 80) as f64 / speed;
        if duration_ms as f64 >= near_limit {
            return Err("TTS_GENERATION_LIMIT".into());
        }
    }
    Ok(())
}
pub(crate) fn retryable(error: &str) -> bool {
    [
        "TTS_EMPTY_AUDIO",
        "TTS_OUTPUT_TOO_LONG",
        "TTS_GENERATION_LIMIT",
    ]
    .contains(&error)
}
pub(crate) fn retry_input(input: &Value, device: &str) -> Value {
    let mut next = input.clone();
    // Japanese ICL can leak content or fail to stop; x-vector conditioning
    // keeps the reference timbre while removing its transcript/code prompt.
    let requested = input["mode"].as_str().unwrap_or("crossLingual");
    let original_seed = input["seed"].as_u64().unwrap_or(0) as u32;
    let seed = if requested == "zeroShot" {
        original_seed
    } else {
        original_seed.wrapping_add(1)
    };
    next["mode"] = "crossLingual".into();
    next["device"] = device.into();
    next["seed"] = seed.into();
    next["qwenRecovery"] = json!({"attempt":1,"requestedMode":requested,"effectiveMode":"crossLingual","requestedSeed":original_seed,"effectiveSeed":seed,"device":device});
    next
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"variantId":"qwen3-17b-gguf-q8","text":"Une explosion ?! Lu !","slotMs":2419,"speed":1,"mode":"zeroShot","device":"vulkan:1","seed":0,"referenceAudio":"reference.wav","referenceTranscript":"爆発？ ルー！"})
    }
    #[test]
    fn short_dialogue_has_a_generous_finite_frame_budget_and_runaway_is_never_accepted() {
        let p = input();
        let tokens = max_tokens(&p);
        assert!((180..=200).contains(&tokens));
        validate_duration(&p, 2155).unwrap();
        assert_eq!(
            validate_duration(&p, (tokens - 1) * 80).unwrap_err(),
            "TTS_GENERATION_LIMIT"
        );
        assert_eq!(
            validate_duration(&p, 163760).unwrap_err(),
            "TTS_OUTPUT_TOO_LONG"
        );
        assert_eq!(validate_duration(&p, 0).unwrap_err(), "TTS_EMPTY_AUDIO");
        for speed in [0.5, 1., 2.] {
            let mut p = input();
            p["speed"] = speed.into();
            p["text"] = "Longue phrase. ".repeat(1000).into();
            let duration = (max_tokens(&p) - 1) as f64 * 80. / speed;
            assert!(duration <= 120000.);
        }
    }
    #[test]
    fn recovery_stays_on_selected_device_keeps_inputs_and_records_changed_conditioning() {
        let p = input();
        let retry = retry_input(&p, "vulkan:1");
        assert_eq!(retry["device"], p["device"]);
        assert_eq!(retry["mode"], "crossLingual");
        for name in ["text", "referenceAudio", "referenceTranscript", "speed"] {
            assert_eq!(retry[name], p[name]);
        }
        assert_eq!(retry["qwenRecovery"]["requestedMode"], "zeroShot");
        assert_eq!(retry["qwenRecovery"]["effectiveSeed"], 0);
        let retry2 = retry_input(&retry, "vulkan:1");
        assert_eq!(retry2["seed"], 1);
        assert!(!retryable("CANCELLED"));
        assert!(!retryable("MODEL_CHECKSUM_FAILED"));
        let fish = json!({"variantId":"fish-s2-gguf-q8"});
        assert_eq!(max_tokens(&fish), 2048);
        validate_duration(&fish, 119999).unwrap();
    }
}
