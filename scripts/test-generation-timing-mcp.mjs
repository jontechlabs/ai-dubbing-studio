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
  assert.equal(client.getServerVersion().version, '0.54.0');
  assert.equal(tools.length, 174);
  if (args.phase === 'before') {
    const p = await call('studio_get_project');
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
      'dubbingTiming',
      'sourceCues',
      'targetCues',
    ])
      assert.deepEqual(p[k], c.project[k]);
    assert.equal(await digest(path.join(c.root, p.media.path)), c.mediaHash);
    for (const g of c.hashes)
      assert.equal(await digest(await call('studio_generation_path', { id: g.id })), g.sha256);
    const proof = {
      version: '0.54.0',
      toolCount: 174,
      officialSdk: true,
      actualApplicationRestart: true,
      persistentTakeTiming: true,
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
