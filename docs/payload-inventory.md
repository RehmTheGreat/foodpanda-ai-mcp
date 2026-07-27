# Payload inventory — Phase 0

Captured live on 2026-07-28 against the repro point (lat 24.814422, lng 67.070805,
Sehar Commercial, DHA Phase 7, Karachi, market `pk`). Raw captures live in
`research/out/` (git-ignored, multi-MB — regenerate with `node research/dump.mjs`).
This distills what each response actually contains, field by field, and which of
those fields the server currently keeps versus discards.

Everything below was read from a live response, not inferred. Where this updates or
contradicts `docs/API-RESEARCH.md` (written 2026-07-27), the delta is called out.

---

## 0. How to read this document

For each field: **upstream name** → **type** → **example** → **currently surfaced?**
("yes" = reaches a tool's output today; "no (discarded)" = present in the raw
payload the adapter already receives, courtesy of the `.passthrough()` zod schemas
in `src/domain/schemas.ts`, but dropped in `src/domain/normalize.ts` or in the
tool's own output mapping; "no (new request)" = would need an endpoint we don't
currently call).

## 1. Listing endpoint — `disco.deliveryhero.io/listing/api/v1/pandora/vendors`

`vertical=restaurants`, repro point, `limit=300`: **184 vendors, `available_count`
184** (down from 227 on 2026-07-27 — this endpoint reflects live, time-of-day
availability; see §7).

### Per-item fields (full list from a captured item, `u1od` / Subway)

| Field | Type | Example | Surfaced? |
|---|---|---|---|
| `id`, `code`, `name` | number/string | `14615`, `"u1od"`, `"Subway - Sehar Commercial Ave"` | yes |
| `address` | string | `"34-C Rahat Lane 3, Phase 6, DHA Karachi"` | yes |
| **`address_line2`** | string | `"Building 12C Shop 1 Main Seher Commercial Avenue DHA Phase 7."` | **no (discarded)** — often the more specific line |
| `post_code` | string | `"75500"` | no (discarded) |
| `city.name` | string | `"Karachi"` | yes |
| `latitude`, `longitude` | number | `24.808714`, `67.068512` | yes |
| `distance` | number (km) | `0.676` | yes → `distanceKm` |
| **`hero_image`**, `hero_listing_image` | string (URL) | `https://images.deliveryhero.io/image/fd-pk/LH/u1od-listing.jpg` | **no (discarded)** — restaurant hero photo |
| **`logo`** | string (URL) | `https://images.deliveryhero.io/image/fd-pk/pk-logos/cz0ks-logo.jpg` | **no (discarded)** — can be `""` |
| **`customer_phone`** | string | (present on detail, absent from this listing item — see §2) | **no (discarded on detail)** |
| **`chain`** | object | `{code:"cz0ks", name:"Subway -  South ", main_vendor_code:"t1gt", url_key:"subway-south"}` | **no (discarded)** — franchise grouping |
| `rating`, `review_number` | number | `4.6`, `8788` | yes, but see §5 (Bug 4) |
| `cuisines[]` | array | `[{id,name,url_key,main}]` | yes → names only, `main` flag discarded |
| `primary_cuisine_id` | number | `71` | yes |
| `budget` | number 1-3 | `2` | yes → `budgetTier` |
| `minimum_order_amount`, `minimum_delivery_fee`, `minimum_delivery_time` | number | `249`, `99`, `45` | yes |
| `minimum_pickup_time` | number | `15` | **no (discarded)** — pickup-mode timing exists on listing too |
| `is_delivery_enabled`, `is_pickup_enabled` | bool | `true`, `true` | yes |
| **`metadata.is_pickup_available`, `.is_dine_in_available`, `.is_temporary_closed`, `.is_flood_feature_closed`, `.is_express_delivery_available`** | bool | see §6 | **no (discarded)** — richer availability signal than the top-level flags |
| `has_online_payment`, `is_promoted`, `is_new` | bool | `true`, `false`, `false` | yes |
| `tags[]` (code `DEAL`), `discounts_info[]` | array | `[{code:"DEAL",text:"34% off selected items",label_metadata:{deal:{id:"1670287"}}}]` | yes (this is the only listing-level discount source — `discounts[]` is always `[]` on listing, confirmed again this run) |
| `web_path` / `redirection_url` | string (absolute URL) | `https://foodpanda.pk/restaurant/u1od/subway-sehar-commercial-ave` | yes → `Restaurant.url` (see §4, Bug 3) |
| `vertical`, `vertical_segment`, `vertical_parent` | string | `"restaurants"` | `vertical` yes, other two discarded |
| `is_active` | bool | `true` | **no (discarded)** — distinct from `is_temporary_closed`; see §7 |
| `vendor_legal_information.legal_name` | string | `"F AND S VENTURES"` | no (discarded) — legal entity, not a phone number |
| `is_vat_included_in_product_price`, `is_service_fee_enabled`, `vat_percentage_amount`, `service_fee_percentage_amount` | bool/number | `true`, `false`, `0`, `0` | yes → `Fees` |
| `is_new_until` | ISO datetime | `"2022-12-30T00:00:00Z"` | no (discarded) — could sharpen the `isNew` signal |

**No restaurant `phone` field exists on the listing item.** It appears only on
the detail payload (`customer_phone`, see §2).

## 2. Vendor detail endpoint — `<market>.fd-api.com/api/v5/vendors/<code>`

Superset of the listing item's fields (same names, e.g. `address`, `hero_image`,
`chain`) plus:

| Field | Type | Example | Surfaced? |
|---|---|---|---|
| **`customer_phone`** | string | `"+922137240861"` | **no (discarded)** — confirms restaurant phone exists, contrary to it being absent project-wide |
| `location` | string | `""` (empty on every vendor sampled) | n/a — no extra geo data beyond top-level `latitude`/`longitude` |
| `original_delivery_fee`, `delivery_fee_source` | number, string | `0`, `"dps"` | no (discarded) — `delivery_fee_source` explains *why* a fee is what it is (dynamic pricing service) |
| `deals[]`, `discounts[]` | array | see §4 (Bug 1) | yes |
| **`toppings`** | object, keyed by topping-group id | `{"25349638": {id, name:"Choose Your Bread 1", quantity_minimum:1, quantity_maximum:1, options:[{id,name,price,is_sold_out}], type:"choice-group"}, ...}` | **no (discarded)** — this is the modifier/add-on/variant-group data Phase 0 asked about |
| `product_variations[].topping_ids[]` | array of numbers | `[25349790, 25867111, ...]` | **no (discarded)** — the per-item link into `toppings` above |
| `product.images[]`, `images_urls[]`, `logo_path` | array/string (URL) | `images[0].image_url = "https://images.deliveryhero.io/.../6c5e97db....jpg"` | partially — only `file_path` is read today (with its `%s` width placeholder substituted); `images[]`/`images_urls` are richer (multiple sizes/angles) and discarded |
| `product.additives`, `dietary_attributes`, `is_alcoholic_item`, `is_prepacked_item`, `sold_out_options[]` | various | mostly empty in this sample | no (discarded), low value observed so far |
| `schedules[]` | array | as documented in API-RESEARCH.md §4 | yes |
| `special_days`, `time_picker`, `order_flow` | various | not populated in samples | no (discarded), unclear value |

### `include=` completeness check

The adapter requests `include=menus,bundles,multiple_discounts`. `bundles` and
`multiple_discounts` were requested but not inspected for extra fields in this
pass — worth a follow-up capture if Phase 3 wants combo/bundle pricing.

## 3. Reviews — re-verified, and the finding has changed

`docs/API-RESEARCH.md` (2026-07-27) says `/api/v5/vendors/<code>/reviews` → `404`.
A fresh request today, made immediately after 5 vendor-detail fetches in this same
run, returned **HTTP 403 with a genuine PerimeterX challenge page** (`_pxAppId:
"PXlJuB4eTB"`), not a clean 404. Given D11/CONTRIBUTING.md's rule to verify
live rather than infer: this endpoint sits behind the **same bot protection as the
rest of the menu host**, and the request volume in this Phase 0 run was enough to
trigger it — a real, reproducible instance of Bug 5's premise. Whether the *route*
itself would 404 on a fresh, unthrottled IP is now unknown; the honest statement is
"blocked, not confirmed absent." Given the project's stated scope boundary
(DECISIONS D11, CONTRIBUTING.md), this does not change the Phase 3 recommendation
to skip review-text scraping unless a clean, unblocked capture proves the route
actually returns data.

## 4. Bug 1 — delivery-fee-vs-discount reconciliation, confirmed at the field level

Fresh detail fetches for both named vendors:

| Vendor | `minimum_delivery_fee` (detail) | active `discounts[]` entry |
|---|---|---|
| `c1tf` Lasani Biryani Centre | `0` | `{discount_type:"free-delivery", discount_amount:0, start_date:"2026-07-27", end_date:"2027-07-27"}` |
| `uche` Lasani Halwa Poori & Biryani Centre | `0` | same free-delivery entry |

So the vendor DETAIL response — which `search_menu_items` already fetches per
candidate at `src/tools/menus.ts:307` (`const { menu, restaurant } =
await ctx.foodpanda.getVendorDetail(...)`) — already carries the reconciled,
correct fee (`0`). The bug is that the ranking code at lines 328/331 reads
`r.deliveryFee` (`r` is the **listing**-sourced candidate from the outer
`candidates` array) instead of `restaurant.deliveryFee` (the **detail**-sourced,
freshly-fetched object sitting right there in scope). This is a one-file,
few-line fix in Phase 1, not a new-data problem — confirms the bug report's own
suspected cause exactly.

Side note: neither `c1tf` nor `uche` appeared in today's 184-vendor listing scan at
all (`uche`'s detail payload shows `metadata.is_temporary_closed: true`; `c1tf`
shows `false` but may simply be outside today's live serviceable window — listing
membership is time-of-day dependent, see §7). Both remain directly fetchable by
code. Fixtures for the regression test should freeze today's captured detail
JSON rather than depend on live listing membership.

## 5. Bug 4 — 0.0★, confirmed at the field level

`wtah` (Naseeb Biryani Chicken Pulao and Pakwan Center - Phase 7): `rating: 0`,
`review_number: 0`, `is_new_until: "2026-09-07T23:04:18Z"` (a future date — genuinely
a new, unrated listing, not a badly-rated one). `src/domain/normalize.ts:294-297`
sets `r.rating = rating` whenever `n(v?.rating)` is not `undefined` — `0` passes
that check — so `wtah` gets `rating: 0` in the domain model, and
`src/tools/format.ts:20` renders `if (r.rating !== undefined) ... '0.0★'`
unconditionally. `sortRestaurants`'s `rating` case (`src/domain/search.ts:140`)
then treats it as a genuine 0, sorting it to the bottom rather than excluding it.
Fix is entirely in `normalizeRestaurant`: only set `rating` when `reviewCount > 0`.

## 6. Order-mode parameter (`opening_type`) — confirmed meaningful

Diffed `opening_type=delivery` vs `opening_type=pickup` on `u1od`:

| Field | `delivery` | `pickup` |
|---|---|---|
| `minimum_delivery_time` | `15` | `0` |
| `minimum_pickup_time` | `0` | `15` |
| `delivery_duration_range` | `{lower:5, upper:20}` | `null` |
| `pickup_duration_range` | `null` | `{lower:5, upper:20}` |
| `deals.length` / `discounts.length` | `2` / `2` | `1` / `1` |

So `opening_type` genuinely switches which timing fields populate and which
deals/discounts apply — pickup-only or delivery-only promos exist. `collection`
was also tried and behaves identically to `delivery` in this sample (same fee/time
numbers), so the two real modes are `delivery` and `pickup`. This confirms Phase
2's `orderMode` idea is meaningful and cheap: same endpoint, one query param.

Also tried: `vertical=darkstores` (returns Pandamart — the grocery/pandamart
vertical, confirmed present, 1 nearby result today) and `vertical=shop` (returns
other retail, e.g. a vape shop, 9 nearby). Both use the **identical schema** to
`vertical=restaurants`, so `normalizeRestaurant`/`UpstreamVendorSchema` need no
changes to support them — only a passthrough `vertical` parameter on the
listing-facing tools (already a typed option on `ListingParams`, just not exposed
on `search_restaurants` / `find_deals` / `browse_by_cuisine` inputs today).

## 7. New observation not in the original bug list: `is_active` vs `is_temporary_closed`

The listing item carries a top-level `is_active` (structural — is this vendor
provisioned at all) distinct from `metadata.is_temporary_closed` (operational —
closed right now, e.g. for the day). Neither is surfaced today. Worth folding into
Phase 2's availability work alongside `orderMode`, since "not in the listing scan
at all" (§4's `c1tf`/`uche` gap) is otherwise unexplained to a caller.

## 8. `s5gf` (deeplink example from Bug 3) — real API error, not a bot block

`GET /api/v5/vendors/s5gf` with the repro coordinates returned **HTTP 400**:
`{"exception_type":"ApiVendorDoesNotDeliverToAddressException", "error":"The
restaurant cannot deliver to your selected address. Please try another one"}`.
This is upstream telling us the vendor exists but does not serve this exact point
today — a legitimate, distinct-from-bot-block error shape that
`src/http/client.ts` currently folds into the generic `UpstreamError` (400 is not
in `RETRYABLE_STATUS`, so it isn't retried, but the message shown to a caller is
the raw upstream JSON slice, not a plain-English "this restaurant doesn't deliver
here" explanation). Worth a distinct error branch alongside `UpstreamBlockedError`
in Phase 1's Bug 5 work.

## 9. Bug 3 (deeplinks) — status is "partially already fixed"

`Restaurant.url` is already computed by `vendorUrl()` in `normalize.ts` (D20) and
already flows into tool output for **`search_restaurants`, `get_restaurant`,
`compare_restaurants`** via the shared `slim()`/`restaurantShape` in
`src/tools/restaurants.ts`. It does **not** reach:
- `find_deals` and `browse_by_cuisine` (`src/tools/discovery.ts`) — both hand-roll
  their own output object and never read `r.url`.
- `get_menu` and `search_menu_items` (`src/tools/menus.ts`) — neither includes the
  restaurant's `url` in their output at all (`MenuItemHit` has no `url` field in
  `src/domain/types.ts` either).

So Phase 1's Bug 3 acceptance criteria reduce to: add `url` to `MenuItemHit`, wire
it through in `menus.ts`, and read `r.url` in `discovery.ts`'s two hand-rolled
mappers — no new normalization logic needed, the field already exists on every
`Restaurant` object these tools already hold.

## 10. Fees/deals/discounts (Phase 2 "surface what we fetch" candidates already done)

`fees`, `deals`, `discounts` with full numbers are already implemented (D21) and
already reach `get_restaurant` and `get_menu`. Not re-litigated here.

## 11. What Bug 5's infrastructure already covers vs. what's still missing

Read `src/http/client.ts`, `circuitBreaker.ts`, `cache/memory.ts`, `config.ts`
before assuming Phase 1 needs to build this from scratch:

| Bug 5 ask | Already exists? |
|---|---|
| In-process cache keyed by (market, code), short TTL | **Yes** — `HttpClient.getJson` caches by URL when `ttlSeconds > 0`; vendor detail defaults to `CACHE_TTL_VENDOR_S=900` (15 min), listing to `120`. Also request **coalescing**: identical concurrent GETs share one in-flight promise. |
| Exponential backoff with jitter, bounded retries on 403/429 | **Partially** — full-jitter exponential backoff on retryable statuses exists (`execute()`, capped at 8s, `FOODPANDA_MAX_RETRIES=3`). But a `403` that `looksLikeBotChallenge()` is explicitly *never* retried (`UpstreamBlockedError`, deliberate per D11) — so "retry on 403" as literally requested would contradict the project's own no-evasion stance. `429` (plain rate-limit, not a bot challenge) already retries. |
| Shared request budget across tools | **Partially** — a per-host `CircuitBreaker` (`breakerThreshold=5` failures trips it) already acts as a shared circuit for the whole process, and the `RateLimiter` is one shared instance. There is no explicit per-call "budget" concept (e.g. a high `restaurantLimit` reserving/spending a token pool), so a single greedy call can still be the one that trips the shared breaker for everyone after it. |
| Rewrite the 403 error text to be caller-actionable | **No** — `UpstreamBlockedError`'s message (`src/http/client.ts:30-36`) still says "lower FOODPANDA_RATE_LIMIT_RPS and FOODPANDA_MAX_CONCURRENCY", which are server env vars a hosted MCP client cannot set. This is the one clearly-still-open item; everything else in Bug 5 is tuning/wording on top of existing infrastructure, not new plumbing. |

---

## Summary for Phase 1/2 scoping

Confirmed **already fetched, just discarded** (Phase 2, cheap — no new requests):
`address_line2`, `post_code`, `hero_image`/`hero_listing_image`/`logo` (restaurant
images), `customer_phone`, `chain`, `metadata.is_temporary_closed` and siblings,
`toppings` + `topping_ids` (modifiers/variants), richer `product.images[]`,
`original_delivery_fee`/`delivery_fee_source`, `is_active`, `is_new_until`.

Confirmed **needs a new/adjusted request** (Phase 2, costed):
- `orderMode` (`opening_type=pickup`) — one extra query param per detail call, no
  new endpoint. Cheap.
- `vertical=darkstores`/`shop` — same endpoint, same schema, just a parameter the
  tools don't expose yet. Cheap.
- Reviews — endpoint is bot-protected (§3); recommend not building this in Phase 3
  without a clean capture proving it ever returns data unblocked.

Confirmed **Phase 1 bugs, root-caused to exact lines**: Bug 1 (`menus.ts:328,331`),
Bug 2 (`search.ts` `scoreMatch`, needs head-noun handling), Bug 3 (`discovery.ts`
mappers + `MenuItemHit`, §9), Bug 4 (`normalize.ts:294-297`), Bug 5 (mostly
wording + one new error branch for `ApiVendorDoesNotDeliverToAddressException`,
§8/§11).
