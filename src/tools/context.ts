import { z } from 'zod';
import type { FoodpandaAdapter } from '../adapters/foodpanda.js';
import type { GeocodeAdapter } from '../adapters/geocode.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { getMarket, guessMarketFromCoordinates, isSupportedMarket } from '../domain/markets.js';
import type { ResolvedLocation, ToolMeta } from '../domain/types.js';

export interface ToolContext {
  foodpanda: FoodpandaAdapter;
  geocoder: GeocodeAdapter;
  config: Config;
  logger: Logger;
}

/**
 * TOOL SCHEMA VERSION.
 *
 * Bumped when a tool's input or output shape changes incompatibly. Reported by
 * the `list_markets` tool and the foodpanda://server-info resource so clients
 * can detect drift. See docs/VERSIONING.md for the deprecation policy.
 */
export const TOOL_SCHEMA_VERSION = '1.2.0';

/**
 * Location input shared by every location-aware tool.
 *
 * Accepting either an address or raw coordinates is what makes "what's open near
 * me" work in one call: models reliably have a place name, rarely coordinates.
 */
export const locationInput = {
  address: z
    .string()
    .min(2)
    .optional()
    .describe(
      'Free-text address, neighbourhood or landmark, e.g. "Clifton, Karachi" or "Orchard Road, Singapore". Resolved to coordinates via OpenStreetMap. Either this or latitude+longitude is required.',
    ),
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Latitude in decimal degrees. Use with longitude to skip address lookup.'),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe('Longitude in decimal degrees. Use with latitude to skip address lookup.'),
  market: z
    .string()
    .length(2)
    .optional()
    .describe(
      'Two-letter market code: pk, bd, my, sg, ph, tw, hk, kh, la, mm. Inferred from the location when omitted.',
    ),
};

export class LocationRequiredError extends Error {
  constructor() {
    super(
      'A location is required. Provide either `address` (e.g. "Gulshan, Dhaka") or both `latitude` and `longitude`.',
    );
    this.name = 'LocationRequiredError';
  }
}

export class MarketMismatchError extends Error {
  constructor(market: string, display: string) {
    super(
      `The resolved location "${display}" is not in a market foodpanda serves via this API (detected: ${market || 'unknown'}). ` +
        `Supported markets are pk, bd, my, sg, ph, tw, hk, kh, la, mm. If the location is correct, pass \`market\` explicitly to override detection.`,
    );
    this.name = 'MarketMismatchError';
  }
}

/**
 * Turn whatever the caller supplied into coordinates plus a market.
 * Coordinates win over an address when both are given (they are unambiguous).
 */
export async function resolveLocation(
  ctx: ToolContext,
  input: { address?: string | undefined; latitude?: number | undefined; longitude?: number | undefined; market?: string | undefined },
): Promise<ResolvedLocation> {
  let resolved: ResolvedLocation;

  if (input.latitude !== undefined && input.longitude !== undefined) {
    resolved = ctx.geocoder.fromCoordinates(input.latitude, input.longitude);
  } else if (input.address) {
    const hits = await ctx.geocoder.forward(input.address, 1);
    const first = hits[0];
    if (!first) {
      throw new Error(
        `Could not find a location matching "${input.address}". Try adding the city and country, e.g. "Clifton, Karachi, Pakistan".`,
      );
    }
    resolved = first;
  } else {
    throw new LocationRequiredError();
  }

  // An explicit market always overrides detection.
  if (input.market) {
    const m = input.market.toLowerCase();
    if (!isSupportedMarket(m)) throw new MarketMismatchError(m, resolved.displayName);
    return { ...resolved, market: m, marketSupported: true };
  }

  const market = resolved.market ?? guessMarketFromCoordinates(resolved.latitude, resolved.longitude);
  if (!market || !isSupportedMarket(market)) {
    throw new MarketMismatchError(market ?? '', resolved.displayName);
  }
  return { ...resolved, market, marketSupported: true };
}

/**
 * The single definition of the `meta` envelope used by every tool's outputSchema.
 *
 * It must be shared: zod-derived JSON Schema sets additionalProperties=false, so
 * a per-tool copy that drifts from buildMeta() causes the SDK to reject otherwise
 * valid responses at runtime. That is exactly what happened before this was unified.
 */
export const metaShape = z.object({
  market: z.string(),
  currencySymbol: z.string().optional(),
  source: z.string(),
  retrievedAt: z.string(),
  warnings: z.array(z.string()).optional(),
  degraded: z.boolean().optional(),
});

/**
 * Charges on top of the basket, shared by every tool that reports pricing.
 *
 * `pricingNote` is part of the payload on purpose: the single easiest mistake a
 * model can make with this data is to subtract an advertised discount from a
 * menu price that already includes it. Saying so inline is cheaper than hoping
 * the caller read the docs.
 */
export const feesShape = z.object({
  minimumOrderAmount: z.number().optional(),
  smallOrderFee: z.number().optional(),
  deliveryFee: z.number().optional(),
  isServiceFeeEnabled: z.boolean().optional(),
  serviceFeePercent: z.number().optional(),
  vatPercent: z.number().optional(),
  isVatIncludedInPrice: z.boolean().optional(),
  isVatVisible: z.boolean().optional(),
});

/** A discount with the numbers needed to reason about it, not just its label. */
export const discountShape = z.object({
  type: z.string(),
  description: z.string(),
  percentage: z.number().optional(),
  amount: z.number().optional(),
  minimumOrderValue: z.number().optional(),
  maximumDiscountAmount: z.number().optional(),
});

export const dealShape = z.object({
  title: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  value: z.number().optional(),
  minimumOrderValue: z.number().optional(),
  maximumDiscountAmount: z.number().optional(),
  isProOnly: z.boolean().optional(),
  isNewCustomerOnly: z.boolean().optional(),
});

export const PRICING_NOTE =
  'Menu prices already include vendor deals and discounts - do not subtract them again. ' +
  'Fees are additive on top of the basket. Bank and voucher codes are not covered here, and whether a vendor ' +
  'accepts one cannot be determined from any data this server can read - many vendors accept none - so quote ' +
  'the menu price as the real price and never let an option fit a budget only after subtracting an assumed ' +
  'voucher. A pickup-only discount, by contrast, IS readable: fetch the menu again with openingType "pickup". ' +
  'The foodpanda checkout screen is the only authority on the final total.';

export function buildMeta(
  market: string,
  source: ToolMeta['source'],
  warnings: string[] = [],
): ToolMeta {
  const meta: ToolMeta = {
    market,
    source,
    retrievedAt: new Date().toISOString(),
  };
  const cur = getMarket(market)?.currencySymbol;
  if (cur) meta.currencySymbol = cur;
  if (warnings.length) {
    meta.warnings = warnings;
    meta.degraded = true;
  }
  return meta;
}

/** Money formatting that respects each market's symbol and decimal convention. */
export function money(amount: number | undefined, market: string): string {
  if (amount === undefined || !Number.isFinite(amount)) return 'n/a';
  const m = getMarket(market);
  const digits = m?.decimalDigits ?? 2;
  const formatted = amount.toFixed(digits);
  const sym = m?.currencySymbol ?? '';
  return m?.currencyPosition === 'right' ? `${formatted}${sym}` : `${sym}${formatted}`;
}

/**
 * Every tool returns BOTH a machine-readable payload and this human-readable
 * text. The MCP spec allows content-only responses, but a model reading a wall
 * of JSON answers worse than one reading a formatted summary — and non-structured
 * clients see something legible instead of a blob.
 */
export function toolResult(text: string, structured: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

/** Uniform error rendering. isError tells the client the call failed. */
export function toolError(err: unknown, hint?: string) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: hint ? `${message}\n\n${hint}` : message }],
    isError: true,
  };
}
