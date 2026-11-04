// Real packaged WebView, synthetic microphone, WAV files and JS/Rust persistence.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
  assert.equal(client.getServerVersion().version, '0.41.0');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 157);
  assert(tools.some((t) => t.name === 'studio_dubbing_batch_report'));
  assert(tools.some((t) => t.name === 'studio_retry_dubbing_batch'));
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
    name: 'Batch recovery 日本語',
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
      [1, 2, 3]
        .map(
          (n) =>
            `${n}\n00:00:${String(n * 3).padStart(2, '0')},000 --> 00:00:${String(n * 3 + 2).padStart(2, '0')},000\n${text}\n`,
        )
        .join('\n'),
      'utf8',
    );
    await call('studio_import_subtitles', { context: await context(), path: file, role });
  }
  let p = await call('studio_get_project');
  const id = p.dialogues[0].id;
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
  const batchId = randomUUID(),
    itemId = randomUUID();
  await call('studio_project_patch', {
    context: await context(),
    patches: [{ op: 'add', path: '/generations/0/batchItemId', value: itemId }],
  });
  p = await call('studio_get_project');
  const before = structuredClone(p),
    hashes = await wavs(p);
  assert(Number.isFinite(Date.parse(p.generations[0].createdAt)));
  const projects = await call('studio_list_projects'),
    entry = projects.entries.find((e) => e.key === projects.activeKey);
  const options = {
    variantId: 'cosy3-official',
    device: 'cpu',
    referenceMode: 'file',
    referenceId: 'missing-reference',
    mode: 'crossLingual',
    speed: 1.1,
    seed: 13,
  };
  const request = {
    root: entry.path,
    project_id: p.id,
    language: 'fr',
    approved_only: false,
    unapproved_only: false,
    skipped: 0,
    items: p.dialogues.map((l, n) => ({
      status: ['succeeded', 'failed', 'pending'][n],
      error: n === 1 ? 'TTS_EMPTY_AUDIO' : null,
      request: {
        root: entry.path,
        projectId: p.id,
        lineId: l.id,
        options,
        fingerprint: 'diagnostic-only-not-inferred',
        batchItemId: n === 0 ? itemId : randomUUID(),
      },
    })),
  };
  const dir = path.join(path.dirname(args.endpoint), 'batches', batchId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(request), 'utf8');
  let report = await call('studio_dubbing_batch_report', { id: batchId });
  assert.equal(report.matching, 2);
  assert.equal(report.progress.succeeded, 1);
  assert.equal(report.progress.failed, 1);
  assert.deepEqual(
    report.items.map((r) => r.status),
    ['failed', 'pending'],
  );
  report = await call('studio_dubbing_batch_report', {
    id: batchId,
    offset: 1,
    limit: 1,
    problemsOnly: false,
  });
  assert.equal(report.matching, 3);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].lineId, p.dialogues[1].id);
  const completed = await call('studio_dubbing_batch_report', { id: batchId, problemsOnly: false });
  assert.equal(completed.items[0].createdAt, p.generations[0].createdAt);
  assert.equal(completed.items[0].generationId, p.generations[0].id);
  for (const selection of [
    { scope: 'selected', lineIds: [id] },
    { scope: 'selected', lineIds: [p.dialogues[1].id, 'unknown'] },
  ]) {
    const refused = await client.callTool({
      name: 'studio_retry_dubbing_batch',
      arguments: { context: await context(), id: batchId, selection },
    });
    assert(refused.isError);
  }
  const job = async (id) => {
    await until(async () => {
      const j = (await call('studio_list_jobs')).find((j) => j.id === id);
      return j && !['queued', 'running', 'paused'].includes(j.status);
    });
  };
  const one = await call('studio_retry_dubbing_batch', {
    context: await context(),
    id: batchId,
    selection: { scope: 'selected', lineIds: [p.dialogues[1].id] },
  });
  await job(one);
  report = await call('studio_dubbing_batch_report', { id: one });
  assert.equal(report.reportId, batchId);
  assert.notEqual(report.items[0].error, 'TTS_EMPTY_AUDIO');
  const two = await call('studio_retry_dubbing_batch', {
    context: await context(),
    id: batchId,
    selection: { scope: 'unfinished', lineIds: [] },
  });
  await job(two);
  report = await call('studio_dubbing_batch_report', { id: batchId });
  assert.equal(report.progress.succeeded, 1);
  assert.equal(report.progress.failed, 2);
  assert(report.items.every((r) => r.status === 'failed' && r.error));
  await call('studio_close_project');
  await until(async () => (await state()).screen === 'home');
  await call('studio_open_registered_project', { key: entry.key });
  assert.equal((await call('studio_dubbing_batch_report', { id: two })).reportId, batchId);
  p = await call('studio_get_project');
  assert.deepEqual(p.generations, before.generations);
  assert.deepEqual(await wavs(p), hashes);
  assert.deepEqual(p.sourceCues, before.sourceCues);
  assert.deepEqual(p.targetCues, before.targetCues);
  const proof = {
    version: '0.41.0',
    officialSdk: true,
    toolCount: 157,
    realMicrophoneTakes: 1,
    realStoredTimestamp: true,
    paginatedReport: true,
    successAndFailureAndPending: true,
    successfulTakeRetryRejected: true,
    mixedInvalidIdsRejected: true,
    individualPreflightRetry: true,
    multiplePreflightRetry: true,
    originReportUpdated: true,
    nativeReopen: true,
    wavAndTimestampPreserved: true,
    noNeuralInference: true,
  };
  await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  console.log('BATCH_RECOVERY_MCP_PROOF ' + JSON.stringify(proof));
} finally {
  await client.close();
}
