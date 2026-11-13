import type { AudioPatch } from './audioPatch';

export type PlaybackPatch = AudioPatch & { cacheKey: string; offsetMs?: number };
// Keep only the 30-second chunks intersecting the scheduling horizon. Layer
// identity stays unchanged so replacements, automation and undo use the same gate.
export function patchSegments(clips: AudioPatch[], start: number, end: number): PlaybackPatch[] {
  return clips.flatMap((clip) => {
    if (clip.endMs <= start || clip.startMs >= end) return [];
    if (clip.endMs - clip.startMs <= 120000) return [{ ...clip, cacheKey: clip.id }];
    const result: PlaybackPatch[] = [];
    const first = Math.floor(Math.max(0, start - clip.startMs) / 30000);
    const last = Math.floor((Math.min(end, clip.endMs) - clip.startMs - 0.001) / 30000);
    for (let index = first; index <= last; index++) {
      const offsetMs = index * 30000;
      result.push({
        ...clip,
        cacheKey: `${clip.id}:${index}`,
        offsetMs,
        startMs: clip.startMs + offsetMs,
        endMs: Math.min(clip.endMs, clip.startMs + offsetMs + 30000),
      });
    }
    return result;
  });
}
