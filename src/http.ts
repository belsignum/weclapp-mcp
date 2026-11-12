#!/usr/bin/env node
/**
 * HTTP-Start (Variante B): zentraler MCP-Server, z. B. im Docker-Container auf einem VPS.
 *
 * Der weclapp-API-Token wird NICHT gespeichert. Jeder Request bringt ihn als
 * "Authorization: Bearer <weclapp-token>" mit; daraus entsteht pro Request
 * ein eigener weclapp-Client. Der Mandant ist fest per WECLAPP_TENANT gesetzt.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { loadWeclappConfig, type WeclappConfig } from './config.ts';
import { createWeclappServer, SERVER_INFO } from './server.ts';
import { WeclappClient } from './weclapp/client.ts';

export interface HttpOptions {
  config: WeclappConfig;
  /** Hostnamen, unter denen der Server erreichbar sein darf (Schutz vor DNS-Rebinding). */
  allowedHosts: string[];
  path?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

const LOCALHOST = ['localhost', '127.0.0.1', '[::1]'];

/** Liest den Token aus "Authorization: Bearer <token>". */
export function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function createHttpServer(options: HttpOptions) {
  const path = options.path ?? '/mcp';
  const log = options.log ?? ((message: string) => console.error(message));
  const allowed = [...new Set([...options.allowedHosts, ...LOCALHOST])];
  const validateHost = hostHeaderValidation(allowed);
  const validateOrigin = originValidation(allowed);

  const handler = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      if (!token) throw new Error('Kein weclapp-Token im Request.');
      return createWeclappServer(new WeclappClient(options.config.baseUrl, token, { fetch: options.fetch }), options.config);
    },
    { onerror: (error) => log(`[weclapp-mcp] ${error.message}`) },
  );
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => log(`[weclapp-mcp] ${error.message}`) });

  const server = createServer((req: IncomingMessage & { auth?: { token: string; clientId: string; scopes: string[] } }, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', name: SERVER_INFO.name, version: SERVER_INFO.version, readOnly: options.config.readOnly });
      return;
    }
    if (url.pathname !== path) {
      sendJson(res, 404, { error: `Nicht gefunden. Der MCP-Endpunkt ist ${path}.` });
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      sendJson(
        res,
        401,
        { error: 'Header "Authorization: Bearer <weclapp-API-Token>" fehlt.' },
        { 'WWW-Authenticate': 'Bearer realm="weclapp-mcp"' },
      );
      return;
    }

    // toNodeHandler reicht req.auth als authInfo an die Server-Factory weiter
    req.auth = { token, clientId: 'weclapp-token', scopes: [] };
    void nodeHandler(req, res);
  });

  return { server, close: () => Promise.all([handler.close(), new Promise<void>((resolve) => server.close(() => resolve()))]) };
}

function main(): void {
  const config = loadWeclappConfig();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const { server, close } = createHttpServer({ config, allowedHosts });
  server.listen(port, host, () => {
    console.error(`[weclapp-mcp] ${SERVER_INFO.version} hört auf http://${host}:${port}/mcp (Mandant: ${new URL(config.baseUrl).hostname}${config.readOnly ? ', nur lesen' : ''})`);
    if (allowedHosts.length === 0) {
      console.error('[weclapp-mcp] MCP_ALLOWED_HOSTS ist leer: nur Zugriffe über localhost werden angenommen.');
    }
  });

  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error('[weclapp-mcp]', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
