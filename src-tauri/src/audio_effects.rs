//! Bounded, allow-listed, local FFmpeg audio processing. No caller-supplied filter text.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};
#[cfg(test)]
#[path = "audio_effects_tests.rs"]
mod tests;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Effect {
    pub kind: String,
    pub enabled: bool,
    pub parameters: BTreeMap<String, f64>,
}
pub fn catalog() -> &'static serde_json::Value {
    static VALUE: OnceLock<serde_json::Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("../../resources/audio-effects.json"))
            .expect("bundled effects catalog")
    })
}
pub fn validate(effects: &[Effect]) -> Result<(), String> {
    if effects.len() > 8 {
        return Err("INVALID_AUDIO_EFFECTS".into());
    }
    for e in effects {
        let spec = catalog()["effects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == e.kind)
            .ok_or("INVALID_AUDIO_EFFECTS")?;
        for (key, value) in &e.parameters {
            let p = spec["parameters"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == *key)
                .ok_or("INVALID_AUDIO_EFFECTS")?;
            if !value.is_finite()
                || !(p["min"].as_f64().unwrap()..=p["max"].as_f64().unwrap()).contains(value)
            {
                return Err("INVALID_AUDIO_EFFECTS".into());
            }
        }
    }
    Ok(())
}
fn parameter(e: &Effect, id: &str) -> f64 {
    e.parameters.get(id).copied().unwrap_or_else(|| {
        catalog()["effects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == e.kind)
            .unwrap()["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap()["default"]
            .as_f64()
            .unwrap()
    })
}
fn db(value: f64) -> f64 {
    10f64.powf(value / 20.0)
}
pub fn filter_chain(effects: &[Effect]) -> Result<String, String> {
    validate(effects)?;
    let mut filters = vec![];
    for e in effects.iter().filter(|e| e.enabled) {
        let p = |name| parameter(e, name);
        let filter = match e.kind.as_str() {
            "equalizer" => format!(
                "bass=g={}:f=120,equalizer=f={}:t=q:w=1:g={},treble=g={}:f=4000",
                p("bass"),
                p("midHz"),
                p("mid"),
                p("treble")
            ),
            "pitch" => format!(
                "rubberband=tempo=1:pitch={:.12}:formant={}:pitchq=quality",
                2f64.powf(p("semitones") / 12.0),
                if p("formants") >= 0.5 {
                    "preserved"
                } else {
                    "shifted"
                }
            ),
            "highpass" => format!("highpass=f={}:p=2", p("frequency")),
            "lowpass" => format!("lowpass=f={}:p=2", p("frequency")),
            "compressor" => format!(
                "acompressor=threshold={:.9}:ratio={}:attack={}:release={}:makeup={:.9}:knee=2.828",
                db(p("threshold")),
                p("ratio"),
                p("attack"),
                p("release"),
                db(p("makeup"))
            ),
            "limiter" => format!(
                "alimiter=limit={:.9}:attack=5:release={}:level=0:latency=1",
                db(p("threshold")),
                p("release")
            ),
            "gate" => format!(
                "agate=threshold={:.9}:ratio={}:attack=5:release=100:range=0.01",
                db(p("threshold")),
                p("ratio")
            ),
            "normalize" => format!("dynaudnorm=f=150:g=15:p=0.9:m={}", p("maximum")),
            "denoise" => format!("afftdn=nr={}:nf=-50:tn=1", p("reduction")),
            "deesser" => format!("deesser=i={}:m=0.5:f=0.5", p("intensity")),
            "echo" => format!("aecho=1:1:{}:{}", p("delay"), p("decay")),
            "reverb" => {
                let delays = [0.13, 0.23, 0.37, 0.53, 0.71, 1.0]
                    .iter()
                    .map(|n| format!("{:.4}", n * p("size")))
                    .collect::<Vec<_>>()
                    .join("|");
                let levels = [0.55, 0.45, 0.36, 0.28, 0.21, 0.15]
                    .iter()
                    .map(|n| format!("{:.6}", n * p("amount")))
                    .collect::<Vec<_>>()
                    .join("|");
                format!("aecho=1:1:{delays}:{levels}")
            }
            "saturation" => format!(
                "volume={:.9},asoftclip=type=atan:threshold=0.8:output=0.9:oversample=2",
                db(p("drive"))
            ),
            "distortion" => format!(
                "volume={:.9},asoftclip=type=tanh:threshold=0.5:output=0.9:oversample=4",
                db(p("drive"))
            ),
            "robot" => format!(
                "aeval=exprs='val(ch)*sin(2*PI*{}*t)':c=same",
                p("frequency")
            ),
            "chorus" => format!(
                "chorus=0.7:0.7:40|60:0.25|0.2:{}|{}:{}|{}",
                p("speed"),
                p("speed") * 1.1,
                p("depth"),
                p("depth") * 0.8
            ),
            "flanger" => format!(
                "flanger=delay=1:depth={}:regen={}:width=65:speed={}",
                p("depth"),
                p("feedback"),
                p("speed")
            ),
            "phaser" => format!(
                "aphaser=in_gain=0.8:out_gain=0.8:delay=3:decay={}:speed={}",
                p("depth"),
                p("speed")
            ),
            "tremolo" => format!("tremolo=f={}:d={}", p("speed"), p("depth")),
            "vibrato" => format!("vibrato=f={}:d={}", p("speed"), p("depth")),
            _ => return Err("INVALID_AUDIO_EFFECTS".into()),
        };
        filters.push(filter);
    }
    Ok(filters.join(","))
}
