import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildMeta, locationInput, metaShape, resolveLocation, toolError, toolResult, type ToolContext } from './context.js';
import { filterRestaurants, flattenMenu, sortRestaurants, type RestaurantSort } from '../domain/search.js';
import { toCsv } from '../domain/csv.js';
import type { Restaurant } from '../domain/types.js';

const RESTAURANT_COLUMNS = [
  'code',
  'name',
  'rating',
  'isUnrated',
  'cuisines',
  'address',
  'url',
  'distanceKm',
  'deliveryFee',
  'minimumOrderAmount',
  'deliveryTimeMinutes',
  'budgetTier',
  'hasDiscount',
];

const DEAL_COLUMNS = ['code', 'name', 'rating', 'distanceKm', 'deliveryFee', 'discounts', 'url'];

const MENU_ITEM_COLUMNS = [
  'category',
  'name',
  'price',
  'priceBeforeDiscount',
  'isDiscounted',
  'isSoldOut',
  'isVegetarian',
  'currency',
];

function restaurantRow(r: Restaurant): Record<string, unknown> {
  return {
    code: r.code,
    name: r.name,
    rating: r.rating,
    isUnrated: r.isUnrated || undefined,
    cuisines: r.cuisines.join('; '),
    address: r.address,
    url: r.url,
    distanceKm: r.distanceKm,
    deliveryFee: r.deliveryFee,
    minimumOrderAmount: r.minimumOrderAmount,
    deliveryTimeMinutes: r.deliveryTimeMinutes,
    budgetTier: r.budgetTier,
    hasDiscount: r.hasDiscount,
  };
}

function dealRow(r: Restaurant): Record<string, unknown> {
  const offers = [...r.discounts.map((d) => d.description), ...r.deals.map((d) => d.title)].join('; ');
  return {
    code: r.code,
    name: r.name,
    rating: r.rating,
    distanceKm: r.distanceKm,
    deliveryFee: r.deliveryFee,
    discounts: offers,
    url: r.url,
  };
}

function render(format: 'json' | 'csv', columns: string[], rows: Array<Record<string, unknown>>): string {
  return format === 'csv' ? toCsv(columns, rows) : JSON.stringify(rows, null, 2);
}

function preview(rows: Array<Record<string, unknown>>, n = 3): string {
  return rows
    .slice(0, n)
    .map((r) => `  ${JSON.stringify(r)}`)
    .join('\n');
}

export function registerExportTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'export_data',
    {
      title: 'Export data as CSV or JSON',
      description:
        'Export restaurants, a deals list, or one restaurant\'s menu as a CSV or JSON text blob, for pasting into a ' +
        'spreadsheet or piping into another tool. This is a bulk data dump, not a search — use search_restaurants, ' +
        'find_deals or get_menu for a conversational answer. `target: "restaurants"` and `"deals"` need a location; ' +
        '`target: "menu"` needs `code` and `market` instead. Row counts are capped (`limit` / `maxItems`); the ' +
        'response says whether the export was truncated.',
      inputSchema: {
        target: z.enum(['restaurants', 'menu', 'deals']).describe('What to export.'),
        format: z.enum(['json', 'csv']).default('json').describe('Output format for the `data` field.'),
        ...locationInput,
        code: z.string().optional().describe('Restaurant code, required when target is "menu".'),
        query: z.string().optional().describe('Restaurant target only: free text matched against name and cuisine.'),
        cuisine: z.string().optional().describe('Restaurant target only: restrict to a cuisine by name.'),
        minRating: z.number().min(0).max(5).optional().describe('Restaurant and deals targets: minimum rating.'),
        hasDiscount: z.boolean().optional().describe('Restaurant target only: only restaurants currently running a discount.'),
        sort: z
          .enum(['relevance', 'rating', 'distance', 'delivery_time', 'delivery_fee', 'minimum_order'])
          .default('distance')
          .describe('Restaurant target only: row order.'),
        limit: z.number().int().min(1).max(500).default(100).describe('Restaurant and deals targets: maximum rows.'),
        maxItems: z.number().int().min(1).max(300).default(150).describe('Menu target only: maximum item rows.'),
        openingType: z
          .enum(['delivery', 'pickup'])
          .default('delivery')
          .describe('Menu target only: which price list to export. Pickup prices can differ from delivery ones.'),
      },
      outputSchema: {
        target: z.enum(['restaurants', 'menu', 'deals']),
        format: z.enum(['json', 'csv']),
        rowCount: z.number(),
        truncated: z.boolean(),
        data: z.string(),
        meta: metaShape,
      },
    },
    async (input) => {
      try {
        if (input.target === 'menu') {
          if (!input.code || !input.market) {
            return toolError(new Error('target "menu" needs both `code` and `market`.'));
          }
          const { menu, warnings } = await ctx.foodpanda.getVendorDetail(input.code, input.market, {
            openingType: input.openingType,
          });
          const items = flattenMenu(menu.categories);
          const truncated = items.length > input.maxItems;
          const rows = items.slice(0, input.maxItems).map((item) => ({
            category: item.categoryName,
            name: item.name,
            price: item.price,
            priceBeforeDiscount: item.priceBeforeDiscount,
            isDiscounted: item.isDiscounted,
            isSoldOut: item.isSoldOut,
            isVegetarian: item.isVegetarian,
            currency: item.currency,
          }));
          const data = render(input.format, MENU_ITEM_COLUMNS, rows);
          return toolResult(
            `Exported ${rows.length} of ${items.length} menu items from ${menu.restaurantName} as ${input.format.toUpperCase()}` +
              (truncated ? ' (truncated, raise maxItems for more)' : '') +
              `.\n\n${preview(rows)}`,
            {
              target: 'menu',
              format: input.format,
              rowCount: rows.length,
              truncated,
              data,
              meta: buildMeta(input.market, 'foodpanda', warnings),
            },
          );
        }

        const loc = await resolveLocation(ctx, input);
        const market = loc.market!;
        const listing = await ctx.foodpanda.listAllVendors(
          { latitude: loc.latitude, longitude: loc.longitude, market },
          { maxTotal: ctx.config.maxScan },
        );

        if (input.target === 'deals') {
          const withDeals = filterRestaurants(listing.restaurants, { hasDiscount: true, minRating: input.minRating });
          const truncated = withDeals.length > input.limit;
          const rows = withDeals.slice(0, input.limit).map(dealRow);
          const data = render(input.format, DEAL_COLUMNS, rows);
          return toolResult(
            `Exported ${rows.length} of ${withDeals.length} restaurants with active deals near ${loc.displayName} as ${input.format.toUpperCase()}` +
              (truncated ? ' (truncated, raise limit for more)' : '') +
              `.\n\n${preview(rows)}`,
            {
              target: 'deals',
              format: input.format,
              rowCount: rows.length,
              truncated,
              data,
              meta: buildMeta(market, 'foodpanda', listing.warnings),
            },
          );
        }

        // target === 'restaurants'
        const filtered = filterRestaurants(listing.restaurants, {
          query: input.query,
          cuisine: input.cuisine,
          minRating: input.minRating,
          hasDiscount: input.hasDiscount,
        });
        const sorted = sortRestaurants(filtered, input.sort as RestaurantSort);
        const truncated = sorted.length > input.limit;
        const rows = sorted.slice(0, input.limit).map(restaurantRow);
        const data = render(input.format, RESTAURANT_COLUMNS, rows);
        return toolResult(
          `Exported ${rows.length} of ${sorted.length} restaurants near ${loc.displayName} as ${input.format.toUpperCase()}` +
            (truncated ? ' (truncated, raise limit for more)' : '') +
            `.\n\n${preview(rows)}`,
          {
            target: 'restaurants',
            format: input.format,
            rowCount: rows.length,
            truncated,
            data,
            meta: buildMeta(market, 'foodpanda', listing.warnings),
          },
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
