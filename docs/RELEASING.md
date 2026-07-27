# Releasing

## Publishing to npm

The package is `foodpanda-mcp-server` (the unscoped name `foodpanda-mcp` was already taken
by an unrelated project — see [DECISIONS.md](../DECISIONS.md#d5)).

Everything needed to publish is already configured: `files`, `bin`, `exports`, `engines`,
`publishConfig.access` and a `prepublishOnly` hook that builds first.

**One-time:** authenticate.

```bash
npm login
```

**Publish:**

```bash
npm publish
```

That is the whole thing. `prepublishOnly` runs `npm run build`, so `dist/` is always fresh
and you cannot publish a stale artefact.

### Before publishing

```bash
npm run verify          # lint + typecheck + 117 tests
npm pack --dry-run      # inspect exactly what will ship
```

`npm pack --dry-run` should list `dist/`, `README.md`, `LICENSE` and `server.json` — and
nothing else. No sources, no tests, no fixtures, no research directory.

### Verifying a published version

```bash
npx -y foodpanda-mcp-server@latest --version
npx -y foodpanda-mcp-server@latest --help
```

Then confirm a real client can drive it:

```bash
claude mcp add foodpanda -- npx -y foodpanda-mcp-server
```

## Cutting a version

1. Decide the bump. Package version is ordinary semver; the **tool schema version** in
   `src/tools/context.ts` follows [docs/VERSIONING.md](VERSIONING.md) and moves independently.
2. Update the version in **three** places — they must agree, and nothing enforces it:
   - `package.json` → `version`
   - `server.json` → `version` **and** `packages[0].version`
   - `src/config.ts` → `SERVER_VERSION`
3. `npm run verify && npm run build`
4. Commit: `chore(release): v0.2.0`
5. Tag and push:
   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push && git push --tags
   ```
6. Wait for CI to go green.
7. `npm publish`
8. Create the GitHub release:
   ```bash
   gh release create v0.2.0 --generate-notes
   ```

## Registries

- **MCP Registry** — publish `server.json` with the
  [registry CLI](https://github.com/modelcontextprotocol/registry). The name
  `io.github.rehmthegreat/foodpanda-mcp` is under the publisher's GitHub namespace, so
  authentication is via GitHub.
- **Smithery** — connect the repository at [smithery.ai](https://smithery.ai); it reads
  `smithery.yaml` from the repo root.
- **mcpmarket.com** — indexes public GitHub MCP repositories. No action needed beyond the
  repo being public with accurate metadata and topics.

Keep `server.json`'s `version` in step with the npm release; registries surface it directly.
