import { expect, test } from 'vitest';
import { demoProject, validateProject } from './project';
import { addCharacter, applySpeakers, analysisCurrent, editCharacter } from './characters';
import {
  editCharacterProfile,
  mergeCharacters,
  portraitSimilarity,
  similarCharacterPortraits,
  speakerAudioSnapshot,
  type CharacterPortrait,
} from './characterReview';
import { rebaseProject } from './rebase';

const portrait = (): CharacterPortrait => ({
  path: 'characters/portrait.png',
  sourcePath: 'demo.mp4',
  lineId: 'example',
  atMs: 1000,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  differenceHash: '0000ffff0000ffff',
  colors: Array(48).fill(1 / 16),
  confirmed: false,
});
function fixture() {
  let p = addCharacter(addCharacter(demoProject(), 'Personnage 01'), 'Personnage 02');
  p.characters.forEach((c, i) => {
    c.references = [
      {
        id: `r${i}`,
        label: `Reference ${i}`,
        path: `characters/ref${i}.wav`,
        durationMs: 2000,
        transcript: `Texte ${i}`,
      },
    ];
    c.defaultReferenceId = `r${i}`;
    p.dialogues[i].characterId = c.id;
  });
  p = editCharacterProfile(p, p.characters[0].id, { portrait: portrait(), temporaryName: true });
  return p;
}
test('manual profile and acoustic register survive storage; invalid image paths and F0 are rejected', () => {
  let p = fixture();
  p = editCharacterProfile(p, p.characters[0].id, {
    gender: 'man',
    vocalRegister: { medianHz: 180, confidence: 0.8, analyzedMs: 2000 },
  });
  expect(validateProject(JSON.parse(JSON.stringify(p))).characterProfiles).toEqual(
    p.characterProfiles,
  );
  expect(() =>
    editCharacterProfile(p, p.characters[0].id, {
      portrait: { ...portrait(), path: 'characters/../secret.png' },
    }),
  ).toThrow('CHARACTER_PORTRAIT_INVALID');
  expect(() =>
    editCharacterProfile(p, p.characters[0].id, {
      vocalRegister: { medianHz: NaN, confidence: 0.8, analyzedMs: 2000 },
    }),
  ).toThrow('INVALID_CHARACTER');
  expect(
    editCharacter(p, p.characters[0].id, { name: 'Shin' }).characterProfiles![p.characters[0].id]
      .temporaryName,
  ).toBe(false);
});
test('visual proposals do not merge characters or infer gender', () => {
  const p = fixture(),
    before = structuredClone(p);
  p.characterProfiles![p.characters[1].id] = { portrait: portrait() };
  expect(portraitSimilarity(portrait(), portrait())).toBeCloseTo(1);
  expect(similarCharacterPortraits(p)).toHaveLength(1);
  expect(p.characters).toEqual(before.characters);
  expect(Object.values(p.characterProfiles!).every((v) => !v.gender)).toBe(true);
});
test('merge keeps all references and historical takes, picks default/portrait and reassigns dialogue IDs', () => {
  const p = fixture(),
    [first, second] = p.characters;
  p.generations.push({
    id: 'historical-take',
    kind: 'example',
    characterId: second.id,
    path: 'generations/original.wav',
  });
  p.characterProfiles![second.id] = {
    portrait: { ...portrait(), path: 'characters/second.png', confirmed: true },
  };
  const next = mergeCharacters(p, {
    ids: [first.id, second.id],
    keepId: first.id,
    defaultReferenceId: 'r1',
    portraitFromId: second.id,
  });
  expect(validateProject(next).characters).toHaveLength(1);
  expect(next.characters[0].references.map((r) => r.id)).toEqual(['r0', 'r1']);
  expect(next.characters[0].defaultReferenceId).toBe('r1');
  expect(next.characterProfiles![first.id].portrait!.confirmed).toBe(true);
  expect(next.dialogues.slice(0, 2).every((l) => l.characterId === first.id)).toBe(true);
  expect(next.generations).toEqual(p.generations);
  expect(p.characters).toHaveLength(2);
});
test('merge appends a prepared concatenated reference and rejects conflicts before changing project', () => {
  const p = fixture(),
    ids = p.characters.map((c) => c.id),
    before = structuredClone(p);
  const ref = {
    id: 'combined',
    label: 'Combined',
    path: 'characters/combined.wav',
    durationMs: 4000,
    transcript: 'Texte 0 Texte 1',
  };
  const next = mergeCharacters(p, { ids, keepId: ids[1], preparedReference: ref });
  expect(next.characters[0].references).toHaveLength(3);
  expect(next.characters[0].defaultReferenceId).toBe('combined');
  p.characters[1].references[0].id = 'r0';
  expect(() => mergeCharacters(p, { ids, keepId: ids[0] })).toThrow('CHARACTER_REFERENCE_CONFLICT');
  expect(p.characters[0]).toEqual(before.characters[0]);
});
function scoped() {
  const p = fixture(),
    line = p.dialogues[0],
    owner = p.characters[1].id;
  p.speakerAnalysis = {
    id: 'local',
    sourcePath: p.media!.path,
    scope: {
      startMs: line.startMs,
      endMs: line.endMs,
      trackId: 'auto',
      referenceCharacterId: owner,
      replaceAssigned: false,
    },
    audioSnapshot: speakerAudioSnapshot(p, owner),
    originalAssignments: { [line.id]: line.characterId },
    lines: [{ id: line.id, startMs: line.startMs, endMs: line.endMs }],
    assignments: [{ dialogueId: line.id, speaker: 0, similarity: 0.95, reason: 'identified' }],
    clusters: [
      {
        speaker: 0,
        characterId: owner,
        referencePath: 'characters/guided.wav',
        durationMs: 2000,
        referenceDialogueId: line.id,
        vocalRegister: { medianHz: 200, confidence: 0.8, analyzedMs: 2000 },
      },
    ],
  };
  return p;
}
test('guided partial identification preserves other lines, manual assignments and old reference defaults', () => {
  const p = scoped(),
    other = structuredClone(p.dialogues.slice(1)),
    first = p.dialogues[0].characterId;
  expect(analysisCurrent(p)).toBe(true);
  expect(applySpeakers(p).dialogues[0].characterId).toBe(first);
  p.speakerAnalysis!.scope!.replaceAssigned = true;
  const next = applySpeakers(p);
  expect(next.dialogues[0].characterId).toBe(p.characters[1].id);
  expect(next.dialogues.slice(1)).toEqual(other);
  expect(next.characters).toHaveLength(2);
  expect(next.characters[1].references).toHaveLength(2);
  expect(next.characters[1].defaultReferenceId).toBe('r1');
  expect(next.generations).toEqual(p.generations);
});
test('partial proposals reject changed audio, reference audio, timings and overwritten manual assignments', () => {
  for (const change of [
    (p: ReturnType<typeof scoped>) => {
      p.tracks[0].gain = 0.5;
    },
    (p: ReturnType<typeof scoped>) => {
      p.characters[1].references[0].path = 'characters/replaced.wav';
    },
    (p: ReturnType<typeof scoped>) => {
      p.dialogues[0].startMs++;
    },
    (p: ReturnType<typeof scoped>) => {
      p.speakerAnalysis!.scope!.replaceAssigned = true;
      p.dialogues[0].characterId = null;
    },
  ]) {
    const p = scoped();
    change(p);
    expect(analysisCurrent(p)).toBe(false);
    expect(() => applySpeakers(p)).toThrow('STALE_REVISION');
  }
});
test('invalid duplicate or unknown assignments cannot be saved through MCP or UI', () => {
  const p = scoped();
  p.speakerAnalysis!.assignments[0].speaker = 31;
  expect(() => validateProject(p)).toThrow('INVALID_CHARACTER');
  p.speakerAnalysis!.assignments[0].speaker = 0;
  p.speakerAnalysis!.lines.push(p.speakerAnalysis!.lines[0]);
  expect(() => validateProject(p)).toThrow('INVALID_CHARACTER');
});
test('an incoming thumbnail survives local profile text edits and other character metadata', () => {
  const base = fixture(),
    local = structuredClone(base),
    incoming = structuredClone(base),
    id = base.characters[0].id;
  local.characterProfiles![id].gender = 'woman';
  incoming.characterProfiles![id].portrait!.path = 'characters/new.png';
  incoming.characterProfiles![base.characters[1].id] = { temporaryName: true };
  const result = rebaseProject(base, local, incoming);
  expect(result.characterProfiles![id]).toMatchObject({
    gender: 'woman',
    portrait: { path: 'characters/new.png' },
  });
  expect(result.characterProfiles![base.characters[1].id].temporaryName).toBe(true);
});
