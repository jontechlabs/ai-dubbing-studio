import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { dubbingClips, moveDubbing, resizeDubbing, dubbingBounds } from './mix';
import {
  addDubbingLane,
  assignDubbingLane,
  dubbingLaneId,
  dubbingLaneGain,
  editDubbingLane,
  removeDubbingLane,
} from './dubbingLanes';
import { defaultVoiceSettings, spokenText } from './tts';
import { rebaseProject } from './rebase';
import type { Generation } from './types';
function fixture() {
  const p = demoProject();
  p.formatVersion = 5;
  p.dialogues = p.dialogues.slice(0, 2);
  p.dialogues.forEach((l) => {
    l.startMs = 1000;
    l.endMs = 3500;
  });
  p.generations = p.dialogues.map((l, i): Generation => ({
    kind: 'tts',
    id: 'lane-take-' + i,
    dialogueId: l.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: 'generations/test' + i + '.wav',
    createdAt: new Date().toISOString(),
    sourcePath: p.media!.path,
    startMs: l.startMs,
    endMs: l.endMs,
    text: spokenText(p, l),
    language: 'fr',
    characterId: l.characterId,
    durationMs: 2000,
    sampleRate: 24000,
    options: defaultVoiceSettings,
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'test',
  }));
  p.dialogues.forEach((l, i) => (l.selectedGenerationIds.fr = 'lane-take-' + i));
  return p;
}
it('independent tracks allow unrelated selected takes at exactly the same onset without touching audio or subtitles', () => {
  const p = fixture(),
    original = structuredClone(p);
  expect(dubbingClips(p).every((c) => c.slotMs === 2000)).toBe(true);
  const next = addDubbingLane(p, 'Second voice', [p.dialogues[1].id]);
  expect(dubbingClips(next).map((c) => [c.startMs, c.endMs])).toEqual([
    [1000, 3000],
    [1000, 3000],
  ]);
  expect(next.generations).toEqual(original.generations);
  expect(next.sourceCues).toEqual(original.sourceCues);
  expect(next.targetCues).toEqual(original.targetCues);
  expect(p).toEqual(original);
  expect(next.formatVersion).toBe(32);
  expect(validateProject(JSON.parse(JSON.stringify(next))).dubbingLanes).toEqual(next.dubbingLanes);
});
it('move and resize protection considers only occupancy on the same track', () => {
  const p = fixture(),
    next = addDubbingLane(p, 'Second', [p.dialogues[1].id]);
  expect(dubbingBounds(next, p.dialogues[0].id).max).toBeGreaterThan(3000);
  const resized = resizeDubbing(next, p.dialogues[0].id, 3000);
  expect(dubbingClips(resized)[0].endMs).toBe(4000);
  const moved = moveDubbing(resized, p.dialogues[1].id, 500);
  expect(dubbingClips(moved).find((c) => c.line.id === p.dialogues[1].id)!.startMs).toBe(1500);
  expect(dubbingClips(moved)[0].endMs).toBe(4000);
});
it('lane gains, mute and solo retain scheduling and do not alter take cache identities', () => {
  let p = fixture();
  p = addDubbingLane(p, 'Second', [p.dialogues[1].id]);
  const second = p.dubbingLanes!.lanes[1].id,
    key = dubbingClips(p)[1].cacheKey;
  p = editDubbingLane(p, second, { gain: 1.75 });
  expect(dubbingLaneGain(p, p.dialogues[1].id)).toBe(1.75);
  expect(dubbingClips(p)[1].cacheKey).toBe(key);
  p = editDubbingLane(p, second, { solo: true });
  expect(dubbingLaneGain(p, p.dialogues[0].id)).toBe(0);
  expect(dubbingLaneGain(p, p.dialogues[1].id)).toBe(1.75);
  p = editDubbingLane(p, second, { mute: true });
  expect(dubbingLaneGain(p, p.dialogues[0].id)).toBe(1);
  expect(dubbingLaneGain(p, p.dialogues[1].id)).toBe(0);
  expect(dubbingClips(p)[1].slotMs).toBe(2000);
});
it('deleting a lane preserves audible take durations even before the next placement normalization', () => {
  const p = fixture(),
    next = addDubbingLane(p, 'Second', [p.dialogues[1].id]),
    removed = removeDubbingLane(next, next.dubbingLanes!.lanes[1].id);
  expect(dubbingLaneId(removed, p.dialogues[1].id)).toBe('main');
  expect(removed.generations).toEqual(p.generations);
  expect(dubbingClips(removed).every((c) => c.slotMs === 2000)).toBe(true);
  expect(() => removeDubbingLane(next, 'main')).toThrow('INVALID_DUBBING_LANES');
});
it('invalid assignments, gain, range, names and formats are rejected before mutation', () => {
  const p = addDubbingLane(fixture(), 'Second'),
    before = structuredClone(p);
  expect(() => assignDubbingLane(p, ['unknown'], 'main')).toThrow();
  expect(() => assignDubbingLane(p, [], 'unknown')).toThrow();
  for (const gain of [NaN, -1, 3.01]) expect(() => editDubbingLane(p, 'main', { gain })).toThrow();
  expect(() => editDubbingLane(p, 'main', { name: ' ' })).toThrow();
  expect(() => validateProject({ ...p, formatVersion: 31 })).toThrow();
  const bad = structuredClone(p);
  bad.dubbingLanes!.assignments[p.dialogues[0].id] = 'absent';
  expect(() => validateProject(bad)).toThrow();
  expect(p).toEqual(before);
});
it('lane edits survive background-result rebasing and media replacement does not reuse old assignments', () => {
  const base = fixture(),
    local = addDubbingLane(base, 'Second', [base.dialogues[1].id]),
    incoming = structuredClone(base);
  incoming.revision++;
  const merged = rebaseProject(base, local, incoming);
  expect(merged.dubbingLanes).toEqual(local.dubbingLanes);
  expect(merged.formatVersion).toBe(32);
  merged.media!.path = 'media/replaced.mkv';
  expect(dubbingLaneId(merged, base.dialogues[1].id)).toBe('main');
  expect(dubbingLaneGain(merged, base.dialogues[1].id)).toBe(1);
});
