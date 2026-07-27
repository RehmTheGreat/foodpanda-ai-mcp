import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, SERVER_NAME, SERVER_VERSION, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createCache } from './cache/index.js';
import { HttpClient } from './http/client.js';
import { FoodpandaAdapter } from './adapters/foodpanda.js';
import { GeocodeAdapter } from './adapters/geocode.js';
import { registerRestaurantTools } from './tools/restaurants.js';
import { registerMenuTools } from './tools/menus.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerExportTools } from './tools/export.js';
import { registerLocationTools } from './tools/location.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import type { ToolContext } from './tools/context.js';

export interface BuiltServer {
  server: McpServer;
  ctx: ToolContext;
  http: HttpClient;
  logger: Logger;
  config: Config;
}

/**
 * Compose the server: config -> logger -> cache -> http client -> adapters ->
 * tools. Dependencies are constructed here and injected downwards, so every
 * layer is independently testable with fakes.
 */
export async function buildServer(overrides: Partial<Config> = {}): Promise<BuiltServer> {
  const config: Config = { ...loadConfig(), ...overrides };
  const logger = createLogger(config.logLevel, config.logFormat, { server: SERVER_NAME });

  const cache = await createCache({
    backend: config.cacheBackend,
    maxEntries: config.cacheMaxEntries,
    redisUrl: config.redisUrl,
    logger,
  });

  const http = new HttpClient({
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    rateLimitRps: config.rateLimitRps,
    rateLimitBurst: config.rateLimitBurst,
    maxConcurrency: config.maxConcurrency,
    breakerThreshold: config.breakerThreshold,
    breakerResetMs: config.breakerResetMs,
    cache,
    logger: logger.child({ component: 'http' }),
  });

  const ctx: ToolContext = {
    foodpanda: new FoodpandaAdapter(http, config, logger.child({ component: 'foodpanda' })),
    geocoder: new GeocodeAdapter(http, config),
    config,
    logger,
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only access to foodpanda restaurant discovery data across 10 markets ' +
        '(Pakistan, Bangladesh, Malaysia, Singapore, Philippines, Taiwan, Hong Kong, Cambodia, Laos, Myanmar).\n\n' +
        'Typical flow: resolve_location -> search_restaurants -> get_menu / get_restaurant. ' +
        'For price hunting across many restaurants use search_menu_items. ' +
        'Most tools accept either an address or latitude+longitude.\n\n' +
        'This server cannot place orders, log in, access an account, or make payments — it only reads public listings. ' +
        'Prices and availability are indicative; the foodpanda app at checkout is the only authority.',
    },
  );

  registerLocationTools(server, ctx);
  registerRestaurantTools(server, ctx);
  registerMenuTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerExportTools(server, ctx);
  registerPrompts(server);
  registerResources(server, ctx);

  logger.info('server built', {
    version: SERVER_VERSION,
    transport: config.transport,
    cache: config.cacheBackend,
    defaultMarket: config.defaultMarket,
  });

  return { server, ctx, http, logger, config };
}
