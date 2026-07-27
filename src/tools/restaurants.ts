import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildMeta,
  locationInput,
  metaShape,
  money,
  resolveLocation,
  toolError,
  toolResult,
  type ToolContext,
} from './context.js';
import { enrichWithOpenStatus, keepOpen } from './enrich.js';
import { filterRestaurants, sortRestaurants } from '../domain/search.js';
import { restaurantList, restaurantLine, openLabel } from './format.js';
import { WEEKDAY_NAMES } from '../domain/openNow.js';
import type { Restaurant } from '../domain/types.js';

const restaurantShape = z.object({
  code: z.string(),
  name: z.string(),
  market: z.string(),
  rating: z.number().optional(),
  reviewCount: z.number().optional(),
  cuisines: z.array(z.string()),
  distanceKm: z.number().optional(),
  deliveryFee: z.number().optional(),
  minimumOrderAmount: z.number().optional(),
  deliveryTimeMinutes: z.number().optional(),
  hasDiscount: z.boolean(),
  isOpen: z.boolean().optional(),
  address: z.string().optional(),
  url: z.string().optional(),
});

function slim(r: Restaurant) {
  return {
    code: r.code,
    name: r.name,
    market: r.market,
    ...(r.rating !== undefined ? { rating: r.rating } : {}),
    ...(r.reviewCount !== undefined ? { reviewCount: r.reviewCount } : {}),
    cuisines: r.cuisines,
    ...(r.distanceKm !== undefined ? { distanceKm: r.distanceKm } : {}),
    ...(r.deliveryFee !== undefined ? { deliveryFee: r.deliveryFee } : {}),
    ...(r.minimumOrderAmount !== undefined ? { minimumOrderAmount: r.minimumOrderAmount } : {}),
    ...(r.deliveryTimeMinutes !== undefined ? { deliveryTimeMinutes: r.deliveryTimeMinutes } : {}),
    hasDiscount: r.hasDiscount,
    ...(r.openStatus ? { isOpen: r.openStatus.isOpen } : {}),
    ...(r.address ? { address: r.address } : {}),
    ...(r.url ? { url: r.url } : {}),
  };
}

export function registerRestaurantTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_restaurants',
    {
      title: 'Search restaurants',
      description:
        'Find restaurants delivering to a location, with filtering and sorting. This is the primary discovery tool. ' +
        'Supports free-text matching on restaurant name and cuisine, plus filters for rating, delivery fee, minimum order, ' +
        'distance, delivery time, discounts and open-now status. ' +
        'Note: the upstream API has no working text search, so matching is performed locally over the nearby restaurant list — ' +
        'this is accurate but bounded by `scanLimit`.',
      inputSchema: {
        ...locationInput,
        query: z
          .string()
          .optional()
          .describe('Free text matched against restaurant name and cuisine, e.g. "biryani", "KFC", "sushi".'),
        cuisine: z.string().optional().describe('Restrict to a cuisine by name, e.g. "Pizza", "Chinese", "Desserts".'),
        openNow: z
          .boolean()
          .optional()
          .describe(
            'Only restaurants currently open for delivery. Opening hours are not present in listing data, so enabling ' +
            'this triggers one extra lookup per candidate (bounded by openNowCheckLimit) and is noticeably slower.',
          ),
        minRating: z.number().min(0).max(5).optional().describe('Minimum average rating, 0-5.'),
        maxDeliveryFee: z.number().min(0).optional().describe('Maximum delivery fee, in the market currency.'),
        maxMinimumOrder: z.number().min(0).optional().describe('Maximum minimum-order amount, in the market currency.'),
        maxDistanceKm: z.number().min(0).optional().describe('Maximum distance in kilometres.'),
        maxDeliveryTimeMinutes: z.number().min(0).optional().describe('Maximum estimated delivery time in minutes.'),
        hasDiscount: z.boolean().optional().describe('Only restaurants currently running a discount or deal.'),
        sort: z
          .enum(['relevance', 'rating', 'distance', 'delivery_time', 'delivery_fee', 'minimum_order'])
          .default('relevance')
          .describe('Result ordering. "relevance" ranks by match quality when a query is given.'),
        limit: z.number().int().min(1).max(50).default(10).describe('How many restaurants to return.'),
        scanLimit: z
          .number()
          .int()
          .min(20)
          .max(200)
          .default(100)
          .describe('How many nearby restaurants to fetch and search through. Higher is more thorough but slower.'),
        openNowCheckLimit: z
          .number()
          .int()
          .min(1)
          .max(40)
          .default(12)
          .describe('When openNow is true, how many top candidates to check opening hours for.'),
      },
      outputSchema: {
        restaurants: z.array(restaurantShape),
        totalNearby: z.number(),
        matched: z.number(),
        openStatusChecked: z.number().optional(),
        location: z.object({ displayName: z.string(), latitude: z.number(), longitude: z.number() }),
        meta: metaShape,
      },
    },
    async (input) => {
      try {
        const loc = await resolveLocation(ctx, input);
        const market = loc.market!;

        const listing = await ctx.foodpanda.listAllVendors(
          { latitude: loc.latitude, longitude: loc.longitude, market },
          { maxTotal: input.scanLimit },
        );

        // Apply every cheap filter first. openNow is deliberately excluded here:
        // listing data carries no schedules, so it can only be evaluated after
        // an enrichment pass, and we want that pass to run on the smallest
        // possible candidate set.
        const filtered = filterRestaurants(listing.restaurants, {
          query: input.query,
          cuisine: input.cuisine,
          minRating: input.minRating,
          maxDeliveryFee: input.maxDeliveryFee,
          maxMinimumOrder: input.maxMinimumOrder,
          maxDistanceKm: input.maxDistanceKm,
          maxDeliveryTimeMinutes: input.maxDeliveryTimeMinutes,
          hasDiscount: input.hasDiscount,
        });

        let sorted = sortRestaurants(filtered, input.sort);
        const warnings = [...listing.warnings];
        let checked: number | undefined;

        if (input.openNow) {
          const budget = Math.max(input.openNowCheckLimit, input.limit);
          const { enriched, checked: c, warnings: w } = await enrichWithOpenStatus(ctx, sorted, market, budget);
          sorted = keepOpen(enriched);
          checked = c;
          warnings.push(...w);
        }

        const page = sorted.slice(0, input.limit);

        const criteria = [
          input.query ? `"${input.query}"` : null,
          input.cuisine ? `cuisine=${input.cuisine}` : null,
          input.openNow ? 'open now' : null,
          input.minRating !== undefined ? `rating>=${input.minRating}` : null,
          input.maxDeliveryFee !== undefined ? `fee<=${money(input.maxDeliveryFee, market)}` : null,
          input.maxDistanceKm !== undefined ? `<=${input.maxDistanceKm}km` : null,
          input.hasDiscount ? 'has discount' : null,
        ]
          .filter(Boolean)
          .join(', ');

        const header =
          `${page.length} of ${sorted.length} matching restaurants near ${loc.displayName}` +
          (criteria ? ` (${criteria})` : '') +
          `\nScanned ${listing.restaurants.length} of ${listing.availableCount} nearby restaurants · sorted by ${input.sort}` +
          (checked !== undefined ? ` · opening hours checked for ${checked}` : '');

        return toolResult(restaurantList(page, header), {
          restaurants: page.map(slim),
          totalNearby: listing.availableCount,
          matched: sorted.length,
          ...(checked !== undefined ? { openStatusChecked: checked } : {}),
          location: { displayName: loc.displayName, latitude: loc.latitude, longitude: loc.longitude },
          meta: buildMeta(market, 'foodpanda', warnings),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'get_restaurant',
    {
      title: 'Get restaurant details',
      description:
        'Full detail for one restaurant by its code: fees, minimum order, delivery estimate, rating, cuisines, ' +
        'active deals and discounts, weekly opening hours and whether it is open right now. ' +
        'Get the code from search_restaurants.',
      inputSchema: {
        code: z.string().min(1).describe('Restaurant code from search_restaurants, e.g. "u1od".'),
        market: z.string().length(2).describe('Two-letter market code the restaurant belongs to, e.g. "pk".'),
        latitude: z.number().optional().describe('Optional: your coordinates, to get a delivery-time estimate.'),
        longitude: z.number().optional().describe('Optional: your coordinates, to get a delivery-time estimate.'),
      },
      outputSchema: {
        restaurant: restaurantShape.extend({
          deals: z.array(z.object({ title: z.string(), description: z.string().optional() })),
          discounts: z.array(z.object({ type: z.string(), description: z.string() })),
          schedule: z.array(z.object({ weekday: z.string(), opensAt: z.string(), closesAt: z.string() })),
          openStatus: z
            .object({ isOpen: z.boolean(), localTime: z.string(), timezone: z.string(), closesAt: z.string().optional() })
            .optional(),
          menuItemCount: z.number(),
        }),
        meta: metaShape,
      },
    },
    async ({ code, market, latitude, longitude }) => {
      try {
        const opts: { latitude?: number; longitude?: number } = {};
        if (latitude !== undefined) opts.latitude = latitude;
        if (longitude !== undefined) opts.longitude = longitude;

        const { restaurant: r, menu, warnings } = await ctx.foodpanda.getVendorDetail(code, market, opts);

        const sched = (r.schedules ?? []).map((s) => ({
          weekday: WEEKDAY_NAMES[s.weekday] ?? String(s.weekday),
          opensAt: s.opensAt,
          closesAt: s.closesAt,
        }));

        const dealLines = r.deals.length
          ? `\nDeals:\n${r.deals.map((d) => `- ${d.title}${d.description ? ` — ${d.description}` : ''}`).join('\n')}`
          : '';
        const discLines = r.discounts.length
          ? `\nDiscounts:\n${r.discounts.map((d) => `- ${d.description}`).join('\n')}`
          : '';
        const schedLines = sched.length
          ? `\nOpening hours:\n${sched.map((s) => `- ${s.weekday}: ${s.opensAt}–${s.closesAt}`).join('\n')}`
          : '';

        const text =
          `${r.name}${openLabel(r)}\n` +
          `${'='.repeat(Math.min(r.name.length, 60))}\n` +
          `- Code: ${r.code} (market ${r.market})\n` +
          (r.rating !== undefined ? `- Rating: ${r.rating.toFixed(1)}★ from ${r.reviewCount ?? 0} reviews\n` : '') +
          (r.cuisines.length ? `- Cuisines: ${r.cuisines.join(', ')}\n` : '') +
          (r.address ? `- Address: ${r.address}\n` : '') +
          (r.deliveryFee !== undefined ? `- Delivery fee: ${money(r.deliveryFee, r.market)}\n` : '') +
          (r.minimumOrderAmount !== undefined ? `- Minimum order: ${money(r.minimumOrderAmount, r.market)}\n` : '') +
          (r.deliveryTimeMinutes !== undefined
            ? `- Estimated delivery: ~${r.deliveryTimeMinutes} min` +
              (r.deliveryTimeRangeMinutes
                ? ` (range ${r.deliveryTimeRangeMinutes.min}–${r.deliveryTimeRangeMinutes.max} min)`
                : '') +
              '\n'
            : '- Estimated delivery: not available (pass latitude/longitude to get one)\n') +
          `- Menu items: ${menu.itemCount} across ${menu.categories.length} categories\n` +
          (r.openStatus ? `- Local time: ${r.openStatus.localTime}\n` : '') +
          dealLines +
          discLines +
          schedLines;

        return toolResult(text, {
          restaurant: {
            ...slim(r),
            deals: r.deals.map((d) => ({ title: d.title, ...(d.description ? { description: d.description } : {}) })),
            discounts: r.discounts.map((d) => ({ type: d.type, description: d.description })),
            schedule: sched,
            ...(r.openStatus
              ? {
                  openStatus: {
                    isOpen: r.openStatus.isOpen,
                    localTime: r.openStatus.localTime,
                    timezone: r.openStatus.timezone,
                    ...(r.openStatus.closesAt ? { closesAt: r.openStatus.closesAt } : {}),
                  },
                }
              : {}),
            menuItemCount: menu.itemCount,
          },
          meta: buildMeta(market, 'foodpanda', warnings),
        });
      } catch (err) {
        return toolError(err, 'Check the restaurant code and market are correct — codes are market-specific.');
      }
    },
  );

  server.registerTool(
    'check_open_now',
    {
      title: 'Check if restaurants are open',
      description:
        'Check whether specific restaurants are open for delivery right now, and if not, when they next open. ' +
        'Evaluated against each market\'s local timezone using the restaurant\'s published weekly schedule. ' +
        'Accepts up to 10 restaurant codes at once.',
      inputSchema: {
        codes: z.array(z.string().min(1)).min(1).max(10).describe('Restaurant codes to check, from search_restaurants.'),
        market: z.string().length(2).describe('Two-letter market code these restaurants belong to.'),
      },
      outputSchema: {
        results: z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            isOpen: z.boolean(),
            closesAt: z.string().optional(),
            opensNext: z.string().optional(),
            localTime: z.string(),
            scheduleUnavailable: z.boolean(),
          }),
        ),
        meta: metaShape,
      },
    },
    async ({ codes, market }) => {
      try {
        const warnings: string[] = [];
        const results = await Promise.all(
          codes.map(async (code) => {
            try {
              const { restaurant } = await ctx.foodpanda.getVendorDetail(code, market);
              const st = restaurant.openStatus;
              return {
                code,
                name: restaurant.name,
                isOpen: st?.isOpen ?? false,
                ...(st?.closesAt ? { closesAt: st.closesAt } : {}),
                ...(st?.opensNext
                  ? { opensNext: `${WEEKDAY_NAMES[st.opensNext.weekday] ?? ''} ${st.opensNext.time}` }
                  : {}),
                localTime: st?.localTime ?? '',
                scheduleUnavailable: st?.scheduleUnavailable ?? true,
              };
            } catch (err) {
              // One bad code should not fail the whole batch.
              warnings.push(`${code}: ${err instanceof Error ? err.message : String(err)}`);
              return {
                code,
                name: '(lookup failed)',
                isOpen: false,
                localTime: '',
                scheduleUnavailable: true,
              };
            }
          }),
        );

        const lines = results.map((r) => {
          if (r.scheduleUnavailable && r.name === '(lookup failed)') return `- ${r.code}: lookup failed`;
          if (r.scheduleUnavailable) return `- ${r.name} (${r.code}): hours not published`;
          if (r.isOpen) return `- ${r.name} (${r.code}): OPEN${r.closesAt ? `, closes ${r.closesAt}` : ''}`;
          return `- ${r.name} (${r.code}): CLOSED${r.opensNext ? `, opens ${r.opensNext}` : ''}`;
        });

        const openCount = results.filter((r) => r.isOpen).length;
        const text =
          `${openCount} of ${results.length} restaurants are open right now` +
          (results[0]?.localTime ? ` (local time ${results[0].localTime})` : '') +
          `:\n\n${lines.join('\n')}`;

        return toolResult(text, { results, meta: buildMeta(market, 'foodpanda', warnings) });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'compare_restaurants',
    {
      title: 'Compare restaurants side by side',
      description:
        'Compare 2-8 restaurants on delivery fee, minimum order, delivery time, rating and current deals, ' +
        'and identify the cheapest and fastest. Use after search_restaurants when the user is choosing between options.',
      inputSchema: {
        codes: z.array(z.string().min(1)).min(2).max(8).describe('Restaurant codes to compare.'),
        market: z.string().length(2).describe('Two-letter market code these restaurants belong to.'),
        latitude: z.number().optional().describe('Optional coordinates for accurate delivery-time estimates.'),
        longitude: z.number().optional().describe('Optional coordinates for accurate delivery-time estimates.'),
      },
      outputSchema: {
        comparison: z.array(restaurantShape.extend({ dealCount: z.number() })),
        cheapestDeliveryCode: z.string().optional(),
        fastestCode: z.string().optional(),
        lowestMinimumCode: z.string().optional(),
        bestRatedCode: z.string().optional(),
        meta: metaShape,
      },
    },
    async ({ codes, market, latitude, longitude }) => {
      try {
        const warnings: string[] = [];
        const opts: { latitude?: number; longitude?: number } = {};
        if (latitude !== undefined) opts.latitude = latitude;
        if (longitude !== undefined) opts.longitude = longitude;

        const settled = await Promise.all(
          codes.map(async (code) => {
            try {
              const { restaurant } = await ctx.foodpanda.getVendorDetail(code, market, opts);
              return restaurant;
            } catch (err) {
              warnings.push(`${code}: ${err instanceof Error ? err.message : String(err)}`);
              return undefined;
            }
          }),
        );
        const found = settled.filter((r): r is Restaurant => r !== undefined);

        if (found.length === 0) {
          return toolError(new Error('None of the supplied restaurant codes could be loaded.'));
        }

        const best = (get: (r: Restaurant) => number | undefined, mode: 'min' | 'max') =>
          found
            .filter((r) => get(r) !== undefined)
            .sort((a, b) => (mode === 'min' ? get(a)! - get(b)! : get(b)! - get(a)!))[0]?.code;

        const cheapest = best((r) => r.deliveryFee, 'min');
        const fastest = best((r) => r.deliveryTimeMinutes, 'min');
        const lowestMin = best((r) => r.minimumOrderAmount, 'min');
        const bestRated = best((r) => r.rating, 'max');

        const rows = found.map((r) => {
          const marks = [
            r.code === cheapest ? 'cheapest delivery' : null,
            r.code === fastest ? 'fastest' : null,
            r.code === lowestMin ? 'lowest minimum' : null,
            r.code === bestRated ? 'best rated' : null,
          ].filter(Boolean);
          return (
            `${restaurantLine(r)}` +
            (r.deals.length ? `\n   deals: ${r.deals.map((d) => d.title).join('; ').slice(0, 120)}` : '') +
            (marks.length ? `\n   ⇒ ${marks.join(', ')}` : '')
          );
        });

        const text = `Comparing ${found.length} restaurants in ${market}:\n\n${rows.join('\n\n')}`;

        return toolResult(text, {
          comparison: found.map((r) => ({ ...slim(r), dealCount: r.deals.length })),
          ...(cheapest ? { cheapestDeliveryCode: cheapest } : {}),
          ...(fastest ? { fastestCode: fastest } : {}),
          ...(lowestMin ? { lowestMinimumCode: lowestMin } : {}),
          ...(bestRated ? { bestRatedCode: bestRated } : {}),
          meta: buildMeta(market, 'foodpanda', warnings),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
