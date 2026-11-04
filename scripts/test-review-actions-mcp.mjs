// Focused actual packaged review/persistence smoke; no neural model or user project.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((r, v, i, a) => (i % 2 === 0 ? [...r, [v.slice(2), a[i + 1]]] : r), []),
);
const client = new Client(
  { name: 'review-actions-validation', version: '1.0.0' },
  { capabilities: {} },
);
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
const context = async () => (await call('studio_get_state')).context;
const screen = async (expected) => {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      if ((await call('studio_get_state')).screen === expected) return;
    } catch (e) {
      if (!String(e).includes('MCP_UI_NOT_READY')) throw e;
    }
    if (Date.now() > deadline) throw Error('Desktop screen did not become ' + expected);
    await new Promise((r) => setTimeout(r, 100));
  }
};
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 155);
  assert.equal(client.getServerVersion().version, '0.40.1');
  await screen('home');
  const created = await call('studio_create_library_project', {
    parentPath: args['test-root'],
    name: 'Review actions 日本語',
    source: 'ja',
    target: 'fr',
  });
  for (const [role, text] of [
    ['source', 'こんにちは。'],
    ['target', 'Bonjour.'],
  ]) {
    const file = path.join(args['test-root'], role + '.srt');
    await fs.writeFile(
      file,
      `1\n00:00:01,000 --> 00:00:02,500\n${text}\n\n2\n00:00:03,000 --> 00:00:04,500\n${text}\n`,
      'utf8',
    );
    await call('studio_import_subtitles', { context: await context(), path: file, role });
  }
  const before = await call('studio_get_project'),
    id = before.dialogues[0].id;
  await call('studio_approve_translations', {
    context: await context(),
    ids: [id],
    approved: true,
  });
  let p = await call('studio_get_project');
  assert(p.translationApprovals[id]);
  // Approving text before a take exists does not invent a validated voice.
  assert.equal(p.dialogues[0].status, before.dialogues[0].status);
  for (const key of ['sourceCues', 'targetCues', 'generations', 'characters', 'media'])
    assert.deepEqual(p[key], before[key]);
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
    text: 'Bonjour après correction.',
  });
  p = await call('studio_get_project');
  assert(!p.translationApprovals?.[id]);
  assert.deepEqual(p.generations, before.generations);
  assert.deepEqual(p.sourceCues, before.sourceCues);
  const index = await call('studio_list_projects'),
    key = index.activeKey;
  assert(key);
  await call('studio_close_project');
  await screen('home');
  await call('studio_open_registered_project', { key });
  const reopened = await call('studio_get_project');
  assert.equal(reopened.id, created.id);
  assert.deepEqual(reopened.targetCues, p.targetCues);
  assert.deepEqual(reopened.sourceCues, p.sourceCues);
  assert.deepEqual(reopened.generations, p.generations);
  assert(!reopened.translationApprovals?.[id]);
  const proof = {
    version: '0.40.1',
    officialSdk: true,
    toolCount: tools.length,
    startupHome: true,
    approveAndWithdraw: true,
    undoReview: true,
    translationEditWithdrawsApproval: true,
    sourceAndGenerationFieldsUnchanged: true,
    generationCount: before.generations.length,
    reopenPreservesReview: true,
    noNeuralModelsRequired: true,
  };
  await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  console.log('REVIEW_ACTIONS_MCP_PROOF ' + JSON.stringify(proof));
} finally {
  await client.close();
}
