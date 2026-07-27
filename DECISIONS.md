# Decisions

Every non-obvious choice made while building this, with the reasoning and the evidence.
Written as the work happened, newest section last.

---

### D1 — Research before design, and treat prior notes as hypotheses

Two candidate endpoints were known going in. They were still re-verified with live requests
before a line of server code was written, and one belief turned out to be wrong
(`X-FP-API-KEY` is not required; the perseus headers are). Everything in
[docs/API-RESEARCH.md](docs/API-RESEARCH.md) is backed by a request made on 2026-07-27.

### D2 — Browser capture abandoned in favour of direct API probing

`www.foodpanda.pk` is behind PerimeterX and returns 403 + captcha to Playwright, so no XHRs
could be captured. Since the target was the JSON API rather than the page, probing the API
hosts directly was both more reliable and closer to what the server actually does. The
project ships with no browser dependency at all.

### D3 — Build it multi-market, Pakistan by default

The brief said to make it global only if a market parameter generalises. It does: the same
URL pattern works across **10 markets** with only `country=` and the `<market>.fd-api.com`
hostname changing (matrix in the research doc). Thailand is excluded with a stated reason
(origin DNS failure) rather than silently omitted, and talabat is excluded because it is a
different platform (404). Default market is `pk`.

### D4 — `@modelcontextprotocol/sdk@1.29.0`, not the 2.x beta

context7 surfaced a v2 API (`@modelcontextprotocol/server`, `serveStdio`) alongside v1.
npm shows `@modelcontextprotocol/sdk` at `latest = 1.29.0` while the v2 packages are
`2.0.0-beta.5` — beta only. The brief asked for a production-grade server on the official
SDK, so v1.29.0 it is. Note the v1 API takes a **raw zod shape** for `inputSchema`, not a
`z.object(...)`.

### D5 — the project is named `foodpanda-ai-mcp`, repo and package alike

The obvious name, `foodpanda-mcp`, is **already taken** on npm (v1.2.1, by John Carlo Joyo —
a PH-only server that performs authenticated *ordering*). Different project, genuinely
different scope, but the name is spoken for.

`foodpanda-ai-mcp` is free, so the GitHub repository and the npm package share it. That keeps
one name for the whole project and makes `npx foodpanda-ai-mcp` work directly, with no scope
prefix, no `-server` suffix and no possibility of being confused with the unrelated package.
A single binary is installed, `foodpanda-ai-mcp`; no alias is registered under the other
project's name.

### D6 — Text search is implemented client-side

Forced, not chosen. The upstream `q=` parameter is **inert**: `q=pizza` and
`q=zzzzqqqqnonexistentvendor12345` both return the identical `available_count` of 231, and
the dedicated search host 500s. So `search_restaurants` and `search_menu_items` fetch a
bounded set of nearby restaurants and rank locally. Consequences are exposed honestly in the
tool descriptions and via `scanLimit` / `restaurantLimit` parameters rather than hidden.

### D7 — Geocoding via OpenStreetMap Nominatim

Every `/api/v5/locations/*` path 404s; foodpanda's own address lookup is a keyed Google
Places integration. Nominatim needs no API key, which preserves the "works with zero
config" requirement. It is used only to turn an address into coordinates — all restaurant
data still comes from foodpanda. Cached for a week, `Accept-Language: en` set (without it,
Karachi comes back in Urdu script).

### D8 — Sort values are allowlisted

Upstream returns **HTTP 200** for `sort=bogus_value` and silently reorders. Passing user
input straight through would produce quietly wrong results, so the adapter forwards only the
four values proven to work.

### D9 — Open/closed is computed locally, and costs extra requests

Opening hours exist only on the detail endpoint: **0 of 50** listing vendors carried a
`schedules` field. The first implementation filtered `openNow` against listing data and
therefore returned zero results every time — a real bug caught by the live smoke test.

Fixed by an explicit enrichment pass (`src/tools/enrich.ts`) that fetches detail for a
bounded number of top candidates before applying the filter. `openNow` is documented as slow
and bounded by `openNowCheckLimit`. In `search_menu_items` the filter is free, because that
tool already fetches each candidate's detail.

Status is computed with `Intl.DateTimeFormat` in the market's timezone — no date library.
Weekdays are ISO 1–7, verified empirically (values `[1..7]`, no `0`).

### D10 — One shared `meta` schema

Two tools initially declared their own `meta` output shape that omitted `currencySymbol`.
Because zod-derived JSON Schema sets `additionalProperties: false`, the SDK rejected valid
responses at runtime (`data/meta must NOT have additional properties`). There is now a
single exported `metaShape` used by every tool, so the schema cannot drift from `buildMeta()`.

### D11 — Bot protection is detected and respected, never circumvented

Partway through live testing the menu host began returning PerimeterX 403 challenges to this
IP. Four header profiles were tested, up to a full browser-like set — **none** got through;
the block is IP-reputation based. The listing host was unaffected throughout.

Deliberate decision: **do not attempt to evade it.** Defeating a bot challenge would mean
impersonating a browser to bypass a control the site operator installed on purpose. Instead
the client detects the challenge, raises a distinct `UpstreamBlockedError`, **never retries
it**, lets the circuit breaker stop traffic, and returns a plain-English explanation. Default
rate limits were lowered to **2 req/s / concurrency 2** and the vendor cache TTL raised to
15 minutes to reduce the chance of triggering it at all.

This is also why the tool set is designed so the most common questions (search, cuisines,
deals) are answerable from the listing host alone.

### D12 — Tests run on recorded fixtures, never the network

`tests/setup.ts` replaces global `fetch` with one that throws, so a test that reaches the
internet fails loudly. Fixtures are distilled from real captures (`tests/fixtures/`), so the
suite validates against genuine upstream shapes — including a real captured PerimeterX
challenge body used to test block detection. The suite is therefore green offline, in CI, and
regardless of whether foodpanda is up or this IP is rate-limited. 117 tests.

### D13 — De-duplicate paginated results

Offset paging over a live, reordering index can return the same vendor twice. `listAllVendors`
de-duplicates by `code` and stops when a page contributes nothing new, which also removes the
possibility of looping forever against a non-advancing upstream.

### D14 — HTTP sessions are reaped on a timer

A client that crashes or closes its socket never sends `DELETE /mcp`, so its session would
leak a transport and an `McpServer` for the process lifetime. Verified during the HTTP smoke
test (`sessions after close: 1`). Idle sessions are now swept every 60s with a 30-minute
timeout; explicit DELETE is also verified to free the session immediately.

### D15 — Deploy targets: Docker, Railway, Render, Fly.io — not Cloudflare Workers or Vercel

The brief asked for Docker plus at least two of Workers/Railway/Render/Fly/Vercel.
Railway, Render and Fly.io are all included because they run a long-lived Node process,
which is what a stateful streamable-HTTP MCP server needs.

**Cloudflare Workers is deliberately excluded**: this server uses Express and a long-lived
in-process session map, neither of which fits the Workers runtime without a rewrite around
Durable Objects. Shipping a `wrangler.toml` that does not actually work would be worse than
omitting it. **Vercel** is excluded for the same reason — its serverless functions do not
hold the in-memory session state that streamable HTTP sessions require. Both are noted in the
README rather than half-supported.

### D16 — Docker image is built and run in CI, not on this machine

Docker is not installed on the build machine, and installing Docker Desktop is a multi-GB
install that the machine's owner has asked to be consulted about first. Rather than skip the
requirement, the CI workflow builds the image **and runs it**, asserting the container starts
and answers `/health`. So the Dockerfile is genuinely verified on every push — just on
GitHub's runners rather than locally. This is stated plainly in the final report rather than
claimed as a local verification.

### D17 — npm publish is prepared, not performed

`npm whoami` returns `ENEEDAUTH` and there is no `~/.npmrc` or stored npm token on this
machine. Per the brief, everything is prepared (package metadata, `files`, `bin`, `exports`,
`prepublishOnly`, `publishConfig.access`) and the publish is left as a single documented
command for the owner to run.

### D18 — Registry manifests target the current schemas

`server.json` follows the MCP registry schema
(`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`) with a
reverse-DNS name under the publisher's GitHub namespace, `io.github.rehmthegreat/foodpanda-ai-mcp`.
`smithery.yaml` uses the stdio `commandFunction` form. Both were written against the current
published schemas rather than from memory.

### D19 — Renamed to `foodpanda-ai-mcp` before first publish

The project was originally pushed as repo `foodpanda-mcp` with the package name
`foodpanda-mcp-server`, then renamed at the owner's request.

Because nothing had been published to npm yet, the rename was free and worth taking further
than the repository: the npm name `foodpanda-ai-mcp` was available, so repo and package now
share one name. That is strictly better than the original split — `npx foodpanda-ai-mcp`
works with no suffix, and there is no longer any binary registered under a name belonging to
the unrelated `foodpanda-mcp` package.

Renamed everywhere in one pass: package and binary names, repository URLs, the MCP registry
identifier (`io.github.rehmthegreat/foodpanda-ai-mcp`), Docker image tags and compose service,
Fly and Render app names, the server's `SERVER_NAME` and User-Agent, and every README config
block. The two documented references to the *other* project's `foodpanda-mcp` npm package were
deliberately left intact, since renaming those would have falsified the history.

GitHub redirects the old repository URL, so existing links keep working. The npm badge and
install instructions point at the new name, which is the one that will be published.
