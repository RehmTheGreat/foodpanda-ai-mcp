# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Version numbers and the actual
release cut (npm publish, git tag, GitHub release) happen once per
[docs/RELEASING.md](docs/RELEASING.md), not per phase — this section accumulates
until then.

## [0.4.0] — 2026-07-30

Tool schema version moves to 1.2.0: new optional inputs and new output fields, all
backward compatible.

### Added — pickup pricing

Vendors publish a **separate price list per fulfilment mode**, and pickup-only discounts
do not appear in delivery prices at all. Until now every request hardcoded
`opening_type=delivery`, so those discounts were invisible and unreachable — the gap
flagged as "order-mode parameter" in the Phase 0 payload inventory.

- `get_menu`, `search_menu_items` and `export_data` (menu target) take
  **`openingType: "delivery" | "pickup"`**, defaulting to `delivery` so existing callers
  are unaffected.
- `get_menu` returns the `openingType` it read and labels the price list in its text.
- `search_menu_items` reports no delivery fee and no fee-inclusive total on pickup, where
  no such fee exists, so ranking falls back to the item price — the true landed cost.
- `get_restaurant` and `search_restaurants` expose **`isPickupEnabled`**, so a caller knows
  when the comparison is worth making; `get_menu` adds a warning pointing at it.
- Requesting pickup from a delivery-only vendor now **warns**. Upstream answers 200 with the
  delivery price list rather than erroring, so silence here meant quoting delivery prices as
  pickup prices.
- Delivery and pickup cache separately — the mode is part of the request URL.

### Fixed — the voucher-subtraction trap

`foodpanda://voucher-codes` published bank codes with no way to know a vendor rejects them.
On 2026-07-30 that led to a real shortlist built with a flat PKR 200 deduction applied to
every candidate, at a vendor (Pizza Max Khayaban-e-Ittehad, `h0e2`) that accepts no vouchers
at all — two options were inside budget only because of a discount that did not exist.

- The resource now leads with a **`quotingRule`**: quote the menu price as the headline number,
  present a voucher only as a separate labelled upside, and never let an option fit a budget
  because a code was subtracted from it.
- A new **`eligibility`** field states plainly that per-vendor eligibility is not discoverable
  by this server or any endpoint, only at checkout, and that many vendors opt out.
- **`knownExclusions`** records vendors observed to reject codes, starting with `h0e2`.
- The resource points at pickup as the saving that *is* verifiable.
- `PRICING_NOTE`, returned with every menu and restaurant response, was upgraded from the
  passive "bank and voucher codes are not covered here" to an explicit instruction not to
  subtract an assumed one.
- README limitation 5 documents the same rule.

### Phase 0 — Payload inventory

- Added `docs/payload-inventory.md`: field-by-field inventory of the listing and
  vendor-detail upstream responses, captured live against the repro point. Confirms
  what's already fetched-and-discarded (phone, images, modifiers/toppings, address
  line 2) versus what needs a new request (order-mode parameter, darkstores/shop
  verticals), and root-causes all five Phase 1 bugs to exact lines.

### Phase 1 — Bug fixes

- **Fixed:** `search_menu_items` ranked by the stale listing-level delivery fee
  instead of the fresher, discount-reconciled fee from the vendor-detail response
  it already fetches — a vendor with an active "Free delivery" discount could be
  ranked as more expensive than it actually is.
- **Fixed:** dish search (`search_menu_items`, and `filterMenuItems`/`scoreMatch`
  generally) let a hit on a modifier word alone (e.g. "chicken") through with a
  reduced score instead of excluding it, so cheap unrelated items could outrank
  the actual dish once results are sorted by price. The final query token (the
  head noun, e.g. "biryani" in "chicken biryani") is now required for multi-word
  queries.
- **Fixed:** `find_deals`, `browse_by_cuisine`, `get_menu` and `search_menu_items`
  did not surface `Restaurant.url` even though it was already computed;
  `search_restaurants`, `get_restaurant` and `compare_restaurants` already had it.
  `get_menu` and `search_menu_items` gained a new `restaurantUrl` field.
- **Fixed:** a restaurant with `rating: 0` and zero reviews (a brand-new,
  unrated listing) rendered as "0.0★", indistinguishable from a genuinely
  badly-rated restaurant. Such restaurants now report `isUnrated: true` and
  omit `rating` instead; text output renders "unrated".
- **Fixed:** the bot-protection (HTTP 403) error message told callers to lower
  `FOODPANDA_RATE_LIMIT_RPS` / `FOODPANDA_MAX_CONCURRENCY` — server environment
  variables a hosted MCP client cannot set. Rewritten with advice the caller can
  act on directly.
- **Added:** a distinct, plain-English error for upstream's HTTP 400
  `ApiVendorDoesNotDeliverToAddressException` (a specific vendor cannot serve the
  given address), instead of a raw JSON slice of the upstream response.
- Caching, exponential backoff with jitter, per-host circuit breaking and request
  coalescing were already implemented before this phase (see
  docs/payload-inventory.md §11) and were not rebuilt.

### Added output fields (tool schema, additive/backward-compatible)

- `Restaurant`-shaped output: `isUnrated?: boolean` (search_restaurants,
  get_restaurant, compare_restaurants, find_deals, browse_by_cuisine); `url`
  (find_deals, browse_by_cuisine).
- `get_menu`: `restaurantUrl?: string`.
- `search_menu_items` hits: `restaurantUrl?: string`,
  `restaurantIsUnrated?: boolean`.

### Phase 2 — skipped by request

Not built in this pass: surfacing address/phone/images/modifiers on
`get_restaurant`/`get_menu`, the `orderMode` (pickup) parameter, and the
darkstores/shop verticals. `docs/payload-inventory.md` already documents
exactly what's fetched-and-discarded versus what needs a new request, so this
remains cheap to pick up later — nothing here required Phase 2 groundwork.

### Phase 3 — new capabilities

- **Added:** `export_data` tool — bulk-dumps `restaurants`, one restaurant's
  `menu`, or a `deals` list as a CSV or JSON text blob (`structuredContent.data`),
  for pasting into a spreadsheet or piping elsewhere. Returns the blob directly
  rather than writing to disk, since this server can run on a hosted/remote
  transport where a local file write wouldn't reach the caller. Row counts are
  capped (`limit`/`maxItems`) and truncation is reported honestly, matching the
  `scanComplete` pattern used elsewhere. New `src/domain/csv.ts` is a small
  hand-rolled encoder — no new dependency added for a handful of columns.
- **Added:** `foodpanda://voucher-codes` resource — HBL25 and ASKARI30, the two
  publicly known Pakistan bank promo codes, with their published terms and an
  explicit disclaimer that this is static reference content, not live API data
  (there is no voucher/promotions endpoint upstream). Documents the known
  inconsistency between foodpanda's own bank-deals page and Askari Bank's
  material (25% vs 30%) and a real observed 32.5% redemption, rather than
  presenting a single confident number.
- **Not built: review text.** Phase 0 found the reviews endpoint returning a
  bot-protection challenge; this phase re-verified with a single, isolated
  request and got a clean 404 (confirmed with two more probes). There is no
  reviews endpoint to build against — see `docs/payload-inventory.md` §3.
