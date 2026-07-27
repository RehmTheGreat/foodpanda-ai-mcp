import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWN_ABSENT, MARKETS } from './domain/markets.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { TOOL_SCHEMA_VERSION, type ToolContext } from './tools/context.js';

/**
 * Resources expose reference data that a client may want to read directly
 * rather than by burning a tool call — the market table and the server's own
 * capability/version metadata — plus a templated restaurant lookup so a
 * restaurant can be attached to a conversation as context.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'markets',
    'foodpanda://markets',
    {
      title: 'Supported foodpanda markets',
      description: 'The markets this server can query, with currency and timezone. Verified against the live API.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              supported: Object.values(MARKETS),
              unavailable: Object.entries(KNOWN_ABSENT).map(([code, reason]) => ({ code, reason })),
              defaultMarket: ctx.config.defaultMarket,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'server-info',
    'foodpanda://server-info',
    {
      title: 'Server capabilities and version',
      description:
        'Server version, tool schema version, configured limits and the data-source disclaimer. Useful for diagnostics.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              name: SERVER_NAME,
              version: SERVER_VERSION,
              toolSchemaVersion: TOOL_SCHEMA_VERSION,
              transport: ctx.config.transport,
              readOnly: true,
              capabilities: {
                ordering: false,
                authentication: false,
                accountAccess: false,
                payments: false,
              },
              limits: {
                rateLimitRps: ctx.config.rateLimitRps,
                maxConcurrency: ctx.config.maxConcurrency,
                timeoutMs: ctx.config.timeoutMs,
                maxRetries: ctx.config.maxRetries,
              },
              cache: { backend: ctx.config.cacheBackend, ttlSeconds: ctx.config.ttl },
              disclaimer:
                'Unofficial project. Not affiliated with, endorsed by, or connected to foodpanda or Delivery Hero SE. ' +
                'Reads public, unauthenticated endpoints only. Prices and availability are indicative; the foodpanda ' +
                'app or website at checkout is the only authority.',
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'restaurant',
    new ResourceTemplate('foodpanda://restaurant/{market}/{code}', { list: undefined }),
    {
      title: 'Restaurant record',
      description:
        'A single restaurant as JSON, addressed by market and code, e.g. foodpanda://restaurant/pk/u1od. ' +
        'Includes fees, rating, deals, schedule and menu summary.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const market = String(variables.market);
      const code = String(variables.code);
      try {
        const { restaurant, menu } = await ctx.foodpanda.getVendorDetail(code, market);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  ...restaurant,
                  menuSummary: {
                    itemCount: menu.itemCount,
                    categories: menu.categories.map((c) => ({ name: c.name, itemCount: c.items.length })),
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        // A resource read must return something readable rather than throwing.
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                { error: err instanceof Error ? err.message : String(err), market, code },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
