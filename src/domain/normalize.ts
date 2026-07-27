import { computeOpenStatus } from './openNow.js';
import { getMarket } from './markets.js';
import type {
  Deal,
  Discount,
  Fees,
  Menu,
  MenuCategory,
  MenuItem,
  MenuItemVariation,
  Restaurant,
  ScheduleEntry,
} from './types.js';

/**
 * Upstream JSON -> normalised domain model.
 *
 * This module is the shock absorber. Every field access is defensive because
 * upstream is an undocumented internal API: a missing or retyped field must
 * produce `undefined` in one place, not an exception that kills a tool call.
 */

const n = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : undefined;
};

const s = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const x = String(v).trim();
  return x === '' ? undefined : x;
};

const b = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * Upstream text fields sometimes contain untranslated i18n keys such as
 * "NEXTGEN_FEATURED_TAG" instead of human copy. Showing those to a user is
 * worse than showing nothing.
 */
function isI18nKey(v: string): boolean {
  return /^[A-Z][A-Z0-9_]{3,}$/.test(v);
}

/** Build readable copy for a discount that upstream left with empty text. */
function describeDiscount(type: string | undefined, amount: number | undefined): string | undefined {
  const t = (type ?? '').toLowerCase();
  if (t === 'free-delivery' || t === 'free_delivery') return 'Free delivery';
  if (t === 'percentage' && amount !== undefined && amount > 0) return `${amount}% off`;
  if (t === 'amount' && amount !== undefined && amount > 0) return `${amount} off`;
  return undefined;
}

/**
 * Discounts in LISTING responses do not live in `discounts` (that array is
 * always empty there — verified across 50 vendors). They live in `tags`
 * entries with code "DEAL", whose `text` carries the human copy, and in
 * `discounts_info`, which carries the percentage value.
 */
function discountsFromTags(v: any): Discount[] {
  const tags = Array.isArray(v?.tags) ? v.tags : [];
  const info = Array.isArray(v?.discounts_info) ? v.discounts_info : [];
  const pct = n(info[0]?.value);

  return tags
    .filter((t: any) => String(t?.code ?? '').toUpperCase() === 'DEAL')
    .map((t: any): Discount | undefined => {
      const text = s(t?.text);
      if (!text || isI18nKey(text)) return undefined;
      const out: Discount = { type: 'deal', description: text };
      if (pct !== undefined && pct > 0 && pct <= 100) out.percentage = pct;
      return out;
    })
    .filter((x: Discount | undefined): x is Discount => x !== undefined);
}

function normalizeDiscounts(raw: unknown): Discount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d: any): Discount | undefined => {
      const rawType = s(d?.discount_type) ?? s(d?.type);
      const rawAmount = n(d?.discount_amount) ?? n(d?.value);
      const explicit = s(d?.description) ?? s(d?.discount_text) ?? s(d?.banner_title);
      // Detail responses often ship discounts with empty description but a
      // usable type/amount pair, so synthesise copy rather than dropping them.
      const description =
        explicit && !isI18nKey(explicit) ? explicit : describeDiscount(rawType, rawAmount);
      if (!description) return undefined;
      const out: Discount = {
        type: s(d?.discount_type) ?? s(d?.type) ?? 'discount',
        description,
      };
      const amount = n(d?.discount_amount) ?? n(d?.value);
      if (amount !== undefined) {
        // Upstream uses `value` for both "30" (percent) and absolute amounts.
        if (/percent/i.test(String(d?.discount_type ?? '')) || (amount > 0 && amount <= 100 && /percent/i.test(String(d?.type ?? '')))) {
          out.percentage = amount;
        } else {
          out.amount = amount;
        }
      }
      // Upstream writes 0 for "no minimum" and "no cap". Passing that through
      // renders as "capped at Rs.0", which reads as a worthless discount, so
      // treat 0 as absent for these two fields.
      const minOrder = n(d?.minimum_order_value);
      if (minOrder !== undefined && minOrder > 0) out.minimumOrderValue = minOrder;
      const maxDisc = n(d?.maximum_discount_amount);
      if (maxDisc !== undefined && maxDisc > 0) out.maximumDiscountAmount = maxDisc;
      return out;
    })
    .filter((x): x is Discount => x !== undefined);
}

function normalizeDeals(raw: unknown): Deal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d: any): Deal | undefined => {
      const title = s(d?.title) ?? s(d?.description) ?? s(d?.offer_type);
      if (!title) return undefined;
      const out: Deal = { title };
      const desc = s(d?.description);
      if (desc && desc !== title) out.description = desc;
      const type = s(d?.offer_type) ?? s(d?.type);
      if (type) out.type = type;
      // As above: 0 means "none", not "zero".
      const minOrder = n(d?.minimum_order_value);
      if (minOrder !== undefined && minOrder > 0) out.minimumOrderValue = minOrder;
      const maxDisc = n(d?.maximum_discount_amount);
      if (maxDisc !== undefined && maxDisc > 0) out.maximumDiscountAmount = maxDisc;
      const value = n(d?.value);
      if (value !== undefined) out.value = value;
      if (b(d?.is_pro) !== undefined) out.isProOnly = b(d?.is_pro);
      if (b(d?.is_new_customer) !== undefined) out.isNewCustomerOnly = b(d?.is_new_customer);
      return out;
    })
    .filter((x): x is Deal => x !== undefined);
}

export function normalizeSchedules(raw: unknown): ScheduleEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const mapped = raw
    .map((sc: any): ScheduleEntry | undefined => {
      const weekday = n(sc?.weekday);
      const opensAt = s(sc?.opening_time);
      const closesAt = s(sc?.closing_time);
      if (weekday === undefined || !opensAt || !closesAt) return undefined;
      return { weekday, openingType: s(sc?.opening_type) ?? 'delivering', opensAt, closesAt };
    })
    .filter((x): x is ScheduleEntry => x !== undefined);

  // Upstream repeats the full week (observed: 28 entries covering 14 distinct
  // windows), which rendered every opening time twice. Collapse identical
  // windows and present them in weekday order.
  const seen = new Set<string>();
  const out = mapped.filter((e) => {
    const key = `${e.weekday}|${e.openingType}|${e.opensAt}|${e.closesAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  out.sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt));

  return out.length ? out : undefined;
}

function cuisineNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: any) => s(c?.name) ?? s(c?.title)).filter((x): x is string => !!x);
}

function cityName(raw: unknown): string | undefined {
  if (typeof raw === 'string') return s(raw);
  if (raw && typeof raw === 'object') return s((raw as any).name);
  return undefined;
}

/**
 * Public link for a vendor.
 *
 * `web_path` and `redirection_url` are **already absolute URLs** upstream, and
 * they differ between endpoints for the same vendor: listing responses return
 * `https://foodpanda.pk/restaurant/...` while detail responses return
 * `https://www.foodpanda.pk/restaurant/...`. An earlier version treated them as
 * paths and prefixed a host, producing
 * `https://www.foodpanda.pk/https://foodpanda.pk/restaurant/...` — every emitted
 * link was broken.
 *
 * So: use what upstream gives us when it is already a URL, and only build one
 * ourselves when it is not. Anything that does not end up a valid http(s) URL is
 * omitted rather than guessed at.
 */
function vendorUrl(v: any, market: string): string | undefined {
  const candidate = s(v?.web_path) ?? s(v?.redirection_url);

  if (candidate) {
    // Already absolute — take it as-is.
    if (/^https?:\/\//i.test(candidate)) return safeUrl(candidate);
    // Protocol-relative ("//host/path").
    if (candidate.startsWith('//')) return safeUrl(`https:${candidate}`);
    // Anything else carrying a scheme is not a path. Refuse it rather than
    // gluing it onto the host, which would turn "javascript:..." into a
    // plausible-looking but nonsensical link.
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined;
    // A genuine path: join it to the market host.
    const host = getMarket(market)?.webHost;
    if (host) return safeUrl(`https://${host}/${candidate.replace(/^\/+/, '')}`);
    return undefined;
  }

  // No link at all: reconstruct from the vendor code and slug.
  const code = s(v?.code);
  const slug = s(v?.url_key);
  const host = getMarket(market)?.webHost;
  if (!code || !slug || !host) return undefined;
  return safeUrl(`https://${host}/restaurant/${code}/${slug}`);
}

/**
 * Extract the charges needed to estimate an order total.
 *
 * The same field names appear on both the listing and the detail payload, so one
 * mapper serves both; whichever fields the payload happens to carry get through.
 * Returns undefined when nothing at all was present, so the caller can omit the
 * object rather than emit a bag of undefineds.
 */
function normalizeFees(v: any): Fees | undefined {
  const fees: Fees = {};

  const minOrder = n(v?.minimum_order_amount);
  if (minOrder !== undefined) fees.minimumOrderAmount = minOrder;

  const smallOrder = n(v?.small_order_fee);
  if (smallOrder !== undefined) fees.smallOrderFee = smallOrder;

  const delivery = n(v?.minimum_delivery_fee) ?? n(v?.delivery_fee);
  if (delivery !== undefined) fees.deliveryFee = delivery;

  const serviceEnabled = b(v?.is_service_fee_enabled);
  if (serviceEnabled !== undefined) fees.isServiceFeeEnabled = serviceEnabled;

  const servicePct = n(v?.service_fee_percentage_amount);
  if (servicePct !== undefined) fees.serviceFeePercent = servicePct;

  const vatPct = n(v?.vat_percentage_amount);
  if (vatPct !== undefined) fees.vatPercent = vatPct;

  const vatIncluded = b(v?.is_vat_included_in_product_price);
  if (vatIncluded !== undefined) fees.isVatIncludedInPrice = vatIncluded;

  const vatVisible = b(v?.is_vat_visible);
  if (vatVisible !== undefined) fees.isVatVisible = vatVisible;

  return Object.keys(fees).length > 0 ? fees : undefined;
}

/** Return the URL only if it actually parses as http(s); never emit a broken link. */
function safeUrl(candidate: string): string | undefined {
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function normalizeRestaurant(v: any, market: string, opts: { computeOpen?: boolean } = {}): Restaurant {
  // Merge both shapes: `discounts` (detail) and tag/discounts_info (listing).
  // De-duplicate on description so a vendor seen through both paths reads once.
  const merged = [...normalizeDiscounts(v?.discounts), ...discountsFromTags(v)];
  const seenDesc = new Set<string>();
  const discounts = merged.filter((d) => {
    const key = d.description.toLowerCase();
    if (seenDesc.has(key)) return false;
    seenDesc.add(key);
    return true;
  });
  const deals = normalizeDeals(v?.deals);
  const schedules = normalizeSchedules(v?.schedules);
  const marketInfo = getMarket(market);

  const r: Restaurant = {
    code: s(v?.code) ?? '',
    id: n(v?.id) ?? 0,
    name: s(v?.name) ?? '(unnamed)',
    market,
    cuisines: cuisineNames(v?.cuisines),
    hasDiscount: discounts.length > 0 || deals.length > 0,
    discounts,
    deals,
  };

  const reviews = n(v?.review_number);
  if (reviews !== undefined) r.reviewCount = reviews;
  const rating = n(v?.rating);
  if (rating !== undefined) {
    // rating:0 with review_number:0 means "nothing rated it yet", not "rated
    // zero stars" — the two are indistinguishable once printed as "0.0★", and
    // a genuinely new listing should not be buried by a rating-based sort.
    if (rating === 0 && (reviews === undefined || reviews === 0)) {
      r.isUnrated = true;
    } else {
      r.rating = rating;
    }
  }
  const pc = n(v?.primary_cuisine_id);
  if (pc !== undefined) r.primaryCuisineId = pc;
  const addr = s(v?.address);
  if (addr) r.address = addr;
  const city = cityName(v?.city);
  if (city) r.city = city;
  const lat = n(v?.latitude);
  if (lat !== undefined) r.latitude = lat;
  const lng = n(v?.longitude);
  if (lng !== undefined) r.longitude = lng;
  const dist = n(v?.distance);
  if (dist !== undefined) r.distanceKm = Math.round(dist * 100) / 100;
  const minOrder = n(v?.minimum_order_amount);
  if (minOrder !== undefined) r.minimumOrderAmount = minOrder;
  const fee = n(v?.minimum_delivery_fee);
  if (fee !== undefined) r.deliveryFee = fee;

  // Delivery estimate. `minimum_delivery_time` is the headline figure users see;
  // `delivery_duration_range.lower_limit_in_minutes` is the OPTIMISTIC end of a
  // range (observed: lower=5 while minimum_delivery_time=15 for the same vendor),
  // so quoting the lower limit alone would understate the wait. Prefer the
  // headline figure and expose the range separately.
  //
  // Both are 0/null on the detail endpoint unless coordinates were supplied.
  const lower = n(v?.delivery_duration_range?.lower_limit_in_minutes);
  const upper = n(v?.delivery_duration_range?.upper_limit_in_minutes);
  const headline = n(v?.minimum_delivery_time);
  const dt = headline !== undefined && headline > 0 ? headline : lower;
  if (dt !== undefined && dt > 0) r.deliveryTimeMinutes = dt;
  if (lower !== undefined && upper !== undefined) {
    r.deliveryTimeRangeMinutes = { min: lower, max: upper };
  }

  const budget = n(v?.budget);
  if (budget !== undefined) r.budgetTier = budget;
  if (b(v?.is_delivery_enabled) !== undefined) r.isDeliveryEnabled = b(v?.is_delivery_enabled);
  if (b(v?.is_pickup_enabled) !== undefined) r.isPickupEnabled = b(v?.is_pickup_enabled);
  if (b(v?.has_online_payment) !== undefined) r.hasOnlinePayment = b(v?.has_online_payment);
  if (b(v?.is_promoted) !== undefined) r.isPromoted = b(v?.is_promoted);
  if (b(v?.is_new) !== undefined) r.isNew = b(v?.is_new);
  const vertical = s(v?.vertical);
  if (vertical) r.vertical = vertical;
  const url = vendorUrl(v, market);
  if (url) r.url = url;

  const fees = normalizeFees(v);
  if (fees) r.fees = fees;

  if (schedules) {
    r.schedules = schedules;
    if (opts.computeOpen !== false && marketInfo?.timezone) {
      r.openStatus = computeOpenStatus(schedules, marketInfo.timezone);
    }
  }

  return r;
}

function normalizeItem(p: any, categoryName: string | undefined, currency?: string): MenuItem | undefined {
  const name = s(p?.name);
  if (!name) return undefined;

  const variations: MenuItemVariation[] = Array.isArray(p?.product_variations)
    ? p.product_variations
        .map((pv: any): MenuItemVariation | undefined => {
          const price = n(pv?.price);
          if (price === undefined) return undefined;
          const out: MenuItemVariation = { id: n(pv?.id) ?? 0, price };
          const nm = s(pv?.name);
          if (nm) out.name = nm;
          const before = n(pv?.price_before_discount);
          if (before !== undefined && before > price) out.priceBeforeDiscount = before;
          if (b(pv?.is_vegetarian) !== undefined) out.isVegetarian = b(pv?.is_vegetarian);
          return out;
        })
        .filter((x: MenuItemVariation | undefined): x is MenuItemVariation => x !== undefined)
    : [];

  if (variations.length === 0) return undefined; // an item with no price is not useful

  const cheapest = variations.reduce((a, c) => (c.price < a.price ? c : a), variations[0]!);

  const item: MenuItem = {
    id: n(p?.id) ?? 0,
    name,
    price: cheapest.price,
    isDiscounted: cheapest.priceBeforeDiscount !== undefined,
    variations,
  };
  const desc = s(p?.description);
  if (desc) item.description = desc;
  if (cheapest.priceBeforeDiscount !== undefined) item.priceBeforeDiscount = cheapest.priceBeforeDiscount;
  if (currency) item.currency = currency;
  if (categoryName) item.categoryName = categoryName;
  if (b(p?.is_sold_out) !== undefined) item.isSoldOut = b(p?.is_sold_out);
  if (cheapest.isVegetarian !== undefined) item.isVegetarian = cheapest.isVegetarian;
  // `file_path` carries a %s width placeholder; substitute a sane default.
  const img = s(p?.file_path);
  if (img) item.imageUrl = img.replace('%s', '400');
  return item;
}

export function normalizeMenu(detail: any, market: string): Menu {
  const currency = getMarket(market)?.currencySymbol;
  const menus = Array.isArray(detail?.menus) ? detail.menus : [];

  // A vendor can publish several menus (delivery/pickup/time-based). Merge the
  // categories rather than arbitrarily picking menus[0], de-duplicating by name.
  const byName = new Map<string, MenuCategory>();
  let itemCount = 0;

  for (const menu of menus) {
    const cats = Array.isArray(menu?.menu_categories) ? menu.menu_categories : [];
    for (const c of cats) {
      const catName = s(c?.name) ?? 'Other';
      const items = (Array.isArray(c?.products) ? c.products : [])
        .map((p: any) => normalizeItem(p, catName, currency))
        .filter((x: MenuItem | undefined): x is MenuItem => x !== undefined);
      if (items.length === 0) continue;

      const existing = byName.get(catName);
      if (existing) {
        const seen = new Set(existing.items.map((i) => i.id));
        for (const it of items) if (!seen.has(it.id)) existing.items.push(it);
      } else {
        const cat: MenuCategory = { id: n(c?.id) ?? 0, name: catName, items };
        const d = s(c?.description);
        if (d) cat.description = d;
        if (b(c?.is_popular_category) !== undefined) cat.isPopular = b(c?.is_popular_category);
        byName.set(catName, cat);
      }
    }
  }

  const categories = [...byName.values()];
  for (const c of categories) itemCount += c.items.length;

  const menu: Menu = {
    restaurantCode: s(detail?.code) ?? '',
    restaurantName: s(detail?.name) ?? '(unnamed)',
    market,
    categories,
    itemCount,
  };
  if (currency) menu.currencySymbol = currency;
  return menu;
}

export function normalizeCuisines(raw: unknown): Array<{ id: number; name: string; slug?: string; restaurantCount?: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: any) => {
      const name = s(c?.title) ?? s(c?.name);
      const id = n(c?.id);
      if (!name || id === undefined) return undefined;
      const out: { id: number; name: string; slug?: string; restaurantCount?: number } = { id, name };
      const slug = s(c?.slug);
      if (slug) out.slug = slug;
      const count = n(c?.count);
      if (count !== undefined) out.restaurantCount = count;
      return out;
    })
    .filter((x): x is { id: number; name: string; slug?: string; restaurantCount?: number } => x !== undefined);
}
