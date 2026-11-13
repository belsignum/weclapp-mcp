/**
 * Angriffstests: jeder Test spielt einen konkreten Angriff durch und prüft, dass er scheitert.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/client';
import { FailureLimiter, TokenVerifier } from '../src/auth.ts';
import { WeclappClient } from '../src/weclapp/client.ts';
import { connect, json, rawPost, startMcp, text } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

type Mock = Awaited<ReturnType<typeof startMockWeclapp>>;

/** POST mit frei wählbaren Headern (fetch erlaubt z. B. keinen eigenen Host-Header). */
function post(port: number, headers: Record<string, string>, body = '{}'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('Zugang ohne gültigen Token', () => {
  let mock: Mock;
  let mcp: Awaited<ReturnType<typeof startMcp>>;

  before(async () => {
    mock = await startMockWeclapp();
    mcp = await startMcp(mock.baseUrl, { maxAuthFailures: 1000 });
  });
  after(async () => {
    await mcp.close();
    await mock.close();
  });

  test('erfundener Token: 401, keine Tool-Liste', async () => {
    const response = await rawPost(mcp.url, { token: 'irgendein-token' });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes('weclapp_'));
  });

  test('kein Token, leerer Token, falsches Schema, Zeilenumbruch im Token: 401', async () => {
    assert.equal((await rawPost(mcp.url)).status, 401);
    assert.equal(await post(mcp.port, { Authorization: 'Bearer ' }), 401);
    assert.equal(await post(mcp.port, { Authorization: 'Basic dG9rZW4tYW5uYQ==' }), 401);
    assert.equal(await post(mcp.port, { Authorization: 'Bearer token-anna token-ben' }), 401);
    assert.equal(await post(mcp.port, { Authorization: `Bearer ${'a'.repeat(5000)}` }), 401);
  });

  test('derselbe falsche Token belastet weclapp nur einmal', async () => {
    mock.requests.length = 0;
    for (let i = 0; i < 5; i++) assert.equal((await rawPost(mcp.url, { token: 'immer-derselbe' })).status, 401);
    assert.equal(mock.requests.length, 1);
  });

  test('GET und DELETE auf /mcp brauchen ebenfalls einen Token', async () => {
    assert.equal((await fetch(`${mcp.url}/mcp`)).status, 401);
    assert.equal((await fetch(`${mcp.url}/mcp`, { method: 'DELETE' })).status, 401);
  });

  test('Healthcheck verrät weder Version noch Konfiguration', async () => {
    assert.deepEqual(await (await fetch(`${mcp.url}/health`)).json(), { status: 'ok' });
  });

  test('fremder Host- oder Origin-Header: 403, auch mit gültigem Token', async () => {
    assert.equal(await post(mcp.port, { Host: 'evil.example', Authorization: 'Bearer token-anna' }), 403);
    assert.equal(await post(mcp.port, { Origin: 'https://evil.example', Authorization: 'Bearer token-anna' }), 403);
  });

  test('zu großer Request: 413', async () => {
    const response = await rawPost(mcp.url, { token: 'token-anna', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1_100_000) } }) });
    assert.equal(response.status, 413);
  });

  test('weclapp nicht erreichbar: 503 statt Durchlassen', async () => {
    const down = await startMcp('http://127.0.0.1:9/webapp/api/v2', { withAudit: false });
    try {
      assert.equal((await rawPost(down.url, { token: 'token-anna' })).status, 503);
    } finally {
      await down.close();
    }
  });
});

describe('Brute-Force-Schutz', () => {
  test('nach zu vielen Fehlversuchen: 429, weclapp wird nicht mehr gefragt', async () => {
    const mock = await startMockWeclapp();
    const mcp = await startMcp(mock.baseUrl, { maxAuthFailures: 5, withAudit: false });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await rawPost(mcp.url, { token: `geraten-${i}-xxxx` })).status, 401);
      mock.requests.length = 0;
      const blocked = await rawPost(mcp.url, { token: 'geraten-6-xxxx' });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      assert.equal(mock.requests.length, 0);
    } finally {
      await mcp.close();
      await mock.close();
    }
  });

  test('gefälschtes X-Forwarded-For umgeht die Sperre nicht', async () => {
    const mock = await startMockWeclapp();
    const mcp = await startMcp(mock.baseUrl, { maxAuthFailures: 3, trustProxy: true, withAudit: false });
    try {
      // Ein Proxy hängt die echte Adresse hinten an; davor kann der Angreifer beliebig lügen
      const attempt = (i: number) => rawPost(mcp.url, { token: `geraten-${i}-xxxx`, headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` } });
      for (let i = 0; i < 3; i++) assert.equal((await attempt(i)).status, 401);
      assert.equal((await attempt(99)).status, 429);
      const other = await rawPost(mcp.url, { token: 'token-anna', headers: { 'X-Forwarded-For': '203.0.113.8' } });
      assert.equal(other.status, 200, 'andere Adressen sind nicht betroffen');
    } finally {
      await mcp.close();
      await mock.close();
    }
  });

  test('ohne trustProxy wird X-Forwarded-For ignoriert', async () => {
    const mock = await startMockWeclapp();
    const mcp = await startMcp(mock.baseUrl, { maxAuthFailures: 3, withAudit: false });
    try {
      for (let i = 0; i < 3; i++) await rawPost(mcp.url, { token: `geraten-${i}-xxxx`, headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
      assert.equal((await rawPost(mcp.url, { token: 'geraten-9-xxxx', headers: { 'X-Forwarded-For': '10.9.9.9' } })).status, 429);
    } finally {
      await mcp.close();
      await mock.close();
    }
  });

  test('FailureLimiter gibt nach Ablauf des Fensters wieder frei', () => {
    let now = 0;
    const limiter = new FailureLimiter({ max: 2, windowMs: 1000, now: () => now });
    limiter.fail('a');
    assert.equal(limiter.blockedFor('a'), 0);
    limiter.fail('a');
    assert.equal(limiter.blockedFor('a'), 1);
    assert.equal(limiter.blockedFor('b'), 0);
    now = 1001;
    assert.equal(limiter.blockedFor('a'), 0);
  });

  test('TokenVerifier: gültige Tokens 5 Minuten, ungültige 1 Minute im Cache', async () => {
    const mock = await startMockWeclapp();
    let now = 0;
    const verifier = new TokenVerifier(mock.baseUrl, { now: () => now });
    try {
      assert.equal((await verifier.verify('token-anna')).ok, true);
      assert.equal((await verifier.verify('token-anna')).ok, true);
      assert.equal((await verifier.verify('falscher-token')).ok, false);
      assert.equal(mock.requests.length, 2);
      now = 61_000;
      await verifier.verify('falscher-token');
      await verifier.verify('token-anna');
      assert.equal(mock.requests.length, 3);
      now = 301_000;
      await verifier.verify('token-anna');
      assert.equal(mock.requests.length, 4, 'ein widerrufener Token fliegt nach spätestens 5 Minuten raus');
    } finally {
      await mock.close();
    }
  });
});

describe('Angriffe mit gültigem Token (z. B. durch manipulierte Ticket-Texte)', () => {
  let mock: Mock;
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let anna: Client;

  before(async () => {
    mock = await startMockWeclapp();
    mcp = await startMcp(mock.baseUrl);
    anna = await connect(mcp.url, 'token-anna');
  });
  after(async () => {
    await anna.close();
    await mcp.close();
    await mock.close();
  });

  const call = (name: string, args: Record<string, unknown>) => anna.callTool({ name, arguments: args });

  test('Pfad-Manipulation über die ID erreicht weclapp nicht', async () => {
    for (const id of ['..', '../../user/currentUser', '1/../2', '1?dryRun=true', '1#x', '%2e%2e', ' 1', '']) {
      mock.requests.length = 0;
      for (const [name, args] of [
        ['weclapp_get_article', { id }],
        ['weclapp_update_ticket', { id, fields: { subject: 'x' } }],
        ['weclapp_get_ticket', { id }],
        ['weclapp_book_time', { ticketId: id, minutes: 5, description: 'x' }],
      ] as const) {
        const result = await call(name, args);
        assert.equal(result.isError, true, `${name} mit id ${JSON.stringify(id)}`);
      }
      assert.equal(mock.requests.length, 0, `id ${JSON.stringify(id)} hat weclapp erreicht`);
    }
  });

  test('der weclapp-Client selbst lehnt manipulierte IDs und Pfade ab', async () => {
    const client = new WeclappClient(mock.baseUrl, 'token-anna');
    await assert.rejects(client.get('article', '..'), /Ungültige weclapp-ID/);
    await assert.rejects(client.delete('article', '1/../../user'), /Ungültige weclapp-ID/);
    await assert.rejects(client.get('../user', '1'), /Ungültiger weclapp-Datentyp/);
    await assert.rejects(client.request('GET', '/article/../../../admin'), /Ungültiger weclapp-Pfad/);
    assert.throws(() => new WeclappClient(mock.baseUrl, 'token\r\nX-Evil: 1'), /unzulässige Zeichen/);
  });

  test('fields kann weder id noch version noch den Prototyp setzen', async () => {
    mock.requests.length = 0;
    json(await call('weclapp_update_article', { id: '1', fields: JSON.parse('{"id":"999","version":"0","createdDate":"2020-01-01","__proto__":{"polluted":true},"constructor":{"x":1},"name":"ok"}') }));
    const put = mock.requests.find((r) => r.method === 'PUT')!;
    assert.equal(put.path, '/article/id/1');
    assert.deepEqual(put.body, { name: 'ok', version: '3' });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test('Filter und Sortierung können keine fremden Parameter einschleusen', async () => {
    mock.requests.length = 0;
    assert.equal((await call('weclapp_search_articles', { filter: 'pageSize=1000' })).isError, true);
    assert.equal((await call('weclapp_search_articles', { filter: 'properties-eq=x&dryRun=true' })).isError, true);
    assert.equal((await call('weclapp_search_articles', { sort: 'name&pageSize=1000' })).isError, true);
    assert.equal((await call('weclapp_search_articles', { pageSize: 100000 })).isError, true);
    assert.equal((await call('weclapp_search_articles', { filter: 'name-eq=a&b=c' })).isError, true);
    assert.equal(mock.requests.length, 0);
    json(await call('weclapp_search_articles', { filter: 'name-eq=x%26pageSize%3D1000' }));
    const query = mock.requests.at(-1)!.query;
    assert.equal(query['name-eq'], 'x%26pageSize%3D1000', 'der Wert bleibt ein Wert');
    assert.equal(query.pageSize, '25');
  });

  test('öffentliche Kommentare sind ohne Freischaltung nicht möglich', async () => {
    mock.requests.length = 0;
    const result = await call('weclapp_add_ticket_comment', { ticketId: '20', text: 'interne Daten', visibility: 'public' });
    assert.equal(result.isError, true);
    assert.equal(mock.requests.filter((r) => r.method === 'POST').length, 0);
    const internal = json(await call('weclapp_add_ticket_comment', { ticketId: '20', text: 'Notiz' }));
    assert.equal(internal.result.publicComment, false);
    assert.equal(internal.result.privateComment, true);
  });

  test('es gibt kein Tool zum Löschen und keinen freien API-Zugriff', async () => {
    const names = (await anna.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => /delete|raw|request|generic/i.test(n)), names.join(', '));
    await assert.rejects(call('weclapp_delete_article', { id: '1' }), /not found/i);
  });

  test('Undo akzeptiert nur echte changeIds', async () => {
    for (const changeId of ['../../etc/passwd', '2026-11', '', "' OR 1=1 --"]) {
      assert.equal((await call('weclapp_undo_change', { changeId })).isError, true);
    }
  });

  test('Fehlermeldungen enthalten keinen Token', async () => {
    const result = await call('weclapp_get_article', { id: '424242' });
    assert.equal(result.isError, true);
    assert.ok(!text(result).includes('token-anna'));
  });
});

describe('Token-Schutz gegenüber weclapp', () => {
  test('Weiterleitungen werden nicht verfolgt (der Token bliebe sonst am Ziel hängen)', async () => {
    let leaked: string | undefined;
    const evil = createServer((req, res) => {
      leaked = req.headers['authenticationtoken'] as string;
      res.end('{}');
    });
    await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve));
    const redirector = createServer((_req, res) => {
      res.writeHead(307, { Location: `http://localhost:${(evil.address() as AddressInfo).port}/steal` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    try {
      const client = new WeclappClient(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}/webapp/api/v2`, 'geheimer-token');
      await assert.rejects(client.get('article', '1'), /nicht erreichbar/);
      assert.equal(leaked, undefined);
    } finally {
      evil.close();
      redirector.close();
    }
  });
});
