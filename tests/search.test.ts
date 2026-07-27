import { describe, it, expect } from 'vitest';
import {
  filterMenuItems,
  filterRestaurants,
  normalizeText,
  scoreMatch,
  sortRestaurants,
  tokenize,
} from '../src/domain/search.js';
import type { MenuItem, Restaurant } from '../src/domain/types.js';

const r = (over: Partial<Restaurant>): Restaurant => ({
  code: over.code ?? 'c',
  id: 1,
  name: over.name ?? 'Test',
  market: 'pk',
  cuisines: over.cuisines ?? [],
  hasDiscount: over.hasDiscount ?? false,
  discounts: [],
  deals: [],
  ...over,
});

describe('text normalisation', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeText("Domino's  Pizza!")).toBe('domino s pizza');
  });

  it('strips accents so accented queries still match', () => {
    expect(normalizeText('Café')).toBe('cafe');
  });

  it('tokenises to non-empty words', () => {
    expect(tokenize('  chicken   biryani ')).toEqual(['chicken', 'biryani']);
  });
});

describe('scoreMatch', () => {
  it('scores an exact phrase above a partial token hit', () => {
    const phrase = scoreMatch('Pizza Hut', tokenize('pizza hut'), normalizeText('pizza hut'));
    const partial = scoreMatch('Pizzeria Supplies', tokenize('pizza hut'), normalizeText('pizza hut'));
    expect(phrase).toBeGreaterThan(partial);
  });

  it('returns zero when nothing matches', () => {
    expect(scoreMatch('Burger Lab', tokenize('sushi'), 'sushi')).toBe(0);
  });

  it('matches everything when the query is empty', () => {
    expect(scoreMatch('Anything', [], '')).toBe(1);
  });

  it('prefers a match at the start of the name', () => {
    const start = scoreMatch('Biryani House', tokenize('biryani'), 'biryani');
    const later = scoreMatch('House of Biryani', tokenize('biryani'), 'biryani');
    expect(start).toBeGreaterThan(later);
  });

  it('penalises multi-word queries that only partly match', () => {
    const both = scoreMatch('Chicken Biryani Center', tokenize('chicken biryani'), 'chicken biryani');
    const one = scoreMatch('Chicken Corner', tokenize('chicken biryani'), 'chicken biryani');
    expect(both).toBeGreaterThan(one * 2);
  });
});

describe('head noun requirement (Bug 2)', () => {
  // Reported symptom: for "chicken biryani", the top 5 search_menu_items
  // results were Chicken Samosa, Chicken Samosa, Chicken Roll, Chicken Samosa,
  // Fried Onion — the actual biryani appeared at position 16. Cause: a hit on
  // the modifier token ("chicken") alone was merely penalised (score / 3),
  // never excluded, so cheap chicken-anything items outranked the dish itself
  // once results are sorted by price rather than score.
  it('scores zero when the head noun is missing, no matter how many modifier tokens hit', () => {
    expect(scoreMatch('Chicken Samosa', tokenize('chicken biryani'), 'chicken biryani')).toBe(0);
    expect(scoreMatch('Chicken Roll', tokenize('chicken biryani'), 'chicken biryani')).toBe(0);
    expect(scoreMatch('Chicken Biryani', tokenize('chicken biryani'), 'chicken biryani')).toBeGreaterThan(0);
  });

  it('applies the same rule to "cold coffee"', () => {
    expect(scoreMatch('Cold Drink', tokenize('cold coffee'), 'cold coffee')).toBe(0);
    expect(scoreMatch('Cold Coffee', tokenize('cold coffee'), 'cold coffee')).toBeGreaterThan(0);
  });

  it('applies the same rule to "chicken karahi"', () => {
    expect(scoreMatch('Chicken Handi', tokenize('chicken karahi'), 'chicken karahi')).toBe(0);
    expect(scoreMatch('Mutton Karahi', tokenize('chicken karahi'), 'chicken karahi')).toBeGreaterThan(0);
    expect(scoreMatch('Chicken Karahi', tokenize('chicken karahi'), 'chicken karahi')).toBeGreaterThan(0);
  });

  it('keeps single-word queries unaffected — there is no modifier to require a noun over', () => {
    expect(scoreMatch('Chicken Karahi', tokenize('chicken'), 'chicken')).toBeGreaterThan(0);
  });

  it('every top-5 result is a genuine dish match at the filterMenuItems level', () => {
    const items: MenuItem[] = [
      { id: 1, name: 'Chicken Samosa', price: 80, isDiscounted: false, variations: [] },
      { id: 2, name: 'Chicken Samosa', price: 90, isDiscounted: false, variations: [] },
      { id: 3, name: 'Chicken Roll', price: 100, isDiscounted: false, variations: [] },
      { id: 4, name: 'Fried Onion', price: 50, isDiscounted: false, variations: [] },
      { id: 5, name: 'Chicken Biryani', price: 256, isDiscounted: false, variations: [] },
    ];
    const hits = filterMenuItems(items, { query: 'chicken biryani' });
    expect(hits.map((h) => h.item.name)).toEqual(['Chicken Biryani']);
  });
});

describe('filterRestaurants', () => {
  const list = [
    r({ code: 'a', name: 'Biryani House', cuisines: ['Biryani'], rating: 4.5, deliveryFee: 50, distanceKm: 1 }),
    r({ code: 'b', name: 'Pizza Place', cuisines: ['Pizza'], rating: 3.2, deliveryFee: 120, distanceKm: 4 }),
    r({ code: 'c', name: 'Sushi Bar', cuisines: ['Japanese'], rating: 4.9, deliveryFee: 0, distanceKm: 9, hasDiscount: true }),
  ];

  it('matches on restaurant name', () => {
    expect(filterRestaurants(list, { query: 'biryani' }).map((x) => x.code)).toEqual(['a']);
  });

  it('matches on cuisine when the name does not contain the term', () => {
    expect(filterRestaurants(list, { query: 'japanese' }).map((x) => x.code)).toEqual(['c']);
  });

  it('applies numeric filters', () => {
    expect(filterRestaurants(list, { minRating: 4.4 }).map((x) => x.code)).toEqual(['a', 'c']);
    expect(filterRestaurants(list, { maxDeliveryFee: 60 }).map((x) => x.code)).toEqual(['a', 'c']);
    expect(filterRestaurants(list, { maxDistanceKm: 5 }).map((x) => x.code)).toEqual(['a', 'b']);
    expect(filterRestaurants(list, { hasDiscount: true }).map((x) => x.code)).toEqual(['c']);
  });

  it('excludes restaurants whose open status is unknown when openNow is set', () => {
    // Listing data has no schedules, so status is undefined; "unknown" must not
    // be treated as "open".
    expect(filterRestaurants(list, { openNow: true })).toEqual([]);
  });

  it('keeps restaurants confirmed open', () => {
    const open = r({
      code: 'o',
      name: 'Open',
      openStatus: { isOpen: true, localTime: '', timezone: 'Asia/Karachi', scheduleUnavailable: false },
    });
    expect(filterRestaurants([...list, open], { openNow: true }).map((x) => x.code)).toEqual(['o']);
  });

  it('returns everything when no filter is supplied', () => {
    expect(filterRestaurants(list, {})).toHaveLength(3);
  });

  it('ranks by relevance when searching', () => {
    const ranked = filterRestaurants(
      [r({ code: 'x', name: 'The Pizza Experts' }), r({ code: 'y', name: 'Pizza' })],
      { query: 'pizza' },
    );
    expect(ranked[0]!.code).toBe('y');
  });
});

describe('sortRestaurants', () => {
  const list = [
    r({ code: 'a', rating: 3.0, distanceKm: 5, deliveryFee: 100, deliveryTimeMinutes: 40, minimumOrderAmount: 500 }),
    r({ code: 'b', rating: 4.8, distanceKm: 2, deliveryFee: 0, deliveryTimeMinutes: 20, minimumOrderAmount: 100 }),
  ];

  it('sorts by each supported key', () => {
    expect(sortRestaurants(list, 'rating')[0]!.code).toBe('b');
    expect(sortRestaurants(list, 'distance')[0]!.code).toBe('b');
    expect(sortRestaurants(list, 'delivery_fee')[0]!.code).toBe('b');
    expect(sortRestaurants(list, 'delivery_time')[0]!.code).toBe('b');
    expect(sortRestaurants(list, 'minimum_order')[0]!.code).toBe('b');
  });

  it('leaves order untouched for relevance', () => {
    expect(sortRestaurants(list, 'relevance').map((x) => x.code)).toEqual(['a', 'b']);
  });

  it('sorts missing values last rather than first', () => {
    const withGap = [r({ code: 'none' }), r({ code: 'has', distanceKm: 3 })];
    expect(sortRestaurants(withGap, 'distance')[0]!.code).toBe('has');
  });

  it('does not mutate the input array', () => {
    const original = [...list];
    sortRestaurants(list, 'rating');
    expect(list).toEqual(original);
  });
});

describe('filterMenuItems', () => {
  const items: MenuItem[] = [
    { id: 1, name: 'Chicken Biryani', price: 400, isDiscounted: false, variations: [] },
    { id: 2, name: 'Beef Biryani', price: 550, isDiscounted: false, variations: [], isSoldOut: true },
    { id: 3, name: 'Veg Pulao', price: 300, isDiscounted: false, variations: [], description: 'served with biryani masala' },
    { id: 4, name: 'Cola', price: 100, isDiscounted: false, variations: [] },
  ];

  it('matches names and, more weakly, descriptions', () => {
    const hits = filterMenuItems(items, { query: 'biryani' }).map((h) => h.item.id);
    expect(hits).toContain(1);
    expect(hits).toContain(3);
    expect(hits).not.toContain(4);
  });

  it('scores a name match above a description-only match', () => {
    const hits = filterMenuItems(items, { query: 'biryani' });
    const byName = hits.find((h) => h.item.id === 1)!;
    const byDesc = hits.find((h) => h.item.id === 3)!;
    expect(byName.score).toBeGreaterThan(byDesc.score);
  });

  it('excludes sold-out items by default', () => {
    expect(filterMenuItems(items, { query: 'biryani' }).map((h) => h.item.id)).not.toContain(2);
  });

  it('includes sold-out items when explicitly asked', () => {
    expect(
      filterMenuItems(items, { query: 'biryani', excludeSoldOut: false }).map((h) => h.item.id),
    ).toContain(2);
  });

  it('applies price bounds', () => {
    // Ids 1 (400) and 3 (300) both match "biryani"; only 3 survives a 350 cap.
    expect(filterMenuItems(items, { query: 'biryani', maxPrice: 350 }).map((h) => h.item.id)).toEqual([3]);
    expect(filterMenuItems(items, { query: 'biryani', minPrice: 350 }).map((h) => h.item.id)).toEqual([1]);
    expect(filterMenuItems(items, { query: 'biryani', minPrice: 5000 })).toEqual([]);
  });
});
