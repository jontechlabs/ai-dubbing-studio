import { expect, test } from 'vitest';
import { demoProject } from './project';
import { audioTracks, effectiveGain, regionGain } from './audio';
import { audioSelectionProject, validAudioSelection } from './audioAudition';

function fixture() {
  const p = demoProject();
  p.tracks.push({
    id: 'speech',
    kind: 'audio',
    role: 'speech',
    path: 'stems/speech.wav',
    sourcePath: p.media!.path,
    durationMs: 8000,
    language: 'ja',
    mute: true,
    solo: false,
    gain: 0.5,
    regions: [{ id: 'quiet', startMs: 1000, endMs: 3000, gain: 0, mute: true }],
  });
  p.tracks.push({
    id: 'dubbing',
    kind: 'dubbing',
    language: 'fr',
    mute: true,
    solo: false,
    gain: 0.8,
  });
  return p;
}

test('audition validates the selected media, source track and finite integral bounds', () => {
  const p = fixture(),
    s = { mediaId: p.media!.id, trackId: 'speech', startMs: 1000, endMs: 2000 };
  expect(validAudioSelection(p, s)).toBe(true);
  for (const changes of [
    { mediaId: 'other' },
    { trackId: 'video' },
    { trackId: 'missing' },
    { startMs: -1 },
    { startMs: 1.5 },
    { endMs: NaN },
    { endMs: Infinity },
    { endMs: 1000 },
    { endMs: 8001 },
  ]) {
    expect(validAudioSelection(p, { ...s, ...changes })).toBe(false);
    expect(() => audioSelectionProject(p, { ...s, ...changes }, false)).toThrow(
      'INVALID_AUDIO_REGION',
    );
  }
  expect(validAudioSelection(null, s)).toBe(false);
});

test('isolating any source or dubbing track preserves its levels and every saved setting', () => {
  const p = fixture(),
    before = structuredClone(p);
  for (const trackId of ['original', 'speech', 'dubbing']) {
    const isolated = audioSelectionProject(
      p,
      { mediaId: p.media!.id, trackId, startMs: 1000, endMs: 2000 },
      false,
    );
    const tracks = audioTracks(isolated);
    for (const track of tracks) {
      const source = audioTracks(p).find((t) => t.id === track.id)!;
      expect(track.mute).toBe(track.id !== trackId);
      expect(track.solo).toBe(track.id === trackId);
      expect(track.gain).toBe(source.gain);
      expect(track.regions).toBe(source.regions);
      if (track.id !== trackId) expect(effectiveGain(track, tracks, 1)).toBe(0);
    }
    expect(isolated.generations).toBe(p.generations);
    expect(isolated.voiceEdits).toBe(p.voiceEdits);
    expect(isolated.sourceCues).toBe(p.sourceCues);
  }
  expect(p).toEqual(before);
});

test('before-level audition bypasses mute and zero-level regions without changing audio edits', () => {
  const p = fixture(),
    before = structuredClone(p);
  const s = { mediaId: p.media!.id, trackId: 'speech', startMs: 1000, endMs: 2000 };
  const normal = audioTracks(audioSelectionProject(p, s, false));
  expect(
    regionGain(
      normal.find((t) => t.id === 'speech')!,
      1500,
    ),
  ).toBe(0);
  const dry = audioTracks(audioSelectionProject(p, s, true));
  const voice = dry.find((t) => t.id === 'speech')!;
  expect(effectiveGain(voice, dry, 1, 1500)).toBe(1);
  expect(voice.path).toBe('stems/speech.wav');
  expect(p).toEqual(before);
});
