import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../server.js';
import { SERVER_NAME, SERVER_VERSION } from '../config.js';

/**
 * Streamable HTTP transport for remote hosting.
 *
 * Stateful sessions: an initialize request mints a session id which the client
 * echoes in Mcp-Session-Id. Each session gets its own transport and its own
 * McpServer instance, so per-connection state cannot leak between clients.
 */
export async function startHttp(): Promise<void> {
  const { logger, config, http } = await buildServer({ transport: 'http' });

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // CORS. Mcp-Session-Id must be exposed or browser clients cannot read it back.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowAll = config.allowedOrigins.includes('*');
    if (allowAll) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && config.allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Last-Event-ID, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  interface Session {
    transport: StreamableHTTPServerTransport;
    lastSeen: number;
  }
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  /**
   * Reap idle sessions.
   *
   * A well-behaved client sends DELETE /mcp to end its session, but a client
   * that crashes, times out or simply closes its socket never does. Without
   * this sweep, every abandoned session leaks a transport and an McpServer for
   * the lifetime of the process.
   */
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const reaper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        logger.info('reaping idle session', { sessionId: id });
        sessions.delete(id);
        try {
          void s.transport.close();
        } catch {
          /* best effort */
        }
      }
    }
  }, 60_000);
  reaper.unref();

  const handle = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const existing = sessions.get(sessionId)?.transport;
      if (existing) sessions.get(sessionId)!.lastSeen = Date.now();
      if (!existing) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found. Start a new session with an initialize request.' },
          id: null,
        });
        return;
      }
      await existing.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // DNS-rebinding protection: only enabled when an explicit host allowlist
        // is configured, so the default local-dev experience still works.
        ...(config.allowedHosts.length
          ? { enableDnsRebindingProtection: true, allowedHosts: config.allowedHosts }
          : {}),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, lastSeen: Date.now() });
          logger.info('session opened', { sessionId: id, sessions: sessions.size });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.info('session closed', { sessionId: transport.sessionId, sessions: sessions.size });
        }
      };

      // A fresh server per session keeps sessions fully isolated.
      const { server } = await buildServer({ transport: 'http' });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header required for non-initialize requests.' },
      id: null,
    });
  };

  app.post('/mcp', (req, res) => {
    void handle(req, res).catch((err) => {
      logger.error('request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    });
  });
  app.get('/mcp', (req, res) => void handle(req, res).catch(() => res.status(500).end()));
  app.delete('/mcp', (req, res) => void handle(req, res).catch(() => res.status(500).end()));

  /** Liveness: is the process up at all. Never touches the network. */
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: SERVER_NAME,
      version: SERVER_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      sessions: sessions.size,
    });
  });

  /**
   * Readiness: is the server able to serve traffic. Reports the upstream circuit
   * breaker state, so an orchestrator can stop routing to an instance whose
   * upstream has gone bad. Degraded rather than failing keeps cached reads working.
   */
  app.get('/ready', (_req, res) => {
    const stats = http.stats();
    const open = Object.values(stats.breakers).filter((b) => b.state === 'open');
    res.status(open.length > 0 ? 503 : 200).json({
      status: open.length > 0 ? 'degraded' : 'ready',
      upstream: stats.breakers,
      cache: stats.cache,
      requests: stats.requests,
      coalesced: stats.coalesced,
    });
  });

  app.get('/', (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description: 'Unofficial read-only MCP server for foodpanda discovery data.',
      mcpEndpoint: '/mcp',
      health: '/health',
      readiness: '/ready',
      documentation: 'https://github.com/RehmTheGreat/foodpanda-ai-mcp',
    });
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('listening on http', {
      url: `http://${config.host}:${config.port}/mcp`,
      health: `http://${config.host}:${config.port}/health`,
    });
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal, sessions: sessions.size });
    clearInterval(reaper);
    for (const s of sessions.values()) {
      try {
        void s.transport.close();
      } catch {
        /* best effort */
      }
    }
    sessions.clear();
    server.close(() => process.exit(0));
    // Do not hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
