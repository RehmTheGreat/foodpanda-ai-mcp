import type { HttpClient } from '../http/client.js';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import {
  UpstreamConfigurationSchema,
  UpstreamListingSchema,
  UpstreamVendorDetailSchema,
  safeValidate,
} from '../domain/schemas.js';
import { normalizeCuisines, normalizeMenu, normalizeRestaurant } from '../domain/normalize.js';
import { getMarket, isSupportedMarket, KNOWN_ABSENT } from '../domain/markets.js';
import type { Cuisine, Menu, Restaurant } from '../domain/types.js';

/**
 * THE ADAPTER BOUNDARY.
 *
 * Every upstream URL, query parameter and required header in this project lives
 * in this file and nowhere else. Tools call these methods and receive normalised
 * domain objects. When foodpanda changes an endpoint, this is the only file to edit.
 *
 * Endpoint facts below were established by live probing on 2026-07-27, not from
 * documentation (there is none) or from training data. See docs/API-RESEARCH.md.
 */

const DISCO_HOST = 'https://disco.deliveryhero.io';
const menuHost = (market: string) => `https://${market}.fd-api.com`;

export class UnsupportedMarketError extends Error {
  constructor(market: string) {
    const reason = KNOWN_ABSENT[market.toLowerCase()];
    super(
      reason
        ? `Market "${market}" is not available: ${reason}`
        : `Market "${market}" is not supported. Supported markets: pk, bd, my, sg, ph, tw, hk, kh, la, mm.`,
    );
    this.name = 'UnsupportedMarketError';
  }
}

export interface ListingParams {
  latitude: number;
  longitude: number;
  market: string;
  vertical?: 'restaurants' | 'darkstores' | 'shop';
  /** Upstream cuisine id, from listCuisines(). */
  cuisineId?: number;
  sort?: 'rating_desc' | 'distance_asc' | 'delivery_time_asc' | 'minimum_order_value_asc';
  limit?: number;
  offset?: number;
}

export interface ListingResult {
  restaurants: Restaurant[];
  availableCount: number;
  returnedCount: number;
  cuisines: Cuisine[];
  warnings: string[];
}

/**
 * `perseus-client-id` / `perseus-session-id` are mandatory on the menu host —
 * omitting them returns 400 "perseus headers are absent". They are opaque
 * client-side tracking identifiers, not credentials and not tied to any account.
 * We mint a fresh random pair per process so no stable identifier is transmitted
 * and no user is tracked across runs.
 */
function perseusId(): string {
  const ms = Date.now();
  const digits = Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('');
  const hex = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  return `${ms}.${digits}.${hex}`;
}

export class FoodpandaAdapter {
  private readonly perseus = perseusId();

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private assertMarket(market: string): string {
    const m = market.toLowerCase();
    if (!isSupportedMarket(m)) throw new UnsupportedMarketError(m);
    return m;
  }

  /** The listing host rejects requests without this header: 403 "Invalid Client ID: null". */
  private discoHeaders(): Record<string, string> {
    return { 'x-disco-client-id': 'web' };
  }

  private menuHeaders(): Record<string, string> {
    return {
      'perseus-client-id': this.perseus,
      'perseus-session-id': this.perseus,
      // X-FP-API-KEY: volo is sent by the website but is NOT required — verified
      // by a control request that omitted it and still returned 200.
    };
  }

  /**
   * Nearby vendors. This is the only upstream discovery primitive that exists:
   * there is no working text-search endpoint, so higher layers filter locally.
   */
  async listVendors(params: ListingParams): Promise<ListingResult> {
    const market = this.assertMarket(params.market);
    const q = new URLSearchParams({
      latitude: String(params.latitude),
      longitude: String(params.longitude),
      language_id: String(this.config.languageId),
      country: market,
      vertical: params.vertical ?? 'restaurants',
      customer_type: 'regular',
      configuration: 'Original',
      dynamic_pricing: '0',
      include: 'characteristics',
      limit: String(params.limit ?? 48),
      offset: String(params.offset ?? 0),
    });
    // Invalid sort values are silently accepted upstream and change ordering
    // unpredictably, so only a known-good allowlist is ever forwarded.
    if (params.sort) q.set('sort', params.sort);
    if (params.cuisineId !== undefined) q.set('cuisine', String(params.cuisineId));

    const url = `${DISCO_HOST}/listing/api/v1/pandora/vendors?${q.toString()}`;
    const raw = await this.http.getJson(url, {
      headers: this.discoHeaders(),
      ttlSeconds: this.config.ttl.listing,
    });

    const { value, warning } = safeValidate(UpstreamListingSchema, raw, 'vendor listing');
    const data: any = (value as any)?.data ?? {};
    const items: any[] = Array.isArray(data.items) ? data.items : [];

    const warnings: string[] = [];
    if (warning) warnings.push(warning);

    const restaurants: Restaurant[] = [];
    for (const item of items) {
      try {
        restaurants.push(normalizeRestaurant(item, market));
      } catch (err) {
        // One malformed vendor must not lose the other 47.
        this.logger.warn('skipped unparseable vendor', {
          error: err instanceof Error ? err.message : String(err),
        });
        warnings.push('One or more vendors could not be parsed and were omitted.');
      }
    }

    return {
      restaurants,
      availableCount: Number(data.available_count) || restaurants.length,
      returnedCount: Number(data.returned_count) || restaurants.length,
      cuisines: normalizeCuisines(data?.aggregations?.cuisines),
      warnings,
    };
  }

  /**
   * Fetch every nearby vendor by walking the offset pages.
   *
   * Needed because all text search and item search happens client-side. Bounded
   * by `maxPages` so a dense city cannot turn one tool call into 40 requests.
   */
  async listAllVendors(
    params: ListingParams,
    opts: { maxTotal?: number; pageSize?: number } = {},
  ): Promise<ListingResult> {
    const pageSize = Math.min(opts.pageSize ?? 100, 200);
    const maxTotal = opts.maxTotal ?? 200;

    const first = await this.listVendors({ ...params, limit: pageSize, offset: 0 });
    const target = Math.min(first.availableCount, maxTotal);

    // De-duplicate by vendor code. Offset paging over a live, reordering index
    // can return the same vendor on two pages; without this the caller sees
    // duplicates and any "how many matched" count is wrong.
    const seen = new Set<string>();
    const all: Restaurant[] = [];
    const push = (list: Restaurant[]): number => {
      let added = 0;
      for (const r of list) {
        if (r.code && seen.has(r.code)) continue;
        if (r.code) seen.add(r.code);
        all.push(r);
        added++;
      }
      return added;
    };

    push(first.restaurants);
    const warnings = [...first.warnings];

    let offset = first.restaurants.length;
    while (all.length < target && offset < target) {
      const page = await this.listVendors({ ...params, limit: pageSize, offset });
      if (page.restaurants.length === 0) break;
      const added = push(page.restaurants);
      warnings.push(...page.warnings);
      offset += page.restaurants.length;
      // A page that contributed nothing new means we have exhausted the index;
      // continuing would loop forever against a non-advancing upstream.
      if (added === 0) break;
    }

    if (first.availableCount > maxTotal) {
      warnings.push(
        `${first.availableCount} restaurants are available nearby; this result covers the first ${all.length}. Narrow the search or raise the limit for wider coverage.`,
      );
    }

    return {
      restaurants: all.slice(0, maxTotal),
      availableCount: first.availableCount,
      returnedCount: Math.min(all.length, maxTotal),
      cuisines: first.cuisines,
      warnings: [...new Set(warnings)],
    };
  }

  /** Full vendor record including menus, schedules and deals. */
  async getVendorDetail(
    code: string,
    market: string,
    opts: { latitude?: number; longitude?: number } = {},
  ): Promise<{ restaurant: Restaurant; menu: Menu; warnings: string[] }> {
    const m = this.assertMarket(market);
    const q = new URLSearchParams({
      include: 'menus,bundles,multiple_discounts',
      language_id: String(this.config.languageId),
      opening_type: 'delivery',
    });
    const cur = getMarket(m)?.currencySymbol;
    if (cur) q.set('basket_currency', currencyCode(m));
    // delivery_duration_range is only populated when coordinates are supplied —
    // verified by comparing responses with and without them.
    if (opts.latitude !== undefined && opts.longitude !== undefined) {
      q.set('latitude', String(opts.latitude));
      q.set('longitude', String(opts.longitude));
    }

    const url = `${menuHost(m)}/api/v5/vendors/${encodeURIComponent(code)}?${q.toString()}`;
    const raw = await this.http.getJson(url, {
      headers: this.menuHeaders(),
      ttlSeconds: this.config.ttl.vendor,
    });

    const { value, warning } = safeValidate(UpstreamVendorDetailSchema, raw, `vendor ${code}`);
    const data: any = (value as any)?.data;
    if (!data) {
      throw new Error(`Restaurant "${code}" was not found in market "${m}".`);
    }

    const warnings = warning ? [warning] : [];
    return {
      restaurant: normalizeRestaurant(data, m),
      menu: normalizeMenu(data, m),
      warnings,
    };
  }

  /** Per-market currency/timezone configuration. Cached for a day; it barely changes. */
  async getMarketConfiguration(market: string): Promise<{
    globalEntityId?: string;
    currencySymbol?: string;
    timezone?: string;
    decimalDigits?: number;
  }> {
    const m = this.assertMarket(market);
    const url = `${menuHost(m)}/api/v5/configuration?language_id=${this.config.languageId}`;
    const raw = await this.http.getJson(url, {
      headers: this.menuHeaders(),
      ttlSeconds: this.config.ttl.config,
    });
    const { value } = safeValidate(UpstreamConfigurationSchema, raw, `configuration ${m}`);
    const d: any = (value as any)?.data ?? {};
    const out: { globalEntityId?: string; currencySymbol?: string; timezone?: string; decimalDigits?: number } = {};
    if (d.global_entity_id) out.globalEntityId = String(d.global_entity_id);
    if (d.currency_symbol) out.currencySymbol = String(d.currency_symbol);
    if (d.timezone) out.timezone = String(d.timezone);
    if (d.number_of_decimal_digits !== undefined && d.number_of_decimal_digits !== null) {
      out.decimalDigits = Number(d.number_of_decimal_digits);
    }
    return out;
  }
}

/** ISO-4217 code per market, for the upstream `basket_currency` parameter. */
function currencyCode(market: string): string {
  const map: Record<string, string> = {
    pk: 'PKR',
    bd: 'BDT',
    my: 'MYR',
    sg: 'SGD',
    ph: 'PHP',
    tw: 'TWD',
    hk: 'HKD',
    kh: 'USD',
    la: 'LAK',
    mm: 'MMK',
  };
  return map[market] ?? 'USD';
}
