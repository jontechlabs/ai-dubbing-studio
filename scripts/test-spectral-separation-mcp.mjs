// Actual packaged desktop + real weights, using the explicitly CPU-only test
// runtime prepared by test-spectral-separation.py. No GPU qualification claim.
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
assert.equal(neural.version, '0.57.0');
assert.equal(neural.device, 'cpu');
assert.equal(neural.caseCount, 8);
const client = new Client({ name: 'spectral-native-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: args.exe,
  args: ['--mcp', '--endpoint', args.endpoint],
  stderr: 'pipe',
});
let tools, previousKey;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const j = (await call('studio_list_jobs')).find((j) => j.id === id);
    if (j?.status === 'succeeded') return j;
    if (j && ['failed', 'cancelled'].includes(j.status)) throw Error(JSON.stringify(j));
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Spectral desktop job timed out: ' + id);
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
      assert.equal(channels, 1);
      assert.equal(rate, 24000);
      return size / 2;
    }
    at += 8 + size + (size % 2);
  }
  throw Error('Missing PCM samples');
}
const proofs = [];
try {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  assert.equal(client.getServerVersion().version, '0.57.0');
  assert.equal(tools.length, 177);
  const schema = tools.find((t) => t.name === 'studio_separate_dialogue_speakers').inputSchema;
  assert(
    JSON.stringify(schema).includes('speakerCount') &&
      JSON.stringify(schema).includes('memoryProfile'),
  );
  previousKey = (await call('studio_list_projects')).activeKey;
  for (const [file, hash] of Object.entries(neural.inputSourceSha256)) {
    const bytes = await fs.readFile(path.join(path.dirname(args.exe), 'workers', file));
    assert.equal(
      sha(
        file.endsWith('.zip')
          ? bytes
          : Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')),
      ),
      hash,
    );
  }
  for (const [modelId, count] of [
    ['tf-gridnet-wsj0-2mix', 2],
    ['sr-corrnet-whamr-2spk', 2],
    ['sr-corrnet-wsj-2-3spk', 3],
    ['sr-corrnet-wsj-2-5spk', 5],
  ]) {
    console.log('SPECTRAL_MCP_STAGE install/verify', modelId);
    await job(await call('studio_install_speaker_separation_model', { modelId }));
    const status = await call('studio_speaker_separation_status');
    assert(status.models.find((m) => m.id === modelId).installed);
    const name = 'Spectral ' + modelId + ' 日本語',
      root = path.join(args['test-root'], name + '.dubproject');
    await call('studio_create_project', {
      parentPath: args['test-root'],
      name,
      source: 'ja',
      target: 'fr',
    });
    await job(
      await call('studio_import_media', {
        path: neural.videos[String(count)],
        audioStreamIndex: 1,
        forceProxy: false,
      }),
    );
    await call('studio_add_dialogue', {
      options: {
        startMs: 0,
        endMs: 2400,
        sourceText: '声のテスト。',
        targetText: 'Plusieurs voix.',
      },
    });
    const before = await call('studio_get_project'),
      line = before.dialogues[0],
      original = sha(await fs.readFile(path.join(root, before.media.path)));
    const options = {
      lineId: line.id,
      modelId,
      sourceTrackId: 'original',
      startMs: 0,
      endMs: 2400,
      device: 'cpu',
      prompt: '',
      windowSeconds: 2,
      speakerCount: count,
      memoryProfile: 'gpu16',
    };
    const id = await call('studio_separate_dialogue_speakers', { options });
    await job(id);
    const result = await call('studio_speaker_separation_result', { id });
    assert.equal(result.stale, false);
    assert.equal(result.outputs.length, count);
    assert.equal(result.precision, 'fp32');
    assert.equal(result.device, 'cpu');
    assert.equal(result.windowMs, 2000);
    assert.equal(result.peakVramMb, 0);
    const placed = await call('studio_place_speaker_dubbings', {
      id,
      audioLanguage: 'ja',
      assignments: result.outputs.map((outputId, i) => ({
        outputId,
        label: 'Voix ' + (i + 1),
        characterId: null,
        sourceText: '声 ' + i,
        targetText: 'Voix ' + i,
        laneId: null,
        laneName: 'Isolée ' + (i + 1),
      })),
    });
    assert.equal(placed.formatVersion, 35);
    assert.equal(placed.speakerDubbings.at(-1).voices.length, count);
    assert.equal(placed.dubbingLanes.lanes.length, count + 1);
    assert.deepEqual(placed.sourceCues, before.sourceCues);
    assert.deepEqual(placed.targetCues, before.targetCues);
    const takes = placed.generations.filter((g) => g.kind === 'tts');
    assert.equal(takes.length, count);
    const hashes = [];
    for (const g of takes) {
      const file = await call('studio_generation_path', { id: g.id }),
        bytes = await fs.readFile(file);
      assert.equal(frames(bytes), 2400 * 24);
      assert.equal(g.takeOrigin.sourceLanguage, 'ja');
      assert.equal(g.takeOrigin.type, 'separation');
      hashes.push([g.id, sha(bytes)]);
    }
    await call('studio_history', { direction: 'undo' });
    assert.deepEqual((await call('studio_get_project')).generations, before.generations);
    await call('studio_history', { direction: 'redo' });
    assert.deepEqual((await call('studio_get_project')).generations, placed.generations);
    await call('studio_open_project', { path: root });
    const reopened = await call('studio_get_project');
    assert.deepEqual(reopened.speakerDubbings, placed.speakerDubbings);
    assert.deepEqual(reopened.dubbingLanes, placed.dubbingLanes);
    assert.equal(sha(await fs.readFile(path.join(root, reopened.media.path))), original);
    for (const [id, hash] of hashes)
      assert.equal(sha(await fs.readFile(await call('studio_generation_path', { id }))), hash);
    proofs.push({
      modelId,
      speakerCount: count,
      realCpuInference: true,
      modelInstallationVerified: true,
      independentSelectedTakes: true,
      exactPcmFrames: true,
      undoRedo: true,
      reopened: true,
      videoAndSubtitlesPreserved: true,
      takeHashesPreserved: true,
    });
  }
  const proof = {
    version: '0.57.0',
    toolCount: 177,
    officialSdk: true,
    actualPackagedApplication: true,
    cpuOnlyFixture: true,
    rtx5060TiQualified: false,
    cases: proofs,
  };
  await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n');
  console.log('SPECTRAL_MCP_PROOF', JSON.stringify(proof));
} finally {
  if (previousKey)
    await call('studio_open_registered_project', { key: previousKey }).catch(() => {});
  await client.close();
}
