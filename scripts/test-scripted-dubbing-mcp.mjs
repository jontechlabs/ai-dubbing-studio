import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((rows, item, i, list) => (i % 2 ? rows : [...rows, [item.slice(2), list[i + 1]]]), []),
);
assert(args['test-root'].includes('volume-leveling-native'));
const client = new Client(
  { name: 'scripted-dubbing-packaged-test', version: '1.0.0' },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: args.exe,
  args: ['--mcp', '--endpoint', args.endpoint],
  stderr: 'pipe',
});
async function call(name, parameters = {}) {
  const response = await client.callTool({ name, arguments: parameters });
  if (response.isError) throw Error(response.content.map((c) => c.text ?? '').join('\n'));
  return response.structuredContent.value;
}
const context = async () => (await call('studio_get_state')).context;
const checkpoint = path.join(args['test-root'], 'scripted-dubbing-checkpoint.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function until(operation) {
  const deadline = Date.now() + 30000;
  while (!(await operation())) {
    if (Date.now() > deadline) throw Error('Script dubbing UI did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function failure(name, parameters, code) {
  await assert.rejects(
    () => call(name, parameters),
    (error) => String(error).includes(code),
  );
}
try {
  await client.connect(transport);
  await until(async () => {
    try {
      await call('studio_get_state');
      return true;
    } catch (error) {
      if (String(error).includes('MCP_UI_NOT_READY')) return false;
      throw error;
    }
  });
  assert.equal(client.getServerVersion().version, '0.59.0');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 180);
  for (const name of [
    'preview_scripted_dubbing',
    'create_scripted_dubbing',
    'generate_scripted_dubbing',
  ])
    assert(tools.some((t) => t.name === 'studio_' + name));
  if (args.phase === 'after') {
    const previous = JSON.parse(await fs.readFile(checkpoint, 'utf8')),
      p = await call('studio_open_project', { path: previous.projectPath });
    assert.deepEqual(p.dialogues, previous.project.dialogues);
    assert.deepEqual(p.dubbingLanes, previous.project.dubbingLanes);
    assert.deepEqual(p.generations, previous.project.generations);
    assert.deepEqual(p.voiceReferences, previous.project.voiceReferences);
    assert.equal(hash(await fs.readFile(previous.source)), previous.sourceSha256);
    await fs.writeFile(
      args.proof,
      JSON.stringify(
        {
          version: '0.59.0',
          toolCount: 180,
          scriptTurns: 3,
          speakers: 2,
          overlap: true,
          referencePerSpeaker: true,
          preservedTakeCount: p.generations.length,
          staleRejected: true,
          invalidTimingRejected: true,
          missingReferenceRejected: true,
          missingRuntimeStartsNoJob: true,
          undoRedo: true,
          reopen: true,
          actualProcessRestart: true,
          sourceUnchanged: true,
          localTtsQualityNotMeasured: true,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const options = {
      variantId: 'cosy3-official',
      device: 'cpu',
      referenceMode: 'file',
      referenceId: null,
      mode: 'crossLingual',
      speed: 1,
      seed: 42,
    };
    const imported = [];
    const referencePath = path.join(args['test-root'], 'session', 'synthetic-microphone.wav');
    await fs.access(referencePath);
    for (let i = 0; i < 2; i++) {
      const p = await call('studio_import_dubbing_reference', {
        lineId: null,
        path: referencePath,
        options,
        range: { startMs: 0, endMs: 1000 },
        context: await context(),
      });
      imported.push(p.voiceReferences.at(-1).id);
    }
    const before = await call('studio_get_project'),
      lib = await call('studio_list_projects'),
      entry = lib.entries.find((e) => e.key === lib.activeKey);
    assert(
      before.generations.length > 0,
      'The earlier packaged microphone/timing fixture must survive script editing',
    );
    const source = path.join(entry.path, before.media.path),
      sourceSha256 = hash(await fs.readFile(source));
    const spec = {
      script:
        '[Speaker 1: Femme adulte] Bonjour.\n[Speaker 2: Jeune fille] Oui !\n[Speaker 1] Approchez.',
      startMs: 500,
      durationMs: 2000,
      slots: [
        { startMs: 500, endMs: 2200 },
        { startMs: 1000, endMs: 2000 },
        { startMs: 2300, endMs: 3500 },
      ],
      speakers: [
        {
          speaker: 1,
          name: 'Femme adulte',
          characterId: null,
          referenceMode: 'file',
          referenceId: imported[0],
        },
        {
          speaker: 2,
          name: 'Jeune fille',
          characterId: null,
          referenceMode: 'file',
          referenceId: imported[1],
        },
      ],
      options,
    };
    const preview = await call('studio_preview_scripted_dubbing', { options: spec });
    assert.deepEqual(
      preview.turns.map((t) => t.text),
      ['Bonjour.', 'Oui !', 'Approchez.'],
    );
    const c = await context();
    const mutate = (o) => ({
      projectId: c.projectId,
      expectedRevision: c.expectedRevision,
      options: o,
      context: c,
    });
    await failure(
      'studio_create_scripted_dubbing',
      { ...mutate(spec), expectedRevision: c.expectedRevision - 1 },
      'STALE_REVISION',
    );
    const missing = structuredClone(spec);
    missing.speakers[1].referenceId = 'missing';
    await failure('studio_create_scripted_dubbing', mutate(missing), 'SCRIPT_REFERENCE_REQUIRED');
    const overlap = structuredClone(spec);
    overlap.slots[2] = { startMs: 600, endMs: 2000 };
    await failure('studio_create_scripted_dubbing', mutate(overlap), 'SCRIPT_SPEAKER_OVERLAP');
    const bounds = structuredClone(spec);
    bounds.slots[0].endMs = before.media.durationMs + 1;
    await failure('studio_create_scripted_dubbing', mutate(bounds), 'SCRIPT_TIMING_INVALID');
    assert.deepEqual(await call('studio_get_project'), before, 'All failures must be atomic');
    const created = await call('studio_create_scripted_dubbing', mutate(spec));
    assert.equal(created.lineIds.length, 3);
    const after = created.project;
    assert.deepEqual(after.generations, before.generations);
    assert.deepEqual(after.sourceCues, before.sourceCues);
    assert.deepEqual(after.media, before.media);
    for (const cue of before.targetCues)
      assert(after.targetCues.some((c) => JSON.stringify(c) === JSON.stringify(cue)));
    const lines = created.lineIds.map((id) => after.dialogues.find((l) => l.id === id));
    assert.deepEqual(
      lines.map((l) => [l.startMs, l.endMs]),
      spec.slots.map((s) => [s.startMs, s.endMs]),
    );
    assert.deepEqual(
      lines.map((l) => l.voiceSettings.referenceId),
      [imported[0], imported[1], imported[0]],
    );
    assert.notEqual(
      after.dubbingLanes.assignments[lines[0].id],
      after.dubbingLanes.assignments[lines[1].id],
    );
    assert.equal(
      after.dubbingLanes.assignments[lines[0].id],
      after.dubbingLanes.assignments[lines[2].id],
    );
    const priorJobs = await call('studio_list_jobs'),
      generationContext = await context();
    await failure(
      'studio_generate_scripted_dubbing',
      {
        ...generationContext,
        selection: { lineIds: created.lineIds, takeCount: 1 },
        context: generationContext,
      },
      'TTS_RUNTIME_REQUIRED',
    );
    assert.deepEqual(
      (await call('studio_list_jobs')).map((j) => j.id),
      priorJobs.map((j) => j.id),
    );
    const undone = await call('studio_history', { direction: 'undo', context: await context() });
    assert.deepEqual(undone.dialogues, before.dialogues);
    assert.deepEqual(undone.dubbingLanes, before.dubbingLanes);
    const redone = await call('studio_history', { direction: 'redo', context: await context() });
    assert.deepEqual(redone.dialogues, after.dialogues);
    assert.deepEqual(redone.dubbingLanes, after.dubbingLanes);
    const reopened = await call('studio_open_project', { path: entry.path });
    assert.deepEqual(reopened.dialogues, after.dialogues);
    assert.deepEqual(reopened.generations, before.generations);
    await call('studio_preferences', { panel: 'scriptDub' });
    await until(async () => (await call('studio_get_state')).preferences.panel === 'scriptDub');
    assert.equal(hash(await fs.readFile(source)), sourceSha256);
    await fs.writeFile(
      checkpoint,
      JSON.stringify({ project: reopened, projectPath: entry.path, source, sourceSha256 }, null, 2),
    );
  }
  console.log('Packaged script dubbing contracts passed: ' + args.phase);
} finally {
  await client.close();
  await transport.close();
}
