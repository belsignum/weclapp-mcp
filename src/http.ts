#!/usr/bin/env node
/**
 * HTTP-Start (Variante B): zentraler MCP-Server, z. B. im Docker-Container auf einem VPS.
 *
 * Der weclapp-API-Token wird NICHT gespeichert. Jeder Request bringt ihn als
 * "Authorization: Bearer <weclapp-token>" mit. Bevor irgendetwas verarbeitet wird,
 * bestätigt weclapp den Token für den fest eingestellten Mandanten (WECLAPP_TENANT).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { AuditLog } from './audit.ts';
import { bearerToken, FailureLimiter, rateLimitKey, TokenVerifier, type Verdict } from './auth.ts';
import { WriteBudget } from './budget.ts';
import { loadWeclappConfig } from './config.ts';
import { createWeclappServer, SERVER_INFO, type ServerOptions } from './server.ts';
import { WeclappClient, type Entity } from './weclapp/client.ts';

export interface HttpOptions extends Omit<ServerOptions, 'writeBudget'> {
  baseUrl: string;
  /** Maximale Schreibaktionen pro Nutzer und Stunde (Standard 120, 0 = unbegrenzt). */
  maxWritesPerHour?: number;
  /** Hostnamen, unter denen der Server erreichbar sein darf (Schutz vor DNS-Rebinding). */
  allowedHosts: string[];
  /** true: Client-IP aus X-Forwarded-For lesen (nur hinter einem eigenen Reverse Proxy setzen). */
  trustProxy?: boolean;
  path?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** Maximale Fehlversuche pro IP-Adresse (IPv6: pro /64-Netz) in 5 Minuten (Standard 10). */
  maxAuthFailures?: number;
}

const LOCALHOST = ['localhost', '127.0.0.1', '[::1]'];
const MAX_BODY_BYTES = 1024 * 1024;

type AuthedRequest = IncomingMessage & { auth?: { token: string; clientId: string; scopes: string[]; extra?: Record<string, unknown> } };

export { bearerToken };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Schlüssel für das Rate-Limit: die Adresse des Clients (IPv6 auf /64 gekürzt). */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    // Der letzte Eintrag stammt vom eigenen Proxy; frühere kann der Client frei erfinden.
    // Ist er keine IP-Adresse, gilt die Adresse der Verbindung.
    const last = rateLimitKey((Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1));
    if (last) return last;
  }
  return rateLimitKey(req.socket.remoteAddress) ?? 'unknown';
}

export function createHttpServer(options: HttpOptions) {
  const path = options.path ?? '/mcp';
  const log = options.log ?? ((message: string) => console.error(message));
  const allowed = [...new Set([...options.allowedHosts, ...LOCALHOST])];
  const validateHost = hostHeaderValidation(allowed);
  const validateOrigin = originValidation(allowed);
  const verifier = new TokenVerifier(options.baseUrl, { fetch: options.fetch });
  const limiter = new FailureLimiter({ max: options.maxAuthFailures });
  // Ein Zähler für alle Requests: pro Request entsteht eine neue Server-Instanz
  const writeBudget = new WriteBudget(options.maxWritesPerHour ?? 120);

  const handler = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      const user = ctx.authInfo?.extra?.user as Entity | undefined;
      if (!token || !user) throw new Error('Request ohne geprüften weclapp-Token.');
      const client = new WeclappClient(options.baseUrl, token, { fetch: options.fetch, currentUser: user });
      return createWeclappServer(client, { readOnly: options.readOnly, allowPublicComments: options.allowPublicComments, audit: options.audit, writeBudget, timeZone: options.timeZone });
    },
    { maxRequestBodySize: MAX_BODY_BYTES, onerror: (error) => log(`[weclapp-mcp] ${error.message}`) },
  );
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MAX_BODY_BYTES, onerror: (error) => log(`[weclapp-mcp] ${error.message}`) });

  async function handle(req: AuthedRequest, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // Ein vorgeschaltetes NGINX soll Antworten (auch SSE) nicht puffern, ohne dass man dort etwas einstellen muss
    res.setHeader('X-Accel-Buffering', 'no');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Ungültige Anfrage.' });
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (url.pathname !== path) {
      sendJson(res, 404, { error: 'Nicht gefunden.' });
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      // Ein Request ohne (wohlgeformten) Token ist kein Rateversuch und kostet weclapp nichts. Er zählt deshalb
      // nicht fürs Rate-Limit: sonst könnte jede Webseite den Nutzer aussperren, indem sie seinen Browser
      // ein paar Mal diese Adresse abrufen lässt (<img src=…>).
      sendJson(res, 401, { error: 'Gültiger Header "Authorization: Bearer <weclapp-API-Token>" erforderlich.' }, { 'WWW-Authenticate': 'Bearer realm="weclapp-mcp"' });
      return;
    }

    // Das Rate-Limit bremst nur unbekannte Tokens. Einen Token, den weclapp kürzlich bestätigt hat,
    // kann niemand von derselben Adresse aus mit Fehlversuchen aussperren.
    const ip = clientIp(req, options.trustProxy ?? false);
    const guess = !verifier.isKnown(token);
    const attempt = verifier.key(token);
    if (guess) {
      const blocked = limiter.blockedFor(ip);
      // Laufende Prüfungen zählen mit, damit viele gleichzeitige Requests das Limit nicht überrennen
      if (blocked > 0 || !limiter.begin(ip, attempt)) {
        sendJson(res, 429, { error: 'Zu viele fehlgeschlagene Anmeldungen. Bitte später erneut versuchen.' }, { 'Retry-After': String(blocked || 5) });
        return;
      }
    }

    let verdict: Verdict = { ok: false, reason: 'unavailable' };
    try {
      verdict = await verifier.verify(token);
    } finally {
      // Auch "weclapp nicht erreichbar" zählt für unbekannte Tokens: sonst ließen sich bei einer weclapp-Störung
      // beliebig viele Anfragen über diesen Server an weclapp schicken.
      if (guess) limiter.end(ip, attempt, !verdict.ok);
    }
    if (!verdict.ok) {
      if (verdict.reason === 'invalid') {
        sendJson(res, 401, { error: 'Gültiger Header "Authorization: Bearer <weclapp-API-Token>" erforderlich.' }, { 'WWW-Authenticate': 'Bearer realm="weclapp-mcp"' });
        return;
      }
      sendJson(res, 503, { error: 'weclapp ist gerade nicht erreichbar; der Token konnte nicht geprüft werden.' }, { 'Retry-After': '30' });
      return;
    }

    // toNodeHandler reicht req.auth als authInfo an die Server-Factory weiter
    req.auth = { token, clientId: `weclapp-user-${verdict.user.id}`, scopes: [], extra: { user: verdict.user } };
    await nodeHandler(req, res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`[weclapp-mcp] ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Interner Fehler.' });
      else res.end();
    });
  });
  // Schutz gegen langsam tröpfelnde Requests
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.maxHeadersCount = 100;

  return { server, close: () => Promise.all([handler.close(), new Promise<void>((resolve) => server.close(() => resolve()))]) };
}

async function main(): Promise<void> {
  const config = loadWeclappConfig();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const trustProxy = ['1', 'true', 'yes'].includes((process.env.MCP_TRUST_PROXY ?? '').toLowerCase());

  const audit = config.auditDir && !config.readOnly ? await AuditLog.open(config.auditDir, { retentionDays: config.auditRetentionDays, maxBytes: config.auditMaxBytes }) : undefined;

  const { server, close } = createHttpServer({
    baseUrl: config.baseUrl,
    readOnly: config.readOnly,
    allowPublicComments: config.allowPublicComments,
    audit,
    maxWritesPerHour: config.maxWritesPerHour,
    timeZone: config.timeZone,
    allowedHosts,
    trustProxy,
  });
  server.listen(port, host, () => {
    const mode = audit ? `Schreiben mit Protokoll in ${audit.dir}` : 'nur lesen';
    console.error(`[weclapp-mcp] ${SERVER_INFO.version} hört auf http://${host}:${port}/mcp (Mandant: ${new URL(config.baseUrl).hostname}, Zeitzone ${config.timeZone}, ${mode})`);
    if (!audit && !config.readOnly) {
      console.error('[weclapp-mcp] WECLAPP_AUDIT_DIR ist nicht gesetzt: ohne Änderungsprotokoll werden keine Schreib-Tools angeboten.');
    }
    if (allowedHosts.length === 0) {
      console.error('[weclapp-mcp] MCP_ALLOWED_HOSTS ist leer: nur Zugriffe über localhost werden angenommen.');
    }
  });

  const shutdown = () => {
    audit?.close();
    void close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[weclapp-mcp]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
