import type { MenuItem, Restaurant } from './types.js';

/**
 * Client-side text search.
 *
 * The upstream listing endpoint accepts a `q` parameter but ignores it: during
 * research, `q=pizza` and `q=zzzzqqqqnonexistentvendor12345` both returned the
 * identical `available_count` of 231 with essentially the same vendors. There is
 * no working search service (the /search/api/v1 path 500s). So search has to
 * happen here, over data we fetch ourselves.
 */

/** Normalise for comparison: lowercase, strip accents and punctuation. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  return normalizeText(input).split(' ').filter(Boolean);
}

/**
 * Score a haystack against query tokens. 0 means no match.
 * Exact phrase > all tokens present > some tokens present. Earlier matches and
 * whole-word matches score higher, so "Pizza Hut" beats "Pizzeria Supplies".
 */
export function scoreMatch(haystack: string, queryTokens: string[], phrase: string): number {
  if (queryTokens.length === 0) return 1;
  const hay = normalizeText(haystack);
  if (!hay) return 0;

  let score = 0;

  if (phrase && hay.includes(phrase)) {
    score += 100;
    if (hay.startsWith(phrase)) score += 40;
  }

  let matched = 0;
  for (const t of queryTokens) {
    const idx = hay.indexOf(t);
    if (idx === -1) continue;
    matched++;
    score += 20;
    // Whole-word hit.
    const wordBoundary = (idx === 0 || hay[idx - 1] === ' ') && (hay[idx + t.length] === undefined || hay[idx + t.length] === ' ');
    if (wordBoundary) score += 15;
    if (idx === 0) score += 10;
  }

  if (matched === 0) return 0;
  // Require every token for multi-word queries; partial matches are noise.
  if (queryTokens.length > 1 && matched < queryTokens.length) score = Math.floor(score / 3);
  return score;
}

export interface RestaurantFilter {
  query?: string | undefined;
  cuisine?: string | undefined;
  openNow?: boolean | undefined;
  minRating?: number | undefined;
  maxDeliveryFee?: number | undefined;
  maxMinimumOrder?: number | undefined;
  maxDistanceKm?: number | undefined;
  maxDeliveryTimeMinutes?: number | undefined;
  hasDiscount?: boolean | undefined;
  budgetTier?: number | undefined;
}

export function filterRestaurants(list: Restaurant[], f: RestaurantFilter): Restaurant[] {
  const tokens = f.query ? tokenize(f.query) : [];
  const phrase = f.query ? normalizeText(f.query) : '';
  const cuisineTokens = f.cuisine ? tokenize(f.cuisine) : [];
  const cuisinePhrase = f.cuisine ? normalizeText(f.cuisine) : '';

  const scored = list
    .map((r) => {
      let score = 0;

      if (tokens.length) {
        // A query may name the restaurant or the food type, so match both.
        const nameScore = scoreMatch(r.name, tokens, phrase);
        const cuisineScore = scoreMatch(r.cuisines.join(' '), tokens, phrase);
        score = Math.max(nameScore, Math.floor(cuisineScore * 0.8));
        if (score === 0) return undefined;
      }

      if (cuisineTokens.length) {
        const cs = scoreMatch(r.cuisines.join(' '), cuisineTokens, cuisinePhrase);
        if (cs === 0) return undefined;
        score += cs;
      }

      if (f.openNow === true && !(r.openStatus?.isOpen ?? false)) return undefined;
      if (f.minRating !== undefined && (r.rating ?? 0) < f.minRating) return undefined;
      if (f.maxDeliveryFee !== undefined && (r.deliveryFee ?? Infinity) > f.maxDeliveryFee) return undefined;
      if (f.maxMinimumOrder !== undefined && (r.minimumOrderAmount ?? Infinity) > f.maxMinimumOrder) return undefined;
      if (f.maxDistanceKm !== undefined && (r.distanceKm ?? Infinity) > f.maxDistanceKm) return undefined;
      if (
        f.maxDeliveryTimeMinutes !== undefined &&
        (r.deliveryTimeMinutes ?? Infinity) > f.maxDeliveryTimeMinutes
      ) {
        return undefined;
      }
      if (f.hasDiscount === true && !r.hasDiscount) return undefined;
      if (f.budgetTier !== undefined && r.budgetTier !== f.budgetTier) return undefined;

      return { r, score };
    })
    .filter((x): x is { r: Restaurant; score: number } => x !== undefined);

  // Relevance first when searching, otherwise preserve upstream ordering.
  if (tokens.length || cuisineTokens.length) {
    scored.sort((a, b) => b.score - a.score || (a.r.distanceKm ?? 0) - (b.r.distanceKm ?? 0));
  }
  return scored.map((x) => x.r);
}

export type RestaurantSort =
  | 'relevance'
  | 'rating'
  | 'distance'
  | 'delivery_time'
  | 'delivery_fee'
  | 'minimum_order';

export function sortRestaurants(list: Restaurant[], sort: RestaurantSort): Restaurant[] {
  const copy = [...list];
  const asc = (get: (r: Restaurant) => number | undefined) => (a: Restaurant, b: Restaurant) =>
    (get(a) ?? Infinity) - (get(b) ?? Infinity);

  switch (sort) {
    case 'rating':
      return copy.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
    case 'distance':
      return copy.sort(asc((r) => r.distanceKm));
    case 'delivery_time':
      return copy.sort(asc((r) => r.deliveryTimeMinutes));
    case 'delivery_fee':
      return copy.sort(asc((r) => r.deliveryFee));
    case 'minimum_order':
      return copy.sort(asc((r) => r.minimumOrderAmount));
    default:
      return copy;
  }
}

export interface MenuItemFilter {
  query: string;
  maxPrice?: number | undefined;
  minPrice?: number | undefined;
  vegetarianOnly?: boolean | undefined;
  excludeSoldOut?: boolean | undefined;
}

/** Match menu items within one restaurant's menu. */
export function filterMenuItems(items: MenuItem[], f: MenuItemFilter): Array<{ item: MenuItem; score: number }> {
  const tokens = tokenize(f.query);
  const phrase = normalizeText(f.query);

  return items
    .map((item) => {
      const nameScore = scoreMatch(item.name, tokens, phrase);
      const descScore = item.description ? Math.floor(scoreMatch(item.description, tokens, phrase) * 0.4) : 0;
      const catScore = item.categoryName ? Math.floor(scoreMatch(item.categoryName, tokens, phrase) * 0.5) : 0;
      const score = Math.max(nameScore, descScore, catScore);
      if (score === 0) return undefined;

      if (f.maxPrice !== undefined && item.price > f.maxPrice) return undefined;
      if (f.minPrice !== undefined && item.price < f.minPrice) return undefined;
      if (f.vegetarianOnly === true && item.isVegetarian !== true) return undefined;
      if (f.excludeSoldOut !== false && item.isSoldOut === true) return undefined;

      return { item, score };
    })
    .filter((x): x is { item: MenuItem; score: number } => x !== undefined);
}

/** Flatten a normalised menu's categories into a single item list. */
export function flattenMenu(categories: Array<{ items: MenuItem[] }>): MenuItem[] {
  return categories.flatMap((c) => c.items);
}
