import { describe, it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import {
  audioTracks,
  dubbingMix,
  editTrack,
  effectiveGain,
  paintAudioRegion,
  setAllAudio,
} from './audio';
import { dubbingClips, mixReport, moveDubbing, dubbingOffset, resizeDubbing } from './mix';
import { defaultVoiceSettings, spokenText } from './tts';
import { rebaseProject } from './rebase';
import type { Generation, Project } from './types';
function fixture() {
  const p = demoProject();
  p.formatVersion = 5;
  p.generations = p.dialogues.map((line, index): Generation => ({
    kind: 'tts',
    id: `take${index}`,
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: `generations/take${index}.wav`,
    createdAt: new Date().toISOString(),
    sourcePath: p.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: spokenText(p, line),
    language: 'fr',
    characterId: line.characterId,
    durationMs: 2000,
    sampleRate: 24000,
    options: { ...defaultVoiceSettings, referenceMode: 'current' },
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'fixture',
  }));
  p.dialogues.forEach((line, i) => {
    line.selectedGenerationIds.fr = `take${i}`;
  });
  return p;
}
describe('synchronized mix', () => {
  it('stores an exact duration independently of voice onset and keeps the next voice protected', () => {
    const p = fixture(),
      line = p.dialogues[0];
    const short = resizeDubbing(p, line.id, 500),
      clip = dubbingClips(short)[0];
    expect(clip.endMs - clip.startMs).toBe(500);
    expect(clip.exactDuration).toBe(true);
    const long = resizeDubbing(p, line.id, 3000),
      extended = dubbingClips(long)[0];
    expect(extended.endMs).toBeLessThanOrEqual(dubbingClips(long)[1].startMs);
    expect(validateProject(JSON.parse(JSON.stringify(long)))).toEqual(long);
    expect(dubbingClips(resizeDubbing(long, line.id, null))[0].exactDuration).toBe(false);
    expect(() => resizeDubbing(p, line.id, 0)).toThrow('INVALID_PROJECT');
  });
  it('moves only the chosen language voice, preserves subtitles and takes, and roundtrips safely', () => {
    const p = fixture(),
      before = JSON.stringify([p.sourceCues, p.targetCues, p.dialogues, p.generations]);
    const moved = moveDubbing(p, p.dialogues[0].id, 250);
    expect(dubbingClips(moved)[0].startMs).toBe(1000);
    expect(dubbingClips(moved)[0].cacheKey).not.toBe(dubbingClips(p)[0].cacheKey);
    expect(
      JSON.stringify([moved.sourceCues, moved.targetCues, moved.dialogues, moved.generations]),
    ).toBe(before);
    expect(validateProject(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
    expect(() => validateProject({ ...moved, formatVersion: 6 })).toThrow('INVALID_PROJECT');
    expect(dubbingOffset(moveDubbing(moved, p.dialogues[0].id, -9999), p.dialogues[0].id)).toBe(
      -750,
    );
    expect(dubbingOffset(moveDubbing(moved, p.dialogues[0].id, 0), p.dialogues[0].id)).toBe(0);
    const incoming = structuredClone(p);
    incoming.revision++;
    expect(dubbingOffset(rebaseProject(p, moved, incoming), p.dialogues[0].id)).toBe(250);
    moved.languages.target = 'en';
    expect(dubbingOffset(moved, p.dialogues[0].id)).toBe(0);
    moved.languages.target = 'fr';
    moved.media!.path = 'media/replaced.mkv';
    expect(dubbingOffset(moved, p.dialogues[0].id)).toBe(0);
  });
  it('reorders moved voices and fits them to the next actual onset', () => {
    const p = fixture(),
      id = p.dialogues[0].id;
    const moved = moveDubbing(p, id, 3600),
      clips = dubbingClips(moved),
      clip = clips.find((c) => c.line.id === id)!;
    expect(clip.startMs).toBe(4350);
    expect(clip.slotMs).toBeLessThanOrEqual(p.dialogues[0].endMs - p.dialogues[0].startMs);
    expect(clips.every((c, i) => i === 0 || clips[i - 1].endMs <= c.startMs)).toBe(true);
    const invalid = structuredClone(moved);
    invalid.dubbingTiming!.offsetsMs[id].fr = NaN;
    expect(() => validateProject(invalid)).toThrow('INVALID_PROJECT');
  });
  it('fits long takes to their current slot and next selected start without stretching short takes', () => {
    const p = fixture();
    p.dialogues[0].endMs = 4500;
    p.dialogues[1].startMs = 1750;
    const before = JSON.stringify(p.generations);
    const clips = dubbingClips(p);
    expect(clips[0].slotMs).toBe(1000);
    expect(clips[0].endMs).toBe(1750);
    expect(clips[0].cacheKey).toContain(':1000');
    expect(mixReport(p).adjusted).toBeGreaterThan(0);
    expect(mixReport(p).fast).toBeGreaterThan(0);
    (p.generations[0] as Generation).durationMs = 400;
    expect(dubbingClips(p)[0].endMs).toBe(1150);
    expect(JSON.stringify(p.generations).replace('"durationMs":400', '"durationMs":2000')).toBe(
      before,
    );
    p.dialogues[1].startMs = p.dialogues[0].startMs;
    expect(mixReport(p).conflicts).toBe(2);
    expect(
      dubbingClips(p)
        .slice(0, 2)
        .every((c) => c.endMs === c.startMs),
    ).toBe(true);
  });
  it('uses only the selected language/source takes and places them at current dialogue starts', () => {
    const p = fixture();
    const old = JSON.stringify(p.generations);
    p.dialogues[0].startMs += 250;
    expect(dubbingClips(p)[0].startMs).toBe(1000);
    expect(mixReport(p).stale).toBe(1);
    (p.generations[1] as Generation).sourcePath = 'old/movie.mkv';
    delete p.dialogues[2].selectedGenerationIds.fr;
    expect(mixReport(p).clips).toHaveLength(2);
    expect(mixReport(p).missing).toBe(2);
    expect(old).not.toBe(JSON.stringify(p.generations));
    expect((p.generations[0] as Generation).startMs).toBe(750);
  });
  it('persists a dedicated bus with independent regions, gain, solo and all-audio controls', () => {
    const p = fixture();
    let mix = dubbingMix(p);
    expect(mix.formatVersion).toBe(6);
    mix = paintAudioRegion(mix, 'dubbing', { startMs: 1000, endMs: 1500, gain: 1, mute: true });
    let tracks = audioTracks(mix),
      dub = tracks.find((t) => t.kind === 'dubbing')!;
    expect(effectiveGain(dub, tracks, 1, 1200)).toBe(0);
    expect(effectiveGain(dub, tracks, 1, 1600)).toBe(1);
    expect(tracks[0].mute).toBe(true);
    expect(validateProject(JSON.parse(JSON.stringify(mix)))).toEqual(mix);
    const muted = setAllAudio(p, false);
    expect(audioTracks(muted).every((t) => effectiveGain(t, audioTracks(muted), 1) === 0)).toBe(
      true,
    );
    const audible = setAllAudio(mix, true);
    expect(
      audioTracks(audible).every((t) => effectiveGain(t, audioTracks(audible), 1, 1200) > 0),
    ).toBe(true);
    mix = editTrack(mix, 'original', { mute: false, solo: true });
    tracks = audioTracks(mix);
    dub = tracks.find((t) => t.kind === 'dubbing')!;
    expect(effectiveGain(dub, tracks, 1)).toBe(0);
    expect(p.formatVersion).toBe(5);
    expect(p.tracks.some((t) => t.kind === 'dubbing')).toBe(false);
  });
  it('keeps a newly materialized bus and its last gain edits when an asynchronous result arrives', () => {
    const before = fixture(),
      local = editTrack(dubbingMix(before), 'dubbing', { gain: 0.6 });
    const incoming: Project = { ...structuredClone(before), revision: before.revision + 1 };
    const merged = rebaseProject(before, local, incoming);
    expect(merged.tracks.find((t) => t.kind === 'dubbing')?.gain).toBe(0.6);
    expect(merged.formatVersion).toBe(6);
    const invalid = { ...local, formatVersion: 5 };
    expect(() => validateProject(invalid)).toThrow('INVALID_PROJECT');
  });
});
