import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { normalizeRestaurant, normalizeSchedules } from '../src/domain/normalize.js';

/**
 * Regression tests for the three defects reported against the deployed server
 * on 2026-07-27. Each one asserts the observed broken behaviour cannot return.
 */

const listing = fixture('listing-pk.json');
const detail = fixture('vendor-detail-pk.json');

const urlOf = (v: any, market: string) => normalizeRestaurant(v, market).url;

/** A correct link has exactly one "scheme://" and names the host exactly once. */
function assertSingleOrigin(url: string | undefined, expectedHost: string) {
  expect(url, 'no url emitted').toBeTruthy();
  expect(url!.match(/:\/\//g) ?? [], `"${url}" has more than one scheme`).toHaveLength(1);
  expect(url!.match(/foodpanda/g) ?? [], `"${url}" repeats the host`).toHaveLength(1);
  const parsed = new URL(url!);
  expect(parsed.protocol).toBe('https:');
  expect(parsed.host).toBe(expectedHost);
}

describe('defect 1: restaurant URLs were doubled', () => {
  // Deployed output was:
  //   https://www.foodpanda.pk/https://foodpanda.pk/restaurant/s4pe/burger-lab-dha-clifton
  // because web_path is ALREADY absolute and was being prefixed with a host.

  it('reproduces the exact reported case cleanly', () => {
    const url = urlOf(
      { code: 's4pe', name: 'Burger Lab', web_path: 'https://foodpanda.pk/restaurant/s4pe/burger-lab-dha-clifton' },
      'pk',
    );
    expect(url).toBe('https://foodpanda.pk/restaurant/s4pe/burger-lab-dha-clifton');
    expect(url).not.toContain('foodpanda.pk/https');
  });

  it('handles the listing host (no www)', () => {
    assertSingleOrigin(
      urlOf(
        { code: 'u1od', name: 'Subway', web_path: 'https://foodpanda.pk/restaurant/u1od/subway-sehar-commercial-ave' },
        'pk',
      ),
      'foodpanda.pk',
    );
  });

  it('handles the detail host, which uses www for the same vendor', () => {
    assertSingleOrigin(
      urlOf(
        { code: 'u1od', name: 'Subway', web_path: 'https://www.foodpanda.pk/restaurant/u1od/subway-sehar-commercial-ave' },
        'pk',
      ),
      'www.foodpanda.pk',
    );
  });

  it('handles other markets, whose hosts follow no derivable rule', () => {
    // Real captured values: Bangladesh is .com.bd but Malaysia is plain .my.
    assertSingleOrigin(
      urlOf({ code: 'ejhq', name: 'Kung Pao', web_path: 'https://foodpanda.com.bd/restaurant/ejhq/kung-pao-gulshan' }, 'bd'),
      'foodpanda.com.bd',
    );
    assertSingleOrigin(
      urlOf({ code: 'i89c', name: 'Empire Sushi', web_path: 'https://foodpanda.my/restaurant/i89c/empire-sushi-nu-sentral' }, 'my'),
      'foodpanda.my',
    );
  });

  it('builds a per-market URL when upstream sends no link at all', () => {
    const bare = { code: 'abcd', name: 'X', url_key: 'x-place' };
    expect(urlOf(bare, 'pk')).toBe('https://foodpanda.pk/restaurant/abcd/x-place');
    assertSingleOrigin(urlOf(bare, 'bd'), 'foodpanda.com.bd');
    assertSingleOrigin(urlOf(bare, 'sg'), 'foodpanda.sg');
    assertSingleOrigin(urlOf(bare, 'my'), 'foodpanda.my');
  });

  it('joins a genuinely relative path without doubling', () => {
    assertSingleOrigin(urlOf({ code: 'abcd', name: 'X', web_path: '/restaurant/abcd/x' }, 'pk'), 'foodpanda.pk');
  });

  it('falls back to redirection_url when web_path is absent', () => {
    assertSingleOrigin(
      urlOf({ code: 'u1od', name: 'X', redirection_url: 'https://foodpanda.pk/restaurant/u1od/x' }, 'pk'),
      'foodpanda.pk',
    );
  });

  it('omits the url rather than emitting a broken or unsafe one', () => {
    expect(urlOf({ code: 'abcd', name: 'X' }, 'pk')).toBeUndefined();
    expect(urlOf({ code: 'abcd', name: 'X', web_path: 'not a url' }, 'zz')).toBeUndefined();
    expect(urlOf({ code: 'a', name: 'X', web_path: 'javascript:alert(1)' }, 'pk')).toBeUndefined();
  });

  it('every vendor in the real listing fixture yields a single-origin url', () => {
    let checked = 0;
    for (const v of listing.data.items) {
      const url = normalizeRestaurant(v, 'pk').url;
      if (!url) continue;
      checked++;
      expect(url.match(/:\/\//g) ?? []).toHaveLength(1);
      expect(() => new URL(url)).not.toThrow();
    }
    expect(checked, 'fixture should exercise at least one url').toBeGreaterThan(0);
  });
});

describe('defect 2: pricing fields were dropped', () => {
  it('reads the fee fields the LISTING fixture really carries', () => {
    const v = listing.data.items[0];
    // Guard the premise: if upstream drops these, fail loudly rather than silently pass.
    expect(v).toHaveProperty('is_service_fee_enabled');
    expect(v).toHaveProperty('vat_percentage_amount');

    const fees = normalizeRestaurant(v, 'pk').fees;
    expect(fees).toBeDefined();
    expect(fees!.isServiceFeeEnabled).toBe(v.is_service_fee_enabled);
    expect(fees!.vatPercent).toBe(v.vat_percentage_amount);
    expect(fees!.minimumOrderAmount).toBe(v.minimum_order_amount);
  });

  it('reads all five fields from a DETAIL-shaped payload', () => {
    const fees = normalizeRestaurant(
      {
        code: 'u1od',
        name: 'Subway',
        minimum_order_amount: 299,
        small_order_fee: 55,
        minimum_delivery_fee: 0,
        is_service_fee_enabled: true,
        service_fee_percentage_amount: 5,
        vat_percentage_amount: 16,
        is_vat_included_in_product_price: true,
        is_vat_visible: true,
      },
      'pk',
    ).fees;

    expect(fees).toEqual({
      minimumOrderAmount: 299,
      smallOrderFee: 55,
      deliveryFee: 0,
      isServiceFeeEnabled: true,
      serviceFeePercent: 5,
      vatPercent: 16,
      isVatIncludedInPrice: true,
      isVatVisible: true,
    });
  });

  it('keeps a zero fee instead of dropping it as falsy', () => {
    // "0% VAT" is information; it is not the same as "unknown".
    const fees = normalizeRestaurant(
      { code: 'a', name: 'A', small_order_fee: 0, vat_percentage_amount: 0, is_service_fee_enabled: false },
      'pk',
    ).fees;
    expect(fees!.smallOrderFee).toBe(0);
    expect(fees!.vatPercent).toBe(0);
    expect(fees!.isServiceFeeEnabled).toBe(false);
  });

  it('omits fees entirely when the payload carries none', () => {
    expect(normalizeRestaurant({ code: 'a', name: 'A' }, 'pk').fees).toBeUndefined();
  });

  it('does not throw on wrong-typed fee fields', () => {
    expect(() =>
      normalizeRestaurant(
        { code: 'a', name: 'A', small_order_fee: 'lots', vat_percentage_amount: {}, is_service_fee_enabled: 'yes' },
        'pk',
      ),
    ).not.toThrow();
  });

  describe('both discount shapes survive with their numbers', () => {
    it('DETAIL shape: blank descriptions, numbers preserved', () => {
      const d = detail.data;
      // Guard the premise documented in API-RESEARCH: detail discounts ship blank copy.
      expect(d.discounts.some((x: any) => !x.description)).toBe(true);

      const r = normalizeRestaurant(d, 'pk');
      expect(r.discounts.length).toBeGreaterThan(0);
      for (const disc of r.discounts) expect(disc.description).not.toBe('');
      expect(r.discounts.some((x) => x.percentage !== undefined || x.amount !== undefined)).toBe(true);
      expect(r.deals.length).toBeGreaterThan(0);
    });

    it('LISTING shape: discounts[] empty, data recovered from tags[] + discounts_info[]', () => {
      const v = listing.data.items.find(
        (x: any) => Array.isArray(x.tags) && x.tags.some((t: any) => t.code === 'DEAL'),
      );
      expect(v, 'fixture needs a vendor with a DEAL tag').toBeTruthy();
      expect(v.discounts).toEqual([]);

      const r = normalizeRestaurant(v, 'pk');
      expect(r.hasDiscount).toBe(true);
      expect(r.discounts[0]!.description).toMatch(/off|free|deal/i);
    });

    it('carries minimum and cap so a total can actually be estimated', () => {
      const r = normalizeRestaurant(
        {
          code: 'a',
          name: 'A',
          discounts: [
            {
              description: '',
              discount_type: 'percentage',
              discount_amount: 30,
              minimum_order_value: 500,
              maximum_discount_amount: 200,
            },
          ],
        },
        'pk',
      );
      expect(r.discounts[0]).toMatchObject({
        description: '30% off',
        percentage: 30,
        minimumOrderValue: 500,
        maximumDiscountAmount: 200,
      });
    });
  });
});

describe('found while reviewing the rendered output', () => {
  it('collapses the duplicated weekly schedule', () => {
    // Upstream ships 28 entries: 14 delivery windows and 14 identical pickup
    // ones, which rendered every opening time twice.
    const raw = detail.data.schedules;
    expect(raw.length).toBe(28);

    const out = normalizeSchedules(raw)!;
    const key = (e: any) => `${e.weekday}|${e.openingType}|${e.opensAt}|${e.closesAt}`;
    expect(new Set(out.map(key)).size).toBe(out.length);

    const delivery = out.filter((e) => /deliver/i.test(e.openingType));
    expect(delivery).toHaveLength(14);
    // Presented in weekday order rather than upstream's arbitrary order.
    const days = delivery.map((e) => e.weekday);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });

  it('treats a zero minimum or cap as absent, not as a real limit', () => {
    // "capped at Rs.0" reads as a worthless discount; upstream means "no cap".
    const r = normalizeRestaurant(
      {
        code: 'a',
        name: 'A',
        deals: [{ title: '34% off', minimum_order_value: 0, maximum_discount_amount: 0 }],
        discounts: [
          { description: '', discount_type: 'percentage', discount_amount: 34, minimum_order_value: 0, maximum_discount_amount: 0 },
        ],
      },
      'pk',
    );
    expect(r.deals[0]!.minimumOrderValue).toBeUndefined();
    expect(r.deals[0]!.maximumDiscountAmount).toBeUndefined();
    expect(r.discounts[0]!.minimumOrderValue).toBeUndefined();
    expect(r.discounts[0]!.maximumDiscountAmount).toBeUndefined();
    // A genuine limit still comes through.
    const withCap = normalizeRestaurant(
      { code: 'b', name: 'B', deals: [{ title: 'x', minimum_order_value: 500, maximum_discount_amount: 200 }] },
      'pk',
    );
    expect(withCap.deals[0]!.minimumOrderValue).toBe(500);
    expect(withCap.deals[0]!.maximumDiscountAmount).toBe(200);
  });
});

describe('defect 3: a new, unrated restaurant renders as "0.0★" (Bug 4)', () => {
  // Naseeb Biryani Phase 7 (code wtah) has rating:0, review_number:0 upstream —
  // a genuinely new listing, indistinguishable from a badly-rated one once
  // "0.0★" is printed, and impossible to exclude from a rating-based sort.

  it('omits rating and flags isUnrated when there are zero reviews', () => {
    const r = normalizeRestaurant({ code: 'wtah', name: 'Naseeb Biryani Phase 7', rating: 0, review_number: 0 }, 'pk');
    expect(r.rating).toBeUndefined();
    expect(r.reviewCount).toBe(0);
    expect(r.isUnrated).toBe(true);
  });

  it('keeps a genuine low rating that has real reviews behind it', () => {
    const r = normalizeRestaurant({ code: 'x', name: 'X', rating: 1.2, review_number: 5 }, 'pk');
    expect(r.rating).toBe(1.2);
    expect(r.isUnrated).toBeUndefined();
  });

  it('does not flag a restaurant that simply has no rating field at all', () => {
    const r = normalizeRestaurant({ code: 'x', name: 'X' }, 'pk');
    expect(r.rating).toBeUndefined();
    expect(r.isUnrated).toBeUndefined();
  });
});

