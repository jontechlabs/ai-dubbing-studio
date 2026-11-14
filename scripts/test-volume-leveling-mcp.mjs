// Qualify the actual packaged app, PCM audio and durable edits through the official SDK.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, s) => (i % 2 ? a : [...a, [v.slice(2), s[i + 1]]]), []),
);
const client = new Client({ name: 'volume-leveling-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: args.exe,
  args: ['--mcp', '--endpoint', args.endpoint],
  stderr: 'pipe',
});
const call = async (name, arguments_ = {}) => {
  const r = await client.callTool({ name, arguments: arguments_ });
  if (r.isError) throw Error(r.content.map((c) => c.text ?? '').join('\n'));
  return r.structuredContent.value;
};
const state = () => call('studio_get_state'),
  context = async () => (await state()).context;
const until = async (fn) => {
  const deadline = Date.now() + 60000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error('Packaged levelling timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const hash = (b) => createHash('sha256').update(b).digest('hex');
function pcm(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'data')
      return bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw Error('Missing PCM');
}
const rms = (bytes, start, end) => {
  let sum = 0;
  for (let i = start * 4; i < end * 4; i += 2) sum += (bytes.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / ((end - start) * 2));
};
function fixture() {
  const b = Buffer.alloc(44 + 130250 * 192);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(192000, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  for (let i = 0; i < 130250 * 48; i++) {
    const a = i < 60 * 48000 ? 0.05 : i < 120 * 48000 ? 0.4 : 0;
    const v = Math.round(Math.sin((i / 48000) * 440 * 2 * Math.PI) * 32767 * a);
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(-v, 46 + i * 4);
  }
  return b;
}
async function job(id) {
  let last;
  await until(async () => {
    last = (await call('studio_list_jobs')).find((j) => j.id === id);
    return last && !['queued', 'running', 'paused'].includes(last.status);
  });
  assert.equal(last.status, 'succeeded', JSON.stringify(last));
}
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, '0.50.0');
  assert.equal((await client.listTools()).tools.length, 170);
  await until(async () => {
    try {
      return (await state()).screen === 'home';
    } catch (e) {
      if (!String(e).includes('MCP_UI_NOT_READY')) throw e;
      return false;
    }
  });
  const checkpoint = path.join(args['test-root'], 'leveling-checkpoint.json');
  if (args.phase === 'before') {
    await call('studio_load_demo');
    let p = await call('studio_get_project');
    const line = p.dialogues[0];
    await call('studio_microphone', { action: 'start', lineId: line.id, context: await context() });
    await until(async () => {
      const m = (await state()).microphone;
      if (m.error) throw Error(JSON.stringify(m));
      return m.phase === 'recording' && m.durationMs >= 900;
    });
    await call('studio_microphone', { action: 'stop', context: await context() });
    await until(async () => (await state()).microphone.phase === 'ready');
    await call('studio_microphone', { action: 'save', context: await context() });
    await until(async () => (await state()).microphone.phase === 'idle');
    p = await call('studio_get_project');
    const lib = await call('studio_list_projects'),
      entry = lib.entries.find((e) => e.key === lib.activeKey),
      root = path.toNamespacedPath(await fs.realpath(entry.path));
    const original = fixture();
    await fs.writeFile(path.join(root, 'stems', 'level-test.wav'), original);
    await call('studio_project_patch', {
      context: await context(),
      patches: [
        { op: 'replace', path: '/media/durationMs', value: 130250 },
        {
          op: 'add',
          path: '/tracks/-',
          value: {
            id: 'level-test',
            kind: 'audio',
            role: 'speech',
            name: 'Level test',
            path: 'stems/level-test.wav',
            durationMs: 130250,
            sourcePath: p.media.path,
            language: 'ja',
            mute: false,
            solo: false,
            gain: 1,
          },
        },
      ],
    });
    p = await call('studio_get_project');
    const before = structuredClone(p),
      movie = hash(await fs.readFile(path.join(root, p.media.path))),
      take = hash(
        await fs.readFile(await call('studio_generation_path', { id: p.generations[0].id })),
      );
    for (const mode of ['low', 'high']) {
      const c = await context();
      const options = {
        mediaId: p.media.id,
        trackId: 'level-test',
        startMs: 0,
        endMs: 130250,
        mode,
      };
      const id = await call('studio_prepare_volume_leveling', {
        context: c,
        projectId: c.projectId,
        expectedRevision: c.expectedRevision,
        options,
      });
      await job(id);
      const details = await call('studio_volume_leveling_result', { id });
      assert.equal(details.options.mode, mode);
      assert(Number.isFinite(details.stats.targetDb));
      const audio = pcm(
        await fs.readFile(await call('studio_volume_leveling_path', { id, role: 'leveled' })),
      );
      assert.equal(audio.length, 130250 * 192);
      assert(Math.abs(rms(audio, 48000, 72000) / rms(audio, 70 * 48000, 71 * 48000) - 1) < 0.02);
      assert(audio.subarray(120 * 48000 * 4).every((v) => v === 0));
      assert.deepEqual((await call('studio_get_project')).generations, before.generations);
      if (mode === 'low') await call('studio_discard_volume_leveling', { id });
      else {
        await call('studio_project_patch', {
          context: await context(),
          patches: [
            {
              op: 'add',
              path: '/tracks/-',
              value: {
                ...p.tracks.find((t) => t.id === 'level-test'),
                id: 'level-companion',
                name: 'Companion',
              },
            },
          ],
        });
        // A project edit invalidates previous previews: explicitly reprepare both at one revision.
        await call('studio_discard_volume_leveling', { id });
        p = await call('studio_get_project');
        const ids = [];
        for (const trackId of ['level-test', 'level-companion']) {
          const c = await context();
          const key = await call('studio_prepare_volume_leveling', {
            context: c,
            projectId: c.projectId,
            expectedRevision: c.expectedRevision,
            options: { mediaId: p.media.id, trackId, startMs: 0, endMs: 130250, mode: 'high' },
          });
          await job(key);
          ids.push(key);
        }
        const c = await context();
        await call('studio_apply_volume_leveling_batch', {
          context: c,
          projectId: c.projectId,
          expectedRevision: c.expectedRevision,
          ids,
        });
      }
    }
    p = await call('studio_get_project');
    assert.equal(p.formatVersion, 28);
    assert.equal(p.generations.length, before.generations.length + 2);
    assert.deepEqual(
      p.tracks.filter((t) => t.id !== 'level-companion'),
      before.tracks,
    );
    assert.deepEqual(p.dialogues, before.dialogues);
    const undo = await call('studio_history', { context: await context(), direction: 'undo' });
    assert.deepEqual(undo.generations, before.generations);
    await call('studio_history', { context: await context(), direction: 'redo' });
    const c = await context(),
      id = await call('studio_prepare_volume_leveling', {
        context: c,
        projectId: c.projectId,
        expectedRevision: c.expectedRevision,
        options: {
          mediaId: p.media.id,
          trackId: 'dubbing',
          startMs: line.startMs,
          endMs: line.startMs + 1000,
          mode: 'high',
        },
      });
    await job(id);
    await call('studio_apply_volume_leveling', {
      context: await context(),
      projectId: c.projectId,
      expectedRevision: c.expectedRevision,
      id,
    });
    p = await call('studio_get_project');
    assert.deepEqual(
      p.generations.filter((g) => g.kind === 'tts'),
      before.generations.filter((g) => g.kind === 'tts'),
    );
    assert.deepEqual(p.sourceCues, before.sourceCues);
    assert.deepEqual(p.targetCues, before.targetCues);
    await call('studio_project_patch', {
      context: await context(),
      patches: [
        { op: 'replace', path: '/formatVersion', value: 29 },
        { op: 'add', path: '/dialogues/0/reviewTags', value: ['retranslate', 'improveVoice'] },
      ],
    });
    assert.equal((await call('studio_dubbing_audit_status')).speakersInstalled, false);
    const auditContext = await context();
    const auditId = await call('studio_analyze_dubbing', {
      context: auditContext,
      projectId: auditContext.projectId,
      expectedRevision: auditContext.expectedRevision,
      options: { voices: 'both', sourceTrackId: null },
    });
    await job(auditId);
    await until(async () => {
      p = await call('studio_get_project');
      return p.dubbingAudit?.id === auditId;
    });
    assert.equal(p.formatVersion, 29);
    assert.equal(p.dubbingAudit.voicesStatus, 'unavailable');
    assert.deepEqual(p.dialogues[0].reviewTags, ['retranslate', 'improveVoice']);
    assert.equal((await call('studio_get_dialogues', { qualityTags: ['retranslate'] })).total, 1);
    assert(p.dubbingAudit.rows.some((r) => r.tags.includes('missing')));
    const listed = await call('studio_get_dialogues', { limit: 200 });
    assert(listed.rows.every((r) => r.qualityCurrent));
    assert(
      (await call('studio_get_dialogues', { qualityTags: ['missing'], limit: 200 })).total > 0,
    );
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'pause',
      id: null,
    });
    const workflowOptions = {
      variantId: 'cosy3-official',
      device: 'cpu',
      referenceMode: 'current',
      referenceId: null,
      mode: 'crossLingual',
      speed: 1,
      seed: 17,
    };
    const workflowSpec = {
      name: 'Fixture dubbing',
      selection: {
        takeCount: 4,
        scope: 'selected',
        lineIds: [p.dialogues[0].id],
        approvedOnly: false,
        unapprovedOnly: false,
        force: true,
        options: workflowOptions,
      },
      separation: null,
      dubbing: true,
      continueOnError: true,
    };
    const firstQueue = await call('studio_enqueue_workflow', {
      context: await context(),
      projectId: p.id,
      expectedRevision: p.revision,
      spec: workflowSpec,
    });
    const secondQueue = await call('studio_enqueue_workflow', {
      context: await context(),
      projectId: p.id,
      expectedRevision: p.revision,
      spec: {
        ...workflowSpec,
        name: 'Fixture separation',
        separation: {
          modelId: 'mel-band-roformer-kim',
          sourceTrackId: 'original',
          device: 'cpu',
          windowSeconds: 4,
          vocals: true,
          music: true,
          muteSource: false,
        },
        dubbing: false,
      },
    });
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'up',
      id: secondQueue,
    });
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'cancel',
      id: firstQueue,
    });
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'retry',
      id: firstQueue,
    });
    const queue = await call('studio_task_queue_status');
    assert(queue.paused);
    assert.equal(queue.entries[0].id, secondQueue);
    assert(queue.entries.every((e) => e.status === 'pending'));
    const queuePage = await call('studio_task_queue_entry', {
      id: firstQueue,
      offset: 0,
      limit: 1,
    });
    assert.equal(queuePage.spec.selection.takeCount, 4);
    assert.equal(queuePage.rows.length, 1);
    assert.equal(queuePage.spec.selection.lineIds.length, 1);
    assert(!('basis' in queue.entries[0]));
    assert(!('rows' in queue.entries[0]));
    assert(!('root' in queue.entries[0]));
    assert.deepEqual(await call('studio_get_project'), p);
    await fs.writeFile(
      checkpoint,
      JSON.stringify({
        entry,
        root,
        movie,
        take,
        original: hash(original),
        project: p,
        desktopPid: Number(args['desktop-pid']),
        queue,
        firstQueue,
        secondQueue,
      }),
    );
    console.log('VOLUME_LEVELING_SDK_PREPARED');
  } else {
    const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    assert.notEqual(saved.desktopPid, Number(args['desktop-pid']));
    await call('studio_open_registered_project', { key: saved.entry.key });
    const p = await call('studio_get_project');
    assert.deepEqual(p.generations, saved.project.generations);
    assert.deepEqual(p.tracks, saved.project.tracks);
    assert.deepEqual(p.dubbingAudit, saved.project.dubbingAudit);
    assert.deepEqual(p.dialogues[0].reviewTags, ['retranslate', 'improveVoice']);
    assert.equal((await call('studio_get_dialogues', { qualityTags: ['improveVoice'] })).total, 1);
    assert(
      (await call('studio_get_dialogues', { qualityTags: ['missing'], limit: 200 })).total > 0,
    );
    assert.equal(hash(await fs.readFile(path.join(saved.root, p.media.path))), saved.movie);
    assert.equal(
      hash(await fs.readFile(path.join(saved.root, 'stems/level-test.wav'))),
      saved.original,
    );
    assert.equal(
      hash(
        await fs.readFile(
          await call('studio_generation_path', {
            id: p.generations.find((g) => g.kind === 'tts').id,
          }),
        ),
      ),
      saved.take,
    );
    const resumedQueue = await call('studio_task_queue_status');
    assert(resumedQueue.paused);
    assert.equal(resumedQueue.entries.length, 2);
    assert.equal(resumedQueue.entries[0].id, saved.secondQueue);
    assert.equal(resumedQueue.entries[0].status, 'interrupted');
    assert.equal(resumedQueue.entries[0].error, 'QUEUE_RESTARTED');
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'retry',
      id: saved.secondQueue,
    });
    const recoveredQueue = await call('studio_task_queue_status');
    assert(recoveredQueue.paused);
    assert.deepEqual(recoveredQueue.entries, saved.queue.entries);
    const detail = await call('studio_task_queue_entry', {
      id: saved.firstQueue,
      offset: 0,
      limit: 1,
    });
    assert.equal(detail.spec.selection.options.seed, 17);
    assert.equal(detail.spec.selection.takeCount, 4);
    assert.equal(detail.rows.length, 1);
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'remove',
      id: saved.secondQueue,
    });
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'cancel',
      id: saved.firstQueue,
    });
    await call('studio_control_task_queue', {
      context: await context(),
      action: 'clear',
      id: null,
    });
    assert.equal((await call('studio_task_queue_status')).entries.length, 0);
    const layers = p.generations.filter((g) => g.operation === 'leveling');
    assert.equal(layers.length, 3);
    const longLayer = layers.find((l) => l.trackId === 'level-test');
    assert.equal(longLayer.endMs, 130250);
    for (const [startMs, endMs] of [
      [0, 30000],
      [30000, 60000],
      [120000, 130250],
    ]) {
      const segment = pcm(
        await fs.readFile(
          await call('studio_audio_patch_path', { id: longLayer.id, startMs, endMs }),
        ),
      );
      assert.equal(segment.length, (endMs - startMs) * 192);
      if (startMs === 120000) assert(segment.every((v) => v === 0));
    }
    for (const layer of layers)
      assert(
        pcm(await fs.readFile(await call('studio_audio_patch_path', { id: layer.id }))).length > 0,
      );
    const proof = {
      version: '0.50.0',
      officialSdk: true,
      toolCount: 170,
      actualApplicationRestart: true,
      persistedQueueAndFrozenWorkflow: true,
      queueControlsAndBoundedRead: true,
      noAutomaticQueueResume: true,
      realPcmLowAndHigh: true,
      fullTrackBeyond120s: true,
      atomicMultiTrackApply: true,
      persistedAuditAndFilters: true,
      missingSpeakerModelExplicit: true,
      boundedPlaybackRanges: true,
      exactRangeAndSilence: true,
      explicitApply: true,
      dubbingSelection: true,
      undoRedo: true,
      immutableSourcesAndTakes: true,
      nativeReopen: true,
      noNeuralInference: true,
    };
    await fs.writeFile(args.proof, JSON.stringify(proof, null, 2) + '\n');
    console.log('VOLUME_LEVELING_MCP_PROOF ' + JSON.stringify(proof));
  }
} finally {
  await client.close();
}
