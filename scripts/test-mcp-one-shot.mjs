// Actual studio CLI, authenticated loopback fixture, and a deliberately open
// stdin pipe like the affected Windows SSH wrapper. No user application/data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifySshTransport } from './test-mcp-ssh-stdio.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function verifyOneShot(executable, parent = os.tmpdir(), legacy = false) {
  const root = await fs.mkdtemp(path.join(parent, 'mcp-one-shot-'));
  const token = randomBytes(32).toString('hex');
  const connections = new Set(), children = [], readers = [];
  const reset = error => { if (!['ECONNRESET', 'EPIPE'].includes(error.code)) throw error; };
  let calls = 0, cancellations = 0;
  const server = createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket)); socket.on('error', reset);
    const lines = createInterface({ input: socket }); lines.on('error', reset);
    lines.on('line', line => {
      const request = JSON.parse(line); assert.equal(request.token, token);
      if (request.op === 'cancel') cancellations++;
      const answer = () => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, value: request.op === 'ping' ? { running: true } : request.tool ? { checked: true, jobId: 'persisted-job' } : null }) + '\n'); };
      if (request.tool) { assert.equal(request.tool, 'studio_get_state'); calls++; setTimeout(answer, 700); }
      else { assert(['ping', 'cancel'].includes(request.op)); answer(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = path.join(root, 'endpoint.json');
  await fs.writeFile(endpoint, JSON.stringify({ pid: process.pid, port: server.address().port, token }));
  const proof = { heldStdin: true, legacy, requests: 0, selfExits: 0, retainedRelays: 0 };
  function start() {
    const child = spawn(executable, ['--mcp', '--endpoint', endpoint], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); child.stdin.on('error', reset); child.stdout.on('error', reset); child.stderr.on('error', reset);
    const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    const lines = createInterface({ input: child.stdout }); readers.push(lines); lines.on('error', reset);
    const received = new Map(), waits = new Map();
    lines.on('line', line => { const value = JSON.parse(line); received.set(value.id, value); waits.get(value.id)?.(value); });
    return { child, exited, receive: id => received.has(id) ? Promise.resolve(received.get(id)) : bounded(new Promise(resolve => waits.set(id, resolve)), 15000, `Missing response ${id}`) };
  }
  const init = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'one-shot-regression', version: '1' } } });
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  try {
    // Sequential requests model the request-per-SSH-channel proxy. Each old
    // process still owns an open stdin after returning its complete response.
    for (let index = 0; index < (legacy ? 6 : 20); index++) {
      const target = index === 0 ? 'init' : index;
      const frames = [{ jsonrpc: '2.0', method: 'notifications/studio/one-shot', params: { requestId: target } }, init('init')];
      if (index !== 0) frames.push(initialized, { jsonrpc: '2.0', id: target, method: index % 2 ? 'tools/list' : 'resources/list' });
      const { child, exited, receive } = start();
      child.stdin.write(frames.map(value => JSON.stringify(value)).join('\n') + '\n');
      const result = await receive(target); assert(result.result && !result.error);
      assert.equal(child.stdin.writableEnded, false, 'The fixture must not forward EOF');
      proof.requests++;
      if (!legacy) { assert.deepEqual(await bounded(exited, 5000, 'Completed SSH relay was retained'), { code: 0, signal: null }); proof.selfExits++; }
    }
    if (legacy) {
      await delay(1500);
      proof.retainedRelays = children.filter(child => child.exitCode === null && child.signalCode === null).length;
      assert.equal(proof.retainedRelays, 6, 'Expected to reproduce six retained legacy relays');
      return proof;
    }
    // A real asynchronous request must finish and flush, without cancelling a
    // heavy job ID that the application has already accepted.
    {
      const { child, exited, receive } = start();
      const frames = [{ jsonrpc: '2.0', method: 'notifications/studio/one-shot', params: { requestId: 'state' } }, init('init'), initialized, { jsonrpc: '2.0', id: 'state', method: 'tools/call', params: { name: 'studio_get_state', arguments: {} } }];
      child.stdin.write(frames.map(value => JSON.stringify(value)).join('\n') + '\n');
      await receive('init'); await delay(250);
      assert.equal(child.exitCode, null, 'Do not close a pending request prematurely');
      const response = await receive('state');
      assert.equal(response.result.structuredContent.value.jobId, 'persisted-job');
      assert.equal(child.stdin.writableEnded, false);
      assert.deepEqual(await bounded(exited, 5000, 'Asynchronous one-shot retained'), { code: 0, signal: null });
      assert.equal(calls, 1); proof.delayedReplyFlushed = true;
    }
    // Invalid RPC replies also end their own channel; no UI mutation involved.
    {
      const { child, exited, receive } = start();
      child.stdin.write([{ jsonrpc: '2.0', method: 'notifications/studio/one-shot', params: { requestId: 'bad' } }, init('init'), initialized, { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { name: 'invalid-tool', arguments: {} } }].map(v => JSON.stringify(v)).join('\n') + '\n');
      assert.equal((await receive('bad')).error.code, -32602);
      assert.deepEqual(await bounded(exited, 5000, 'RPC error relay retained'), { code: 0, signal: null }); proof.errorReplyFlushed = true;
    }
    // Persistent MCP clients remain usable during an idle interval and for
    // later requests. The new mode is never enabled by default.
    {
      const { child, exited, receive } = start();
      child.stdin.write([init('init'), initialized, { jsonrpc: '2.0', id: 'first', method: 'ping' }].map(v => JSON.stringify(v)).join('\n') + '\n');
      await receive('first'); await delay(1000); assert.equal(child.exitCode, null);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'later', method: 'tools/list' }) + '\n');
      assert.equal((await receive('later')).result.tools.length, 113);
      child.stdin.end(); assert.deepEqual(await bounded(exited, 5000, 'Normal client EOF failed'), { code: 0, signal: null }); proof.persistentClient = true;
    }
    // Cancellation only releases completed RPC ownership, never studio jobs.
    assert(cancellations >= 23);
    proof.sshTransport = await verifySshTransport(executable, endpoint, root);
    proof.retainedRelays = children.filter(child => child.exitCode === null && child.signalCode === null).length;
    assert.equal(proof.retainedRelays, 0);
    return proof;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const child of children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
    for (const reader of readers) reader.close();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Pass the actual studio executable');
  console.log('MCP_ONE_SHOT_PROOF ' + JSON.stringify(await verifyOneShot(path.resolve(process.argv[2]), os.tmpdir(), process.argv.includes('--expect-legacy'))));
}
