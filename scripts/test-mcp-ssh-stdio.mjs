// Simulates Windows SSH's missing EOF using real studio child processes.
// The bridge never closes the studio stdin. The studio must close itself.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function verifySshTransport(executable, endpoint, root) {
  const bridge = path.join(root, 'held-stdin-bridge.mjs');
  const events = path.join(root, 'bridge-events.jsonl');
  const configuration = path.join(root, 'ssh-test.json');
  await fs.writeFile(bridge, `
import {spawn} from 'node:child_process';
import fs from 'node:fs';
const [exe,endpoint,log]=process.argv.slice(2);
const child=spawn(exe,['--mcp','--endpoint',endpoint],{windowsHide:true,stdio:['pipe','pipe','pipe']});
child.stdin.on('error',()=>{});
const record=value=>fs.appendFileSync(log,JSON.stringify(value)+'\\n');
child.once('spawn',()=>record({event:'spawn',pid:child.pid}));
child.once('error',error=>{console.error(error);process.exitCode=1;process.stdin.destroy();});
child.once('exit',(code,signal)=>{record({event:'exit',pid:child.pid,code,signal});process.stdin.destroy();process.exitCode=code??1;});
let first=true;
process.stdin.on('data',data=>{
 if(first){first=false;const frame=JSON.parse(data.toString().split('\\n')[0]);
  if(frame.method!=='notifications/studio/one-shot')throw Error('Missing first-write one-shot notification');}
 child.stdin.write(data);
});
process.stdin.on('end',()=>{}); // Intentionally DO NOT forward EOF.
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
`, 'utf8');
  await fs.writeFile(configuration, JSON.stringify({ command: process.execPath, args: [bridge, executable, endpoint, events] }));
  const client = new Client({ name: 'ssh-one-shot-regression', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp-ssh-stdio.mjs', import.meta.url)), configuration], stderr: 'pipe' });
  let diagnostics = ''; transport.stderr?.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-2000); });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 120);
    await client.ping();
    for (let i = 0; i < 2; i++) {
      const value = await client.callTool({ name: 'studio_get_state', arguments: {} });
      assert.equal(value.isError, false); assert(value.structuredContent.value);
    }
    await assert.rejects(client.callTool({ name: 'invalid-tool', arguments: {} }));
  } catch (error) {
    throw Error(`SSH proxy regression: ${error.message}; ${diagnostics}`);
  } finally { await client.close(); }
  let rows;
  const deadline = Date.now() + 6000;
  do {
    rows = (await fs.readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (rows.filter(row => row.event === 'exit').length === 6) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const started = rows.filter(row => row.event === 'spawn'), exited = rows.filter(row => row.event === 'exit');
  assert.equal(started.length, 6);
  assert.equal(exited.length, 6, 'The proxy must not leave orphan studio processes');
  for (const entry of started) assert.deepEqual(exited.find(exit => exit.pid === entry.pid), { event: 'exit', pid: entry.pid, code: 0, signal: null });
  return { requests: 6, selfExits: 6, noEofForwarded: true, officialSdk: true };
}
