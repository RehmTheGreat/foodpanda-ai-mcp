# Tool schema versioning and deprecation policy

The server has two version numbers, and they answer different questions.

| Version | Where | Question it answers |
|---|---|---|
| **Package version** | `package.json`, MCP `initialize` response | Which build am I running? |
| **Tool schema version** | `TOOL_SCHEMA_VERSION`, `foodpanda://server-info` | Can my integration still rely on these tool shapes? |

Both are readable at runtime:

```
resource: foodpanda://server-info
{ "version": "0.1.0", "toolSchemaVersion": "1.0.0", ... }
```

## What the tool schema version covers

It covers the **contract MCP clients depend on**:

- tool names
- input parameter names, types and whether they are required
- `structuredContent` output field names and types
- prompt names and argument names
- resource URIs and templates

It does **not** cover the human-readable `content[].text` rendering, log output, internal
module layout, or upstream request details. Those may change at any time.

## Semantics

Tool schema versioning is semver.

**MAJOR** — something existing breaks:
- a tool, prompt or resource is removed or renamed
- a required input is added, or an optional input becomes required
- an output field is removed or changes type
- a parameter's accepted values narrow

**MINOR** — additive and backward compatible:
- a new tool, prompt or resource
- a new **optional** input
- a new output field
- a parameter's accepted values widen

**PATCH** — no contract change:
- description or documentation wording
- ranking, formatting, performance, bug fixes that restore documented behaviour

## Deprecation policy

Nothing in the covered surface is removed without notice.

1. **Announce.** The deprecated item is marked in its description with the removal version
   and the replacement, noted in the README tool table, and recorded in the release notes.
2. **Keep it working.** A deprecated tool or field keeps functioning for at least **one minor
   release and 90 days**, whichever is longer.
3. **Warn at runtime.** Calls to a deprecated tool add a line to `meta.warnings`, so an
   integration notices without reading the changelog.
4. **Remove.** Removal happens only in a MAJOR tool-schema bump.

Renames are handled as add-then-deprecate: the new name ships first, the old name continues
to work through the deprecation window.

## The upstream is not versioned, and that matters

foodpanda's endpoints are undocumented internal APIs with no compatibility guarantee. They
can change without warning, and this project cannot promise otherwise.

What it does promise is that **an upstream change does not become a breaking change for you**:

- upstream knowledge is confined to `src/adapters/foodpanda.ts`;
- responses are validated with permissive schemas that **degrade rather than throw** — a
  missing or retyped field yields `undefined` plus `meta.degraded: true`, not a failed call;
- tools return a normalised domain model, so an upstream rename is absorbed in normalisation.

So the practical failure mode of upstream drift is a field going missing with a warning
attached, not a tool disappearing or changing shape underneath an integration.

If upstream removes a capability outright, the affected tool is deprecated through the policy
above rather than silently returning empty results.

## Pre-1.0

The package is below 1.0, so the package version may move quickly. The **tool schema version
is already treated as stable at 1.0.0** — the tool contract is what integrations build
against, and it is governed by the rules above from day one.
