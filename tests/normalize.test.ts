import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { normalizeMenu, normalizeRestaurant, normalizeSchedules } from '../src/domain/normalize.js';

const listing = fixture('listing-pk.json');
const detail = fixture('vendor-detail-pk.json');

describe('normalizeRestaurant', () => {
  it('maps a real listing vendor onto the domain model', () => {
    const r = normalizeRestaurant(listing.data.items[0], 'pk');
    expect(r.code).toBeTruthy();
    expect(r.name).toBeTruthy();
    expect(r.market).toBe('pk');
    expect(Array.isArray(r.cuisines)).toBe(true);
    expect(typeof r.hasDiscount).toBe('boolean');
  });

  it('reads listing discounts from tags, not the always-empty discounts array', () => {
    // This is the regression that made find_deals report zero offers: in listing
    // responses `discounts` is [] and the real data sits in tags[].text.
    const withTagDeal = listing.data.items.find(
      (v: any) => Array.isArray(v.tags) && v.tags.some((t: any) => t.code === 'DEAL'),
    );
    expect(withTagDeal, 'fixture should contain a vendor with a DEAL tag').toBeTruthy();
    expect(withTagDeal.discounts).toEqual([]);

    const r = normalizeRestaurant(withTagDeal, 'pk');
    expect(r.hasDiscount).toBe(true);
    expect(r.discounts.length).toBeGreaterThan(0);
    expect(r.discounts[0]!.description).toMatch(/off|free|deal/i);
  });

  it('never surfaces raw i18n keys as discount text', () => {
    const r = normalizeRestaurant(
      { code: 'x', name: 'X', tags: [{ code: 'DEAL', text: 'NEXTGEN_FEATURED_TAG' }] },
      'pk',
    );
    expect(r.discounts).toHaveLength(0);
  });

  it('synthesises copy for detail discounts that have an empty description', () => {
    const r = normalizeRestaurant(
      {
        code: 'x',
        name: 'X',
        discounts: [
          { description: '', discount_type: 'percentage', discount_amount: 34 },
          { description: '', discount_type: 'free-delivery', discount_amount: 0 },
        ],
      },
      'pk',
    );
    const texts = r.discounts.map((d) => d.description);
    expect(texts).toContain('34% off');
    expect(texts).toContain('Free delivery');
  });

  it('prefers the headline delivery estimate over the optimistic range floor', () => {
    // Upstream reports lower_limit=5 alongside minimum_delivery_time=15 for the
    // same vendor; quoting 5 would understate the wait.
    const r = normalizeRestaurant(
      {
        code: 'x',
        name: 'X',
        minimum_delivery_time: 15,
        delivery_duration_range: { lower_limit_in_minutes: 5, upper_limit_in_minutes: 20 },
      },
      'pk',
    );
    expect(r.deliveryTimeMinutes).toBe(15);
    expect(r.deliveryTimeRangeMinutes).toEqual({ min: 5, max: 20 });
  });

  it('treats a zero delivery estimate as absent rather than instant', () => {
    const r = normalizeRestaurant({ code: 'x', name: 'X', minimum_delivery_time: 0 }, 'pk');
    expect(r.deliveryTimeMinutes).toBeUndefined();
  });

  it('survives a vendor stripped of every optional field', () => {
    const r = normalizeRestaurant({ code: 'bare', name: 'Bare' }, 'pk');
    expect(r.code).toBe('bare');
    expect(r.cuisines).toEqual([]);
    expect(r.discounts).toEqual([]);
    expect(r.hasDiscount).toBe(false);
  });

  it('does not throw on wrong-typed upstream fields', () => {
    expect(() =>
      normalizeRestaurant(
        { code: 123, name: null, rating: 'not-a-number', cuisines: 'nope', discounts: {}, tags: 5 },
        'pk',
      ),
    ).not.toThrow();
  });

  it('accepts city as either a string or an object', () => {
    expect(normalizeRestaurant({ code: 'a', name: 'A', city: 'Karachi' }, 'pk').city).toBe('Karachi');
    expect(normalizeRestaurant({ code: 'a', name: 'A', city: { name: 'Lahore' } }, 'pk').city).toBe('Lahore');
  });
});

describe('normalizeSchedules', () => {
  it('reads the real schedule block', () => {
    const s = normalizeSchedules(detail.data.schedules);
    expect(s!.length).toBeGreaterThan(0);
    expect(s![0]).toHaveProperty('weekday');
    expect(s![0]!.opensAt).toMatch(/^\d{2}:\d{2}$/);
  });

  it('uses ISO weekdays 1-7 with no zero, as verified upstream', () => {
    const days = new Set(normalizeSchedules(detail.data.schedules)!.map((s) => s.weekday));
    expect(Math.min(...days)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...days)).toBeLessThanOrEqual(7);
  });

  it('drops incomplete entries instead of emitting broken ones', () => {
    const s = normalizeSchedules([{ weekday: 1, opening_time: '09:00' }, { weekday: 2, opening_time: '09:00', closing_time: '17:00' }]);
    expect(s).toHaveLength(1);
  });
});

describe('normalizeMenu', () => {
  it('builds categories and prices from a real menu payload', () => {
    const m = normalizeMenu(detail.data, 'pk');
    expect(m.restaurantName).toBeTruthy();
    expect(m.categories.length).toBeGreaterThan(0);
    expect(m.itemCount).toBeGreaterThan(0);
    const item = m.categories[0]!.items[0]!;
    expect(item.price).toBeGreaterThan(0);
    expect(item.name).toBeTruthy();
  });

  it('uses the cheapest variation as the headline price', () => {
    const m = normalizeMenu(
      {
        code: 'x',
        name: 'X',
        menus: [
          {
            menu_categories: [
              {
                id: 1,
                name: 'Cat',
                products: [
                  {
                    id: 9,
                    name: 'Multi',
                    product_variations: [
                      { id: 1, price: 500 },
                      { id: 2, price: 300 },
                      { id: 3, price: 900 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      'pk',
    );
    expect(m.categories[0]!.items[0]!.price).toBe(300);
  });

  it('marks an item discounted only when the previous price was higher', () => {
    const build = (price: number, before: number) =>
      normalizeMenu(
        {
          code: 'x',
          name: 'X',
          menus: [
            {
              menu_categories: [
                { id: 1, name: 'C', products: [{ id: 1, name: 'P', product_variations: [{ id: 1, price, price_before_discount: before }] }] },
              ],
            },
          ],
        },
        'pk',
      ).categories[0]!.items[0]!;

    expect(build(80, 100).isDiscounted).toBe(true);
    expect(build(80, 100).priceBeforeDiscount).toBe(100);
    expect(build(100, 100).isDiscounted).toBe(false);
  });

  it('drops items that carry no price at all', () => {
    const m = normalizeMenu(
      { code: 'x', name: 'X', menus: [{ menu_categories: [{ id: 1, name: 'C', products: [{ id: 1, name: 'No price', product_variations: [] }] }] }] },
      'pk',
    );
    expect(m.itemCount).toBe(0);
  });

  it('merges duplicate category names across multiple menus', () => {
    const mk = (id: number) => ({
      menu_categories: [{ id: 1, name: 'Shared', products: [{ id, name: `P${id}`, product_variations: [{ id, price: 10 }] }] }],
    });
    const m = normalizeMenu({ code: 'x', name: 'X', menus: [mk(1), mk(2)] }, 'pk');
    expect(m.categories).toHaveLength(1);
    expect(m.itemCount).toBe(2);
  });

  it('returns an empty menu rather than throwing when menus are missing', () => {
    const m = normalizeMenu({ code: 'x', name: 'X' }, 'pk');
    expect(m.categories).toEqual([]);
    expect(m.itemCount).toBe(0);
  });
});
