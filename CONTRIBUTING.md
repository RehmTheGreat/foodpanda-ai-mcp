# Contributing

Thanks for considering a contribution.

## Ground rules

This project is **read-only by design**. Pull requests that add ordering, authentication,
account access, payments, or any write action against foodpanda will be closed regardless of
quality. The same goes for anything that tries to **circumvent bot protection** — browser
impersonation, challenge solving, proxy rotation, CAPTCHA bypass. That boundary is the point
of the project, not an oversight. See [DECISIONS.md](DECISIONS.md#d11).

## Getting set up

```bash
git clone https://github.com/RehmTheGreat/foodpanda-mcp.git
cd foodpanda-mcp
npm install
npm run verify     # lint + typecheck + test
```

Node 20 or newer.

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | Everything CI runs: lint, typecheck, tests |
| `npm test` | Vitest suite (offline — no network) |
| `npm run build` | Compile to `dist/` |
| `npm run smoke` | **Live** stdio test: real handshake + every tool against the real API |
| `npm run smoke:http` | **Live** HTTP test: handshake, `/health`, `/ready`, session lifecycle |

`npm run smoke` makes real upstream requests. Run it sparingly — the menu host is
bot-protected and will start challenging your IP if you hammer it.

## Architecture rules

These keep the project maintainable against an undocumented upstream:

1. **Only `src/adapters/` may know upstream URLs, query params or headers.** Tools call
   adapters and receive normalised domain objects. If you find yourself building a foodpanda
   URL inside a tool, the abstraction has leaked.
2. **Tools return the domain model, never raw upstream JSON.** Add fields to
   `src/domain/types.ts` and map them in `src/domain/normalize.ts`.
3. **Never throw on an unexpected upstream shape.** Use `safeValidate`, return best-effort
   data, and surface a warning through `meta.degraded`. A missing field must degrade one
   value, not fail the call.
4. **Never write to stdout.** Under the stdio transport, stdout is the JSON-RPC channel.
   Use the logger (stderr). ESLint enforces this via `no-console`.
5. **Every tool needs a real description, a zod input schema, structured output and a
   human-readable text fallback.** The description is what a model uses to decide whether to
   call it — write it for that reader.

## Adding a tool

1. Add the handler in `src/tools/`, using `metaShape` from `src/tools/context.ts` for the
   `meta` field. Do not hand-roll a `meta` schema — a copy that drifts from `buildMeta()`
   causes runtime validation failures.
2. Register it in `src/server.ts`.
3. Add it to `EXPECTED_TOOLS` in `scripts/ci-handshake.js`.
4. Add a case to the "every tool returns both text and structured output" table in
   `tests/tools.test.ts`.
5. Update the tool table in `README.md`.

## Changing upstream behaviour

If you discover that an endpoint, parameter or response shape has changed:

1. Verify it with a live request — do not infer it.
2. Update `docs/API-RESEARCH.md` with what you observed, including the request you made.
3. Regenerate or hand-edit the affected fixture in `tests/fixtures/`.
4. Add a regression test. Every bug fixed so far has one.

## Tests

- The suite must stay **hermetic**. `tests/setup.ts` makes global `fetch` throw; inject a
  stub through `HttpClient`'s `fetchImpl` seam instead.
- Fixtures come from real captured responses. Keep them real — an invented payload tests
  your imagination, not the integration.
- Prefer a test that would have caught a real bug over a test that restates the implementation.

## Commits and PRs

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add browse_by_cuisine
fix(normalize): read listing discounts from tags[]
docs(readme): document the openNow cost
test(http): cover circuit breaker half-open transition
chore(ci): run the docker image in CI
```

Before opening a PR: `npm run verify` passes, new behaviour has a test, and user-visible
changes are reflected in the README.

## Reporting bugs

Include the tool name, the exact arguments, what you expected, what happened, and the output
of `LOG_LEVEL=debug`. If it involves upstream data, say which market and roughly where.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
