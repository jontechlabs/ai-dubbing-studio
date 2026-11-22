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
const neural = JSON.parse(await fs.readFile(args['neural-proof'], 'utf8'));
assert.equal(neural.version, '0.58.0');
assert.equal(neural.device, 'cpu');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const client = new Client(
  { name: 'inworld-packaged-test', version: '1.0.0' },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: args.exe,
  args: ['--mcp', '--endpoint', args.endpoint],
  stderr: 'pipe',
});
let tools, previousKey;
async function call(name, input = {}) {
  if (
    tools?.find((t) => t.name === name)?.inputSchema.properties?.context &&
    input.context === undefined
  )
    input = { ...input, context: (await call('studio_get_state')).context };
  const result = await client.callTool({ name, arguments: input });
  if (result.isError) throw Error(result.content.map((c) => c.text ?? '').join('\n'));
  return result.structuredContent.value;
}
async function job(id) {
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    const j = (await call('studio_list_jobs')).find((j) => j.id === id);
    if (j?.status === 'succeeded') return j;
    if (j && ['failed', 'cancelled'].includes(j.status)) throw Error(JSON.stringify(j));
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Inworld job timeout: ' + id);
}
function frames(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  let at = 12,
    rate,
    channels;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4),
      kind = bytes.toString('ascii', at, at + 4);
    if (kind === 'fmt ') {
      assert.equal(bytes.readUInt16LE(at + 8), 1);
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
      assert.equal(bytes.readUInt16LE(at + 22), 16);
    }
    if (kind === 'data') {
      assert.equal(channels, 2);
      assert.equal(rate, 48000);
      return size / 4;
    }
    at += 8 + size + (size % 2);
  }
  throw Error('No PCM samples');
}
try {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  assert.equal(client.getServerVersion().version, '0.58.0');
  assert.equal(tools.length, 177);
  previousKey = (await call('studio_list_projects')).activeKey;
  for (const [name, hash] of Object.entries(neural.inputSourceSha256)) {
    const bytes = await fs.readFile(path.join(path.dirname(args.exe), 'workers', name));
    assert.equal(sha(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))), hash, name);
  }
  await job(
    await call('studio_install_audio_toolbox_model', { modelId: 'inworld-voice-isolator-v1' }),
  );
  const status = await call('studio_audio_toolbox_status'),
    model = status.models.find((m) => m.id === 'inworld-voice-isolator-v1');
  assert(model.installed);
  assert.deepEqual(model.outputs, ['vocals', 'instrumental']);
  const name = 'Inworld CPU 日本語',
    root = path.join(args['test-root'], name + '.dubproject');
  await call('studio_create_project', {
    parentPath: args['test-root'],
    name,
    source: 'en',
    target: 'fr',
  });
  await job(
    await call('studio_import_media', {
      path: neural.video,
      audioStreamIndex: 1,
      forceProxy: false,
    }),
  );
  await call('studio_add_dialogue', {
    options: {
      startMs: 0,
      endMs: 3000,
      sourceText: 'Recorded voice.',
      targetText: 'Voix enregistrée.',
    },
  });
  const before = await call('studio_get_project'),
    videoHash = sha(await fs.readFile(path.join(root, before.media.path)));
  const id = await call('studio_separate_audio_selection', {
    options: {
      modelId: model.id,
      sourceTrackId: 'original',
      startMs: 0,
      endMs: 3000,
      device: 'cpu',
      prompt: '',
      windowSeconds: 2,
    },
  });
  await job(id);
  const result = await call('studio_audio_toolbox_result', { id });
  assert.equal(result.device, 'cpu');
  assert.equal(result.precision, 'fp32');
  assert.equal(result.windowMs, 2000);
  assert.equal(result.peakVramMb, 0);
  assert.equal(result.stale, false);
  assert.deepEqual((await call('studio_get_project')).generations, before.generations);
  const outputHashes = {};
  for (const outputId of result.outputs) {
    const bytes = await fs.readFile(await call('studio_audio_toolbox_path', { id, outputId }));
    assert.equal(frames(bytes), 144000);
    outputHashes[outputId] = sha(bytes);
  }
  const placed = await call('studio_apply_audio_toolbox_result', {
    id,
    muteSource: true,
    destinations: [
      { outputId: 'vocals', trackId: null, role: 'speech' },
      { outputId: 'instrumental', trackId: null, role: 'sfx' },
    ],
  });
  const patches = placed.generations.filter((g) => g.kind === 'audioPatch');
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map((g) => placed.tracks.find((t) => t.id === g.trackId).role).sort(), [
    'sfx',
    'speech',
  ]);
  for (const p of patches) {
    assert.equal(p.startMs, 0);
    assert.equal(p.endMs, 3000);
    assert.equal(p.mode, 'replace');
  }
  assert.deepEqual(placed.sourceCues, before.sourceCues);
  assert.deepEqual(placed.targetCues, before.targetCues);
  assert.deepEqual(placed.media, before.media);
  await call('studio_history', { direction: 'undo' });
  assert.deepEqual((await call('studio_get_project')).generations, before.generations);
  await call('studio_history', { direction: 'redo' });
  assert.deepEqual((await call('studio_get_project')).generations, placed.generations);
  await call('studio_open_project', { path: root });
  const reopened = await call('studio_get_project');
  assert.deepEqual(reopened.generations, placed.generations);
  assert.equal(sha(await fs.readFile(path.join(root, reopened.media.path))), videoHash);
  for (const outputId of result.outputs)
    assert.equal(
      sha(await fs.readFile(await call('studio_audio_toolbox_path', { id, outputId }))),
      outputHashes[outputId],
    );
  const proof = {
    version: '0.58.0',
    toolCount: 177,
    officialSdk: true,
    actualPackagedApplication: true,
    realCpuInference: true,
    modelInstallationVerified: true,
    bundledSourcesVerified: true,
    previewBeforeApply: true,
    exactStereoPcmFrames: true,
    voiceAndBackgroundPlaced: true,
    undoRedo: true,
    reopened: true,
    videoAndSubtitlesPreserved: true,
    outputHashesPreserved: true,
    rtx5060TiQualified: false,
  };
  await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n');
  console.log('INWORLD_MCP_PROOF', JSON.stringify(proof));
} finally {
  if (previousKey)
    await call('studio_open_registered_project', { key: previousKey }).catch(() => {});
  await client.close();
}
