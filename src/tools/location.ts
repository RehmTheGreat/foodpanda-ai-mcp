import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildMeta, metaShape, toolError, toolResult, type ToolContext } from './context.js';
import { KNOWN_ABSENT, MARKETS } from '../domain/markets.js';

export function registerLocationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'resolve_location',
    {
      title: 'Resolve a location',
      description:
        'Turn a free-text address, neighbourhood or landmark into coordinates and identify which foodpanda market it belongs to. ' +
        'Call this first when the user names a place and you need to confirm coverage before searching. ' +
        'Returns candidate matches with latitude/longitude that other tools accept directly. ' +
        'Uses OpenStreetMap; no API key required.',
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe('Address, neighbourhood, landmark or city, e.g. "Gulshan-e-Iqbal, Karachi" or "Bugis, Singapore".'),
        limit: z.number().int().min(1).max(10).default(3).describe('Maximum candidate locations to return.'),
      },
      outputSchema: {
        locations: z.array(
          z.object({
            displayName: z.string(),
            latitude: z.number(),
            longitude: z.number(),
            countryCode: z.string().optional(),
            market: z.string().optional(),
            marketSupported: z.boolean(),
          }),
        ),
        meta: metaShape,
      },
    },
    async ({ query, limit }) => {
      try {
        const results = await ctx.geocoder.forward(query, limit);
        if (results.length === 0) {
          return toolResult(
            `No location found for "${query}". Try including the city and country, e.g. "${query}, Karachi, Pakistan".`,
            { locations: [], meta: buildMeta('', 'openstreetmap') },
          );
        }

        const lines = results.map((r, i) => {
          const status = r.marketSupported
            ? `foodpanda market: ${r.market} (${MARKETS[r.market!]?.name})`
            : `NOT in a supported foodpanda market${r.countryCode ? ` (country: ${r.countryCode})` : ''}`;
          return `${i + 1}. ${r.displayName}\n   ${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}\n   ${status}`;
        });

        const supported = results.filter((r) => r.marketSupported);
        const text =
          `Found ${results.length} location(s) for "${query}":\n\n${lines.join('\n\n')}` +
          (supported.length === 0
            ? `\n\nNone of these are in a market this server covers (pk, bd, my, sg, ph, tw, hk, kh, la, mm).`
            : `\n\nPass latitude/longitude from the best match into search_restaurants.`);

        return toolResult(text, {
          locations: results.map((r) => ({
            displayName: r.displayName,
            latitude: r.latitude,
            longitude: r.longitude,
            ...(r.countryCode ? { countryCode: r.countryCode } : {}),
            ...(r.market ? { market: r.market } : {}),
            marketSupported: r.marketSupported,
          })),
          meta: buildMeta(supported[0]?.market ?? '', 'openstreetmap'),
        });
      } catch (err) {
        return toolError(err, 'You can bypass address lookup entirely by passing latitude and longitude directly to the other tools.');
      }
    },
  );

  server.registerTool(
    'list_markets',
    {
      title: 'List supported markets',
      description:
        'List every foodpanda market this server can query, with currency, timezone and a representative city. ' +
        'Use it to check coverage before searching, or to discover the correct two-letter market code. ' +
        'Answers offline from a verified table; pass verify=true to re-confirm one market against the live API.',
      inputSchema: {
        verify: z
          .boolean()
          .default(false)
          .describe('When true, fetch live configuration for `market` to confirm it is reachable right now.'),
        market: z.string().length(2).optional().describe('Market code to verify. Only used when verify=true.'),
      },
      outputSchema: {
        markets: z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            currencySymbol: z.string().optional(),
            timezone: z.string().optional(),
            globalEntityId: z.string().optional(),
          }),
        ),
        unavailable: z.array(z.object({ code: z.string(), reason: z.string() })),
        verified: z
          .object({ market: z.string(), reachable: z.boolean(), detail: z.string().optional() })
          .optional(),
        meta: metaShape,
      },
    },
    async ({ verify, market }) => {
      const list = Object.values(MARKETS);
      let verified: { market: string; reachable: boolean; detail?: string } | undefined;

      if (verify && market) {
        try {
          const cfg = await ctx.foodpanda.getMarketConfiguration(market);
          verified = {
            market,
            reachable: true,
            detail: `entity=${cfg.globalEntityId ?? '?'} currency=${cfg.currencySymbol ?? '?'} tz=${cfg.timezone ?? '?'}`,
          };
        } catch (err) {
          verified = { market, reachable: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }

      const table = list
        .map((m) => `- ${m.code} — ${m.name} · ${m.currencySymbol} · ${m.timezone}`)
        .join('\n');
      const absent = Object.entries(KNOWN_ABSENT)
        .map(([c, r]) => `- ${c} — unavailable: ${r}`)
        .join('\n');

      const text =
        `foodpanda markets supported by this server (${list.length}):\n\n${table}\n\n` +
        (absent ? `Known unavailable:\n${absent}\n\n` : '') +
        (verified
          ? `Live check of "${verified.market}": ${verified.reachable ? 'reachable' : 'NOT reachable'}${
              verified.detail ? ` — ${verified.detail}` : ''
            }\n\n`
          : '') +
        `Pass any of these codes as \`market\`, or let the server infer it from your coordinates.`;

      return toolResult(text, {
        markets: list.map((m) => ({
          code: m.code,
          name: m.name,
          ...(m.currencySymbol ? { currencySymbol: m.currencySymbol } : {}),
          ...(m.timezone ? { timezone: m.timezone } : {}),
          ...(m.globalEntityId ? { globalEntityId: m.globalEntityId } : {}),
        })),
        unavailable: Object.entries(KNOWN_ABSENT).map(([code, reason]) => ({ code, reason })),
        ...(verified ? { verified } : {}),
        meta: buildMeta(market ?? ctx.config.defaultMarket, verify ? 'foodpanda' : 'computed'),
      });
    },
  );
}
