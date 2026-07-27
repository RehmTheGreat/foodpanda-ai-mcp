import { describe, it, expect } from 'vitest';
import { defaultRoutes, fixture, makeAdapter, testConfig } from './helpers.js';
import { UnsupportedMarketError } from '../src/adapters/foodpanda.js';
import { guessMarketFromCoordinates, isSupportedMarket, MARKET_CODES } from '../src/domain/markets.js';

describe('FoodpandaAdapter', () => {
  it('sends the client-id header the listing host requires', async () => {
    // Omitting x-disco-client-id returns 403 "Invalid Client ID: null" upstream.
    let seen: Record<string, string> = {};
    const { adapter } = makeAdapterCapturing((h) => (seen = h));
    await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(seen['x-disco-client-id']).toBe('web');
  });

  it('sends perseus headers on the menu host', async () => {
    // Omitting them returns 400 "perseus headers are absent".
    let seen: Record<string, string> = {};
    const { adapter } = makeAdapterCapturing((h) => (seen = h));
    await adapter.getVendorDetail('u1od', 'pk');
    expect(seen['perseus-client-id']).toBeTruthy();
    expect(seen['perseus-session-id']).toBeTruthy();
  });

  it('normalises a listing into domain restaurants', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    const res = await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(res.restaurants.length).toBeGreaterThan(0);
    expect(res.availableCount).toBeGreaterThan(0);
    expect(res.cuisines.length).toBeGreaterThan(0);
    expect(res.restaurants[0]!.market).toBe('pk');
  });

  it('exposes the cuisine catalogue from listing aggregations', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    const res = await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    const biryani = res.cuisines.find((c) => /biryani/i.test(c.name));
    expect(biryani?.id).toBeTypeOf('number');
    expect(biryani?.restaurantCount).toBeGreaterThan(0);
  });

  it('only forwards allowlisted sort values', async () => {
    // Upstream accepts any string for `sort` and silently reorders, so the
    // adapter must never pass through an arbitrary value.
    const { adapter, stub } = makeAdapter(defaultRoutes());
    await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk', sort: 'rating_desc' });
    expect(stub.calls[0]).toContain('sort=rating_desc');

    await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(stub.calls[1]).not.toContain('sort=');
  });

  it('returns a menu and a restaurant from vendor detail', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    const { restaurant, menu } = await adapter.getVendorDetail('u1od', 'pk');
    expect(restaurant.name).toBeTruthy();
    expect(menu.itemCount).toBeGreaterThan(0);
    expect(menu.categories.length).toBeGreaterThan(0);
  });

  it('computes open status from the detail schedule', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    const { restaurant } = await adapter.getVendorDetail('u1od', 'pk');
    expect(restaurant.openStatus).toBeDefined();
    expect(restaurant.openStatus!.timezone).toBe('Asia/Karachi');
  });

  it('adds coordinates to the detail request only when supplied', async () => {
    // delivery_duration_range is null unless lat/lng are sent.
    const { adapter, stub } = makeAdapter(defaultRoutes());
    await adapter.getVendorDetail('u1od', 'pk');
    expect(stub.calls[0]).not.toContain('latitude=');
    await adapter.getVendorDetail('u1od', 'pk', { latitude: 24.8, longitude: 67.0 });
    expect(stub.calls[1]).toContain('latitude=24.8');
  });

  it('rejects an unsupported market with an actionable message', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    await expect(adapter.listVendors({ latitude: 1, longitude: 1, market: 'zz' })).rejects.toBeInstanceOf(
      UnsupportedMarketError,
    );
  });

  it('explains why Thailand is unavailable rather than saying "unsupported"', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    await expect(adapter.listVendors({ latitude: 13.7, longitude: 100.5, market: 'th' })).rejects.toThrow(
      /Origin DNS error|not available/i,
    );
  });

  it('reads currency and timezone from market configuration', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    const cfg = await adapter.getMarketConfiguration('pk');
    expect(cfg.globalEntityId).toBe('FP_PK');
    expect(cfg.timezone).toBe('Asia/Karachi');
  });

  it('degrades instead of throwing when the payload shape is unrecognisable', async () => {
    const { adapter } = makeAdapter([{ match: 'disco.deliveryhero.io', body: { unexpected: true } }]);
    const res = await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(res.restaurants).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('keeps good vendors when one entry in the list is malformed', async () => {
    const listing = structuredClone(fixture('listing-pk.json'));
    listing.data.items[1] = { garbage: true, name: null };
    const { adapter } = makeAdapter([{ match: 'disco.deliveryhero.io', body: listing }]);
    const res = await adapter.listVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(res.restaurants.length).toBeGreaterThan(1);
  });

  it('paginates until the requested total is reached', async () => {
    const { adapter, stub } = makeAdapter(defaultRoutes());
    await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' }, { maxTotal: 18, pageSize: 6 });
    expect(stub.calls.length).toBeGreaterThan(1);
    expect(stub.calls[0]).toContain('limit=6');
  });

  it('warns when more restaurants exist than were scanned', async () => {
    const { adapter } = makeAdapter(defaultRoutes());
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' }, { maxTotal: 6 });
    expect(res.warnings.some((w) => /available nearby/i.test(w))).toBe(true);
  });
});

describe('markets', () => {
  it('lists exactly the markets verified live', () => {
    expect(MARKET_CODES.sort()).toEqual(['bd', 'hk', 'kh', 'la', 'mm', 'my', 'pk', 'ph', 'sg', 'tw'].sort());
  });

  it('excludes Thailand, which failed verification', () => {
    expect(isSupportedMarket('th')).toBe(false);
  });

  it('guesses the market from coordinates, preferring the smallest box', () => {
    expect(guessMarketFromCoordinates(24.86, 67.0)).toBe('pk');
    expect(guessMarketFromCoordinates(1.3521, 103.8198)).toBe('sg'); // inside Malaysia's box too
    expect(guessMarketFromCoordinates(22.3193, 114.1694)).toBe('hk');
    expect(guessMarketFromCoordinates(23.8103, 90.4125)).toBe('bd');
  });

  it('returns undefined well outside every market', () => {
    expect(guessMarketFromCoordinates(51.5, -0.12)).toBeUndefined(); // London
  });
});

function makeAdapterCapturing(onHeaders: (h: Record<string, string>) => void) {
  const routes = defaultRoutes();
  const cfg = testConfig();
  const { adapter, http, stub } = makeAdapter(routes, cfg);
  const original = (http as any).fetchImpl;
  (http as any).fetchImpl = async (url: any, init: any) => {
    onHeaders((init?.headers ?? {}) as Record<string, string>);
    return original(url, init);
  };
  return { adapter, stub };
}
