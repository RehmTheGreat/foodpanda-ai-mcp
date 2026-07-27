/**
 * End-to-end smoke test of the streamable HTTP transport.
 *
 * Boots the real server on a port, then connects with a real MCP client over
 * StreamableHTTPClientTransport, performs a handshake, lists tools, calls one,
 * and checks /health and /ready. Exits non-zero on any failure.
 *
 *   node scripts/smoke-http.js
 */
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.SMOKE_PORT || '3737';
const BASE = `http://127.0.0.1:${PORT}`;

let child;
function stop() {
  if (child && !child.killed) child.kill();
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function main() {
  child = spawn(process.execPath, [join(root, 'dist', 'index.js'), '--http'], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const health = await waitForHealth();
  console.log('=== /health ===');
  console.log(JSON.stringify(health, null, 2));
  if (health.status !== 'ok') throw new Error('health status not ok');

  const ready = await fetch(`${BASE}/ready`);
  console.log('\n=== /ready ===');
  console.log(`status ${ready.status}`);
  console.log(JSON.stringify(await ready.json(), null, 2));

  const root_ = await fetch(`${BASE}/`);
  console.log('\n=== / ===');
  console.log(JSON.stringify(await root_.json(), null, 2));

  console.log('\n=== MCP HANDSHAKE OVER STREAMABLE HTTP ===');
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  const client = new Client({ name: 'http-smoke', version: '1.0.0' });
  await client.connect(transport);

  const info = client.getServerVersion();
  console.log(`connected: ${info?.name} v${info?.version}`);
  console.log(`session id: ${transport.sessionId ?? '(none)'}`);
  if (!transport.sessionId) throw new Error('no session id issued');

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.length} (${tools.map((t) => t.name).join(', ')})`);
  if (tools.length < 10) throw new Error(`expected >=10 tools, got ${tools.length}`);

  // A tool call that needs no network so the smoke test is deterministic.
  const res = await client.callTool({ name: 'list_markets', arguments: {} });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  console.log(`\nlist_markets ->\n${text.slice(0, 300)}`);
  if (res.isError) throw new Error('list_markets returned an error');

  const resources = await client.listResources();
  console.log(`\nresources: ${resources.resources.map((r) => r.uri).join(', ')}`);

  // Explicit DELETE is how a well-behaved client ends a session; verify the
  // server actually frees it (abandoned sessions are reaped on a timer instead).
  const sid = transport.sessionId;
  await client.close();

  const del = await fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
  console.log(`\nDELETE /mcp -> ${del.status}`);

  const after = await (await fetch(`${BASE}/health`)).json();
  console.log(`sessions after DELETE: ${after.sessions}`);
  if (after.sessions !== 0) throw new Error(`session was not released (still ${after.sessions})`);

  console.log('\nHTTP TRANSPORT: ALL GREEN');
}

main()
  .then(() => {
    stop();
    process.exit(0);
  })
  .catch((e) => {
    console.error('HTTP SMOKE FAILED: ' + (e?.stack ?? e));
    stop();
    process.exit(1);
  });
