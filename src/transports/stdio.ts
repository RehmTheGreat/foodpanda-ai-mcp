import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../server.js';

/**
 * stdio transport: the client spawns this process and speaks JSON-RPC over
 * stdin/stdout. Nothing may ever be written to stdout except protocol frames —
 * all diagnostics go to stderr via the logger.
 */
export async function startStdio(): Promise<void> {
  const { server, logger } = await buildServer({ transport: 'stdio' });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('listening on stdio');

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    try {
      await server.close();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
