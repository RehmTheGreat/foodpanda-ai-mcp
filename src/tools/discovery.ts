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
import { restaurantList } from './format.js';

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_cuisines',
    {
      title: 'Browse cuisines nearby',
      description:
        'List the cuisine categories available at a location with a count of restaurants in each, ' +
        'e.g. "Biryani (21), Burgers (13), Chinese (7)". ' +
        'Use it to orient before searching, or to answer "what kind of food can I get around here". ' +
        'The returned cuisine ids can be passed to browse_by_cuisine.',
      inputSchema: {
        ...locationInput,
        minRestaurants: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Only list cuisines with at least this many restaurants nearby.'),
      },
      outputSchema: {
        cuisines: z.array(
          z.object({ id: z.number(), name: z.string(), restaurantCount: z.number().optional(), slug: z.string().optional() }),
        ),
        totalRestaurantsNearby: z.number(),
        location: z.object({ displayName: z.string(), latitude: z.number(), longitude: z.number() }),
        meta: metaShape,
      },
    },
    async (input) => {
      try {
        const loc = await resolveLocation(ctx, input);
        const market = loc.market!;

        // One small page is enough: cuisine aggregations describe the whole area,
        // not just the returned page.
        const listing = await ctx.foodpanda.listVendors({
          latitude: loc.latitude,
          longitude: loc.longitude,
          market,
          limit: 1,
        });

        const cuisines = listing.cuisines
          .filter((c) => (c.restaurantCount ?? 0) >= input.minRestaurants)
          .sort((a, b) => (b.restaurantCount ?? 0) - (a.restaurantCount ?? 0));

        if (cuisines.length === 0) {
          return toolResult(`No cuisine information is available near ${loc.displayName}.`, {
            cuisines: [],
            totalRestaurantsNearby: listing.availableCount,
            location: { displayName: loc.displayName, latitude: loc.latitude, longitude: loc.longitude },
            meta: buildMeta(market, 'foodpanda', listing.warnings),
          });
        }

        const text =
          `${cuisines.length} cuisines available near ${loc.displayName} ` +
          `(${listing.availableCount} restaurants total):\n\n` +
          cuisines.map((c) => `- ${c.name} — ${c.restaurantCount ?? 0} restaurants (id ${c.id})`).join('\n');

        return toolResult(text, {
          cuisines: cuisines.map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.restaurantCount !== undefined ? { restaurantCount: c.restaurantCount } : {}),
            ...(c.slug ? { slug: c.slug } : {}),
          })),
          totalRestaurantsNearby: listing.availableCount,
          location: { displayName: loc.displayName, latitude: loc.latitude, longitude: loc.longitude },
          meta: buildMeta(market, 'foodpanda', listing.warnings),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'browse_by_cuisine',
    {
      title: 'Browse restaurants by cuisine',
      description:
        'List restaurants of a specific cuisine near a location, filtered server-side by cuisine id. ' +
        'More precise than a text search when the user names a cuisine category ("show me Thai places"). ' +
        'Get the cuisine id from list_cuisines, or pass a cuisine name and it will be looked up automatically.',
      inputSchema: {
        ...locationInput,
        cuisineId: z.number().int().optional().describe('Upstream cuisine id from list_cuisines. Preferred when known.'),
        cuisineName: z.string().optional().describe('Cuisine name to look up, e.g. "Biryani". Used when cuisineId is absent.'),
        openNow: z
          .boolean()
          .default(false)
          .describe('Only restaurants open right now. Costs one extra lookup per candidate, so it is slower.'),
        sort: z
          .enum(['relevance', 'rating', 'distance', 'delivery_time', 'delivery_fee', 'minimum_order'])
          .default('rating')
          .describe('Result ordering.'),
        limit: z.number().int().min(1).max(50).default(15).describe('How many restaurants to return.'),
      },
      outputSchema: {
        restaurants: z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            rating: z.number().optional(),
            isUnrated: z.boolean().optional(),
            cuisines: z.array(z.string()),
            distanceKm: z.number().optional(),
            deliveryFee: z.number().optional(),
            minimumOrderAmount: z.number().optional(),
            hasDiscount: z.boolean(),
            isOpen: z.boolean().optional(),
            url: z.string().optional(),
          }),
        ),
        cuisineUsed: z.object({ id: z.number().optional(), name: z.string().optional() }),
        matched: z.number(),
        meta: metaShape,
      },
    },
    async (input) => {
      try {
        const loc = await resolveLocation(ctx, input);
        const market = loc.market!;
        const warnings: string[] = [];

        let cuisineId = input.cuisineId;
        let cuisineName = input.cuisineName;

        // Resolve a name to an id using the location's own cuisine aggregation.
        if (cuisineId === undefined && cuisineName) {
          const probe = await ctx.foodpanda.listVendors({
            latitude: loc.latitude,
            longitude: loc.longitude,
            market,
            limit: 1,
          });
          const needle = cuisineName.toLowerCase();
          const exact = probe.cuisines.find((c) => c.name.toLowerCase() === needle);
          const partial = probe.cuisines.find((c) => c.name.toLowerCase().includes(needle));
          const found = exact ?? partial;
          if (found) {
            cuisineId = found.id;
            cuisineName = found.name;
          } else {
            warnings.push(
              `No cuisine named "${input.cuisineName}" is available near this location; falling back to a text search.`,
            );
          }
        }

        if (cuisineId === undefined && !cuisineName) {
          return toolError(new Error('Provide either cuisineId or cuisineName.'));
        }

        const listing =
          cuisineId !== undefined
            ? await ctx.foodpanda.listAllVendors(
                { latitude: loc.latitude, longitude: loc.longitude, market, cuisineId },
                { maxTotal: ctx.config.maxScan },
              )
            : await ctx.foodpanda.listAllVendors(
                { latitude: loc.latitude, longitude: loc.longitude, market },
                { maxTotal: ctx.config.maxScan },
              );

        let list = listing.restaurants;
        // When the id lookup failed, fall back to matching the cuisine text.
        if (cuisineId === undefined && cuisineName) {
          list = filterRestaurants(list, { cuisine: cuisineName });
        }

        let ranked = sortRestaurants(list, input.sort);
        if (input.openNow) {
          // Listing data has no opening hours; enrich the top candidates only.
          const budget = Math.max(input.limit * 2, 20);
          const { enriched, warnings: w } = await enrichWithOpenStatus(ctx, ranked, market, budget);
          ranked = keepOpen(enriched);
          warnings.push(...w);
        }
        const sorted = ranked.slice(0, input.limit);

        const header =
          `${sorted.length} ${cuisineName ?? `cuisine ${cuisineId}`} restaurants near ${loc.displayName}` +
          (input.openNow ? ' (open now)' : '') +
          ` · sorted by ${input.sort}`;

        return toolResult(restaurantList(sorted, header), {
          restaurants: sorted.map((r) => ({
            code: r.code,
            name: r.name,
            ...(r.rating !== undefined ? { rating: r.rating } : {}),
            ...(r.isUnrated ? { isUnrated: r.isUnrated } : {}),
            cuisines: r.cuisines,
            ...(r.distanceKm !== undefined ? { distanceKm: r.distanceKm } : {}),
            ...(r.deliveryFee !== undefined ? { deliveryFee: r.deliveryFee } : {}),
            ...(r.minimumOrderAmount !== undefined ? { minimumOrderAmount: r.minimumOrderAmount } : {}),
            hasDiscount: r.hasDiscount,
            ...(r.openStatus ? { isOpen: r.openStatus.isOpen } : {}),
            ...(r.url ? { url: r.url } : {}),
          })),
          cuisineUsed: {
            ...(cuisineId !== undefined ? { id: cuisineId } : {}),
            ...(cuisineName ? { name: cuisineName } : {}),
          },
          matched: ranked.length,
          meta: buildMeta(market, 'foodpanda', [...listing.warnings, ...warnings]),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'find_deals',
    {
      title: 'Find restaurants with active deals',
      description:
        'Find restaurants near a location that currently advertise a discount or deal, ranked by how good the offer looks. ' +
        'Answers "what is on offer near me right now". ' +
        'Note these are restaurant-level promotions published by foodpanda; bank or voucher codes are not covered.',
      inputSchema: {
        ...locationInput,
        openNow: z
          .boolean()
          .default(false)
          .describe('Only restaurants open right now. Costs one extra lookup per candidate, so it is slower.'),
        minRating: z.number().min(0).max(5).optional().describe('Minimum average rating.'),
        limit: z.number().int().min(1).max(40).default(15).describe('How many restaurants to return.'),
        scanLimit: z
          .number()
          .int()
          .min(20)
          .max(2000)
          .optional()
          .describe(
            'How many nearby restaurants to scan. Omit to scan everything available (up to ' +
            'FOODPANDA_MAX_SCAN, default 600) so the deal list is complete rather than a sample. ' +
            'Listing pages are cheap and not rate-limited.',
          ),
      },
      outputSchema: {
        restaurants: z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            rating: z.number().optional(),
            isUnrated: z.boolean().optional(),
            distanceKm: z.number().optional(),
            deliveryFee: z.number().optional(),
            discounts: z.array(z.string()),
            isOpen: z.boolean().optional(),
            url: z.string().optional(),
          }),
        ),
        matched: z.number(),
        scanned: z.number(),
        scanComplete: z.boolean(),
        meta: metaShape,
      },
    },
    async (input) => {
      try {
        const loc = await resolveLocation(ctx, input);
        const market = loc.market!;

        const listing = await ctx.foodpanda.listAllVendors(
          { latitude: loc.latitude, longitude: loc.longitude, market },
          { maxTotal: input.scanLimit ?? ctx.config.maxScan },
        );

        const dealWarnings = [...listing.warnings];
        let withDeals = filterRestaurants(listing.restaurants, {
          hasDiscount: true,
          minRating: input.minRating,
        });

        if (input.openNow) {
          // Opening hours are absent from listing data; enrich then filter.
          const budget = Math.max(input.limit * 2, 20);
          const { enriched, warnings: w } = await enrichWithOpenStatus(ctx, withDeals, market, budget);
          withDeals = keepOpen(enriched);
          dealWarnings.push(...w);
        }

        // Rank by the strongest advertised percentage, then rating.
        const scored = withDeals
          .map((r) => {
            const pct = Math.max(
              0,
              ...r.discounts.map((d) => d.percentage ?? 0),
              ...r.deals.map((d) => (d.value !== undefined && d.value <= 100 ? d.value : 0)),
            );
            return { r, pct };
          })
          .sort((a, b) => b.pct - a.pct || (b.r.rating ?? 0) - (a.r.rating ?? 0));

        const page = scored.slice(0, input.limit);

        if (page.length === 0) {
          return toolResult(
            `No restaurants near ${loc.displayName} are advertising a discount right now ` +
              `(scanned ${listing.restaurants.length} of ${listing.availableCount} nearby).`,
            {
              restaurants: [],
              matched: 0,
              scanned: listing.restaurants.length,
              scanComplete: listing.complete === true,
              meta: buildMeta(market, 'foodpanda', dealWarnings),
            },
          );
        }

        const lines = page.map(({ r }, i) => {
          const offers = [...r.discounts.map((d) => d.description), ...r.deals.map((d) => d.title)]
            .filter(Boolean)
            .slice(0, 3);
          const bits = [
            r.rating !== undefined ? `${r.rating.toFixed(1)}★` : r.isUnrated ? 'unrated' : null,
            r.distanceKm !== undefined ? `${r.distanceKm.toFixed(1)} km` : null,
            r.deliveryFee !== undefined ? `fee ${money(r.deliveryFee, market)}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return `${i + 1}. ${r.name} (${r.code})\n   ${bits}\n   ${offers.map((o) => `🏷 ${o}`).join('\n   ')}`;
        });

        const coverage = listing.complete
          ? `scanned all ${listing.availableCount} nearby`
          : `scanned ${listing.restaurants.length} of ${listing.availableCount} nearby`;
        const text =
          `${withDeals.length} restaurants near ${loc.displayName} have active offers ` +
          `(${coverage}). Top ${page.length}:\n\n${lines.join('\n\n')}`;

        return toolResult(text, {
          restaurants: page.map(({ r }) => ({
            code: r.code,
            name: r.name,
            ...(r.rating !== undefined ? { rating: r.rating } : {}),
            ...(r.isUnrated ? { isUnrated: r.isUnrated } : {}),
            ...(r.distanceKm !== undefined ? { distanceKm: r.distanceKm } : {}),
            ...(r.deliveryFee !== undefined ? { deliveryFee: r.deliveryFee } : {}),
            discounts: [...r.discounts.map((d) => d.description), ...r.deals.map((d) => d.title)],
            ...(r.openStatus ? { isOpen: r.openStatus.isOpen } : {}),
            ...(r.url ? { url: r.url } : {}),
          })),
          matched: withDeals.length,
          scanned: listing.restaurants.length,
          scanComplete: listing.complete === true,
          meta: buildMeta(market, 'foodpanda', dealWarnings),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
