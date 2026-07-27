import { describe, it, expect } from 'vitest';
import { fixture, makeAdapter, testConfig, type RouteSpec } from './helpers.js';

/**
 * Defect 3: filtered searches scanned only the first 100 of ~490 nearby vendors
 * and flagged degraded:true, so every filtered answer was a truncated sample.
 *
 * The listing host has no page-size cap and is not the rate-limited one, so full
 * coverage is a couple of cheap requests.
 */

/** A listing stub that pages over `total` synthetic vendors like upstream does. */
function pagedListing(total: number): RouteSpec[] {
  const base = fixture('listing-pk.json');
  const template = base.data.items[0];

  return [
    {
      match: 'disco.deliveryhero.io',
      handler: (url: string) => {
        const u = new URL(url);
        const limit = Number(u.searchParams.get('limit') ?? '48');
        const offset = Number(u.searchParams.get('offset') ?? '0');
        const items = [];
        for (let i = offset; i < Math.min(offset + limit, total); i++) {
          items.push({ ...template, id: i, code: `v${i}`, name: `Vendor ${i}` });
        }
        return {
          status_code: 200,
          message: 'success',
          data: {
            available_count: total,
            returned_count: items.length,
            items,
            aggregations: base.data.aggregations,
          },
        };
      },
    },
  ];
}

describe('listing pagination and coverage', () => {
  it('scans every nearby vendor when the ceiling allows it', async () => {
    const { adapter } = makeAdapter(pagedListing(490), testConfig({ maxScan: 600, listingPageSize: 200 }));
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });

    expect(res.restaurants).toHaveLength(490);
    expect(res.availableCount).toBe(490);
    expect(res.complete).toBe(true);
  });

  it('emits no truncation warning when coverage is complete', async () => {
    const { adapter } = makeAdapter(pagedListing(490), testConfig({ maxScan: 600, listingPageSize: 200 }));
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    // The old behaviour warned on every large area, training callers to ignore it.
    expect(res.warnings.filter((w) => /available nearby/i.test(w))).toHaveLength(0);
  });

  it('uses few requests because the page size is large', async () => {
    const { adapter, stub } = makeAdapter(pagedListing(490), testConfig({ maxScan: 600, listingPageSize: 200 }));
    await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    // 490 vendors at 200/page is 3 requests, not 5 at the old 100/page.
    expect(stub.calls.length).toBeLessThanOrEqual(3);
    expect(stub.calls[0]).toContain('limit=200');
  });

  it('still warns, and reports incomplete, when genuinely capped', async () => {
    const { adapter } = makeAdapter(pagedListing(490), testConfig({ maxScan: 100, listingPageSize: 100 }));
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });

    expect(res.restaurants).toHaveLength(100);
    expect(res.complete).toBe(false);
    expect(res.warnings.some((w) => /490 restaurants are available nearby/i.test(w))).toBe(true);
    expect(res.warnings.some((w) => /scanLimit|FOODPANDA_MAX_SCAN/.test(w))).toBe(true);
  });

  it('honours an explicit per-call ceiling over the configured one', async () => {
    const { adapter } = makeAdapter(pagedListing(490), testConfig({ maxScan: 600 }));
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' }, { maxTotal: 40 });
    expect(res.restaurants).toHaveLength(40);
    expect(res.complete).toBe(false);
  });

  it('stops cleanly when the area holds fewer vendors than the ceiling', async () => {
    const { adapter, stub } = makeAdapter(pagedListing(12), testConfig({ maxScan: 600, listingPageSize: 200 }));
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(res.restaurants).toHaveLength(12);
    expect(res.complete).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('does not loop forever against an upstream that never advances', async () => {
    // Every page returns the same vendor: de-duplication must break the loop.
    const { adapter, stub } = makeAdapter(
      [
        {
          match: 'disco.deliveryhero.io',
          body: {
            status_code: 200,
            data: {
              available_count: 500,
              returned_count: 1,
              items: [fixture('listing-pk.json').data.items[0]],
              aggregations: {},
            },
          },
        },
      ],
      testConfig({ maxScan: 600 }),
    );
    const res = await adapter.listAllVendors({ latitude: 24.8, longitude: 67.0, market: 'pk' });
    expect(res.restaurants).toHaveLength(1);
    expect(stub.calls.length).toBeLessThan(5);
  });
});
