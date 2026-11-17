// Persistence/schema diagnostic on an isolated real desktop. Native worker tests
// measure actual elapsed execution; this SDK fixture supplies a known value.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, s) => (i % 2 ? a : [...a, [v.slice(2), s[i + 1]]]), []),
);
assert(args['test-root'].includes('volume-leveling-native'));
const client = new Client({ name: 'take-timing-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: args.exe,
  args: ['--mcp', '--endpoint', args.endpoint],
  stderr: 'pipe',
});
let tools;
async function call(name, input = {}) {
  if (
    tools?.find((t) => t.name === name)?.inputSchema.properties?.context &&
    input.context === undefined
  )
    input = { ...input, context: (await call('studio_get_state')).context };
  const r = await client.callTool({ name, arguments: input });
  if (r.isError) throw Error(r.content.map((c) => c.text ?? '').join('\n'));
  return r.structuredContent.value;
}
const digest = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const checkpoint = path.join(args['test-root'], 'take-timing-checkpoint.json');
try {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  assert.equal(client.getServerVersion().version, '0.56.0');
  assert.equal(tools.length, 177);
  // New placement is exposed with revision context. A missing separation
  // must leave all dialogues/takes intact; real PCM placement is exercised
  // by the native transactional tests, without claiming neural inference.
  if (args.phase === 'before') {
    const beforePlacement = await call('studio_get_project');
    await assert.rejects(
      () =>
        call('studio_place_speaker_dubbings', {
          id: 'missing-result',
          audioLanguage: beforePlacement.languages.source,
          assignments: [
            {
              outputId: 'voice-1',
              label: 'Test',
              characterId: null,
              sourceText: '',
              targetText: '',
              laneId: null,
              laneName: 'Test',
            },
          ],
        }),
      /INVALID_JOB/,
    );
    assert.deepEqual(await call('studio_get_project'), beforePlacement);
  }
  if (args.phase === 'before') {
    let p = await call('studio_get_project');
    assert(p);
    const library = await call('studio_list_projects');
    const entry = library.entries.find((e) => e.key === library.activeKey);
    assert(entry);
    const root = path.toNamespacedPath(await fs.realpath(entry.path));
    assert(
      root
        .toLowerCase()
        .startsWith(
          path.toNamespacedPath(path.resolve(args['test-root'])).toLowerCase() + path.sep,
        ),
    );
    const index = p.generations.findIndex((g) => g.kind === 'tts');
    assert(index >= 0);
    const input = p.generations[index],
      line = p.dialogues.find((l) => l.id === input.dialogueId);
    assert(input.durationMs >= 1000 && line);
    const reference = {
      generationId: 'batch',
      referenceMode: 'generation',
      referenceId: input.id,
      characterId: null,
      device: 'cpu',
      referenceRange: { startMs: 0, endMs: 1000 },
    };
    const selection = { lineIds: [line.id], reference };
    const beforePreview = structuredClone(p);
    const preview = await call('studio_preview_voice_batch', { options: selection });
    assert.deepEqual(preview.ready, [line.id]);
    assert.deepEqual(preview.blocked, []);
    const invalid = await client.callTool({
      name: 'studio_preview_voice_batch',
      arguments: {
        options: {
          ...selection,
          reference: { ...reference, referenceRange: { startMs: 0, endMs: 100 } },
        },
      },
    });
    assert(
      invalid.isError && invalid.content.some((c) => c.text?.includes('INVALID_REFERENCE_AUDIO')),
    );
    assert.deepEqual(await call('studio_get_project'), beforePreview);
    // This isolated diagnostic has no voice weights. Check the real guard,
    // not an invented inference result, through the official SDK.
    const rejected = await client.callTool({
      name: 'studio_convert_voice_batch',
      arguments: { context: (await call('studio_get_state')).context, options: selection },
    });
    assert(
      rejected.isError && rejected.content.some((c) => c.text?.includes('TTS_MODEL_REQUIRED')),
    );
    assert.deepEqual(await call('studio_get_project'), beforePreview);
    const pcm = Buffer.alloc(44 + 2 * 24000 * 2);
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
      pcm.writeInt16LE(Math.round(Math.sin(i * 0.03) * 6000), 44 + i * 2);
    const file = path.join(root, 'cache', 'sdk-vc-reference.wav');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, pcm);
    await call('studio_import_dubbing_reference', {
      lineId: null,
      path: file,
      options: {
        device: 'cpu',
        referenceMode: 'current',
        referenceId: null,
        mode: 'crossLingual',
        speed: 1,
        seed: 0,
      },
      range: { startMs: 250, endMs: 1750 },
    });
    p = await call('studio_get_project');
    const imported = p.voiceReferences.at(-1);
    assert.equal(imported.durationMs, 1500);
    assert.deepEqual(p.generations, beforePreview.generations);
    const filePreview = await call('studio_preview_voice_batch', {
      options: {
        lineIds: [line.id],
        reference: {
          generationId: 'batch',
          referenceMode: 'reference',
          referenceId: imported.id,
          characterId: null,
          device: 'cpu',
        },
      },
    });
    assert.deepEqual(filePreview.ready, [line.id]);
    const laneState = {
      sourcePath: p.media.path,
      lanes: [
        { id: 'main', name: 'Voix principale', mute: false, solo: false, gain: 1 },
        { id: 'sdk-second', name: 'Voix secondaire', mute: true, solo: false, gain: 1.75 },
      ],
      assignments: { [line.id]: 'sdk-second' },
    };
    await call('studio_project_patch', {
      patches: [
        { op: 'replace', path: '/formatVersion', value: 32 },
        { op: 'add', path: '/dubbingLanes', value: laneState },
      ],
    });
    p = await call('studio_get_project');
    assert.deepEqual(p.dubbingLanes, laneState);
    assert.deepEqual(p.generations, beforePreview.generations);
    const invalidLane = await client.callTool({
      name: 'studio_project_patch',
      arguments: {
        context: (await call('studio_get_state')).context,
        patches: [{ op: 'replace', path: '/dubbingLanes/lanes/1/gain', value: 4 }],
      },
    });
    assert(
      invalidLane.isError &&
        invalidLane.content.some((c) => c.text?.includes('INVALID_DUBBING_LANES')),
    );
    assert.equal((await call('studio_get_project')).revision, p.revision);
    const other = p.dialogues.find((l) => l.id !== line.id);
    assert(other);
    const otherIndex = p.dialogues.findIndex((l) => l.id === other.id),
      lineIndex = p.dialogues.findIndex((l) => l.id === line.id);
    await call('studio_project_patch', {
      patches: [
        {
          op: 'add',
          path: '/characters/-',
          value: {
            id: 'sdk-auto-a',
            name: 'Alice MCP',
            color: '#a48bd4',
            references: [],
            defaultReferenceId: null,
          },
        },
        {
          op: 'add',
          path: '/characters/-',
          value: {
            id: 'sdk-auto-b',
            name: 'Bob MCP',
            color: '#82bda0',
            references: [],
            defaultReferenceId: null,
          },
        },
        { op: 'replace', path: `/dialogues/${lineIndex}/characterId`, value: 'sdk-auto-a' },
        { op: 'replace', path: `/dialogues/${otherIndex}/characterId`, value: 'sdk-auto-b' },
      ],
    });
    await call('studio_configure_character_lanes', {
      options: { enabled: true, preserveManual: false },
    });
    p = await call('studio_get_project');
    assert.equal(p.formatVersion, 33);
    assert(p.dubbingLanes.byCharacter.enabled);
    const laneA = p.dubbingLanes.lanes.find((l) => l.characterId === 'sdk-auto-a'),
      laneB = p.dubbingLanes.lanes.find((l) => l.characterId === 'sdk-auto-b');
    assert(laneA && laneB && laneA.id !== laneB.id);
    assert.equal(p.dubbingLanes.assignments[line.id], laneA.id);
    assert.equal(p.dubbingLanes.assignments[other.id], laneB.id);
    assert.equal(laneA.gain, 1.75);
    assert(laneA.mute);
    await call('studio_assign_dubbing_lanes', { lineIds: [line.id], laneId: 'main' });
    await call('studio_project_patch', {
      patches: [
        { op: 'replace', path: `/dialogues/${lineIndex}/characterId`, value: 'sdk-auto-b' },
      ],
    });
    p = await call('studio_get_project');
    assert.equal(p.dubbingLanes.assignments[line.id], undefined);
    assert(p.dubbingLanes.byCharacter.manualLineIds.includes(line.id));
    await call('studio_assign_dubbing_lanes', { lineIds: [line.id], laneId: null });
    p = await call('studio_get_project');
    assert.equal(p.dubbingLanes.assignments[line.id], laneB.id);
    await call('studio_assign_dubbing_lanes', { lineIds: [line.id], laneId: 'main' });
    p = await call('studio_get_project');
    const badRoute = await client.callTool({
      name: 'studio_assign_dubbing_lanes',
      arguments: {
        context: (await call('studio_get_state')).context,
        lineIds: ['missing-sdk-dialogue'],
        laneId: 'main',
      },
    });
    assert(
      badRoute.isError && badRoute.content.some((c) => c.text?.includes('INVALID_DUBBING_LANES')),
    );
    assert.equal((await call('studio_get_project')).revision, p.revision);
    assert.deepEqual(p.generations, beforePreview.generations);
    const record = {
      takeId: p.generations[index].id,
      operation: 'tts',
      elapsedMs: 42000,
      inputUnits: 40,
      warmModel: false,
      contextKey: 'a'.repeat(64),
    };
    const hashes = await Promise.all(
      p.generations
        .filter((g) => g.kind === 'tts')
        .map(async (g) => ({
          id: g.id,
          sha256: await digest(await call('studio_generation_path', { id: g.id })),
        })),
    );
    const mediaHash = await digest(path.join(root, p.media.path));
    await call('studio_project_patch', {
      patches: [{ op: 'add', path: `/generations/${index}/generationTiming`, value: record }],
    });
    const saved = await call('studio_get_project');
    assert.deepEqual(saved.generations[index].generationTiming, record);
    const expected = structuredClone(p.generations);
    expected[index].generationTiming = record;
    assert.deepEqual(saved.generations, expected);
    for (const invalid of [
      { ...record, elapsedMs: -1 },
      { ...record, takeId: '' },
      { ...record, contextKey: 'invalid' },
    ]) {
      const r = await client.callTool({
        name: 'studio_project_patch',
        arguments: {
          context: (await call('studio_get_state')).context,
          patches: [
            { op: 'replace', path: `/generations/${index}/generationTiming`, value: invalid },
          ],
        },
      });
      assert(r.isError && r.content.some((c) => c.text?.includes('INVALID_GENERATION')));
      assert.equal((await call('studio_get_project')).revision, saved.revision);
    }
    await fs.writeFile(
      checkpoint,
      JSON.stringify({
        key: entry.key,
        root,
        record,
        index,
        project: saved,
        hashes,
        mediaHash,
        pid: Number(args['desktop-pid']),
      }) + '\n',
    );
    console.log('TAKE_TIMING_RESTART_PREPARED');
  } else {
    const c = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    assert.notEqual(Number(args['desktop-pid']), c.pid);
    await call('studio_open_registered_project', { key: c.key });
    const p = await call('studio_get_project');
    assert.deepEqual(p.generations, c.project.generations);
    assert.deepEqual(p.generations[c.index].generationTiming, c.record);
    for (const k of [
      'dialogues',
      'tracks',
      'voiceEdits',
      'voiceReferences',
      'dubbingTiming',
      'dubbingLanes',
      'sourceCues',
      'targetCues',
    ])
      assert.deepEqual(p[k], c.project[k]);
    assert.equal(await digest(path.join(c.root, p.media.path)), c.mediaHash);
    for (const g of c.hashes)
      assert.equal(await digest(await call('studio_generation_path', { id: g.id })), g.sha256);
    const proof = {
      version: '0.56.0',
      toolCount: 177,
      officialSdk: true,
      actualApplicationRestart: true,
      persistentTakeTiming: true,
      independentDubbingLanesPersisted: true,
      automaticCharacterRoutingPersisted: true,
      manualCharacterRoutingOverrideRetained: true,
      invalidCharacterRoutingRejected: true,
      invalidLaneGainRejected: true,
      batchTimbrePreviewValidated: true,
      batchReferenceImportPersisted: true,
      batchRuntimeGuardPreservesTakes: true,
      invalidMeasurementsRejected: true,
      otherTakesAndMixPreserved: true,
      wavAndVideoHashesPreserved: true,
      syntheticTimingFixture: true,
      noNeuralInference: true,
    };
    await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n');
    console.log('TAKE_TIMING_MCP_PROOF ' + JSON.stringify(proof));
  }
} finally {
  await client.close();
}
