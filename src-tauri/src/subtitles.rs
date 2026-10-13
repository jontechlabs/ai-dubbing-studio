use crate::domain::{id, Cue, Dialogue};
use std::collections::{HashMap, HashSet};

pub fn parse_time(text: &str) -> Result<u64, String> {
    let normalized = text.replace(',', ".");
    let parts: Vec<_> = normalized.split([':', '.']).collect();
    if parts.len() != 4
        || parts[0].len() < 2
        || parts[1].len() != 2
        || parts[2].len() != 2
        || parts[3].len() != 3
    {
        return Err("INVALID_TIMECODE".into());
    }
    let numbers: Result<Vec<u64>, _> = parts.iter().map(|s| s.parse()).collect();
    let n = numbers.map_err(|_| "INVALID_TIMECODE".to_string())?;
    if n[1] >= 60 || n[2] >= 60 || n[3] >= 1000 {
        return Err("INVALID_TIMECODE".into());
    }
    n[0].checked_mul(3_600_000)
        .and_then(|v| v.checked_add(n[1] * 60_000 + n[2] * 1000 + n[3]))
        .ok_or("INVALID_TIMECODE".into())
}
pub fn format_time(ms: u64) -> String {
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}
pub fn parse_srt(text: &str) -> Result<Vec<Cue>, String> {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut cues = vec![];
    let mut block: Vec<&str> = vec![];
    for line in normalized.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if !block.is_empty() {
                cues.push(parse_block(&block)?);
                block.clear();
            }
        } else {
            block.push(line);
        }
    }
    Ok(cues)
}
fn parse_block(block: &[&str]) -> Result<Cue, String> {
    let timing_index = usize::from(block[0].trim().parse::<u64>().is_ok());
    let timing = block.get(timing_index).ok_or("INVALID_SRT")?;
    let (start, rest) = timing.split_once("-->").ok_or("INVALID_SRT")?;
    let end = rest.split_whitespace().next().ok_or("INVALID_SRT")?;
    let start_ms = parse_time(start.trim())?;
    let end_ms = parse_time(end)?;
    if end_ms <= start_ms {
        return Err("INVALID_CUE_RANGE".into());
    }
    Ok(Cue {
        id: id(),
        start_ms,
        end_ms,
        text: block[timing_index + 1..].join("\n"),
    })
}
pub fn export_srt(cues: &[Cue]) -> String {
    let mut cues = cues.to_vec();
    cues.sort_by_key(|c| c.start_ms);
    cues.iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                format_time(c.start_ms),
                format_time(c.end_ms),
                c.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn near(a: &Cue, b: &Cue) -> bool {
    a.start_ms.abs_diff(b.start_ms) <= 100 && a.end_ms.abs_diff(b.end_ms) <= 100
}
fn dialogue(source: Option<&Cue>, target: Option<&Cue>, uncertain: bool) -> Dialogue {
    let cue = source.or(target).expect("at least one cue");
    Dialogue {
        id: id(),
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        source_cue_ids: source.map(|c| vec![c.id.clone()]).unwrap_or_default(),
        target_cue_ids: target.map(|c| vec![c.id.clone()]).unwrap_or_default(),
        tts_text: None,
        character_id: None,
        status: "ungenerated".into(),
        warnings: if uncertain {
            vec!["alignment".into()]
        } else {
            vec![]
        },
        selected_generation_ids: HashMap::new(),
    }
}
pub fn align(source: &[Cue], target: &[Cue]) -> Vec<Dialogue> {
    let mut used = HashSet::new();
    let mut result = vec![];
    for cue in source {
        let matches: Vec<_> = target.iter().filter(|c| near(cue, c)).collect();
        let candidate = if matches.len() == 1
            && source.iter().filter(|s| near(s, matches[0])).count() == 1
            && !used.contains(&matches[0].id)
        {
            Some(matches[0])
        } else {
            None
        };
        if let Some(c) = candidate {
            used.insert(c.id.clone());
        }
        result.push(dialogue(
            Some(cue),
            candidate,
            !target.is_empty() && candidate.is_none(),
        ));
    }
    for cue in target.iter().filter(|c| !used.contains(&c.id)) {
        result.push(dialogue(None, Some(cue), !source.is_empty()));
    }
    result.sort_by_key(|d| d.start_ms);
    result
}
pub fn reconcile(previous: &[Dialogue], aligned: Vec<Dialogue>) -> Vec<Dialogue> {
    aligned
        .into_iter()
        .map(|mut line| {
            if let Some(old) = previous.iter().find(|d| {
                (!line.source_cue_ids.is_empty() && d.source_cue_ids == line.source_cue_ids)
                    || (!line.target_cue_ids.is_empty() && d.target_cue_ids == line.target_cue_ids)
            }) {
                line.id = old.id.clone();
                line.tts_text = old.tts_text.clone();
                line.character_id = old.character_id.clone();
                line.selected_generation_ids = old.selected_generation_ids.clone();
                line.status = if old.status == "ungenerated" {
                    "ungenerated"
                } else {
                    "review"
                }
                .into();
            }
            line
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_crlf_bom_multiline() {
        let cues =
            parse_srt("\u{feff}1\r\n00:02:08,157 --> 00:02:11,493\r\n殺さないで\r\nください！\r\n")
                .unwrap();
        assert_eq!(cues[0].start_ms, 128157);
        assert_eq!(cues[0].text, "殺さないで\nください！");
        assert!(export_srt(&cues).contains("00:02:08,157"));
    }
    #[test]
    fn rejects_reversed_and_bad_time() {
        assert!(parse_time("00:70:00,000").is_err());
        assert!(parse_srt("1\n00:00:03,000 --> 00:00:01,000\nX").is_err());
    }
    #[test]
    fn ambiguous_matches_remain_separate() {
        let a =
            parse_srt("1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:01,010 --> 00:00:02,010\nB")
                .unwrap();
        let b = parse_srt("1\n00:00:01,000 --> 00:00:02,000\nC").unwrap();
        let matches = align(&a, &b);
        assert_eq!(matches.len(), 3);
        assert!(matches.iter().all(|d| !d.warnings.is_empty()));
    }
    #[test]
    fn aligns_only_unique_time_matches() {
        let a = parse_srt("1\n00:00:01,000 --> 00:00:02,000\nA").unwrap();
        let b = parse_srt("1\n00:00:01,050 --> 00:00:02,010\nB").unwrap();
        assert_eq!(align(&a, &b)[0].target_cue_ids.len(), 1);
    }
}
