import { expect, test } from 'vitest';
import {
  audioTracks,
  editTrack,
  effectiveGain,
  enableAudioRegions,
  gainChanges,
  paintAudioRegion,
  regionGain,
  setAllAudio,
  setAudioRegions,
} from './audio';
import { demoProject, validateProject } from './project';
import { rebaseProject } from './rebase';
import { addCharacter } from './characters';
import { setSubtitleDisplay } from './subtitleDisplay';
const paint = (p = demoProject()) =>
  paintAudioRegion(p, 'original', { startMs: 1000, endMs: 5000, gain: 1, mute: true });
test('overlapping painting preserves outer fragments and half-open boundaries', () => {
  let p = paint();
  p = paintAudioRegion(p, 'original', { startMs: 2000, endMs: 3000, gain: 0.25, mute: false });
  const track = audioTracks(p)[0];
  expect(
    track.regions?.map(({ startMs, endMs, mute, gain }) => [startMs, endMs, mute, gain]),
  ).toEqual([
    [1000, 2000, true, 1],
    [2000, 3000, false, 0.25],
    [3000, 5000, true, 1],
  ]);
  expect([999, 1000, 2000, 2999, 3000, 5000].map((t) => regionGain(track, t))).toEqual([
    1, 0, 0.25, 0.25, 0, 1,
  ]);
  expect(validateProject(JSON.parse(JSON.stringify(p))).formatVersion).toBe(4);
  expect(setSubtitleDisplay(addCharacter(p, 'A'), 'off').formatVersion).toBe(4);
});
test('track, region and master gains multiply while mute and solo retain priority', () => {
  const p = editTrack(
    paintAudioRegion(demoProject(), 'original', {
      startMs: 1000,
      endMs: 2000,
      gain: 0.25,
      mute: false,
    }),
    'original',
    { gain: 0.5 },
  );
  const track = audioTracks(p)[0];
  expect(effectiveGain(track, [track], 0.8, 1500)).toBe(0.1);
  expect(effectiveGain(track, [track], 0.8, 2000)).toBe(0.4);
  expect(effectiveGain({ ...track, mute: true }, [track], 1, 1500)).toBe(0);
  const solo = { ...track, id: 'other', solo: true };
  expect(effectiveGain(track, [track, solo], 1, 1500)).toBe(0);
});
test('quick commands bypass and restore edits without deleting regions or volume settings', () => {
  const p = editTrack(paint(), 'original', { gain: 0.35, solo: true });
  const silent = setAllAudio(p, false);
  expect(audioTracks(silent)[0]).toMatchObject({ mute: true, solo: false, gain: 0.35 });
  const audible = setAllAudio(silent, true);
  const track = audioTracks(audible)[0];
  expect(track).toMatchObject({ mute: false, solo: false, gain: 0.35, regionsEnabled: false });
  expect(track.regions).toEqual(audioTracks(p)[0].regions);
  expect(regionGain(track, 2000)).toBe(1);
  expect(regionGain(audioTracks(enableAudioRegions(audible))[0], 2000)).toBe(0);
});
test('invalid ranges, overlaps and legacy schema cannot discard region edits', () => {
  const p = paint(),
    region = audioTracks(p)[0].regions![0];
  const empty = structuredClone(p);
  empty.tracks[1].regions = undefined;
  empty.tracks[1].regionsEnabled = true;
  expect(validateProject(empty).formatVersion).toBe(4);
  for (const regions of [
    [{ ...region, startMs: -1 }],
    [{ ...region, endMs: 17000 }],
    [region, { ...region, id: 'b', startMs: 2000 }],
    [{ ...region, gain: NaN }],
    [{ ...region, startMs: 1.2 }],
  ]) {
    expect(() => setAudioRegions(p, 'original', regions)).toThrow('INVALID_AUDIO_REGION');
  }
  expect(() => validateProject({ ...p, formatVersion: 3 })).toThrow('INVALID_AUDIO_REGION');
  const altered = structuredClone(p);
  altered.tracks[1].regions![0].endMs = 17000;
  expect(() => validateProject(altered)).toThrow('INVALID_AUDIO_REGION');
});
test('gain schedule merges touching boundaries and restores the default level after a region', () => {
  const p = paintAudioRegion(paint(), 'original', {
    startMs: 5000,
    endMs: 6000,
    gain: 0.5,
    mute: false,
  });
  expect(gainChanges(audioTracks(p)[0], 1500, 6500)).toEqual([
    { timeMs: 5000, gain: 0.5 },
    { timeMs: 6000, gain: 1 },
  ]);
});
test('unsaved regions survive media-job rebase and legacy-track creation but stay with their media', () => {
  const base = demoProject();
  base.tracks = [];
  const local = paint(base),
    incoming = structuredClone(base);
  incoming.revision++;
  expect(audioTracks(rebaseProject(base, local, incoming))[0].regions).toEqual(
    audioTracks(local)[0].regions,
  );
  incoming.media = { ...incoming.media!, path: 'different.mp4', durationMs: 1000 };
  expect(
    audioTracks(validateProject(rebaseProject(base, local, incoming)))[0].regions,
  ).toBeUndefined();
});
