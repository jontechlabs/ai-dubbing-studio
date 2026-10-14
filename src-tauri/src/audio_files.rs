use crate::domain::io_error;
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
};
pub fn wav_frames(path: &Path) -> Result<u64, String> {
    pcm_frames(path, 2, 48000, "SEPARATION_FAILED")
}
pub fn reference_duration(path: &Path) -> Result<u64, String> {
    let frames = pcm_frames(path, 1, 24000, "INVALID_REFERENCE_AUDIO")?;
    let duration = frames * 1000 / 24000;
    if !(500..=20000).contains(&duration) {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    Ok(duration)
}
fn pcm_frames(path: &Path, channels: u16, sample_rate: u32, error: &str) -> Result<u64, String> {
    let mut file = std::fs::File::open(path).map_err(io_error)?;
    let length = file.metadata().map_err(io_error)?.len();
    let mut header = [0_u8; 12];
    file.read_exact(&mut header).map_err(io_error)?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err(error.into());
    }
    let mut valid = false;
    loop {
        let mut chunk = [0_u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            break;
        }
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
        let start = file.stream_position().map_err(io_error)?;
        if start + size > length {
            return Err(error.into());
        }
        if &chunk[..4] == b"fmt " && size >= 16 {
            let mut format = [0_u8; 16];
            file.read_exact(&mut format).map_err(io_error)?;
            valid = u16::from_le_bytes(format[..2].try_into().unwrap()) == 1
                && u16::from_le_bytes(format[2..4].try_into().unwrap()) == channels
                && u32::from_le_bytes(format[4..8].try_into().unwrap()) == sample_rate
                && u16::from_le_bytes(format[12..14].try_into().unwrap()) == channels * 2
                && u16::from_le_bytes(format[14..16].try_into().unwrap()) == 16;
        }
        if &chunk[..4] == b"data" {
            if valid && size > 0 && size.is_multiple_of(u64::from(channels) * 2) {
                return Ok(size / (u64::from(channels) * 2));
            }
            return Err(error.into());
        }
        file.seek(SeekFrom::Start(start + size + size % 2))
            .map_err(io_error)?;
    }
    Err(error.into())
}
