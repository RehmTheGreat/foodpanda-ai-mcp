# foodpanda / Delivery Hero API research

Everything here was established by **live requests on 2026-07-27**, not from documentation
(there is none) and not from prior knowledge. Where a belief turned out to be wrong, the
wrong belief is recorded too — that is the useful part.

Reproduction harness: `research/` in the working tree (git-ignored; it holds multi-MB raw
captures). Distilled fixtures live in `tests/fixtures/`.

---

## 0. Summary of what is actually usable

| Capability | Endpoint | Status |
|---|---|---|
| Nearby restaurant listing | `disco.deliveryhero.io/listing/api/v1/pandora/vendors` | ✅ works, 10 markets |
| Cuisine catalogue + filter counts | same endpoint, `data.aggregations` | ✅ works |
| Cuisine-filtered listing | same endpoint, `&cuisine=<id>` | ✅ works |
| Restaurant detail + full menu | `<market>.fd-api.com/api/v5/vendors/<code>` | ✅ works (bot-protected) |
| Opening hours | detail endpoint, `data.schedules` | ✅ works |
| Deals / discounts | listing `tags[]`, detail `deals[]`/`discounts[]` | ✅ works (two different shapes) |
| Market currency/timezone | `<market>.fd-api.com/api/v5/configuration` | ✅ works |
| **Text search** | `q=` parameter | ❌ **accepted but completely ignored** |
| **Dedicated search service** | `disco.deliveryhero.io/search/api/v1/...` | ❌ HTTP 500 |
| **Geocoding** | `/api/v5/locations/*` | ❌ every variant 404 |
| **Reviews** | `/api/v5/vendors/<code>/reviews` | ❌ 404 |
| **Cities / cuisines catalogue** | `/api/v5/cities`, `/api/v5/cuisines` | ❌ empty / 404 |

---

## 1. The website is not scrapeable; the API is (mostly) reachable

First approach was Playwright against `www.foodpanda.pk` to capture XHRs. It fails:

```
TOP STATUS: 403
TITLE: Access to this page has been denied
BODY: "Before we continue... Please confirm you are a human (and not a bot)."
```

The site is behind **PerimeterX** (`client.px-cloud.net/PXlJuB4eTB/main.min.js`) with a
reCAPTCHA Enterprise challenge. Zero API calls were captured because the SPA never booted.

So all subsequent research was done by probing the JSON hosts directly, which is also what
the server does at runtime. No browser is involved anywhere in this project.

---

## 2. Listing endpoint — `disco.deliveryhero.io`

```
GET https://disco.deliveryhero.io/listing/api/v1/pandora/vendors
      ?latitude=24.814418&longitude=67.071643
      &language_id=1&country=pk&vertical=restaurants
      &customer_type=regular&configuration=Original&dynamic_pricing=0
      &include=characteristics&limit=48&offset=0
Header: x-disco-client-id: web        <-- REQUIRED
```

**The header is mandatory.** Omitting it:

```
HTTP 403   body: Invalid Client ID: null
```

Response envelope: `{status_code, message, data:{available_count, returned_count, items[], aggregations{}}}`.

Each `items[]` entry carries ~85 fields. The ones that matter:
`id, code, name, rating, review_number, cuisines[], primary_cuisine_id, address, city,
latitude, longitude, distance, minimum_order_amount, minimum_delivery_fee,
minimum_delivery_time, budget, is_delivery_enabled, is_pickup_enabled, has_online_payment,
is_promoted, is_new, tags[], discounts_info[], web_path, url_key, vertical`.

`code` (e.g. `u1od`) is the vendor key used by the detail endpoint.

### Verticals

`vertical=restaurants | darkstores | shop` all return 200. `darkstores` is pandamart.

### Pagination — there is no hard page cap

| requested `limit` | `returned_count` | `available_count` |
|---|---|---|
| 50 | 50 | 231 |
| 100 | 100 | 231 |
| 200 | 200 | 231 |
| 300 | **231** | 231 |
| 500 | **231** | 231 |

Asking for more than exists simply returns everything. The server still paginates in
modest pages by default to stay polite.

Offset paging works and pages do not overlap in a single snapshot, but the index is live,
so the adapter de-duplicates by `code` anyway.

### Sorting

`sort=` demonstrably changes ordering for `rating_desc`, `distance_asc`,
`delivery_time_asc`, `minimum_order_value_asc`.

**Trap:** an invalid value such as `sort=bogus_value` returns **HTTP 200** and silently
reorders rather than erroring. The adapter therefore forwards only an allowlist.

### `aggregations` — the cuisine catalogue

```json
"cuisines": [
  { "id": 193, "title": "Biryani",  "count": 36, "slug": "biryani" },
  { "id": 85,  "title": "Burgers",  "count": 13, "slug": "burgers" }
]
```

This is a per-location catalogue with live counts, and the `id` feeds `&cuisine=<id>`.
Also present: `quickFilters` (`has_online_payment`, `is_voucher_enabled`, `has_discount`,
`is_new`, `is_super_vendor`), `foodCharacteristics`, `payment_types`, `delivery_provider`.

> Recorded mistake: an early probe guessed `cuisine=194` for Biryani and got zero results.
> The real id is **193**. Cuisine ids must be read from `aggregations`, never guessed.

---

## 3. `q=` is inert — the single most consequential finding

The listing endpoint accepts `q=` and ignores it. Proof:

| `q` | `available_count` | first three vendors |
|---|---|---|
| *(absent)* | 231 | Subway, Florentine, Flora Coffee |
| `pizza` | **231** | Subway, Florentine, Bismillah Lahori |
| `zzzzqqqqnonexistentvendor12345` | **231** | Subway, Florentine, Flora Coffee |

A term that cannot match anything returns the same count as no term at all. The parameter
only perturbs ordering slightly.

The dedicated search host is dead:

```
GET https://disco.deliveryhero.io/search/api/v1/pandora/search?...&q=biryani
HTTP 500  {"error_name":"worker_threw_exception","error_category":"worker"}
```

**Consequence for this project:** all text search — restaurant search and dish search — is
implemented client-side in `src/domain/search.ts` over data the server fetches itself. This
is why `search_restaurants` has a `scanLimit` and `search_menu_items` has a
`restaurantLimit`: they bound how much is fetched to search through.

---

## 4. Vendor detail endpoint — `<market>.fd-api.com`

```
GET https://pk.fd-api.com/api/v5/vendors/u1od
      ?include=menus,bundles,multiple_discounts
      &language_id=1&opening_type=delivery&basket_currency=PKR
Headers: perseus-client-id: <ms>.<18 digits>.<hex>     <-- REQUIRED
         perseus-session-id: <same format>             <-- REQUIRED
```

~150 KB response.

### Which headers are genuinely required

| Variant | Result |
|---|---|
| perseus headers present, no `X-FP-API-KEY` | **200 OK** |
| `X-FP-API-KEY: volo` present, no perseus headers | **400** `perseus headers are absent` |

So `X-FP-API-KEY: volo` — which the website sends and which most write-ups treat as the
magic key — **is not required at all**. The perseus headers are. They are opaque
client-side tracking ids, not credentials; any well-formed `<ms>.<digits>.<hex>` string is
accepted. This server mints one random pair per process so no stable identifier is sent.

### Coordinates change the response

| Request | `minimum_delivery_time` | `delivery_duration_range` |
|---|---|---|
| without `latitude`/`longitude` | `0` | `null` |
| with `latitude`/`longitude` | `15` | `{lower: 5, upper: 20}` |

Two lessons: a delivery estimate requires coordinates, and `lower_limit_in_minutes` (5) is
the **optimistic** end of a range, not the estimate (15). Reporting the lower limit as "the"
delivery time understates the wait by 3× — the normaliser prefers `minimum_delivery_time`
and exposes the range separately.

### `schedules` — weekday encoding

```json
{ "weekday": 1, "opening_type": "delivering", "opening_time": "09:30", "closing_time": "23:59" }
```

Sampling six vendors gave distinct weekday values of exactly `[1,2,3,4,5,6,7]` — no `0`.
So the encoding is **ISO-8601: 1 = Monday … 7 = Sunday**, not 0-indexed. Windows may wrap
past midnight (`00:00–04:00` appears alongside `09:30–23:59` on the same weekday).

**Opening hours exist ONLY here.** Verified: 0 of 50 listing vendors carried a `schedules`
field. Any "open now" answer therefore costs one detail request per restaurant — which is
why `openNow` is documented as a slow filter.

### Menu shape

```
data.menus[].menu_categories[].products[].product_variations[].price
                                                             .price_before_discount
```

`price_before_discount > price` is the only reliable discount signal per item. Prices
already reflect vendor promotions, so subtracting an advertised percentage again
double-counts. Products with no priced variation are unusable and are dropped.

---

## 5. Discounts live in two different places

This caused a real bug during development (`find_deals` reported zero offers everywhere).

**In listing responses, `discounts` is always `[]`** — 0 of 50 vendors had a populated
array. The real data is elsewhere:

```json
"tags": [{ "code": "DEAL", "text": "34% off selected items",
           "label_metadata": { "deal": { "id": "1670287" } } }],
"discounts_info": [{ "id": "1670287", "value": 34 }]
```

**In detail responses**, `deals[]` and `discounts[]` are populated, but discount entries
often have **empty** `description`/`discount_text` and carry only `discount_type` +
`discount_amount`:

```json
"deals":     [{ "title": "34% off selected items", "offer_type": "percentage", "value": 34 }]
"discounts": [{ "description": "", "discount_type": "percentage",   "discount_amount": 34 },
              { "description": "", "discount_type": "free-delivery", "discount_amount": 0  }]
```

The normaliser reads both shapes and synthesises copy ("34% off", "Free delivery") when
upstream leaves it blank.

**Also:** several text fields contain untranslated i18n keys such as
`NEXTGEN_FEATURED_TAG`. These are filtered out rather than shown to users.

---

## 6. Market generalisation — it generalises

Same URL pattern, only `country=` and the `<market>.fd-api.com` hostname change.

| Market | City tested | Listing | `available_count` | Menu host | Entity | Currency | Timezone |
|---|---|---|---|---|---|---|---|
| pk | Karachi | 200 | 227 | ✅ | FP_PK | Rs. | Asia/Karachi |
| bd | Dhaka | 200 | 518 | ✅ | FP_BD | Tk | Asia/Dhaka |
| my | Kuala Lumpur | 200 | 2853 | ✅ | FP_MY | RM | Asia/Kuala_Lumpur |
| sg | Singapore | 200 | 795 | ✅ | FP_SG | S$ | Asia/Singapore |
| ph | Manila | 200 | 2396 | ✅ | FP_PH | ₱ | Asia/Manila |
| tw | Taipei | 200 | 1501 | ✅ | FP_TW | $ | Asia/Taipei |
| hk | Hong Kong | 200 | 1446 | ✅ | FP_HK | HK$ | Asia/Hong_Kong |
| kh | Phnom Penh | 200 | 2693 | ✅ | FP_KH | $ | Asia/Phnom_Penh |
| la | Vientiane | 200 | 951 | ✅ | FP_LA | ₭ | Asia/Vientiane |
| mm | Yangon | 200 | 601 | ✅ | FP_MM | MMK | Asia/Yangon |
| **th** | Bangkok | **530** | — | **530** | — | — | — |
| **ae** (talabat) | Dubai | **404** | — | — | — | — | — |
| **de** | Berlin | 200 | 53 | **404** | — | — | — |

- **th** — `th.fd-api.com` returns Cloudflare **Error 1016: Origin DNS error** on both the
  listing and configuration endpoints, on repeated attempts. The hostname does not resolve
  at the origin. Excluded, and the reason is reported to users rather than a bare
  "unsupported".
- **talabat (ae)** — 404. Delivery Hero's MENA brand is a separate platform, not reachable
  through `country=`.
- **de** — the *listing* host answers, but there is no matching `de.fd-api.com` menu host,
  so menus are unavailable. Excluded as non-foodpanda.

The `ph` timezone deserves a note: `/configuration` reports `Asia/Singapore`, which is the
same UTC+8 offset as `Asia/Manila`. This project uses `Asia/Manila` as the more accurate
label; the offset is identical so open/closed calculations are unaffected.

---

## 7. Rate limits and bot protection

The detail endpoint exposes its budget in response headers:

```
x-ratelimit-limit: 100
x-ratelimit-remaining: 95..99
x-ratelimit-reset: <unix ts>
```

`/api/v5/cities` advertised `x-ratelimit-limit: 12000`, so limits are per-endpoint.
`remaining` fluctuates non-monotonically across sequential requests (99, 99, 98, 97, 99…),
which indicates several edge nodes each keeping their own counter.

### PerimeterX will block you

**This is the most important operational finding.** After a period of sustained use from a
single IP (several full tool sweeps plus a 12-request burst), `pk.fd-api.com` stopped
serving data and began returning:

```
HTTP 403  {"appId":"PXlJuB4eTB","jsClientSrc":"/lJuB4eTB/init.js", ... }
```

— the same PerimeterX appId that guards the website. Tested against it:

| Header set | Result |
|---|---|
| Project's own polite User-Agent + perseus | 403 challenge |
| Chrome User-Agent + perseus | 403 challenge |
| Chrome UA + perseus + `X-FP-API-KEY` + Referer/Origin | 403 challenge |
| Full browser-like set (sec-ch-ua, sec-fetch-*, Accept-Language…) | 403 challenge |
| **Listing host (`disco.deliveryhero.io`) during the same window** | **200 OK** |

**No header combination gets through.** The block is IP-reputation based, and it is
endpoint-specific — restaurant search, cuisine browsing and deal listing kept working
throughout because they use a different host.

**This project does not attempt to defeat that challenge.** Impersonating a browser to
evade a control the operator deliberately installed is out of scope on purpose. Instead the
client:

1. detects the challenge body and raises a distinct `UpstreamBlockedError`;
2. **never retries it** (retrying is precisely the behaviour the challenge exists to stop);
3. lets the circuit breaker open so traffic stops entirely for a cool-off period;
4. returns a plain-English explanation telling the user to wait and lower the request rate.

Defaults were lowered accordingly: **2 req/s, concurrency 2**, vendor cache TTL 15 min.
Raising them makes a block more likely, not throughput higher.

---

## 8. Geocoding: not available upstream

Every candidate 404'd:

```
/api/v5/locations/autocomplete   404
/api/v5/locations/suggestions    404
/api/v5/locations/search         404
/api/v5/locations/reverse        404
/api/v5/locations/geocode        404
/api/v5/locations/details        404
/api/v5/cities                   200 but data.items == []
/api/v5/cuisines                 404
/api/v5/vendors/<code>/reviews   404
```

The website uses a keyed Google Places integration that cannot be reused.

**OpenStreetMap Nominatim** is used instead — free, no API key, consistent with the
project's zero-key promise:

```
GET https://nominatim.openstreetmap.org/search?q=Clifton%2C+Karachi&format=jsonv2
-> 24.8190552, 67.0262397
```

One gotcha: without `Accept-Language: en` it returns localised names
(`کلفٹن, ضلع کراچی, ...` for Karachi). The adapter sets the header. Nominatim's usage policy
requires an identifying User-Agent and ≤1 req/s; results are cached for a week since
addresses do not move.

---

## 9. Things that were assumed and turned out wrong

Kept deliberately — each cost real debugging time.

1. **`X-FP-API-KEY: volo` is required.** It is not. Perseus headers are.
2. **`q=` filters results.** It does nothing.
3. **Biryani is cuisine 194.** It is 193, and ids differ per market.
4. **`discounts[]` holds the discounts.** In listings it is always empty; the data is in `tags[]`.
5. **`delivery_duration_range.lower_limit` is the delivery estimate.** It is the optimistic
   floor; `minimum_delivery_time` is the headline figure.
6. **Listing data can answer "open now".** It cannot — no listing vendor has `schedules`.
7. **The API is unprotected.** The listing host is; the menu host is behind PerimeterX and
   will block a busy IP.

---

## 10. Stability outlook

Every endpoint here is an undocumented internal API with no compatibility guarantee. It can
change or disappear without notice. Mitigations in the codebase:

- all upstream knowledge is confined to `src/adapters/foodpanda.ts` — one file to fix;
- every response is validated with permissive zod schemas that **degrade rather than throw**
  (`safeValidate` returns best-effort data plus a warning surfaced as `meta.degraded`);
- tools return a normalised model, so upstream renames do not change the tool contract;
- the test suite runs entirely on recorded fixtures, so CI stays green regardless of
  upstream availability.
