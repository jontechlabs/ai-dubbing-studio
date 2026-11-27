import { expect, it } from 'vitest';
import cases from '../../tests/fixtures/natural-dubbing-placement.json';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, selectGeneration, spokenText } from './tts';
import type { Generation } from './types';
import { resolveDubbingPlacement } from './dubbingPlacement';
import { dubbingClips, dubbingDuration, resizeDubbing } from './mix';
import {
  dubbingLaneId,
  dubbingLanes,
  editDubbingLane,
  addDubbingLane,
  configureCharacterLanes,
  syncCharacterLanes,
} from './dubbingLanes';
import { setVoiceOutputGain } from './voiceEdit';

function fixture(starts = [1000, 2000], durations = [3000, 2000]) {
  const p = demoProject();
  p.formatVersion = Math.max(5, p.formatVersion);
  p.dialogues = starts.map((startMs, i) => ({
    ...structuredClone(p.dialogues[0]),
    id: `line-${i}`,
    startMs,
    endMs: startMs + 100,
    selectedGenerationIds: { fr: `take-${i}` },
  }));
  p.generations = p.dialogues.map((line, i): Generation => ({
    kind: 'tts',
    id: `take-${i}`,
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: `generations/take-${i}.wav`,
    createdAt: new Date().toISOString(),
    sourcePath: p.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: spokenText(p, line),
    language: 'fr',
    characterId: line.characterId,
    durationMs: durations[i],
    sampleRate: 24000,
    options: defaultVoiceSettings,
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'fixture',
  }));
  return p;
}
for (const spec of cases)
  it(`shared native/browser placement: ${spec.name}`, () => {
    const next = fixture(spec.starts, spec.durations);
    if (spec.overrides) {
      next.formatVersion = Math.max(next.formatVersion, 7);
      next.dubbingTiming = {
        sourcePath: next.media!.path,
        offsetsMs: {},
        durationsMs: Object.fromEntries(
          Object.entries(spec.overrides).map(([i, duration]) => [`line-${i}`, { fr: duration }]),
        ),
      };
    }
    const before = structuredClone(next);
    before.dialogues.forEach((line, i) => {
      if (!spec.existing.includes(i)) delete line.selectedGenerationIds.fr;
    });
    const snapshot = JSON.stringify(next);
    const placed = resolveDubbingPlacement(before, next);
    expect(JSON.stringify(next)).toBe(snapshot);
    const laneIds = dubbingLanes(placed).map((lane) => lane.id);
    expect(placed.dialogues.map((line) => laneIds.indexOf(dubbingLaneId(placed, line.id)))).toEqual(
      spec.lanes,
    );
    const clips = new Map(dubbingClips(placed).map((clip) => [clip.line.id, clip]));
    expect(
      placed.dialogues.map((line) => {
        const c = clips.get(line.id)!;
        return c.endMs - c.startMs;
      }),
    ).toEqual(spec.lengths);
    expect(placed.generations).toEqual(next.generations);
    expect(placed.sourceCues).toEqual(next.sourceCues);
    expect(placed.targetCues).toEqual(next.targetCues);
    expect(validateProject(JSON.parse(JSON.stringify(placed)))).toEqual(placed);
    expect(resolveDubbingPlacement(placed, placed)).toEqual(placed);
  });
it('a newly selected take uses its own duration; manual timing of the same take remains reversible', () => {
  const p = resizeDubbing(fixture(), 'line-0', 1000);
  const newTake: Generation = {
    ...(p.generations[0] as Generation),
    id: 'new-take',
    durationMs: 4000,
  };
  p.generations.push(newTake);
  const selected = selectGeneration(p, newTake.id);
  expect(dubbingDuration(selected, 'line-0')).toBeUndefined();
  const clip = dubbingClips(selected).find((c) => c.line.id === 'line-0')!;
  expect(clip.endMs - clip.startMs).toBe(4000);
  expect(dubbingLaneId(selected, 'line-0')).not.toBe(dubbingLaneId(selected, 'line-1'));
  expect(selected.generations).toEqual(p.generations);
  expect(
    dubbingClips(resizeDubbing(selected, 'line-0', 2500)).find((c) => c.line.id === 'line-0')!
      .endMs - clip.startMs,
  ).toBe(2500);
});
it('new overflow lanes preserve mixer gain, mute/solo and character routing across repeated edits', () => {
  let p = fixture();
  p = configureCharacterLanes(p, { enabled: true, preserveManual: true });
  p = editDubbingLane(p, dubbingLaneId(p, 'line-0'), { gain: 0.75, solo: true });
  const before = structuredClone(p);
  delete before.dialogues[1].selectedGenerationIds.fr;
  const placed = resolveDubbingPlacement(before, p);
  const lane = dubbingLanes(placed).find((l) => l.id === dubbingLaneId(placed, 'line-1'))!;
  expect(lane).toMatchObject({ gain: 0.75, solo: true, mute: false });
  expect(resolveDubbingPlacement(placed, syncCharacterLanes(placed))).toEqual(placed);
});
it('uses an available compatible second lane, never an occupied or muted one', () => {
  let p = addDubbingLane(fixture(), 'Muted');
  p = editDubbingLane(p, p.dubbingLanes!.lanes[1].id, { mute: true });
  p = addDubbingLane(p, 'Free');
  const before = structuredClone(p);
  delete before.dialogues[1].selectedGenerationIds.fr;
  const placed = resolveDubbingPlacement(before, p);
  expect(dubbingLaneId(placed, 'line-1')).toBe(p.dubbingLanes!.lanes[2].id);
  expect(dubbingLanes(placed)).toHaveLength(3);
});
it('output attenuation is independent of natural duration and preserves the source performance', () => {
  const p = fixture(),
    next = setVoiceOutputGain(p, 'take-0', 0.25);
  expect(next.voiceEdits!['take-0'].outputGain).toBe(0.25);
  expect(dubbingClips(next)[0].endMs - dubbingClips(next)[0].startMs).toBe(3000);
  expect(next.generations).toEqual(p.generations);
});

it('a full 256-lane collision fails atomically without dropping a take or changing any timing', () => {
  const p = fixture(Array(257).fill(1000), Array(257).fill(500));
  p.formatVersion = 33;
  p.dubbingLanes = {
    sourcePath: p.media!.path,
    lanes: Array.from({ length: 256 }, (_, i) => ({
      id: i ? `lane-${i}` : 'main',
      name: `Voice ${i + 1}`,
      mute: false,
      solo: false,
      gain: 1,
    })),
    assignments: Object.fromEntries(
      Array.from({ length: 255 }, (_, i) => [`line-${i + 1}`, `lane-${i + 1}`]),
    ),
  };
  const before = structuredClone(p);
  delete before.dialogues[256].selectedGenerationIds.fr;
  const snapshot = JSON.stringify(p);
  expect(() => resolveDubbingPlacement(before, p)).toThrow('DUBBING_LANES_LIMIT');
  expect(JSON.stringify(p)).toBe(snapshot);
});

it('timbre and intonation transfers keep the reviewed duration of the performance they derive from', () => {
  for (const mode of ['conversion', 'intonation']) {
    const p = resizeDubbing(fixture(), 'line-0', 1000);
    p.formatVersion = Math.max(p.formatVersion, 17);
    const derived: Generation = { ...(p.generations[0] as Generation), id: `derived-${mode}` };
    if (mode === 'conversion')
      derived.takeOrigin = { type: 'conversion', sourceGenerationId: 'take-0', referenceId: 'ref' };
    else
      derived.prosodyTransfer = {
        algorithm: 'praat-psola-v1',
        sourceGenerationId: 'take-0',
        sourceDurationMs: 3000,
        guideDurationMs: 3000,
        options: {
          generationId: 'take-0',
          referenceMode: 'dialogue',
          referenceId: null,
          strength: 0.5,
          pitch: true,
          rhythm: false,
          energy: true,
        },
      };
    p.generations.push(derived);
    const next = selectGeneration(p, derived.id);
    expect(dubbingDuration(next, 'line-0')).toBe(1000);
    expect(dubbingClips(next).find((c) => c.line.id === 'line-0')!.endMs).toBe(2000);
    expect(next.generations).toEqual(p.generations);
  }
});
