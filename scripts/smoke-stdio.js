/**
 * End-to-end smoke test over the REAL stdio transport against the REAL upstream API.
 *
 * Spawns dist/index.js as a child process exactly the way Claude Desktop does,
 * performs a genuine MCP handshake, then calls every registered tool and prints
 * a real excerpt of each result. Exits non-zero if any tool fails.
 *
 *   node scripts/smoke-stdio.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Karachi, Pakistan — the market with the most verification coverage.
const LAT = 24.814418;
const LNG = 67.071643;
const MARKET = 'pk';

const results = [];
let failures = 0;

function excerpt(res, n = 420) {
  const text = res?.content?.find((c) => c.type === 'text')?.text ?? '';
  return text.replace(/\n{3,}/g, '\n\n').slice(0, n);
}

async function call(client, name, args) {
  const started = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const ms = Date.now() - started;
    if (res.isError) {
      failures++;
      results.push({ name, ok: false, ms, note: excerpt(res, 200) });
      console.log(`\n❌ ${name} (${ms}ms)\n${excerpt(res, 300)}`);
      return undefined;
    }
    const hasStructured = res.structuredContent !== undefined;
    results.push({ name, ok: true, ms, structured: hasStructured });
    console.log(`\n✅ ${name} (${ms}ms, structured=${hasStructured})\n${excerpt(res)}`);
    return res;
  } catch (err) {
    failures++;
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, note: String(err?.message ?? err) });
    console.log(`\n❌ ${name} (${ms}ms) THREW: ${err?.message ?? err}`);
    return undefined;
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'index.js')],
    env: { ...process.env, LOG_LEVEL: 'warn', MCP_TRANSPORT: 'stdio' },
  });

  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(transport);

  const info = client.getServerVersion();
  console.log(`=== HANDSHAKE OK ===\nserver: ${info?.name} v${info?.version}`);

  const { tools } = await client.listTools();
  console.log(`\n=== ${tools.length} TOOLS REGISTERED ===`);
  for (const t of tools) console.log(`  - ${t.name}`);

  const { prompts } = await client.listPrompts();
  console.log(`\n=== ${prompts.length} PROMPTS ===`);
  for (const p of prompts) console.log(`  - ${p.name}`);

  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();
  console.log(`\n=== ${resources.length} RESOURCES + ${resourceTemplates.length} TEMPLATES ===`);
  for (const r of resources) console.log(`  - ${r.uri}`);
  for (const r of resourceTemplates) console.log(`  - ${r.uriTemplate} (template)`);

  console.log('\n\n=== LIVE TOOL CALLS ===');

  await call(client, 'list_markets', { verify: true, market: MARKET });
  await call(client, 'resolve_location', { query: 'Clifton, Karachi', limit: 2 });

  const search = await call(client, 'search_restaurants', {
    latitude: LAT, longitude: LNG, market: MARKET, limit: 5, sort: 'rating', scanLimit: 50,
  });

  // Use a real code from the live search for the code-dependent tools.
  const codes = search?.structuredContent?.restaurants?.map((r) => r.code) ?? [];
  const code = codes[0];
  console.log(`\n[smoke] using live restaurant codes: ${codes.slice(0, 3).join(', ')}`);

  await call(client, 'search_restaurants', {
    address: 'Gulshan-e-Iqbal, Karachi', query: 'biryani', limit: 4, openNow: true, scanLimit: 60,
  });

  if (code) {
    await call(client, 'get_restaurant', { code, market: MARKET, latitude: LAT, longitude: LNG });
    await call(client, 'get_menu', { code, market: MARKET, maxItems: 8 });
    await call(client, 'check_open_now', { codes: codes.slice(0, 3), market: MARKET });
    if (codes.length >= 2) {
      await call(client, 'compare_restaurants', {
        codes: codes.slice(0, 3), market: MARKET, latitude: LAT, longitude: LNG,
      });
    }
  } else {
    console.log('⚠ no restaurant code available; skipping code-dependent tools');
    failures++;
  }

  await call(client, 'list_cuisines', { latitude: LAT, longitude: LNG, market: MARKET, minRestaurants: 3 });
  await call(client, 'browse_by_cuisine', {
    latitude: LAT, longitude: LNG, market: MARKET, cuisineName: 'Biryani', limit: 4,
  });
  await call(client, 'find_deals', { latitude: LAT, longitude: LNG, market: MARKET, limit: 4, scanLimit: 60 });
  await call(client, 'search_menu_items', {
    latitude: LAT, longitude: LNG, market: MARKET, query: 'biryani', restaurantLimit: 5, limit: 5,
  });

  // Resources
  console.log('\n\n=== RESOURCE READS ===');
  for (const uri of ['foodpanda://markets', 'foodpanda://server-info']) {
    const r = await client.readResource({ uri });
    console.log(`✅ ${uri} -> ${r.contents[0].text.slice(0, 160)}...`);
  }
  if (code) {
    const uri = `foodpanda://restaurant/${MARKET}/${code}`;
    const r = await client.readResource({ uri });
    console.log(`✅ ${uri} -> ${r.contents[0].text.slice(0, 160)}...`);
  }

  // Prompts
  console.log('\n=== PROMPT RENDER ===');
  const p = await client.getPrompt({
    name: 'cheapest_dish_nearby',
    arguments: { dish: 'biryani', location: 'Clifton, Karachi' },
  });
  console.log(`✅ cheapest_dish_nearby -> ${p.messages[0].content.text.slice(0, 160)}...`);

  await client.close();

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} ${String(r.ms).padStart(6)}ms${r.note ? '  ' + r.note.slice(0, 90) : ''}`);
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} tool calls succeeded`);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('ALL GREEN');
}

main().catch((e) => {
  console.error('SMOKE FAILED: ' + (e?.stack ?? e));
  process.exit(1);
});
