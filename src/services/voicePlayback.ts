// Auditions use either Web Audio or an HTML audio element. Read their audio
// clock on demand; a UI timer must never be the source of playback position.
export interface VoicePlayback {
  generationId: string;
  positionMs: number;
  durationMs: number;
  original: boolean;
  playing: boolean;
}
let sequence = 0;
let reader: (() => VoicePlayback) | null = null;
let last: VoicePlayback | null = null;
export function readVoicePlayback() {
  return { sequence, playback: reader?.() ?? last };
}
export function beginVoicePlayback(read: () => VoicePlayback) {
  const owned = ++sequence;
  reader = read;
  last = null;
  return () => {
    if (owned !== sequence || !reader) return;
    last = { ...reader(), playing: false };
    reader = null;
  };
}
