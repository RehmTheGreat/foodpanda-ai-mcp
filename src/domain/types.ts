/**
 * The normalised domain model.
 *
 * MCP tools return THESE shapes, never raw upstream JSON. Upstream fields get
 * renamed, restructured or dropped without warning; this indirection means an
 * upstream change is a one-file edit in normalize.ts rather than a breaking
 * change to every tool's documented output.
 */

export interface Market {
  /** ISO-3166-1 alpha-2, lowercased. Doubles as the upstream `country` param. */
  code: string;
  name: string;
  /** Delivery Hero global entity id, e.g. FP_PK. */
  globalEntityId?: string;
  currencySymbol?: string;
  currencyPosition?: 'left' | 'right';
  timezone?: string;
  decimalDigits?: number;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface ResolvedLocation extends Coordinates {
  /** Human-readable label for the resolved point. */
  displayName: string;
  countryCode?: string;
  /** Which foodpanda market this location falls in, if any. */
  market?: string;
  marketSupported: boolean;
  source: 'coordinates' | 'geocoder';
}

export interface Cuisine {
  id: number;
  name: string;
  slug?: string;
  /** Number of nearby restaurants in this cuisine (listing aggregations only). */
  restaurantCount?: number;
}

export interface Discount {
  type: string;
  description: string;
  /** Percentage off, when the discount is percentage-based. */
  percentage?: number;
  amount?: number;
  minimumOrderValue?: number;
  maximumDiscountAmount?: number;
}

export interface Deal {
  title: string;
  description?: string;
  type?: string;
  minimumOrderValue?: number;
  maximumDiscountAmount?: number;
  value?: number;
  isProOnly?: boolean;
  isNewCustomerOnly?: boolean;
}

export interface ScheduleEntry {
  /** ISO-8601 weekday: 1 = Monday … 7 = Sunday. Verified empirically. */
  weekday: number;
  openingType: string;
  opensAt: string;
  closesAt: string;
}

export interface OpenStatus {
  isOpen: boolean;
  /** Local time in the market's timezone used to make the determination. */
  localTime: string;
  timezone: string;
  /** Next opening, as a local "HH:MM" plus weekday, when currently closed. */
  opensNext?: { weekday: number; time: string };
  closesAt?: string;
  /** True when the vendor publishes no schedule; status is then unknown. */
  scheduleUnavailable: boolean;
}

export interface Restaurant {
  code: string;
  id: number;
  name: string;
  market: string;
  rating?: number;
  reviewCount?: number;
  cuisines: string[];
  primaryCuisineId?: number;
  address?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  /** Kilometres from the query point, as reported by upstream. */
  distanceKm?: number;
  minimumOrderAmount?: number;
  deliveryFee?: number;
  /**
   * Realistic delivery estimate in minutes. Only populated on the detail
   * endpoint when coordinates were supplied; upstream returns 0 without them.
   */
  deliveryTimeMinutes?: number;
  /** Optimistic-to-pessimistic range, when upstream publishes one. */
  deliveryTimeRangeMinutes?: { min: number; max: number };
  /** Upstream `budget`: a 1-3 price tier. */
  budgetTier?: number;
  isDeliveryEnabled?: boolean;
  isPickupEnabled?: boolean;
  hasOnlinePayment?: boolean;
  isPromoted?: boolean;
  isNew?: boolean;
  hasDiscount: boolean;
  discounts: Discount[];
  deals: Deal[];
  schedules?: ScheduleEntry[];
  openStatus?: OpenStatus;
  /** Public web page for the restaurant, when derivable. */
  url?: string;
  vertical?: string;
}

export interface MenuItemVariation {
  id: number;
  name?: string;
  price: number;
  priceBeforeDiscount?: number;
  isVegetarian?: boolean;
}

export interface MenuItem {
  id: number;
  name: string;
  description?: string;
  /** Lowest price across variations, the number users actually compare on. */
  price: number;
  priceBeforeDiscount?: number;
  /** True when priceBeforeDiscount is present and higher than price. */
  isDiscounted: boolean;
  currency?: string;
  categoryName?: string;
  isSoldOut?: boolean;
  isVegetarian?: boolean;
  imageUrl?: string;
  variations: MenuItemVariation[];
}

export interface MenuCategory {
  id: number;
  name: string;
  description?: string;
  isPopular?: boolean;
  items: MenuItem[];
}

export interface Menu {
  restaurantCode: string;
  restaurantName: string;
  market: string;
  currencySymbol?: string;
  categories: MenuCategory[];
  itemCount: number;
}

/** A menu item found during a cross-restaurant search, with its origin attached. */
export interface MenuItemHit extends MenuItem {
  restaurantCode: string;
  restaurantName: string;
  restaurantRating?: number;
  distanceKm?: number;
  deliveryFee?: number;
  minimumOrderAmount?: number;
  deliveryTimeMinutes?: number;
  /** price + deliveryFee, the number that actually decides "cheapest". */
  totalWithDelivery?: number;
}

/** Every tool wraps its payload in this envelope for a predictable shape. */
export interface ToolMeta {
  market: string;
  currencySymbol?: string;
  /** Set when the upstream response failed validation and data was degraded. */
  degraded?: boolean;
  warnings?: string[];
  /** Where the data came from, so callers can reason about freshness. */
  source: 'foodpanda' | 'openstreetmap' | 'computed';
  retrievedAt: string;
}
