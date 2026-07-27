import { describe, it, expect } from 'vitest';
import { restaurantLine } from '../src/tools/format.js';
import type { Restaurant } from '../src/domain/types.js';

const base = (over: Partial<Restaurant>): Restaurant => ({
  code: 'a',
  id: 1,
  name: 'Test',
  market: 'pk',
  cuisines: [],
  hasDiscount: false,
  discounts: [],
  deals: [],
  ...over,
});

describe('restaurantLine', () => {
  it('renders "unrated" for a new listing rather than a rating figure', () => {
    const line = restaurantLine(base({ isUnrated: true }));
    expect(line).toContain('unrated');
    expect(line).not.toMatch(/0\.0★/);
  });

  it('renders the real rating and review count when present', () => {
    const line = restaurantLine(base({ rating: 4.6, reviewCount: 8788 }));
    expect(line).toContain('4.6★ (8788)');
  });

  it('shows neither rating nor "unrated" when rating is simply absent', () => {
    const line = restaurantLine(base({}));
    expect(line).not.toContain('unrated');
    expect(line).not.toMatch(/★/);
  });
});
