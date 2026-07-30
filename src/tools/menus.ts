import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildMeta,
  dealShape,
  discountShape,
  feesShape,
  locationInput,
  metaShape,
  money,
  PRICING_NOTE,
  resolveLocation,
  toolError,
  toolResult,
  type ToolContext,
} from './context.js';
import {
  filterMenuItems,
  filterRestaurants,
  flattenMenu,
  normalizeText,
  sortRestaurants,
} from '../domain/search.js';
import { feesBlock, itemHitLine, offersBlock } from './format.js';
import type { MenuItemHit } from '../domain/types.js';

export function registerMenuTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_menu',
    {
      title: 'Get a restaurant menu',
      description:
        'Retrieve the menu for one restaurant, with prices, categories and discount markers, plus the ' +
        'charges needed to estimate a total: minimum order, small-order fee, delivery fee, service fee and VAT, ' +
        'alongside the vendor\'s active deals and discounts. ' +
        'Optionally filter to items matching a keyword or a single category, and cap how much is returned — ' +
        'full menus can run to hundreds of items. ' +
        'Menu prices already include vendor deals; the fees are additive. ' +
        'Set openingType to "pickup" to read the pickup price list instead of the delivery one — vendors ' +
        'frequently run pickup-only discounts that do not appear in delivery prices, so compare both before ' +
        'quoting a total. ' +
        'Includes restaurantUrl, a link to the restaurant\'s foodpanda page, when upstream provides one.',
      inputSchema: {
        code: z.string().min(1).describe('Restaurant code from search_restaurants.'),
        market: z.string().length(2).describe('Two-letter market code the restaurant belongs to.'),
        query: z.string().optional().describe('Only return items matching this keyword, e.g. "chicken".'),
        category: z.string().optional().describe('Only return items from this menu category, matched loosely.'),
        maxItems: z.number().int().min(1).max(300).default(60).describe('Maximum items to return.'),
        discountedOnly: z.boolean().default(false).describe('Only return items currently discounted.'),
        openingType: z
          .enum(['delivery', 'pickup'])
          .default('delivery')
          .describe(
            'Which price list to read. Vendors publish separate delivery and pickup menus and a pickup-only ' +
            'discount is invisible in the delivery menu, so call twice to compare when pickup is an option.',
          ),
      },
      outputSchema: {
        restaurantName: z.string(),
        restaurantCode: z.string(),
        restaurantUrl: z.string().optional(),
        /** Which price list these prices came from. */
        openingType: z.enum(['delivery', 'pickup']),
        /** Whether this vendor offers pickup at all, so a comparison is worth making. */
        isPickupEnabled: z.boolean().optional(),
        totalItems: z.number(),
        returnedItems: z.number(),
        categories: z.array(
          z.object({
            name: z.string(),
            items: z.array(
              z.object({
                id: z.number(),
                name: z.string(),
                description: z.string().optional(),
                price: z.number(),
                priceBeforeDiscount: z.number().optional(),
                isDiscounted: z.boolean(),
                isSoldOut: z.boolean().optional(),
              }),
            ),
          }),
        ),
        fees: feesShape.optional(),
        deals: z.array(dealShape),
        discounts: z.array(discountShape),
        pricingNote: z.string(),
        meta: metaShape,
      },
    },
    async ({ code, market, query, category, maxItems, discountedOnly, openingType }) => {
      try {
        const { menu, restaurant, warnings, openingType: mode } = await ctx.foodpanda.getVendorDetail(code, market, {
          openingType,
        });

        // Nudge the caller towards the comparison when there is money in it.
        // A pickup discount is invisible from the delivery menu, so the delivery
        // answer alone is not enough to quote a cheapest total.
        if (mode === 'delivery' && restaurant.isPickupEnabled === true) {
          warnings.push(
            'This vendor also offers pickup, which can carry a pickup-only discount not shown in these ' +
              'delivery prices. Call get_menu again with openingType "pickup" to compare.',
          );
        }

        let categories = menu.categories;
        if (category) {
          const needle = category.toLowerCase();
          const matched = categories.filter((c) => c.name.toLowerCase().includes(needle));
          if (matched.length) categories = matched;
          else warnings.push(`No category matched "${category}"; showing all categories instead.`);
        }

        let remaining = maxItems;
        const out: Array<{ name: string; items: typeof menu.categories[number]['items'] }> = [];

        for (const c of categories) {
          if (remaining <= 0) break;
          let items = c.items;
          if (query) items = filterMenuItems(items, { query }).map((x) => x.item);
          if (discountedOnly) items = items.filter((i) => i.isDiscounted);
          if (items.length === 0) continue;
          const take = items.slice(0, remaining);
          remaining -= take.length;
          out.push({ name: c.name, items: take });
        }

        const returned = out.reduce((n, c) => n + c.items.length, 0);

        if (returned === 0) {
          const why = query ? ` matching "${query}"` : discountedOnly ? ' that are discounted' : '';
          return toolResult(`${menu.restaurantName} has no menu items${why}. The menu has ${menu.itemCount} items in total.`, {
            restaurantName: menu.restaurantName,
            restaurantCode: menu.restaurantCode,
            ...(restaurant.url ? { restaurantUrl: restaurant.url } : {}),
            openingType: mode,
            ...(restaurant.isPickupEnabled !== undefined ? { isPickupEnabled: restaurant.isPickupEnabled } : {}),
            totalItems: menu.itemCount,
            returnedItems: 0,
            categories: [],
            ...(restaurant.fees ? { fees: restaurant.fees } : {}),
            deals: restaurant.deals,
            discounts: restaurant.discounts,
            pricingNote: PRICING_NOTE,
            meta: buildMeta(market, 'foodpanda', warnings),
          });
        }

        const body = out
          .map((c) => {
            const items = c.items
              .map((i) => {
                const was = i.priceBeforeDiscount !== undefined ? ` (was ${money(i.priceBeforeDiscount, market)})` : '';
                const sold = i.isSoldOut ? ' [SOLD OUT]' : '';
                const desc = i.description ? `\n     ${i.description.slice(0, 100)}` : '';
                return `   - ${i.name} — ${money(i.price, market)}${was}${sold}${desc}`;
              })
              .join('\n');
            return `${c.name}\n${items}`;
          })
          .join('\n\n');

        const text =
          `${menu.restaurantName} (${menu.restaurantCode}) — showing ${returned} of ${menu.itemCount} items` +
          (query ? ` matching "${query}"` : '') +
          `\n${mode === 'pickup' ? 'PICKUP prices (delivery fee does not apply)' : 'DELIVERY prices'}` +
          `\n\n${body}\n` +
          feesBlock(restaurant.fees, market) +
          offersBlock(restaurant.deals, restaurant.discounts, market) +
          `\n${PRICING_NOTE}`;

        return toolResult(text, {
          restaurantName: menu.restaurantName,
          restaurantCode: menu.restaurantCode,
          ...(restaurant.url ? { restaurantUrl: restaurant.url } : {}),
          openingType: mode,
          ...(restaurant.isPickupEnabled !== undefined ? { isPickupEnabled: restaurant.isPickupEnabled } : {}),
          totalItems: menu.itemCount,
          returnedItems: returned,
          categories: out.map((c) => ({
            name: c.name,
            items: c.items.map((i) => ({
              id: i.id,
              name: i.name,
              ...(i.description ? { description: i.description } : {}),
              price: i.price,
              ...(i.priceBeforeDiscount !== undefined ? { priceBeforeDiscount: i.priceBeforeDiscount } : {}),
              isDiscounted: i.isDiscounted,
              ...(i.isSoldOut !== undefined ? { isSoldOut: i.isSoldOut } : {}),
            })),
          })),
          ...(restaurant.fees ? { fees: restaurant.fees } : {}),
          deals: restaurant.deals,
          discounts: restaurant.discounts,
          pricingNote: PRICING_NOTE,
          meta: buildMeta(market, 'foodpanda', warnings),
        });
      } catch (err) {
        return toolError(err, 'Check the restaurant code and market are correct.');
      }
    },
  );

  server.registerTool(
    'search_menu_items',
    {
      title: 'Search dishes across restaurants',
      description:
        'Search for a specific dish across many nearby restaurants at once and rank the results by price. ' +
        'This answers questions like "the cheapest biryani within 3 km" or "who has beef pizza under 1500". ' +
        'It fetches menus from multiple restaurants, so it is the slowest tool here — keep `restaurantLimit` modest. ' +
        'Set includeDeliveryFee to rank by true landed cost (item price + delivery fee) rather than sticker price. ' +
        'Each hit includes restaurantUrl, a link to the restaurant\'s foodpanda page, when upstream provides one.',
      inputSchema: {
        ...locationInput,
        query: z.string().min(2).describe('The dish to look for, e.g. "chicken biryani", "cold coffee", "margherita".'),
        maxPrice: z.number().min(0).optional().describe('Ignore items above this price.'),
        minPrice: z.number().min(0).optional().describe('Ignore items below this price.'),
        maxDistanceKm: z.number().min(0).optional().describe('Only consider restaurants within this distance.'),
        openNow: z
          .boolean()
          .default(false)
          .describe(
            'Only include dishes from restaurants open right now. Evaluated from each restaurant\'s schedule as its ' +
            'menu is fetched, so it costs nothing extra here.',
          ),
        vegetarianOnly: z.boolean().default(false).describe('Only return items flagged vegetarian upstream.'),
        includeDeliveryFee: z
          .boolean()
          .default(true)
          .describe(
            'Rank by item price plus delivery fee instead of item price alone. Ignored when openingType is ' +
            '"pickup", where no delivery fee applies.',
          ),
        openingType: z
          .enum(['delivery', 'pickup'])
          .default('delivery')
          .describe(
            'Which price list to search. Use "pickup" to hunt pickup prices, which can be materially cheaper ' +
            'than the delivery ones at the same vendor.',
          ),
        restaurantLimit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(8)
          .describe(
            'How many nearby restaurants to open menus for. Each one is a separate upstream request against a ' +
            'rate-limited, bot-protected host, so raise this only when you need wider coverage.',
          ),
        limit: z.number().int().min(1).max(50).default(15).describe('How many matching dishes to return.'),
      },
      outputSchema: {
        items: z.array(
          z.object({
            name: z.string(),
            price: z.number(),
            priceBeforeDiscount: z.number().optional(),
            totalWithDelivery: z.number().optional(),
            restaurantName: z.string(),
            restaurantCode: z.string(),
            restaurantUrl: z.string().optional(),
            restaurantRating: z.number().optional(),
            restaurantIsUnrated: z.boolean().optional(),
            distanceKm: z.number().optional(),
            deliveryFee: z.number().optional(),
            minimumOrderAmount: z.number().optional(),
          }),
        ),
        restaurantsSearched: z.number(),
        cheapest: z.object({ name: z.string(), price: z.number(), restaurantName: z.string() }).optional(),
        meta: metaShape,
      },
    },
    async (input) => {
      try {
        const loc = await resolveLocation(ctx, input);
        const market = loc.market!;

        // Candidate selection is a filter over the whole area, so scan the whole
        // area. Only the menu fetches below are rate-limited, and those stay
        // bounded by restaurantLimit.
        const listing = await ctx.foodpanda.listAllVendors(
          { latitude: loc.latitude, longitude: loc.longitude, market },
          { maxTotal: ctx.config.maxScan },
        );

        // Pre-filter restaurants so we spend our menu fetches on plausible candidates.
        // Matching the dish name against the restaurant/cuisine first is a strong
        // prior: a biryani place is far likelier to sell biryani than a bakery.
        // openNow is NOT applied here: listing data has no opening hours. It is
        // applied below, once each candidate's detail response supplies them.
        const candidatesByName = filterRestaurants(listing.restaurants, {
          query: input.query,
          maxDistanceKm: input.maxDistanceKm,
        });

        // Candidate selection matters more than anything else here: we can only
        // afford to open a handful of menus, so they must be the right ones.
        // If the dish name corresponds to a cuisine category upstream knows
        // about ("biryani", "pizza", "sushi"), ask the server for that cuisine
        // directly — far better than hoping a biryani shop has "biryani" in its
        // name. Without this, a search near a cluster of cafes returns nothing.
        const q = normalizeText(input.query);
        const cuisineMatch =
          listing.cuisines.find((c) => normalizeText(c.name) === q) ??
          listing.cuisines.find((c) => {
            const cn = normalizeText(c.name);
            return cn.length > 3 && (q.includes(cn) || cn.includes(q));
          });

        let byCuisine: typeof listing.restaurants = [];
        if (cuisineMatch) {
          try {
            const cuisineListing = await ctx.foodpanda.listAllVendors(
              { latitude: loc.latitude, longitude: loc.longitude, market, cuisineId: cuisineMatch.id },
              { maxTotal: ctx.config.maxScan },
            );
            byCuisine = filterRestaurants(cuisineListing.restaurants, {
              maxDistanceKm: input.maxDistanceKm,
            });
          } catch {
            // Cuisine narrowing is an optimisation; fall through to the generic list.
          }
        }

        const nearest = sortRestaurants(
          filterRestaurants(listing.restaurants, { maxDistanceKm: input.maxDistanceKm }),
          'distance',
        );

        const seen = new Set<string>();
        const candidates = [...candidatesByName, ...byCuisine, ...nearest]
          .filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)))
          .slice(0, input.restaurantLimit);

        if (candidates.length === 0) {
          return toolResult(
            `No restaurants near ${loc.displayName} matched the location filters, so there was nothing to search.`,
            { items: [], restaurantsSearched: 0, meta: buildMeta(market, 'foodpanda', listing.warnings) },
          );
        }

        const warnings = [...listing.warnings];
        const hits: MenuItemHit[] = [];
        let skippedClosed = 0;

        // Sequential-ish via the shared rate limiter; the HttpClient enforces
        // concurrency, so mapping in parallel here is still polite.
        await Promise.all(
          candidates.map(async (r) => {
            try {
              const { menu, restaurant } = await ctx.foodpanda.getVendorDetail(r.code, market, {
                openingType: input.openingType,
              });
              // The detail response is where opening hours live, so the openNow
              // filter is free at this point.
              if (input.openNow && restaurant.openStatus?.isOpen !== true) {
                skippedClosed++;
                return;
              }
              const matches = filterMenuItems(flattenMenu(menu.categories), {
                query: input.query,
                maxPrice: input.maxPrice,
                minPrice: input.minPrice,
                vegetarianOnly: input.vegetarianOnly || undefined,
              });
              for (const { item } of matches) {
                const hit: MenuItemHit = {
                  ...item,
                  restaurantCode: r.code,
                  restaurantName: r.name,
                };
                if (r.rating !== undefined) hit.restaurantRating = r.rating;
                if (r.isUnrated) hit.restaurantIsUnrated = r.isUnrated;
                if (r.url) hit.restaurantUrl = r.url;
                if (r.distanceKm !== undefined) hit.distanceKm = r.distanceKm;
                if (r.minimumOrderAmount !== undefined) hit.minimumOrderAmount = r.minimumOrderAmount;
                if (r.deliveryTimeMinutes !== undefined) hit.deliveryTimeMinutes = r.deliveryTimeMinutes;
                // deliveryFee deliberately comes from the freshly-fetched detail-level
                // `restaurant`, not the listing-level candidate `r`: the detail response
                // already reconciles the fee against active discounts (e.g. a vendor-level
                // "Free delivery" promo can zero out a nonzero listing-level fee), and it's
                // already in scope from the fetch above. Ranking by the stale listing value
                // here was Bug 1 — it could rank a truly-free-delivery vendor as more
                // expensive than it actually is.
                // On pickup there is no delivery fee to land, so neither the fee
                // nor a fee-inclusive total is reported; ranking then falls back
                // to the item price, which is the true landed cost in that mode.
                if (input.openingType !== 'pickup') {
                  if (restaurant.deliveryFee !== undefined) hit.deliveryFee = restaurant.deliveryFee;
                  hit.totalWithDelivery = item.price + (restaurant.deliveryFee ?? 0);
                }
                hits.push(hit);
              }
            } catch (err) {
              warnings.push(`Menu for ${r.name} (${r.code}) could not be read: ${err instanceof Error ? err.message : String(err)}`);
            }
          }),
        );

        const rank = (h: MenuItemHit) => (input.includeDeliveryFee ? (h.totalWithDelivery ?? h.price) : h.price);
        hits.sort((a, b) => rank(a) - rank(b));
        const page = hits.slice(0, input.limit);

        const closedNote = skippedClosed > 0 ? ` (${skippedClosed} skipped as closed)` : '';

        if (page.length === 0) {
          return toolResult(
            `Searched ${candidates.length} restaurants near ${loc.displayName}${closedNote} but found no menu items matching "${input.query}".\n\n` +
              `Try a broader term (e.g. "biryani" instead of "chicken tikka biryani"), raise restaurantLimit, or relax the price filters.`,
            { items: [], restaurantsSearched: candidates.length, meta: buildMeta(market, 'foodpanda', warnings) },
          );
        }

        const basis =
          input.openingType === 'pickup'
            ? 'pickup item price'
            : input.includeDeliveryFee
              ? 'item price + delivery fee'
              : 'item price';
        const text =
          `${hits.length} matches for "${input.query}" across ${candidates.length} restaurants near ${loc.displayName}${closedNote}` +
          `\nShowing the ${page.length} cheapest by ${basis}:\n\n` +
          page.map((h, i) => itemHitLine(h, market, i)).join('\n\n');

        const cheapest = page[0];

        return toolResult(text, {
          items: page.map((h) => ({
            name: h.name,
            price: h.price,
            ...(h.priceBeforeDiscount !== undefined ? { priceBeforeDiscount: h.priceBeforeDiscount } : {}),
            ...(h.totalWithDelivery !== undefined ? { totalWithDelivery: h.totalWithDelivery } : {}),
            restaurantName: h.restaurantName,
            restaurantCode: h.restaurantCode,
            ...(h.restaurantUrl ? { restaurantUrl: h.restaurantUrl } : {}),
            ...(h.restaurantRating !== undefined ? { restaurantRating: h.restaurantRating } : {}),
            ...(h.restaurantIsUnrated ? { restaurantIsUnrated: h.restaurantIsUnrated } : {}),
            ...(h.distanceKm !== undefined ? { distanceKm: h.distanceKm } : {}),
            ...(h.deliveryFee !== undefined ? { deliveryFee: h.deliveryFee } : {}),
            ...(h.minimumOrderAmount !== undefined ? { minimumOrderAmount: h.minimumOrderAmount } : {}),
          })),
          restaurantsSearched: candidates.length,
          ...(cheapest
            ? { cheapest: { name: cheapest.name, price: cheapest.price, restaurantName: cheapest.restaurantName } }
            : {}),
          meta: buildMeta(market, 'foodpanda', warnings),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
