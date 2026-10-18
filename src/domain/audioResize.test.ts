import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { audioResizeLimits, resizeAudioRegion, setAudioRegions, regionGain } from './audio';
function fixture() {
  return setAudioRegions(demoProject(), 'original', [
    { id: 'one', startMs: 1000, endMs: 2000, gain: 0.5, mute: false },
    { id: 'two', startMs: 4000, endMs: 5000, gain: 1, mute: true },
  ]);
}
it('resizes an applied region with its original gain and protects adjacent regions', () => {
  const base = fixture(),
    p = resizeAudioRegion(base, 'original', 'one', 500, 2500),
    track = p.tracks.find((t) => t.id === 'original')!;
  expect(track.regions?.[0]).toEqual({
    id: 'one',
    startMs: 500,
    endMs: 2500,
    gain: 0.5,
    mute: false,
  });
  expect(track.regions?.[1]).toEqual(base.tracks.find((t) => t.id === 'original')!.regions![1]);
  expect(regionGain(track, 600)).toBe(0.5);
  expect(regionGain(track, 2600)).toBe(1);
  expect(validateProject(p)).toEqual(p);
  expect(audioResizeLimits(p, 'original', 'one')).toMatchObject({ min: 0, max: 4000 });
  expect(() => resizeAudioRegion(p, 'original', 'one', 500, 4100)).toThrow('INVALID_AUDIO_REGION');
});
it('shrinks silence, retains bypass state and does not mutate the original', () => {
  const base = fixture();
  base.tracks.find((t) => t.id === 'original')!.regionsEnabled = false;
  const p = resizeAudioRegion(base, 'original', 'two', 4200, 4800),
    track = p.tracks.find((t) => t.id === 'original')!;
  expect(track.regions?.[1].mute).toBe(true);
  expect(track.regionsEnabled).toBe(false);
  expect(base.tracks.find((t) => t.id === 'original')!.regions?.[1].startMs).toBe(4000);
  expect(() => resizeAudioRegion(base, 'original', 'two', 5000, 4500)).toThrow(
    'INVALID_AUDIO_REGION',
  );
});
it('bounds free selections to the track and refuses stale or fractional region boundaries', () => {
  const p = fixture();
  expect(audioResizeLimits(p, 'original')).toMatchObject({ min: 0, max: 16000, region: undefined });
  for (const args of [
    ['missing', 0, 500],
    ['one', 0.5, 500],
    ['one', -1, 500],
  ] as const)
    expect(() => resizeAudioRegion(p, 'original', args[0], args[1], args[2])).toThrow(
      'INVALID_AUDIO_REGION',
    );
});
