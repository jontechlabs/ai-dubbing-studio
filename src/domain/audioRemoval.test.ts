import { expect, test } from 'vitest';
import {
  audioTracks,
  editTrack,
  paintAudioRegion,
  removeAudioRegion,
  regionGain,
  setAudioRegions,
} from './audio';
import { demoProject, validateProject } from './project';

test('deleting a region restores the track envelope and retains neighbours and track levels', () => {
  const p = editTrack(
    setAudioRegions(demoProject(), 'original', [
      { id: 'left', startMs: 1000, endMs: 2000, gain: 1, mute: true },
      { id: 'middle', startMs: 2000, endMs: 3000, gain: 0.5, mute: false },
      { id: 'right', startMs: 3000, endMs: 4000, gain: 2, mute: false },
    ]),
    'original',
    { gain: 0.7, solo: true },
  );
  const snapshot = JSON.stringify(p),
    next = removeAudioRegion(p, 'original', 'middle');
  expect(JSON.stringify(p)).toBe(snapshot);
  const track = audioTracks(next)[0];
  expect(track).toMatchObject({ gain: 0.7, solo: true });
  expect(track.regions?.map((r) => r.id)).toEqual(['left', 'right']);
  expect([1999, 2000, 2999, 3000].map((t) => regionGain(track, t))).toEqual([0, 1, 1, 2]);
  expect(next.media).toEqual(p.media);
  expect(next.generations).toEqual(p.generations);
  expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
});

test('removing the last region preserves bypass, mute and independent tracks', () => {
  const p = paintAudioRegion(
    demoProject(),
    'original',
    { startMs: 1000, endMs: 2000, gain: 0, mute: true },
    'zone',
  );
  const bypass = editTrack(
    setAudioRegions(p, 'original', audioTracks(p)[0].regions!, false),
    'original',
    { mute: true },
  );
  const next = removeAudioRegion(bypass, 'original', 'zone');
  expect(audioTracks(next)[0]).toMatchObject({ regions: [], regionsEnabled: false, mute: true });
  expect(next.tracks.filter((t) => t.id !== 'original')).toEqual(
    p.tracks.filter((t) => t.id !== 'original'),
  );
  expect(validateProject(next)).toEqual(next);
});

test('missing track or region is rejected without editing a different zone', () => {
  const p = paintAudioRegion(
    demoProject(),
    'original',
    { startMs: 1000, endMs: 2000, gain: 0, mute: true },
    'zone',
  );
  const snapshot = JSON.stringify(p);
  expect(() => removeAudioRegion(p, 'other', 'zone')).toThrow('INVALID_AUDIO_REGION');
  expect(() => removeAudioRegion(p, 'original', 'missing')).toThrow('INVALID_AUDIO_REGION');
  expect(JSON.stringify(p)).toBe(snapshot);
});
