import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWN_ABSENT, MARKETS } from './domain/markets.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { TOOL_SCHEMA_VERSION, type ToolContext } from './tools/context.js';

/**
 * Resources expose reference data that a client may want to read directly
 * rather than by burning a tool call — the market table and the server's own
 * capability/version metadata — plus a templated restaurant lookup so a
 * restaurant can be attached to a conversation as context.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'markets',
    'foodpanda://markets',
    {
      title: 'Supported foodpanda markets',
      description: 'The markets this server can query, with currency and timezone. Verified against the live API.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              supported: Object.values(MARKETS),
              unavailable: Object.entries(KNOWN_ABSENT).map(([code, reason]) => ({ code, reason })),
              defaultMarket: ctx.config.defaultMarket,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'server-info',
    'foodpanda://server-info',
    {
      title: 'Server capabilities and version',
      description:
        'Server version, tool schema version, configured limits and the data-source disclaimer. Useful for diagnostics.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              name: SERVER_NAME,
              version: SERVER_VERSION,
              toolSchemaVersion: TOOL_SCHEMA_VERSION,
              transport: ctx.config.transport,
              readOnly: true,
              capabilities: {
                ordering: false,
                authentication: false,
                accountAccess: false,
                payments: false,
              },
              limits: {
                rateLimitRps: ctx.config.rateLimitRps,
                maxConcurrency: ctx.config.maxConcurrency,
                timeoutMs: ctx.config.timeoutMs,
                maxRetries: ctx.config.maxRetries,
              },
              cache: { backend: ctx.config.cacheBackend, ttlSeconds: ctx.config.ttl },
              disclaimer:
                'Unofficial project. Not affiliated with, endorsed by, or connected to foodpanda or Delivery Hero SE. ' +
                'Reads public, unauthenticated endpoints only. Prices and availability are indicative; the foodpanda ' +
                'app or website at checkout is the only authority.',
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'voucher-codes',
    'foodpanda://voucher-codes',
    {
      title: 'Publicly known Pakistan bank voucher codes',
      description:
        'Bank-card promo codes commonly advertised for foodpanda Pakistan (e.g. HBL25, ASKARI30), with their ' +
        'published terms. NOT read from the API — there is no working voucher/promotions endpoint upstream — ' +
        'so treat this as unverified static reference content, not live data. Critically, WHICH VENDORS ACCEPT ' +
        'A CODE IS NOT KNOWABLE from here: many opt out, and eligibility is only resolved in the basket at ' +
        'checkout. Quote menu prices as the real price and treat any voucher as a separate maybe.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              market: 'pk',
              quotingRule:
                'READ THIS BEFORE USING ANY CODE BELOW IN A CALCULATION. Quote the menu price as the headline ' +
                'number and present a voucher only as a separate, clearly-labelled upside line. Never rank or ' +
                'recommend options by a voucher-inclusive total, and never let an option qualify for a budget ' +
                'only because a voucher was subtracted from it — if it does not fit on menu price, it does not ' +
                'fit. This rule exists because it was broken: on 2026-07-30 a shortlist was built with a flat ' +
                'PKR 200 ASKARI30 deduction applied to every candidate, and the vendor turned out not to accept ' +
                'vouchers at all, so two options were only inside budget because of a discount that did not exist.',
              eligibility:
                'PER-VENDOR ELIGIBILITY IS NOT DISCOVERABLE, by this server or by any other means short of ' +
                'checkout. It is not in the listing response, not in the vendor detail response, and there is no ' +
                'promotions endpoint; it is resolved against the basket at checkout. A large share of vendors ' +
                'opt out entirely, and "eligible restaurants only" appears in the codes\' own terms. Assume a ' +
                'code does NOT apply until the checkout screen says otherwise.',
              cheaperAlternativeThatIsActuallyReadable:
                'Unlike vouchers, pickup pricing IS readable: call get_menu (or search_menu_items) with ' +
                'openingType "pickup". Vendors run pickup-only discounts that never appear in delivery prices, ' +
                'and get_restaurant reports isPickupEnabled so you know when the comparison is worth making. ' +
                'Prefer this verifiable saving over an assumed voucher.',
              knownExclusions: [
                {
                  market: 'pk',
                  code: 'h0e2',
                  name: 'Pizza Max - Khayaban-e-Ittehad',
                  observed: '2026-07-30',
                  note:
                    'Accepts no bank voucher codes. Reported first-hand by a customer after this server\'s data ' +
                    'was used to quote a voucher-inclusive price. It does run a 15% pickup discount, which is ' +
                    'readable via get_menu with openingType "pickup".',
                },
              ],
              disclaimer:
                'This is NOT from the foodpanda API — this project reads only public discovery data and has no ' +
                'working voucher or promotions endpoint (see docs/API-RESEARCH.md). The entries below are static ' +
                'reference content assembled from foodpanda\'s own historical bank-deals page and bank promotional ' +
                'material, which is frequently stale, inconsistent, or wrong — foodpanda\'s own page has, for example, ' +
                'labelled the ASKARI30 code "25% off" while Askari Bank\'s own material says 30%, and one real observed ' +
                'redemption paid out 32.5%. This server cannot apply a code, verify it is still active, or place an ' +
                'order — it is read-only. The foodpanda checkout screen is the only authority on what a code actually ' +
                'pays out; treat every field below as a starting point to try, not a promise.',
              howToUse:
                'Enter the code in the "Promo Code" field at checkout in the foodpanda app or website. This server ' +
                'has no ordering capability and cannot apply it for you.',
              codes: [
                {
                  code: 'ASKARI30',
                  advertisedDiscount:
                    '30% off per Askari Bank\'s own promotional material; foodpanda\'s bank-deals page labels the same ' +
                    'row "25% off", likely a foodpanda-side error. One real redemption observed paying 32.5%. Treat ' +
                    'the true rate as uncertain until confirmed at checkout.',
                  maxDiscount: 'PKR 200 per order',
                  minOrder: 'PKR 300',
                  validDays: 'All week',
                  cardRequirement: 'Askari Bank Mastercard Credit Card',
                  scope: 'Food orders only (delivery and pick-up); excludes pandamart/shops, delivery fee, service fee and tax',
                  confidence: 'low — source page was last updated for an Aug-Dec 2023 campaign window',
                },
                {
                  code: 'HBL25',
                  advertisedDiscount: '25% off',
                  maxDiscount: 'PKR 300 per order',
                  minOrder: 'PKR 700',
                  validDays: 'Saturday and Sunday only',
                  cardRequirement: 'HBL-issued card (Visa/Mastercard); exact tier for the current campaign is unconfirmed',
                  scope: 'Restaurants, pick-up and Everyday Favourites',
                  confidence: 'low — source page was last updated for an Aug-Dec 2023 campaign window',
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'restaurant',
    new ResourceTemplate('foodpanda://restaurant/{market}/{code}', { list: undefined }),
    {
      title: 'Restaurant record',
      description:
        'A single restaurant as JSON, addressed by market and code, e.g. foodpanda://restaurant/pk/u1od. ' +
        'Includes fees, rating, deals, schedule and menu summary.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const market = String(variables.market);
      const code = String(variables.code);
      try {
        const { restaurant, menu } = await ctx.foodpanda.getVendorDetail(code, market);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  ...restaurant,
                  menuSummary: {
                    itemCount: menu.itemCount,
                    categories: menu.categories.map((c) => ({ name: c.name, itemCount: c.items.length })),
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        // A resource read must return something readable rather than throwing.
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                { error: err instanceof Error ? err.message : String(err), market, code },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
