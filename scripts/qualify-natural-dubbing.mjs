import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function qualifyNaturalDubbing(call, root, lineIds) {
  let p = await call('studio_get_project');
  const context = async () => (await call('studio_get_state')).context;
  const pcm = Buffer.alloc(44 + 48000 * 2);
  pcm.write('RIFF');
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(24000, 24);
  pcm.writeUInt32LE(48000, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(pcm.length - 44, 40);
  for (let i = 0; i < 48000; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 440 * Math.PI * 2) / 24000) * 6000), 44 + i * 2);
  const relative = 'generations/sdk-natural-duration.wav';
  const source = path.join(root, relative);
  await fs.writeFile(source, pcm);
  const base = p.generations.find((g) => g.kind === 'tts');
  assert(base);
  const generations = lineIds.slice(0, 2).map((lineId, i) => {
    const line = p.dialogues.find((l) => l.id === lineId);
    const g = {
      ...base,
      id: `sdk-natural-${i}`,
      dialogueId: lineId,
      path: relative,
      durationMs: 2000,
      startMs: 500 + i * 500,
      endMs: 600 + i * 500,
      characterId: line.characterId,
      text: ['Bonjour.', 'Oui !'][i],
    };
    for (const key of [
      'generationTiming',
      'batchItemId',
      'takeOrigin',
      'prosodyTransfer',
      'pipeline',
    ])
      delete g[key];
    return g;
  });
  const originalCount = p.generations.length;
  const patches = [
    {
      op: 'add',
      path: '/dubbingLanes',
      value: {
        sourcePath: p.media.path,
        lanes: [{ id: 'main', name: 'Doublage 1', gain: 1, mute: false, solo: false }],
        assignments: {},
      },
    },
    ...p.dialogues.map((_, i) => ({
      op: 'replace',
      path: `/dialogues/${i}/selectedGenerationIds`,
      value: {},
    })),
  ];
  for (const g of generations) {
    const i = p.dialogues.findIndex((l) => l.id === g.dialogueId);
    patches.push(
      { op: 'replace', path: `/dialogues/${i}/startMs`, value: g.startMs },
      { op: 'replace', path: `/dialogues/${i}/endMs`, value: g.endMs },
      { op: 'add', path: '/generations/-', value: g },
    );
  }
  // Remove unrelated old timing only in this isolated SDK fixture.
  if (p.dubbingTiming) patches.push({ op: 'remove', path: '/dubbingTiming' });
  await call('studio_project_patch', { context: await context(), patches });
  // Save staged, unselected takes first: the UI render preflight only reads
  // files referenced by generations already owned by the native session.
  await call('studio_project_patch', {
    context: await context(),
    patches: generations.map((g) => ({
      op: 'replace',
      path: `/dialogues/${p.dialogues.findIndex((l) => l.id === g.dialogueId)}/selectedGenerationIds`,
      value: { fr: g.id },
    })),
  });
  p = await call('studio_get_project');
  assert.equal(p.generations.length, originalCount + 2);
  assert.notEqual(
    p.dubbingLanes.assignments[lineIds[0]] ?? 'main',
    p.dubbingLanes.assignments[lineIds[1]] ?? 'main',
  );
  for (const g of generations) {
    const file = await call('studio_dubbing_path', {
      id: g.id,
      slotMs: 2000,
      exactDuration: false,
    });
    assert.equal(
      hash(await fs.readFile(file)),
      hash(pcm),
      'Natural playback must return every source sample unchanged',
    );
    assert.equal(p.dialogues.find((l) => l.id === g.dialogueId).startMs, g.startMs);
  }
  const first = lineIds[0];
  await call('studio_resize_voice', { id: first, durationMs: 1000, context: await context() });
  p = await call('studio_get_project');
  assert.equal(p.dubbingTiming.durationsMs[first].fr, 1000);
  const short = await call('studio_dubbing_path', {
    id: generations[0].id,
    slotMs: 1000,
    exactDuration: true,
  });
  assert.notEqual(hash(await fs.readFile(short)), hash(pcm));
  const newTake = { ...generations[0], id: 'sdk-natural-new-take' };
  await call('studio_project_patch', {
    context: await context(),
    patches: [{ op: 'add', path: '/generations/-', value: newTake }],
  });
  await call('studio_project_patch', {
    context: await context(),
    patches: [
      {
        op: 'replace',
        path: `/dialogues/${p.dialogues.findIndex((l) => l.id === first)}/selectedGenerationIds/fr`,
        value: newTake.id,
      },
    ],
  });
  p = await call('studio_get_project');
  assert.equal(
    p.dubbingTiming.durationsMs[first].fr,
    undefined,
    'New take must not inherit old short duration',
  );
  assert.equal(p.generations.length, originalCount + 3);
  const natural = await call('studio_dubbing_path', {
    id: newTake.id,
    slotMs: 2000,
    exactDuration: false,
  });
  assert.equal(hash(await fs.readFile(natural)), hash(pcm));
  const proof = {
    naturalDurationMs: 2000,
    subtitleDurationMs: 100,
    separateOverlappingLanes: true,
    sameOnsets: true,
    naturalWavSha256: hash(pcm),
    source,
    selectedTakeId: newTake.id,
    originalCount,
    manualDurationStillAvailable: true,
    noInheritedShortDuration: true,
  };
  return { project: p, proof };
}
export async function verifyNaturalDubbingRestart(call, proof) {
  const file = await call('studio_dubbing_path', {
    id: proof.selectedTakeId,
    slotMs: 2000,
    exactDuration: false,
  });
  assert.equal(hash(await fs.readFile(file)), proof.naturalWavSha256);
  assert.equal(hash(await fs.readFile(proof.source)), proof.naturalWavSha256);
  return { ...proof, actualProcessRestart: true };
}
