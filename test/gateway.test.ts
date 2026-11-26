import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { connect as tcpConnect, createServer, type AddressInfo, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createEgressProxy, createIngressForwarder, parseAllowList, parseTarget, throttledLog } from '../src/gateway.ts';
import { connect } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

async function listen<T extends Server>(server: T): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Echo-Server als Ziel eines Tunnels. */
function echoServer(): Server {
  return createServer((socket) => socket.pipe(socket));
}

/** Schickt eine rohe Anfrage an den Proxy und liefert die erste Antwortzeile; bei 200 wird danach "ping" durch den Tunnel geschickt. */
function rawConnect(proxyPort: number, requestLine: string): Promise<{ status: string; echo?: string }> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(proxyPort, '127.0.0.1');
    let buffer = '';
    let status: string | undefined;
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (status === undefined && buffer.includes('\r\n\r\n')) {
        status = buffer.split('\r\n')[0];
        buffer = buffer.slice(buffer.indexOf('\r\n\r\n') + 4);
        if (!status.includes(' 200 ')) return;
        socket.write('ping');
      }
      if (status?.includes(' 200 ') && buffer === 'ping') {
        socket.destroy();
        resolve({ status, echo: buffer });
      }
    });
    socket.on('close', () => resolve({ status: status ?? '(keine Antwort)' }));
    socket.write(`${requestLine}\r\nHost: x\r\n\r\n`);
  });
}

test('Gateway: Ziele nur als host:port, Liste darf nicht leer sein', () => {
  assert.deepEqual(parseTarget('Acme.Weclapp.com:443'), { host: 'acme.weclapp.com', port: 443 });
  for (const invalid of ['acme.weclapp.com', 'acme.weclapp.com:0', 'acme.weclapp.com:70000', '[::1]:443', 'user@acme.weclapp.com:443', 'acme.weclapp.com:443/x', 'acme.weclapp.com.:443', '-acme.weclapp.com:443', ':443']) {
    assert.equal(parseTarget(invalid), undefined, invalid);
  }
  assert.deepEqual([...parseAllowList(' acme.weclapp.com:443, oauth2.googleapis.com:443 ')], ['acme.weclapp.com:443', 'oauth2.googleapis.com:443']);
  assert.throws(() => parseAllowList(''), /EGRESS_ALLOW fehlt/);
  assert.throws(() => parseAllowList('acme.weclapp.com'), /kein gültiges Ziel/);
});

test('Gateway ausgehend: CONNECT nur zu freigegebenen Zielen, kein Klartext-HTTP', async () => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const other = echoServer();
  const otherPort = await listen(other);
  const log: string[] = [];
  const proxy = createEgressProxy({ allow: parseAllowList(`localhost:${echoPort}`), log: (m) => log.push(m) });
  const proxyPort = await listen(proxy);
  try {
    assert.deepEqual(await rawConnect(proxyPort, `CONNECT localhost:${echoPort} HTTP/1.1`), { status: 'HTTP/1.1 200 Connection Established', echo: 'ping' });
    // Groß-/Kleinschreibung des Hostnamens spielt keine Rolle
    assert.equal((await rawConnect(proxyPort, `CONNECT LOCALHOST:${echoPort} HTTP/1.1`)).echo, 'ping');

    for (const target of [`localhost:${otherPort}`, `127.0.0.1:${echoPort}`, `localhost.:${echoPort}`, `[::1]:${echoPort}`, `localhost:0${echoPort}`, 'example.com:443']) {
      assert.equal((await rawConnect(proxyPort, `CONNECT ${target} HTTP/1.1`)).status, 'HTTP/1.1 403 Forbidden', target);
    }
    // Absolute URL wie bei einem Klartext-Proxy: wird nicht weitergeleitet
    assert.match((await rawConnect(proxyPort, `GET http://localhost:${echoPort}/ HTTP/1.1`)).status, /^HTTP\/1\.1 403 /);
    assert.match((await rawConnect(proxyPort, 'GET /health HTTP/1.1')).status, /^HTTP\/1\.1 200 /);
    assert.ok(log.some((m) => m.includes(`abgelehnt: CONNECT localhost:${otherPort}`)));
  } finally {
    await Promise.all([close(proxy), close(echo), close(other)]);
  }
});

test('Gateway: Log-Flut wird gebremst, die ersten Zeilen bleiben, der Rest wird gezählt', () => {
  const lines: string[] = [];
  let time = 0;
  const log = throttledLog((m) => lines.push(m), 3, () => time);
  for (let i = 0; i < 1000; i++) log(`abgelehnt ${i}`);
  assert.deepEqual(lines, ['abgelehnt 0', 'abgelehnt 1', 'abgelehnt 2']);
  time = 60_000;
  log('abgelehnt neu');
  assert.deepEqual(lines.slice(3), ['[gateway] 997 weitere Meldungen in der Minute davor nicht einzeln protokolliert', 'abgelehnt neu']);
});

test('Gateway ausgehend: nicht erreichbares Ziel ergibt 502, der Gateway läuft weiter', async () => {
  const unused = echoServer();
  const unusedPort = await listen(unused);
  await close(unused);
  const proxy = createEgressProxy({ allow: parseAllowList(`localhost:${unusedPort}`), log: () => {} });
  const proxyPort = await listen(proxy);
  try {
    assert.equal((await rawConnect(proxyPort, `CONNECT localhost:${unusedPort} HTTP/1.1`)).status, 'HTTP/1.1 502 Bad Gateway');
    assert.match((await rawConnect(proxyPort, 'GET /health HTTP/1.1')).status, / 200 /);
  } finally {
    await close(proxy);
  }
});

test('Gateway eingehend: reicht TCP unverändert durch, X-Forwarded-For bleibt, wie es ist', async () => {
  const seen: Array<string | undefined> = [];
  const { createServer: createHttp } = await import('node:http');
  const backend = createHttp((req, res) => {
    seen.push(req.headers['x-forwarded-for'] as string | undefined);
    res.end('hallo');
  });
  const backendPort = await listen(backend);
  const ingress = createIngressForwarder({ target: { host: '127.0.0.1', port: backendPort } });
  const ingressPort = await listen(ingress);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: ingressPort, path: '/', headers: { 'X-Forwarded-For': '203.0.113.7' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'hallo');
    assert.deepEqual(seen, ['203.0.113.7']);
  } finally {
    await Promise.all([close(ingress), close(backend)]);
  }
});

/** Startet src/http.ts als eigenen Prozess mit dem Proxy aus der Umgebung, wie im Container. */
async function serverBehindProxy(baseUrl: string, proxyPort: number) {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/http.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', WECLAPP_BASE_URL: baseUrl, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startet nicht:\n${log}`)), 15_000);
    child.stderr.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes('hört auf')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { port, stop: () => child.kill() };
}

test('Server mit NODE_USE_ENV_PROXY: weclapp nur über den Gateway; ohne Freigabe 503', async () => {
  const mock = await startMockWeclapp();
  const target = new URL(mock.baseUrl).host;
  const log: string[] = [];
  const allowed = createEgressProxy({ allow: parseAllowList(target), log: (m) => log.push(m) });
  const denied = createEgressProxy({ allow: parseAllowList('acme.weclapp.com:443'), log: (m) => log.push(m) });
  const allowedPort = await listen(allowed);
  const deniedPort = await listen(denied);
  const viaAllowed = await serverBehindProxy(mock.baseUrl, allowedPort);
  const viaDenied = await serverBehindProxy(mock.baseUrl, deniedPort);
  try {
    const client = await connect(`http://127.0.0.1:${viaAllowed.port}`, 'token-anna');
    assert.ok((await client.listTools()).tools.length > 0);
    await client.close();
    assert.ok(mock.requests.some((r) => r.path === '/user/currentUser'));

    const before = mock.requests.length;
    const response = await fetch(`http://127.0.0.1:${viaDenied.port}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-ben', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(response.status, 503);
    assert.equal(mock.requests.length, before, 'ohne Freigabe erreicht keine Anfrage weclapp');
    assert.ok(log.includes(`[gateway] abgelehnt: CONNECT ${target}`));
  } finally {
    viaAllowed.stop();
    viaDenied.stop();
    await Promise.all([close(allowed), close(denied), mock.close()]);
  }
});
