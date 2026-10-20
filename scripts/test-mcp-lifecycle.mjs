// Real stdio processes with an authenticated, private loopback host fixture.
// Keep stdin open to reproduce an orphaned SSH/AI client holding the exe.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function verifyRelayLifecycle(executable, parent = os.tmpdir()) {
  const root = await fs.mkdtemp(path.join(parent, 'relay-lifecycle-'));
  const proof = {};
  for (const scenario of ['stdinEof', 'stdinEofWhileWaiting', 'blockedStdout', 'hostExit', 'endpointRemoved', 'endpointRotated']) {
    const endpointPath = path.join(root, scenario + '.json');
    const token = randomBytes(32).toString('hex');
    const sockets = new Set();
    const closedConnection = error => {
      // Windows can reset an RPC/ping socket when its owning relay drops it.
      // Process discovery, liveness and exact exit-code assertions below still
      // detect a relay failure. readline forwards input errors to this handler.
      if (error.code !== 'ECONNRESET') throw error;
    };
    let waiting;
    const pending = new Promise(resolve => { waiting = resolve; });
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', closedConnection);
      const lines = createInterface({ input: socket });
      lines.on('error', closedConnection);
      lines.on('line', line => {
        const request = JSON.parse(line);
        assert.equal(request.token, token);
        if (scenario === 'stdinEofWhileWaiting' && request.tool === 'studio_get_state') {
          waiting(); // Deliberately leave this RPC open, even after cancellation.
          return;
        }
        assert(['ping', 'cancel'].includes(request.op));
        socket.end(JSON.stringify({ ok: true, value: request.op === 'ping' ? { running: true } : null }) + '\n');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = { pid: process.pid, port: server.address().port, token };
    await fs.writeFile(endpointPath, JSON.stringify(endpoint));
    const child = spawn(executable, ['--mcp', '--endpoint', endpointPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // An early process failure is reported by ready/exit below.
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const lines = createInterface({ input: child.stdout });
    lines.on('error', closedConnection);
    const ready = new Promise((resolve, reject) => {
      lines.on('line', line => {
        const response = JSON.parse(line);
        if (response.error) reject(Error(JSON.stringify(response.error)));
        if (response.id === 'tools') { assert(response.result.tools.length >= 95); resolve(); }
      });
      child.once('error', reject);
      child.once('exit', code => reject(Error(`Relay exited before discovery: ${code}; ${stderr}`)));
    });
    try {
      child.stdin.write([
        { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'lifecycle-test', version: '1' }, capabilities: {} } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'tools', method: 'tools/list' },
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
      await bounded(ready, 15000, 'Relay discovery timeout');
      await new Promise(resolve => setTimeout(resolve, 750));
      assert.equal(child.exitCode, null, 'Healthy idle relay must remain connected');
      if (scenario === 'stdinEofWhileWaiting') {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'pending', method: 'tools/call', params: { name: 'studio_get_state', arguments: {} } }) + '\n');
        await bounded(pending, 5000, 'The pending native request was not received');
        child.stdin.end();
      }
      else if (scenario === 'blockedStdout') {
        lines.close(); child.stdout.pause();
        child.stdin.write(Array.from({ length: 30 }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: 'flood-' + i, method: 'tools/list' })).join('\n') + '\n');
        await new Promise(resolve => setTimeout(resolve, 250));
        await fs.unlink(endpointPath);
      }
      else if (scenario === 'stdinEof') child.stdin.end();
      else if (scenario === 'hostExit') {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve)); // Leave the stale endpoint in place.
      } else if (scenario === 'endpointRemoved') await fs.unlink(endpointPath);
      else await fs.writeFile(endpointPath, JSON.stringify({ ...endpoint, token: randomBytes(32).toString('hex') }));
      const result = await bounded(exited, 6000, `Relay still holds the executable after ${scenario}`);
      assert.equal(result.signal, null, 'Relay must exit itself, without forced termination');
      assert.equal(result.code, scenario.startsWith('stdinEof') ? 0 : 1);
      proof[scenario] = true;
      console.log('MCP relay lifecycle passed: ' + scenario);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      child.stdout.destroy();
      lines.close();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
  return proof;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Pass the real studio executable');
  console.log('MCP_RELAY_LIFECYCLE_PROOF ' + JSON.stringify(await verifyRelayLifecycle(path.resolve(process.argv[2]))));
}
