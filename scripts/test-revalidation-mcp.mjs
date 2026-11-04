// Real packaged WebView, synthetic microphone, WAV files and JS/Rust persistence.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((r, v, i, a) => (i % 2 === 0 ? [...r, [v.slice(2), a[i + 1]]] : r), []),
);
const client = new Client({ name: 'revalidation-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: args.exe,
  args: ['--mcp', '--endpoint', args.endpoint],
  stderr: 'pipe',
});
const call = async (name, parameters = {}) => {
  const r = await client.callTool({ name, arguments: parameters });
  if (r.isError) throw Error(r.content.map((c) => c.text ?? '').join('\n'));
  return r.structuredContent.value;
};
const state = () => call('studio_get_state');
const context = async () => (await state()).context;
const until = async (check) => {
  const deadline = Date.now() + 60000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('Packaged UI timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const wavs = async (p) =>
  Object.fromEntries(
    await Promise.all(
      p.generations.map(async (g) => {
        const bytes = await fs.readFile(await call('studio_generation_path', { id: g.id }));
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        assert(bytes.length > 44 + 150 * 48);
        return [g.id, createHash('sha256').update(bytes).digest('hex')];
      }),
    ),
  );
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, '0.40.2');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 155);
  for (const name of ['studio_review_take', 'studio_approve_translations'])
    assert.equal(
      tools.find((t) => t.name === name).inputSchema.properties.acceptChangedTake.type,
      'boolean',
    );
  await until(async () => {
    try {
      return (await state()).screen === 'home';
    } catch (e) {
      if (!String(e).includes('MCP_UI_NOT_READY')) throw e;
      return false;
    }
  });
  await call('studio_create_library_project', {
    parentPath: args['test-root'],
    name: 'Revalidation 日本語',
    source: 'ja',
    target: 'fr',
  });
  for (const [role, text] of [
    ['source', 'こんにちは。'],
    ['target', 'Bonjour.'],
  ]) {
    const file = path.join(args['test-root'], role + '.srt');
    await fs.writeFile(file, `1\n00:00:01,000 --> 00:00:03,500\n${text}\n`, 'utf8');
    await call('studio_import_subtitles', { context: await context(), path: file, role });
  }
  let p = await call('studio_get_project');
  const id = p.dialogues[0].id;
  for (let n = 0; n < 2; n++) {
    await call('studio_microphone', { action: 'start', lineId: id, context: await context() });
    await until(async () => {
      const m = (await state()).microphone;
      if (m.error) throw Error(JSON.stringify(m));
      return m.phase === 'recording' && m.durationMs >= 900;
    });
    await call('studio_microphone', { action: 'stop', context: await context() });
    await until(async () => (await state()).microphone.phase === 'ready');
    await call('studio_microphone', { action: 'save', context: await context() });
    await until(async () => (await state()).microphone.phase === 'idle');
  }
  p = await call('studio_get_project');
  assert.equal(p.generations.length, 2);
  const original = structuredClone(p),
    hashes = await wavs(p);
  await call('studio_edit_dialogue', {
    context: await context(),
    lineId: id,
    role: 'tts',
    text: 'Bonsoir, une autre réplique.',
  });
  const refusal = await client.callTool({
    name: 'studio_review_take',
    arguments: { context: await context(), lineId: id, validated: true },
  });
  assert(refusal.isError);
  assert(JSON.stringify(refusal.content).includes('TTS_STALE_GENERATION'));
  await call('studio_review_take', {
    context: await context(),
    lineId: id,
    validated: true,
    acceptChangedTake: true,
  });
  p = await call('studio_get_project');
  assert(p.translationApprovals[id]);
  assert.equal(p.dialogues[0].status, 'validated');
  assert.deepEqual(p.generations, original.generations);
  assert.deepEqual(p.sourceCues, original.sourceCues);
  assert.deepEqual(p.targetCues, original.targetCues);
  const key = (await call('studio_list_projects')).activeKey;
  await call('studio_close_project');
  await until(async () => (await state()).screen === 'home');
  await call('studio_open_registered_project', { key });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 1);
  await call('studio_retime_dialogue', {
    context: await context(),
    lineId: id,
    role: 'both',
    startMs: 1000,
    endMs: 3700,
  });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 0);
  await call('studio_approve_translations', {
    context: await context(),
    ids: [id],
    approved: true,
  });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 0);
  await call('studio_approve_translations', {
    context: await context(),
    ids: [id],
    approved: true,
    acceptChangedTake: true,
  });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 1);
  await call('studio_approve_translations', {
    context: await context(),
    ids: [id],
    approved: false,
  });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 0);
  await call('studio_history', { context: await context(), direction: 'undo' });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 1);
  await call('studio_edit_dialogue', {
    context: await context(),
    lineId: id,
    role: 'target',
    text: 'Une correction ultérieure.',
  });
  assert.equal((await call('studio_get_dialogues', { status: 'approved' })).total, 0);
  p = await call('studio_get_project');
  assert.deepEqual(p.generations, original.generations);
  assert.deepEqual(await wavs(p), hashes);
  const proof = {
    version: '0.40.2',
    officialSdk: true,
    toolCount: 155,
    realMicrophoneTakes: 2,
    staleRejectedByDefault: true,
    explicitAcceptance: true,
    nativeReopenPreservesReview: true,
    bulkDefaultSkipsStale: true,
    bulkExplicitAcceptance: true,
    laterChangesWithdrawReview: true,
    undoReview: true,
    allGenerationMetadataPreserved: true,
    allWavHashesPreserved: true,
  };
  await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  console.log('REVALIDATION_MCP_PROOF ' + JSON.stringify(proof));
} finally {
  await client.close();
}
