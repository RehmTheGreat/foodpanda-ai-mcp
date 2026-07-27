import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultRoutes, fixture, makeAdapter, testConfig } from './helpers.js';
import { registerLocationTools } from '../src/tools/location.js';
import { registerRestaurantTools } from '../src/tools/restaurants.js';
import { registerMenuTools } from '../src/tools/menus.js';
import { registerDiscoveryTools } from '../src/tools/discovery.js';
import { registerPrompts } from '../src/prompts.js';
import { registerResources } from '../src/resources.js';
import { nullLogger } from '../src/logger.js';
import type { ToolContext } from '../src/tools/context.js';
import type { RouteSpec } from './helpers.js';

/**
 * These drive the real McpServer through a real MCP client over an in-memory
 * transport, so tool registration, zod input validation and outputSchema
 * validation are all genuinely exercised — only the network is faked.
 */
async function connect(routes: RouteSpec[] = defaultRoutes()) {
  const config = testConfig();
  const { adapter, geocoder } = makeAdapter(routes, config);
  const ctx: ToolContext = { foodpanda: adapter, geocoder, config, logger: nullLogger };

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerLocationTools(server, ctx);
  registerRestaurantTools(server, ctx);
  registerMenuTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerPrompts(server);
  registerResources(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const text = (res: any): string => res.content?.find((c: any) => c.type === 'text')?.text ?? '';

/** Resource contents are a text|blob union; every resource here is text/JSON. */
const readJson = (res: { contents: Array<Record<string, unknown>> }): any =>
  JSON.parse(String(res.contents[0]!.text));

let client: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  client = await connect();
});

describe('tool registration', () => {
  it('registers the full documented tool set', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
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
      ].sort(),
    );
  });

  it('gives every tool a substantive description and an input schema', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description, `${t.name} needs a description`).toBeTruthy();
      expect(t.description!.length, `${t.name} description too short`).toBeGreaterThan(60);
      expect(t.inputSchema, `${t.name} needs an inputSchema`).toBeTruthy();
    }
  });

  it('registers prompts and resources', async () => {
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
      'what_should_i_order',
      'cheapest_dish_nearby',
      'compare_delivery_options',
    ]);
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain('foodpanda://markets');
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
  });
});

describe('every tool returns both text and structured output', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['list_markets', {}],
    ['resolve_location', { query: 'Clifton, Karachi' }],
    ['search_restaurants', { latitude: 24.81, longitude: 67.07, market: 'pk', limit: 3 }],
    ['get_restaurant', { code: 'u1od', market: 'pk' }],
    ['get_menu', { code: 'u1od', market: 'pk', maxItems: 5 }],
    ['check_open_now', { codes: ['u1od'], market: 'pk' }],
    ['compare_restaurants', { codes: ['u1od', 'qeqr'], market: 'pk' }],
    ['list_cuisines', { latitude: 24.81, longitude: 67.07, market: 'pk' }],
    ['browse_by_cuisine', { latitude: 24.81, longitude: 67.07, market: 'pk', cuisineName: 'Biryani', limit: 3 }],
    ['find_deals', { latitude: 24.81, longitude: 67.07, market: 'pk', limit: 3 }],
    ['search_menu_items', { latitude: 24.81, longitude: 67.07, market: 'pk', query: 'sub', restaurantLimit: 2 }],
  ];

  for (const [name, args] of cases) {
    it(`${name} succeeds and validates against its output schema`, async () => {
      const res: any = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name} returned an error: ${text(res)}`).toBeFalsy();
      expect(text(res).length, `${name} produced no human-readable text`).toBeGreaterThan(10);
      expect(res.structuredContent, `${name} produced no structured output`).toBeDefined();
      expect(res.structuredContent.meta?.market).toBeDefined();
    });
  }
});

describe('input validation', () => {
  it('rejects a call with no location at all', async () => {
    const res: any = await client.callTool({ name: 'search_restaurants', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/location is required/i);
  });

  it('rejects an out-of-range latitude before any request is made', async () => {
    // The SDK validates against the zod inputSchema and returns an error result
    // rather than throwing, so the bad value never reaches our handler.
    const res: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 999, longitude: 0 },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/validation|Invalid arguments/i);
  });

  it('rejects an unsupported market with guidance', async () => {
    const res: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 51.5, longitude: -0.12, market: 'gb' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not supported|Supported markets/i);
  });

  it('refuses more restaurant codes than check_open_now allows', async () => {
    const res: any = await client.callTool({
      name: 'check_open_now',
      arguments: { codes: Array.from({ length: 11 }, (_, i) => `c${i}`), market: 'pk' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/too_big|<=10/i);
  });
});

describe('search behaviour', () => {
  it('filters by query rather than returning everything', async () => {
    const all: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', limit: 20 },
    });
    const filtered: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', query: 'subway', limit: 20 },
    });
    expect(filtered.structuredContent.restaurants.length).toBeLessThan(
      all.structuredContent.restaurants.length,
    );
  });

  it('reports zero matches honestly instead of inventing results', async () => {
    const res: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', query: 'zzzznotarealcuisine', limit: 5 },
    });
    expect(res.structuredContent.restaurants).toEqual([]);
    expect(text(res)).toMatch(/No restaurants matched/i);
  });

  it('ranks cheapest first in search_menu_items', async () => {
    const res: any = await client.callTool({
      name: 'search_menu_items',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', query: 'sub', restaurantLimit: 2, limit: 10 },
    });
    const prices = res.structuredContent.items.map((i: any) => i.totalWithDelivery ?? i.price);
    expect([...prices].sort((a: number, b: number) => a - b)).toEqual(prices);
  });
});

describe('defect: search_menu_items ranked by stale listing-level delivery fee (Bug 1)', () => {
  // Reproduces the reported case: c1tf (Lasani Biryani Centre) shows
  // "Rs.256 · Rs.355 with delivery" from search_menu_items, but its OWN
  // vendor-detail response — which search_menu_items already fetches per
  // candidate — reports minimum_delivery_fee: 0 plus an active free-delivery
  // discount. The listing-level fee (used here as a stand-in stale value)
  // must not win over the fresher detail-level one.
  it('uses the freshly-fetched detail fee, not the listing-level one', async () => {
    const c = await connect([
      { match: 'disco.deliveryhero.io', body: fixture('listing-c1tf.json') },
      { match: '/api/v5/vendors/', body: fixture('vendor-c1tf-detail.json') },
      { match: '/api/v5/configuration', body: fixture('configuration-pk.json') },
    ]);
    const res: any = await c.callTool({
      name: 'search_menu_items',
      arguments: {
        latitude: 24.814422,
        longitude: 67.070805,
        market: 'pk',
        query: 'chicken biryani',
        restaurantLimit: 1,
      },
    });
    expect(res.isError, text(res)).toBeFalsy();
    const hit = res.structuredContent.items.find((i: any) => i.name === 'Chicken Biryani');
    expect(hit, 'expected a Chicken Biryani hit').toBeDefined();
    expect(hit.price).toBe(256);
    expect(hit.deliveryFee).toBe(0);
    expect(hit.totalWithDelivery).toBe(256);
  });
});

describe('graceful degradation', () => {
  it('surfaces a bot-protection block as a clear, actionable error', async () => {
    const c = await connect([
      { match: 'disco.deliveryhero.io', body: fixture('listing-pk.json') },
      { match: '/api/v5/vendors/', status: 403, body: fixture('perimeterx-403.json') },
    ]);
    const res: any = await c.callTool({ name: 'get_restaurant', arguments: { code: 'u1od', market: 'pk' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/bot-protection/i);
  });

  it('keeps working when the upstream payload shape is unrecognisable', async () => {
    const c = await connect([{ match: 'disco.deliveryhero.io', body: { totally: 'different' } }]);
    const res: any = await c.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk' },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.meta.degraded).toBe(true);
    expect(res.structuredContent.restaurants).toEqual([]);
  });

  it('does not fail the whole batch when one restaurant lookup fails', async () => {
    const res: any = await client.callTool({
      name: 'check_open_now',
      arguments: { codes: ['u1od', 'definitely-not-real'], market: 'pk' },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.results).toHaveLength(2);
  });
});

describe('pricing and link fields reach the tool output', () => {
  it('get_restaurant surfaces fees, deals, discounts and the double-count warning', async () => {
    const res: any = await client.callTool({
      name: 'get_restaurant',
      arguments: { code: 'u1od', market: 'pk' },
    });
    expect(res.isError).toBeFalsy();
    const r = res.structuredContent.restaurant;

    expect(r.fees, 'fees object missing').toBeDefined();
    expect(Array.isArray(r.deals)).toBe(true);
    expect(Array.isArray(r.discounts)).toBe(true);
    expect(r.deals.length).toBeGreaterThan(0);
    expect(r.pricingNote).toMatch(/already include/i);
    expect(text(res)).toMatch(/already include/i);
  });

  it('get_menu surfaces the same pricing context alongside items', async () => {
    const res: any = await client.callTool({
      name: 'get_menu',
      arguments: { code: 'u1od', market: 'pk', maxItems: 5 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent;
    expect(sc.fees).toBeDefined();
    expect(Array.isArray(sc.deals)).toBe(true);
    expect(Array.isArray(sc.discounts)).toBe(true);
    expect(sc.pricingNote).toMatch(/already include/i);
  });

  it('search_restaurants emits usable, single-origin links', async () => {
    const res: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', limit: 5 },
    });
    const withUrl = res.structuredContent.restaurants.filter((r: any) => r.url);
    expect(withUrl.length, 'expected at least one url').toBeGreaterThan(0);
    for (const r of withUrl) {
      expect(r.url.match(/:\/\//g) ?? []).toHaveLength(1);
      expect(r.url).not.toMatch(/foodpanda\.[a-z.]+\/https/);
      expect(() => new URL(r.url)).not.toThrow();
    }
  });

  it('find_deals emits a usable link for each restaurant', async () => {
    const res: any = await client.callTool({
      name: 'find_deals',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', limit: 5 },
    });
    const withUrl = res.structuredContent.restaurants.filter((r: any) => r.url);
    expect(withUrl.length, 'expected at least one url').toBeGreaterThan(0);
    for (const r of withUrl) expect(() => new URL(r.url)).not.toThrow();
  });

  it('browse_by_cuisine emits a usable link for each restaurant', async () => {
    const res: any = await client.callTool({
      name: 'browse_by_cuisine',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', cuisineName: 'Biryani', limit: 5 },
    });
    const withUrl = res.structuredContent.restaurants.filter((r: any) => r.url);
    expect(withUrl.length, 'expected at least one url').toBeGreaterThan(0);
    for (const r of withUrl) expect(() => new URL(r.url)).not.toThrow();
  });

  it('get_menu includes the restaurant link', async () => {
    const res: any = await client.callTool({
      name: 'get_menu',
      arguments: { code: 'u1od', market: 'pk', maxItems: 5 },
    });
    expect(res.structuredContent.restaurantUrl).toBeDefined();
    expect(() => new URL(res.structuredContent.restaurantUrl)).not.toThrow();
  });

  it('search_menu_items includes a link per hit', async () => {
    const res: any = await client.callTool({
      name: 'search_menu_items',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', query: 'sub', restaurantLimit: 2 },
    });
    const withUrl = res.structuredContent.items.filter((i: any) => i.restaurantUrl);
    expect(withUrl.length, 'expected at least one url').toBeGreaterThan(0);
    for (const i of withUrl) expect(() => new URL(i.restaurantUrl)).not.toThrow();
  });

  it('search_restaurants reports scan coverage honestly', async () => {
    const res: any = await client.callTool({
      name: 'search_restaurants',
      arguments: { latitude: 24.81, longitude: 67.07, market: 'pk', limit: 5 },
    });
    const sc = res.structuredContent;
    expect(typeof sc.scanned).toBe('number');
    expect(typeof sc.scanComplete).toBe('boolean');

    // The fixture advertises available_count=231 but only serves 6 vendors, so
    // coverage really is partial here. The invariant that matters is that the
    // flag and the warning agree with each other and with the numbers.
    expect(sc.scanComplete).toBe(sc.scanned >= sc.totalNearby);
    if (!sc.scanComplete) {
      expect(sc.scanned).toBeLessThan(sc.totalNearby);
      expect((sc.meta.warnings ?? []).some((w: string) => /available nearby/i.test(w))).toBe(true);
    }
  });
});

describe('resources', () => {
  it('serves the market table', async () => {
    const data = readJson(await client.readResource({ uri: 'foodpanda://markets' }));
    expect(data.supported.length).toBe(10);
    expect(data.unavailable[0].code).toBe('th');
  });

  it('declares itself read-only in server-info', async () => {
    const data = readJson(await client.readResource({ uri: 'foodpanda://server-info' }));
    expect(data.readOnly).toBe(true);
    expect(data.capabilities.ordering).toBe(false);
    expect(data.disclaimer).toMatch(/not affiliated/i);
  });

  it('resolves a templated restaurant URI', async () => {
    const data = readJson(await client.readResource({ uri: 'foodpanda://restaurant/pk/u1od' }));
    expect(data.code).toBeTruthy();
    expect(data.menuSummary.itemCount).toBeGreaterThan(0);
  });
});

describe('prompts', () => {
  it('renders a prompt that names the tools to use', async () => {
    const p = await client.getPrompt({
      name: 'cheapest_dish_nearby',
      arguments: { dish: 'biryani', location: 'Karachi' },
    });
    const body = (p.messages[0]!.content as any).text;
    expect(body).toMatch(/search_menu_items/);
    expect(body).toMatch(/biryani/);
  });
});
