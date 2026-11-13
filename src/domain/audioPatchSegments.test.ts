import { expect, it } from 'vitest';
import { patchSegments } from './audioPatchSegments';
import { demoProject, validateProject } from './project';
import type { AudioPatch } from './audioPatch';
const clip: AudioPatch = {
  kind: 'audioPatch',
  id: 'long',
  operationId: 'op',
  operation: 'leveling',
  sourcePath: 'media/source.mp4',
  trackId: 'original',
  sourceTrackId: 'original',
  startMs: 1000,
  endMs: 7201000,
  mode: 'replace',
  path: 'stems/patch-long.wav',
  gain: 1,
};
it('only schedules nearby exact chunks; joins have no gaps, preserve layer identity and accept seeks', () => {
  expect(patchSegments([clip], 0, 500)).toEqual([]);
  const both = patchSegments([clip], 29999, 33000);
  expect(both.map((c) => [c.cacheKey, c.startMs, c.endMs, c.offsetMs, c.id])).toEqual([
    ['long:0', 1000, 31000, 0, 'long'],
    ['long:1', 31000, 61000, 30000, 'long'],
  ]);
  expect(patchSegments([clip], 31000, 34000).map((c) => c.cacheKey)).toEqual(['long:1']);
  const end = patchSegments([{ ...clip, endMs: 131250 }], 130000, 140000);
  expect(end).toHaveLength(1);
  expect(end[0]).toMatchObject({ startMs: 121000, endMs: 131250, offsetMs: 120000 });
  expect(patchSegments([clip], 7199000, 7205000)).toHaveLength(1);
  const short = { ...clip, endMs: 121000 };
  expect(patchSegments([short], 2000, 4000)[0]).toEqual({ ...short, cacheKey: 'long' });
});
it('long replacements require format 28; unrelated transfer/effects limits remain in force', () => {
  const p = demoProject();
  p.media!.durationMs = 7201000;
  p.generations = [{ ...clip, sourcePath: p.media!.path }];
  p.formatVersion = 28;
  expect(validateProject(p)).toEqual(p);
  expect(() => validateProject({ ...p, formatVersion: 27 })).toThrow();
  for (const operation of ['effects', 'copy'])
    expect(() =>
      validateProject({ ...p, generations: [{ ...p.generations[0], operation }] }),
    ).toThrow();
  expect(() =>
    validateProject({ ...p, generations: [{ ...p.generations[0], endMs: 86400001 }] }),
  ).toThrow();
});
