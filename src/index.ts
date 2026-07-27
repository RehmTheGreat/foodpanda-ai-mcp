#!/usr/bin/env node
import { loadConfig, SERVER_NAME, SERVER_VERSION } from './config.js';

/**
 * Entry point. One codebase, two transports, chosen by --http/--stdio or
 * MCP_TRANSPORT. Defaults to stdio because that is what desktop MCP clients use.
 */

const HELP = `${SERVER_NAME} v${SERVER_VERSION}
Unofficial MCP server for foodpanda public discovery data. Read-only.

USAGE
  foodpanda-mcp [--stdio | --http] [--help] [--version]

TRANSPORTS
  --stdio   JSON-RPC over stdin/stdout (default). For Claude Desktop, Claude Code, Cursor.
  --http    Streamable HTTP on PORT (default 3000). For remote hosting.

ENVIRONMENT
  MCP_TRANSPORT=stdio|http     Same as the flags above.
  PORT=3000                    HTTP port.
  FOODPANDA_DEFAULT_MARKET=pk  Fallback market code.
  LOG_LEVEL=info               error | warn | info | debug | silent
  See .env.example for the full list. Every value is optional.

No API key is required. This server cannot order food or access any account.
Docs: https://github.com/RehmTheGreat/foodpanda-mcp`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(SERVER_VERSION + '\n');
    return;
  }

  const config = loadConfig();
  if (config.transport === 'http') {
    const { startHttp } = await import('./transports/http.js');
    await startHttp();
  } else {
    const { startStdio } = await import('./transports/stdio.js');
    await startStdio();
  }
}

// A crash must be legible on stderr and must not print to stdout.
process.on('uncaughtException', (err) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'uncaughtException', error: String(err?.stack ?? err) })}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'unhandledRejection', error: String(reason) })}\n`);
});

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'fatal', error: String(err?.stack ?? err) })}\n`);
  process.exit(1);
});
