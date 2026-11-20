/**
 * Betrieb hinter einem vorgeschalteten NGINX (docker-compose.nginx.yml, DEPLOY.md):
 * Je nach Konfiguration reicht das NGINX den Host der Domain durch oder schickt "127.0.0.1:<port>".
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { startMcp } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proxy-test', version: '1.0.0' } },
});

function initialize(port: number, host: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { Host: host, Authorization: 'Bearer token-anna', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on('error', reject);
    req.end(INITIALIZE);
  });
}

describe('Hinter einem vorgeschalteten NGINX', () => {
  let mock: Awaited<ReturnType<typeof startMockWeclapp>>;
  let mcp: Awaited<ReturnType<typeof startMcp>>;

  before(async () => {
    mock = await startMockWeclapp();
    // wie im Container: MCP_ALLOWED_HOSTS enthält nur die öffentliche Domain
    mcp = await startMcp(mock.baseUrl, { allowedHosts: ['mcp.example.com'], withAudit: false });
  });

  after(async () => {
    await mcp?.close();
    await mock?.close();
  });

  test('Host der Domain (proxy_set_header Host $host) wird angenommen', async () => {
    assert.equal((await initialize(mcp.port, 'mcp.example.com')).status, 200);
  });

  test('Host 127.0.0.1:<port> (NGINX-Standard bei proxy_pass http://127.0.0.1:<port>) wird angenommen', async () => {
    assert.equal((await initialize(mcp.port, '127.0.0.1:8734')).status, 200);
    assert.equal((await initialize(mcp.port, 'localhost:8734')).status, 200);
  });

  test('fremder Host bleibt abgelehnt, auch mit Port', async () => {
    assert.equal((await initialize(mcp.port, 'evil.example')).status, 403);
    assert.equal((await initialize(mcp.port, 'evil.example:8734')).status, 403);
  });

  test('Antworten von /mcp verbieten NGINX das Puffern und Zwischenspeichern', async () => {
    const { headers } = await initialize(mcp.port, 'mcp.example.com');
    assert.equal(headers['x-accel-buffering'], 'no');
    assert.match(String(headers['cache-control']), /no-store|no-cache/);
  });

  test('auch abgelehnte Requests werden nicht zwischengespeichert', async () => {
    const response = await fetch(`${mcp.url}/mcp`, { method: 'POST' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
