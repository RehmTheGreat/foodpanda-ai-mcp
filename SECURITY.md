# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: **Security → Report a vulnerability** on
[this repository](https://github.com/RehmTheGreat/foodpanda-ai-mcp/security/advisories/new).

Include what the issue is, how to reproduce it, and what an attacker could achieve. Expect an
acknowledgement within a few days. Please give a reasonable window to ship a fix before
disclosing publicly.

## Supported versions

The latest published version on the `main` branch is supported. This project is pre-1.0;
fixes ship in a new release rather than as backports.

## Security properties of this server

Worth stating plainly, because it shapes what a vulnerability here could mean.

**This server holds no secrets and needs none.**

- No API keys, tokens, passwords or credentials — not optional, simply not used.
- No user accounts, no authentication, no session data belonging to any person.
- No database, no persistence. The cache is in-memory by default and holds only public
  restaurant listings.
- No write operations of any kind against foodpanda: no ordering, no payment, no account
  access.
- Personal data is never collected or transmitted. The `perseus-*` headers the upstream
  requires are randomly generated per process, so no stable identifier is sent and nothing is
  traceable across runs.

**What it does do:** outbound HTTPS GETs to `disco.deliveryhero.io`,
`<market>.fd-api.com` and `nominatim.openstreetmap.org`.

## Deployment considerations

Relevant if you host the HTTP transport publicly:

- **The endpoint is unauthenticated.** It exposes read-only public data, but anyone who can
  reach it can drive upstream requests through your IP. Put it behind auth or a network
  boundary if that matters to you.
- **Set `ALLOWED_ORIGINS`.** It defaults to `*`, which is convenient locally and too open in
  production.
- **Set `ALLOWED_HOSTS`** to enable DNS-rebinding protection.
- **Rate limits are your protection too.** `FOODPANDA_RATE_LIMIT_RPS` and
  `FOODPANDA_MAX_CONCURRENCY` bound how much traffic your instance can generate upstream.
  Raising them increases the chance your IP is blocked by upstream bot protection.
- **Sessions live in process memory.** Idle sessions are reaped after 30 minutes. Running
  multiple instances requires sticky sessions.
- **Logs go to stderr and are structured.** Keys matching `token|secret|key|authorization|
  cookie|password` are redacted, though the server has nothing of that kind to log.

## Scope

In scope: anything that lets an attacker execute code, read files, exhaust resources, poison
the cache across sessions, or make this server act as an amplification vector.

Out of scope: the fact that upstream endpoints are undocumented and may change; upstream bot
protection blocking your IP; and requests to add ordering or authentication support, which
are refused by design.
