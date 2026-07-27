# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Version numbers and the actual
release cut (npm publish, git tag, GitHub release) happen once per
[docs/RELEASING.md](docs/RELEASING.md), not per phase — this section accumulates
until then.

## [Unreleased]

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
