import { expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import { audioTracks, editTrack, effectiveGain } from './audio';
import { cueIndex } from './cueIndex';
import { rebaseProject } from './rebase';
import { editDialogue } from './subtitles';
import { splitDialogue } from './timing';
it('indexes overlapping subtitles without missing a long-running earlier cue', () => {
  const cues = [
    { id: 'long', startMs: 0, endMs: 10000, text: 'A' },
    { id: 'short', startMs: 2000, endMs: 3000, text: 'B' },
    { id: 'later', startMs: 5000, endMs: 6000, text: 'C' },
  ];
  const active = cueIndex(cues);
  expect(active(2500).map((cue) => cue.id)).toEqual(['long', 'short']);
  expect(active(5000).map((cue) => cue.id)).toEqual(['long', 'later']);
  expect(active(10000)).toEqual([]);
  expect(active(-1)).toEqual([]);
});
it('handles a large subtitle list and matches the reference result across seeks', () => {
  const cues = Array.from({ length: 20000 }, (_, i) => ({
    id: String(i),
    startMs: i * 3000,
    endMs: i * 3000 + 2500,
    text: String(i),
  }));
  const active = cueIndex(cues);
  for (const ms of [0, 2999, 3000, 456700, 20000000, 59999000])
    expect(active(ms)).toEqual(cues.filter((cue) => cue.startMs <= ms && cue.endMs > ms));
});
it('combines master gain, mute and solo with explicit track states', () => {
  const p = demoProject();
  let original = audioTracks(p)[0];
  expect(effectiveGain(original, [original], 0.8)).toBe(0.8);
  const changed = editTrack(p, original.id, { gain: 1.5, mute: true });
  original = audioTracks(changed)[0];
  expect(effectiveGain(original, [original], 1)).toBe(0);
  const speech = { ...original, id: 'speech', mute: false, solo: true, gain: 0.5 };
  expect(effectiveGain(speech, [original, speech], 0.8)).toBe(0.4);
  expect(
    effectiveGain({ ...original, mute: false }, [{ ...original, mute: false }, speech], 1),
  ).toBe(0);
});
it('creates a persistent original mixer track for older projects without tracks', () => {
  const p = demoProject();
  p.tracks = [];
  const next = editTrack(p, 'original', { gain: 0.4 });
  expect(next.tracks[0].gain).toBe(0.4);
  expect(next.tracks[0].kind).toBe('original');
  expect(p.tracks).toEqual([]);
});
it('rebases unsaved text and gain on a finished media job without losing new stems', () => {
  const base = demoProject();
  let local = editDialogue(base, base.dialogues[0].id, 'target', 'Dernière frappe');
  local = editTrack(local, 'original', { gain: 0.3 });
  const server = structuredClone(base);
  server.revision++;
  server.formatVersion = 2;
  server.tracks.find((track) => track.kind === 'original')!.mute = true;
  server.tracks.push({
    id: 'speech',
    kind: 'audio',
    role: 'speech',
    path: 'stems/test/speech.wav',
    durationMs: 16000,
    sourcePath: server.media!.path,
    language: 'en',
    mute: false,
    solo: false,
    gain: 1,
  });
  server.generations.push({ kind: 'separation', id: 'test' });
  const next = validateProject(rebaseProject(base, local, server));
  expect(next.targetCues[0].text).toBe('Dernière frappe');
  expect(next.revision).toBe(server.revision);
  expect(next.formatVersion).toBe(2);
  expect(next.tracks.find((track) => track.id === 'original')!.gain).toBe(0.3);
  expect(next.tracks.find((track) => track.id === 'original')!.mute).toBe(true);
  expect(next.tracks.some((track) => track.id === 'speech')).toBe(true);
  expect(next.generations).toEqual(server.generations);
});
it('accepts integer timecodes when splitting at a fractional player timestamp', () => {
  const p = demoProject();
  const divided = splitDialogue(p, p.dialogues[0].id, 2000.456);
  expect(
    divided.sourceCues.every(
      (cue) => Number.isSafeInteger(cue.startMs) && Number.isSafeInteger(cue.endMs),
    ),
  ).toBe(true);
  expect(divided.dialogues[0].endMs).toBe(2000);
});
