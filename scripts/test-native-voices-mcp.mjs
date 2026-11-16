// Real installed weights and actual packaged native paths, in an isolated CI fixture.
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
const client = new Client(
  { name: 'native-voice-models-test', version: '1.0.0' },
  { capabilities: {} },
);
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
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function job(id, timeout = 1800000) {
  const end = Date.now() + timeout;
  let stage = '';
  while (Date.now() < end) {
    const j = (await call('studio_list_jobs')).find((j) => j.id === id);
    if (j?.stage !== stage) {
      stage = j?.stage;
      console.log('Real native voice job', j?.kind, stage);
    }
    if (j && !['queued', 'running', 'paused'].includes(j.status)) {
      assert.equal(j.status, 'succeeded', JSON.stringify(j));
      return j;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error('Real native voice job timed out');
}
function wav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  let at = 12,
    format;
  while (at + 8 <= bytes.length) {
    const n = bytes.readUInt32LE(at + 4),
      name = bytes.toString('ascii', at, at + 4);
    if (name === 'fmt ') {
      format = {
        tag: bytes.readUInt16LE(at + 8),
        channels: bytes.readUInt16LE(at + 10),
        rate: bytes.readUInt32LE(at + 12),
        bits: bytes.readUInt16LE(at + 22),
      };
    }
    if (name === 'data') {
      assert.deepEqual(format, { tag: 1, channels: 1, rate: 24000, bits: 16 });
      const pcm = bytes.subarray(at + 8, at + 8 + n);
      assert(pcm.length >= 12000 && pcm.length <= 120 * 48000);
      let peak = 0;
      for (let p = 0; p < pcm.length; p += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(p)));
      assert(peak > 100);
      return { durationMs: pcm.length / 48, sha256: hash(pcm) };
    }
    at += 8 + n + (n % 2);
  }
  throw Error('Missing PCM');
}
try {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  assert.equal(client.getServerVersion().version, '0.54.0');
  assert.equal(tools.length, 174);
  let p = await call('studio_get_project');
  assert(p?.dialogues.length >= 2);
  const lib = await call('studio_list_projects'),
    entry = lib.entries.find((e) => e.key === lib.activeKey),
    root = path.toNamespacedPath(await fs.realpath(entry.path));
  assert(
    root
      .toLowerCase()
      .startsWith(path.toNamespacedPath(path.resolve(args['test-root'])).toLowerCase() + path.sep),
  );
  const old = p.generations.map((g) => structuredClone(g));
  const movie = hash(await fs.readFile(path.join(root, p.media.path)));
  const originals = await Promise.all(
    old
      .filter((g) => g.kind === 'tts')
      .map(async (g) => ({
        id: g.id,
        sha: hash(await fs.readFile(await call('studio_generation_path', { id: g.id }))),
      })),
  );
  await job(
    await call('studio_change_model_storage', {
      path: path.join(args['test-root'], 'real-native-models'),
    }),
  );
  for (const variantId of ['zonos3-mini-gguf', 'moss-local-v15-gguf-q8']) {
    const space = await call('studio_voice_install_space', { variantId });
    assert(space.enough);
    assert(space.modelBytes > 0);
    await job(await call('studio_install_voice_runtime', { variantId }));
    assert((await call('studio_voice_status')).variants.find((v) => v.id === variantId).installed);
  }
  const url =
    'https://huggingface.co/Zyphra/ZONOS3-Mini/resolve/d2d142a86b1e6aeb4252679673c86ecd86177bf8/gguf/voices/French/Gaspard_fr_M_1.mp3';
  const response = await fetch(url);
  assert(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 303899);
  assert.equal(hash(bytes), 'b353c4f7cccb9ffd335dde8428cae212373db2cf9c7018afc22cbb8f3d6c949a');
  const reference = path.join(args['test-root'], 'Gaspard-francais.mp3');
  await fs.writeFile(reference, bytes);
  const lineId = p.dialogues[0].id;
  const base = {
    variantId: 'zonos3-mini-gguf',
    device: 'cpu',
    referenceMode: 'current',
    referenceId: null,
    mode: 'crossLingual',
    speed: 1,
    seed: 7,
    accent: 'auto',
    mood: 'default',
  };
  await call('studio_import_dubbing_reference', {
    path: reference,
    lineId,
    range: { startMs: 0, endMs: 8000 },
    options: base,
  });
  p = await call('studio_get_project');
  const ref = p.voiceReferences.at(-1);
  assert(ref);
  assert.equal(ref.transcript, '');
  await call('studio_project_patch', {
    patches: [
      { op: 'add', path: '/dialogues/0/ttsText', value: 'Bonjour à tous. Je garde ma voix.' },
    ],
  });
  const options = { ...base, referenceMode: 'file', referenceId: ref.id };
  await job(await call('studio_generate_line', { lineId, options, count: 1 }), 300000);
  p = await call('studio_get_project');
  const neutral = p.generations.at(-1);
  assert.equal(neutral.providerId, 'zonos3');
  const a = wav(await fs.readFile(await call('studio_generation_path', { id: neutral.id })));
  const report = await job(
    await call('studio_generate_line', {
      lineId,
      options: { ...options, accent: 'fr-FR', quality: { accentStrength: 0.75 } },
      count: 2,
    }),
    600000,
  );
  assert(report.logs.some((l) => l.includes('reusing the private batch server')));
  p = await call('studio_get_project');
  const zonos = p.generations.filter((g) => g.modelId === 'zonos3-mini-gguf');
  assert.equal(zonos.length, 3);
  const french = zonos.find((g) => g.options.accent === 'fr-FR');
  assert(french);
  assert.equal(french.options.quality.accentStrength, 0.75);
  assert.equal(french.options.seed, neutral.options.seed);
  const b = wav(await fs.readFile(await call('studio_generation_path', { id: french.id })));
  assert.notEqual(a.sha256, b.sha256);
  await call('studio_project_patch', {
    patches: [
      { op: 'add', path: '/dialogues/0/ttsText', value: 'Bonjour à tous. Je parle français.' },
    ],
  });
  await job(
    await call('studio_generate_line', {
      lineId,
      options: { ...options, variantId: 'moss-local-v15-gguf-q8' },
      count: 1,
    }),
    600000,
  );
  p = await call('studio_get_project');
  const moss = p.generations.at(-1);
  assert.equal(moss.providerId, 'moss-tts-local');
  const c = wav(await fs.readFile(await call('studio_generation_path', { id: moss.id })));
  const transcripts = [];
  for (const [generation, word] of [
    [french, 'voix'],
    [moss, 'francais'],
  ]) {
    await call('studio_import_dubbing_reference', {
      lineId: null,
      path: await call('studio_generation_path', { id: generation.id }),
      options: base,
      range: null,
    });
    let project = await call('studio_get_project');
    const referenceId = project.voiceReferences.at(-1).id;
    await job(
      await call('studio_transcribe_voice_reference', {
        characterId: null,
        referenceId,
        language: 'auto',
      }),
      300000,
    );
    project = await call('studio_get_project');
    const transcript = project.voiceReferences.find((r) => r.id === referenceId).transcript;
    const normalized = transcript
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
    assert(
      normalized.includes('bonjour') && normalized.includes(word),
      JSON.stringify({ model: generation.modelId, transcript }),
    );
    transcripts.push({ model: generation.modelId, text: transcript });
  }
  p = await call('studio_get_project');
  assert.equal(p.formatVersion, 31);
  assert.equal(p.generations.length, old.length + 4);
  for (const g of old)
    assert.deepEqual(
      p.generations.find((n) => n.id === g.id),
      g,
    );
  assert.equal(hash(await fs.readFile(path.join(root, p.media.path))), movie);
  for (const g of originals)
    assert.equal(
      hash(await fs.readFile(await call('studio_generation_path', { id: g.id }))),
      g.sha,
    );
  await call('studio_open_registered_project', { key: entry.key });
  p = await call('studio_get_project');
  assert.equal(p.formatVersion, 31);
  assert.equal(p.generations.at(-1).id, moss.id);
  const proof = {
    version: '0.54.0',
    officialSdk: true,
    realModelInstallers: true,
    realNeuralInference: true,
    cpuVerified: true,
    selectedGpuNotBenchmarked: true,
    referenceWithoutTranscript: true,
    frenchDirectionChangesOutput: true,
    retainedBatchModel: true,
    allOldTakesAndSourcePreserved: true,
    format31NativeReopen: true,
    frenchLexicalContentCheckedWithWhisper: true,
    transcripts,
    zonosNeutral: a,
    zonosFrench075: b,
    mossLocal: c,
  };
  await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n');
  console.log('NATIVE_VOICE_MODELS_PROOF ' + JSON.stringify(proof));
} finally {
  await client.close();
}
