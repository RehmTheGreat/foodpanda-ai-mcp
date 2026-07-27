/**
 * CI gate: prove the built artefact is a working MCP server.
 *
 * Spawns dist/index.js over stdio exactly as a desktop client would, completes a
 * real handshake, and asserts the expected tools, prompts and resources are
 * registered. Makes NO upstream requests, so it is safe and deterministic in CI.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_TOOLS = [
  'browse_by_cuisine',
  'check_open_now',
  'compare_restaurants',
  'find_deals',
  'get_menu',
  'get_restaurant',
  'list_cuisines',
  'list_markets',
  'resolve_location',
  'search_menu_items',
  'search_restaurants',
];

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'index.js')],
    env: { ...process.env, LOG_LEVEL: 'silent', MCP_TRANSPORT: 'stdio' },
  });

  const client = new Client({ name: 'ci-handshake', version: '1.0.0' });
  await client.connect(transport);

  const info = client.getServerVersion();
  console.log(`handshake ok: ${info?.name} v${info?.version}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`tools (${names.length}): ${names.join(', ')}`);

  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) throw new Error(`missing tools: ${missing.join(', ')}`);

  for (const t of tools) {
    if (!t.description || t.description.length < 60) {
      throw new Error(`tool ${t.name} has an inadequate description`);
    }
    if (!t.inputSchema) throw new Error(`tool ${t.name} has no input schema`);
  }

  const { prompts } = await client.listPrompts();
  console.log(`prompts (${prompts.length}): ${prompts.map((p) => p.name).join(', ')}`);
  if (prompts.length !== 3) throw new Error(`expected 3 prompts, got ${prompts.length}`);

  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();
  console.log(`resources (${resources.length}) + templates (${resourceTemplates.length})`);
  if (resources.length < 2) throw new Error('expected at least 2 resources');

  // An offline tool call: list_markets answers from a static table.
  const res = await client.callTool({ name: 'list_markets', arguments: {} });
  if (res.isError) throw new Error('list_markets failed');
  const markets = res.structuredContent?.markets ?? [];
  console.log(`list_markets returned ${markets.length} markets`);
  if (markets.length !== 10) throw new Error(`expected 10 markets, got ${markets.length}`);

  const info_ = await client.readResource({ uri: 'foodpanda://server-info' });
  const parsed = JSON.parse(info_.contents[0].text);
  if (parsed.readOnly !== true) throw new Error('server-info must declare readOnly');
  if (parsed.capabilities.ordering !== false) throw new Error('server must not claim ordering');

  await client.close();
  console.log('CI HANDSHAKE: OK');
}

main().catch((e) => {
  console.error('CI HANDSHAKE FAILED: ' + (e?.stack ?? e));
  process.exit(1);
});
