import { it, expect } from 'vitest';
import spec from '../../resources/character-lanes-fixture.json';
import { demoProject, validateProject } from './project';
import type { Dialogue, Character } from './types';
import {
  configureCharacterLanes,
  syncCharacterLanes,
  assignDubbingLane,
  resetCharacterLane,
  dubbingLaneId,
  editDubbingLane,
  removeDubbingLane,
  addDubbingLane,
} from './dubbingLanes';
import { rebaseProject } from './rebase';
function fixture() {
  const p = demoProject();
  p.media!.path = 'media/source.mkv';
  p.characters = structuredClone(spec.characters) as Character[];
  p.dialogues = structuredClone(spec.dialogues) as Dialogue[];
  p.generations = [];
  return p;
}
const enable = (p: ReturnType<typeof fixture>, preserveManual = true) =>
  configureCharacterLanes(p, { enabled: true, preserveManual });
it('matches the shared native routing fixture and repeated synchronization never duplicates tracks or changes assets', () => {
  const p = fixture(),
    before = structuredClone(p),
    next = enable(p);
  expect(next.dubbingLanes).toEqual(spec.expected);
  expect(p).toEqual(before);
  expect(next.formatVersion).toBe(33);
  expect(syncCharacterLanes(next)).toEqual(next);
  expect(next.generations).toEqual(p.generations);
  expect(next.sourceCues).toEqual(p.sourceCues);
  expect(next.targetCues).toEqual(p.targetCues);
  expect(validateProject(JSON.parse(JSON.stringify(next))).dubbingLanes).toEqual(next.dubbingLanes);
});
it('manual routing to the main track survives character changes and can explicitly return to automatic routing', () => {
  let p = enable(fixture());
  p = assignDubbingLane(p, ['line'], 'main');
  p.dialogues[0].characterId = 'beta';
  p = syncCharacterLanes(p);
  expect(dubbingLaneId(p, 'line')).toBe('main');
  expect(p.dubbingLanes!.byCharacter!.manualLineIds).toEqual(['line']);
  p = resetCharacterLane(p, ['line']);
  expect(dubbingLaneId(p, 'line')).toBe('character-2');
  p = configureCharacterLanes(p, { enabled: false, preserveManual: true });
  p.dialogues[0].characterId = 'alpha';
  expect(syncCharacterLanes(p)).toEqual(p);
  expect(dubbingLaneId(p, 'line')).toBe('character-2');
  p = enable(p);
  expect(dubbingLaneId(p, 'line')).toBe('character-1');
});
it('reuses unambiguous existing tracks and preserves their settings and prior manual choices', () => {
  let p = fixture();
  p = addDubbingLane(p, 'Alice', ['line']);
  const id = p.dubbingLanes!.lanes[1].id;
  p = editDubbingLane(p, id, { gain: 1.75, mute: true });
  const added = structuredClone(p.dialogues[0]);
  added.id = 'new-alice';
  p.dialogues.push(added);
  p = enable(p);
  expect(p.dubbingLanes!.lanes).toHaveLength(3);
  expect(dubbingLaneId(p, 'line')).toBe(id);
  expect(dubbingLaneId(p, 'new-alice')).toBe(id);
  expect(p.dubbingLanes!.byCharacter!.manualLineIds).toContain('line');
  expect(p.dubbingLanes!.lanes[1]).toMatchObject({ gain: 1.75, mute: true, characterId: 'alpha' });
  p = assignDubbingLane(p, ['line'], 'main');
  p = enable(p, false);
  expect(dubbingLaneId(p, 'line')).toBe(id);
  expect(p.dubbingLanes!.byCharacter!.manualLineIds).toEqual([]);
});
it('binds by character ID and follows renames while retaining custom track names', () => {
  let p = fixture();
  p.characters[1].name = 'Alice';
  p = enable(p);
  expect(dubbingLaneId(p, 'line')).not.toBe(dubbingLaneId(p, 'line2'));
  p.characters[0].name = 'Alicia';
  p = syncCharacterLanes(p);
  expect(p.dubbingLanes!.lanes[1].name).toBe('Alicia');
  p = editDubbingLane(p, 'character-1', { name: 'Voix grave' });
  p.characters[0].name = 'Alice finale';
  p = syncCharacterLanes(p);
  expect(p.dubbingLanes!.lanes[1].name).toBe('Voix grave');
  expect(p.dubbingLanes!.lanes[1].characterName).toBe('Alice finale');
});
it('track deletion preserves a manual return to main, while a future dialogue gets its own character route', () => {
  let p = enable(fixture());
  p = removeDubbingLane(p, 'character-1');
  p = syncCharacterLanes(p);
  expect(dubbingLaneId(p, 'line')).toBe('main');
  expect(p.dubbingLanes!.lanes).toHaveLength(2);
  const l = structuredClone(p.dialogues[0]);
  l.id = 'future';
  p.dialogues.push(l);
  p = syncCharacterLanes(p);
  expect(dubbingLaneId(p, 'future')).not.toBe('main');
  expect(dubbingLaneId(p, 'line')).toBe('main');
  p.characters = p.characters.filter((c) => c.id !== 'alpha');
  p.dialogues.forEach((l) => {
    if (l.characterId === 'alpha') l.characterId = null;
  });
  p = syncCharacterLanes(p);
  expect(p.dubbingLanes!.lanes.every((l) => l.characterId !== 'alpha')).toBe(true);
});
it('supports more than 32 characters, rejects invalid metadata and fails atomically at the track limit', () => {
  const p = fixture();
  p.characters = Array.from({ length: 40 }, (_, i) => ({
    ...p.characters[0],
    id: 'c' + i,
    name: 'Personnage ' + i,
  }));
  p.dialogues = p.characters.map((c) => ({ ...p.dialogues[0], id: 'l' + c.id, characterId: c.id }));
  const next = enable(p);
  expect(next.dubbingLanes!.lanes).toHaveLength(41);
  expect(() => validateProject({ ...next, formatVersion: 32 })).toThrow('INVALID_DUBBING_LANES');
  const bad = structuredClone(next);
  bad.dubbingLanes!.lanes[2].characterId = 'c0';
  expect(() => validateProject(bad)).toThrow();
  p.characters = Array.from({ length: 256 }, (_, i) => ({
    ...p.characters[0],
    id: 'c' + i,
    name: 'Personnage ' + i,
  }));
  p.dialogues = p.characters.map((c) => ({ ...p.dialogues[0], id: 'l' + c.id, characterId: c.id }));
  const before = structuredClone(p);
  expect(() => enable(p)).toThrow('DUBBING_LANES_LIMIT');
  expect(p).toEqual(before);
});
it('new background character assignments route immediately without overwriting local manual edits', () => {
  const base = enable(fixture()),
    local = assignDubbingLane(base, ['line'], 'main'),
    incoming = structuredClone(base);
  incoming.dialogues[2].characterId = 'beta';
  incoming.revision++;
  const merged = rebaseProject(base, local, incoming);
  expect(dubbingLaneId(merged, 'line')).toBe('main');
  expect(dubbingLaneId(merged, 'line3')).toBe('character-2');
  expect(merged.generations).toEqual(base.generations);
});
