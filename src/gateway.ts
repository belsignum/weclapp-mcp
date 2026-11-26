#!/usr/bin/env node
/**
 * Gateway für den Docker-Betrieb: der einzige Weg des Servers nach draußen und, hinter einem vorhandenen NGINX, herein.
 *
 * Der Server-Container hängt nur in einem internen Docker-Netz ohne Internet und ohne Adresse des Hosts.
 * Der Gateway hängt zusätzlich in einem normalen Netz.
 *
 * - Ausgehend (EGRESS_ALLOW): HTTP-Proxy, der nur CONNECT zu fest eingestellten Zielen erlaubt, z. B. acme.weclapp.com:443.
 *   TLS bleibt Ende-zu-Ende zwischen Server und weclapp: Der Gateway sieht Ziel und verschlüsselte Bytes, nie den Token.
 *   Klartext-HTTP leitet er nicht weiter.
 * - Eingehend (INGRESS_TARGET, INGRESS_PORT): reicht TCP-Verbindungen unverändert an den Server durch. Nötig, weil Docker
 *   für einen Container, der nur in einem internen Netz hängt, keinen Port veröffentlicht.
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';

export interface Target {
  host: string;
  port: number;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TARGET_PATTERN = new RegExp(`^(${LABEL}(?:\\.${LABEL})*):([1-9][0-9]{0,4})$`);

/** "host:port" in Kleinbuchstaben; alles andere (IPv6-Klammern, Pfade, Zugangsdaten, Port 0) ist ungültig. */
export function parseTarget(value: string): Target | undefined {
  const match = TARGET_PATTERN.exec(value.trim().toLowerCase());
  if (!match || Number(match[2]) > 65_535) return undefined;
  return { host: match[1], port: Number(match[2]) };
}

/** Kommagetrennte Liste "host:port,host:port" für EGRESS_ALLOW. */
export function parseAllowList(value: string | undefined): Set<string> {
  const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('EGRESS_ALLOW fehlt: erwartet wird "host:port", z. B. "acme.weclapp.com:443".');
  const allow = new Set<string>();
  for (const entry of entries) {
    const target = parseTarget(entry);
    if (!target) throw new Error(`EGRESS_ALLOW: "${entry.slice(0, 80)}" ist kein gültiges Ziel "host:port".`);
    allow.add(`${target.host}:${target.port}`);
  }
  return allow;
}

/** Für Logzeilen: nur druckbare Zeichen, gekürzt. */
function printable(value: string | undefined): string {
  return (value ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
}

/**
 * Höchstens `limit` Logzeilen pro Minute, der Rest wird gezählt und mit der nächsten Zeile zusammengefasst.
 * Wer im Server-Container Code ausführt, kann sonst mit abgelehnten Anfragen das Log fluten (gemessen: rund 1 MB in 5 s):
 * ohne Log-Limit von Docker bis die Platte voll ist, mit Limit so lange, bis die ersten, aufschlussreichen Zeilen verdrängt sind.
 */
export function throttledLog(log: (message: string) => void, limit = 20, now: () => number = Date.now): (message: string) => void {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  let suppressed = 0;
  return (message) => {
    const time = now();
    if (time - windowStart >= 60_000) {
      if (suppressed > 0) log(`[gateway] ${suppressed} weitere Meldungen in der Minute davor nicht einzeln protokolliert`);
      windowStart = time;
      count = 0;
      suppressed = 0;
    }
    if (count++ < limit) log(message);
    else suppressed++;
  };
}

function closeBoth(a: Socket, b: Socket): void {
  a.destroy();
  b.destroy();
}

export interface EgressOptions {
  allow: Set<string>;
  log?: (message: string) => void;
  /** Höchstens so viele gleichzeitige Verbindungen (Standard 64). */
  maxConnections?: number;
  /** Aufbau der Verbindung zum Ziel (Standard 10 s). */
  connectTimeoutMs?: number;
  /** Ein Tunnel ohne Daten in beide Richtungen wird nach dieser Zeit geschlossen (Standard 120 s). */
  idleTimeoutMs?: number;
  /** Höchstens so viele Logzeilen pro Minute (Standard 20). */
  logLimitPerMinute?: number;
  now?: () => number;
}

export function createEgressProxy(options: EgressOptions): HttpServer {
  const log = throttledLog(options.log ?? ((message: string) => console.error(message)), options.logLimitPerMinute ?? 20, options.now);
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const idleTimeout = options.idleTimeoutMs ?? 120_000;

  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    // Kein Weiterleiten von Klartext-HTTP ("GET http://…"): nur CONNECT zu freigegebenen Zielen
    log(`[gateway] abgelehnt: ${printable(req.method)} ${printable(req.url)}`);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    res.end('Nur CONNECT zu freigegebenen Zielen.\n');
  });

  server.on('connect', (req, client: Socket, head: Buffer) => {
    // Ohne Listener beendete ein abgebrochener Client den ganzen Prozess
    client.on('error', () => {});
    const raw = req.url ?? '';
    const target = parseTarget(raw);
    if (!target || !options.allow.has(`${target.host}:${target.port}`)) {
      log(`[gateway] abgelehnt: CONNECT ${printable(raw)}`);
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }

    let established = false;
    const upstream = connect({ host: target.host, port: target.port });
    upstream.setTimeout(connectTimeout);
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(idleTimeout);
      client.setTimeout(idleTimeout);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', () => {
      if (established) return closeBoth(upstream, client);
      log(`[gateway] ${target.host}:${target.port} antwortet nicht`);
      upstream.destroy();
      client.end('HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    client.on('timeout', () => closeBoth(upstream, client));
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (established) return closeBoth(upstream, client);
      log(`[gateway] ${target.host}:${target.port} nicht erreichbar (${printable(error.code ?? error.message)})`);
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    upstream.on('close', () => established && client.destroy());
    client.on('close', () => upstream.destroy());
  });

  server.maxConnections = options.maxConnections ?? 64;
  server.headersTimeout = 10_000;
  // Ein Tunnel ist ein langer "Request"; ihn begrenzen die Leerlauf-Timeouts oben
  server.requestTimeout = 0;
  server.maxHeadersCount = 50;
  return server;
}

export interface IngressOptions {
  target: Target;
  maxConnections?: number;
  idleTimeoutMs?: number;
}

/** Reicht jede TCP-Verbindung unverändert an das Ziel durch (Header wie X-Forwarded-For bleiben, wie sie sind). */
export function createIngressForwarder(options: IngressOptions): TcpServer {
  const idleTimeout = options.idleTimeoutMs ?? 120_000;
  const server = createTcpServer((client) => {
    const upstream = connect(options.target);
    client.setTimeout(idleTimeout);
    upstream.setTimeout(idleTimeout);
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on('error', () => closeBoth(client, upstream));
      socket.on('timeout', () => closeBoth(client, upstream));
      socket.on('close', () => closeBoth(client, upstream));
    }
  });
  server.maxConnections = options.maxConnections ?? 256;
  return server;
}

function listen(server: HttpServer | TcpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} muss ein Port zwischen 1 und 65535 sein.`);
  return value;
}

async function main(): Promise<void> {
  const allow = parseAllowList(process.env.EGRESS_ALLOW);
  const egressPort = port('EGRESS_PORT', 3128);
  const servers: Array<HttpServer | TcpServer> = [];

  const egress = createEgressProxy({ allow });
  await listen(egress, egressPort);
  servers.push(egress);
  console.error(`[gateway] ausgehend auf Port ${egressPort}, nur zu ${[...allow].join(', ')}`);

  if (process.env.INGRESS_TARGET) {
    const target = parseTarget(process.env.INGRESS_TARGET);
    if (!target) throw new Error('INGRESS_TARGET muss "host:port" sein, z. B. "weclapp-mcp:3000".');
    const ingressPort = port('INGRESS_PORT', 3000);
    const ingress = createIngressForwarder({ target });
    await listen(ingress, ingressPort);
    servers.push(ingress);
    console.error(`[gateway] eingehend auf Port ${ingressPort}, weiter an ${target.host}:${target.port}`);
  }

  const shutdown = () => {
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[gateway]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
