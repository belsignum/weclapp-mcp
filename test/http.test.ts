import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../src/http.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

type Mock = Awaited<ReturnType<typeof startMockWeclapp>>;

async function startMcp(baseUrl: string, readOnly = false) {
  const { server, close } = createHttpServer({ config: { baseUrl, readOnly }, allowedHosts: [], log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close };
}

async function connect(url: string, token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
}

function json(result: Awaited<ReturnType<Client['callTool']>>): any {
  assert.ok(!result.isError, `Tool-Fehler: ${text(result)}`);
  return JSON.parse(text(result));
}

describe('HTTP-Server mit Bearer-Weitergabe', () => {
  let mock: Mock;
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let anna: Client;

  before(async () => {
    mock = await startMockWeclapp();
    mcp = await startMcp(mock.baseUrl);
    anna = await connect(mcp.url, 'token-anna');
  });

  after(async () => {
    await anna?.close();
    await mcp?.close();
    await mock?.close();
  });

  test('ohne Bearer-Token antwortet der Server mit 401', async () => {
    const response = await fetch(`${mcp.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer/);
  });

  test('Healthcheck braucht keinen Token', async () => {
    const response = await fetch(`${mcp.url}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  });

  test('fremder Host-Header wird abgelehnt (DNS-Rebinding-Schutz)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${mcp.url}/mcp`);
      const req = request({ host: url.hostname, port: url.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: 'Bearer token-anna', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
  });

  test('listet alle 19 Tools', async () => {
    const { tools } = await anna.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.equal(names.length, 19, names.join(', '));
    for (const name of ['weclapp_search_articles', 'weclapp_create_article', 'weclapp_update_article', 'weclapp_search_sales_invoices', 'weclapp_get_ticket', 'weclapp_update_ticket', 'weclapp_book_time', 'weclapp_update_contract']) {
      assert.ok(names.includes(name), `${name} fehlt`);
    }
    const update = tools.find((t) => t.name === 'weclapp_update_ticket');
    assert.equal(update?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'weclapp_get_ticket')?.annotations?.readOnlyHint, true);
  });

  test('reicht den Token des jeweiligen Requests an weclapp weiter', async () => {
    const ben = await connect(mcp.url, 'token-ben');
    try {
      mock.requests.length = 0;
      assert.equal(json(await anna.callTool({ name: 'weclapp_whoami', arguments: {} })).firstName, 'Anna');
      assert.equal(json(await ben.callTool({ name: 'weclapp_whoami', arguments: {} })).firstName, 'Ben');
      assert.deepEqual(mock.requests.map((r) => r.token), ['token-anna', 'token-ben']);
    } finally {
      await ben.close();
    }
  });

  test('ungültiger Token liefert eine verständliche Fehlermeldung', async () => {
    const eve = await connect(mcp.url, 'falsch');
    try {
      const result = await eve.callTool({ name: 'weclapp_whoami', arguments: {} });
      assert.equal(result.isError, true);
      assert.match(text(result), /API-Token abgelehnt \(401\)/);
    } finally {
      await eve.close();
    }
  });

  test('Artikelsuche: ODER-Suche, kompakte Felder, ISO-Datum', async () => {
    mock.requests.length = 0;
    const data = json(await anna.callTool({ name: 'weclapp_search_articles', arguments: { query: 'wartung', active: true } }));
    const queries = mock.requests.filter((r) => r.path === '/article').map((r) => r.query);
    assert.equal(queries.length, 2);
    assert.ok(queries.some((q) => q['name-ilike'] === '%wartung%'));
    assert.ok(queries.some((q) => q['articleNumber-ilike'] === '%wartung%'));
    assert.ok(queries.every((q) => q['active-eq'] === 'true' && q.properties?.includes('articleNumber')));
    assert.equal(data.result.length, 1, 'Treffer aus beiden Abfragen werden zusammengeführt');
    assert.equal(data.result[0].lastModifiedDate, '2026-01-01T00:00:00.000Z');
  });

  test('Artikel anlegen: Standard-Steuersatz wird gesetzt', async () => {
    const created = json(await anna.callTool({ name: 'weclapp_create_article', arguments: { articleNumber: 'A-2000', name: 'Neu', articleType: 'BASIC', unitId: '8' } }));
    assert.equal(created.id, '999');
    assert.equal(created.taxRateType, 'STANDARD');
  });

  test('Artikel ändern: PUT mit ignoreMissingProperties, version und dryRun', async () => {
    mock.requests.length = 0;
    const updated = json(await anna.callTool({ name: 'weclapp_update_article', arguments: { id: '1', fields: { name: 'Wartung (neu)' }, version: '3', dryRun: true } }));
    const put = mock.requests.find((r) => r.method === 'PUT');
    assert.equal(put?.path, '/article/id/1');
    assert.equal(put?.query.ignoreMissingProperties, 'true');
    assert.equal(put?.query.dryRun, 'true');
    assert.deepEqual(put?.body, { name: 'Wartung (neu)', version: '3' });
    assert.equal(updated.name, 'Wartung (neu)');
  });

  test('veraltete version führt zu einem Konfliktfehler', async () => {
    const result = await anna.callTool({ name: 'weclapp_update_ticket', arguments: { id: '20', fields: { subject: 'x' }, version: '1' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /409.*optimistic lock/);
  });

  test('Rechnungssuche: Datumsbereich wird in Epoch-ms übersetzt, Ende inklusive', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_search_sales_invoices', arguments: { invoiceDateFrom: '2026-01-01', invoiceDateTo: '2026-01-31', paymentStatus: 'OPEN' } }));
    const q = mock.requests.find((r) => r.path === '/salesInvoice')!.query;
    assert.equal(q['invoiceDate-ge'], String(Date.parse('2026-01-01')));
    assert.equal(q['invoiceDate-le'], String(Date.parse('2026-01-31') + 86_399_999));
    assert.equal(q['paymentStatus-eq'], 'OPEN');
    assert.equal(q.sort, '-invoiceDate');
  });

  test('Ticketsuche "nur offene, mir zugewiesen" löst Status und Nutzer auf', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_search_tickets', arguments: { openOnly: true, assignedToMe: true } }));
    const q = mock.requests.find((r) => r.path === '/ticket')!.query;
    assert.equal(q['ticketStatusId-in'], '[1,2]');
    assert.equal(q['assignedUserId-eq'], '100');
  });

  test('Ticket lesen liefert Kommentare und Zeiten mit Summe', async () => {
    mock.requests.length = 0;
    const data = json(await anna.callTool({ name: 'weclapp_get_ticket', arguments: { id: '20' } }));
    assert.equal(data.ticket.ticketNumber, 'T-42');
    assert.equal(data.comments.length, 1);
    assert.equal(data.totalBookedMinutes, 30);
    const commentQuery = mock.requests.find((r) => r.path === '/comment')!.query;
    assert.equal(commentQuery.entityName, 'ticket');
    assert.equal(commentQuery.entityId, '20');
  });

  test('Zeit buchen: Minuten → Sekunden, Nutzer aus dem Token', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_book_time', arguments: { ticketId: '20', minutes: 45, description: 'Treiber neu installiert', start: '2026-11-12T09:00:00+01:00', billableMinutes: 30 } }));
    const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/timeRecord');
    assert.deepEqual(post?.body, {
      ticketId: '20',
      userId: '100',
      startDate: Date.parse('2026-11-12T09:00:00+01:00'),
      durationSeconds: 2700,
      billableDurationSeconds: 1800,
      description: 'Treiber neu installiert',
    });
  });

  test('Ticket-Kommentar: interne und öffentliche Sichtbarkeit', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_add_ticket_comment', arguments: { ticketId: '20', text: 'Intern' } }));
    json(await anna.callTool({ name: 'weclapp_add_ticket_comment', arguments: { ticketId: '20', text: '<p>Hallo</p>', visibility: 'public', html: true } }));
    const [internal, pub] = mock.requests.filter((r) => r.path === '/comment' && r.method === 'POST').map((r) => r.body as Record<string, unknown>);
    assert.deepEqual(internal, { entityName: 'ticket', entityId: '20', comment: 'Intern', privateComment: true, publicComment: false, solution: false });
    assert.equal(pub.htmlComment, '<p>Hallo</p>');
    assert.equal(pub.publicComment, true);
    assert.equal(pub.privateComment, false);
  });

  test('Vertrag ändern: ISO-Datum in fields wird zu Epoch-ms', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_update_contract', arguments: { id: '60', fields: { endDate: '2026-12-31', contractItems: [{ id: '1', servicePeriodToDate: '2026-12-31T00:00:00Z' }] } } }));
    const body = mock.requests.find((r) => r.method === 'PUT')!.body as any;
    assert.equal(body.endDate, Date.parse('2026-12-31'));
    assert.equal(body.contractItems[0].servicePeriodToDate, Date.parse('2026-12-31T00:00:00Z'));
  });

  test('ungültige Filter werden abgelehnt, bevor weclapp gefragt wird', async () => {
    mock.requests.length = 0;
    const result = await anna.callTool({ name: 'weclapp_search_contracts', arguments: { filter: 'properties=id' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Ungültiger Filter/);
    assert.equal(mock.requests.length, 0);
  });

  test('Stammdaten-Suche filtert nach Namen', async () => {
    const data = json(await anna.callTool({ name: 'weclapp_lookup', arguments: { resource: 'unit', query: 'stun' } }));
    assert.deepEqual(data.result.map((u: { name: string }) => u.name), ['Stunde']);
  });
});

describe('Nur-Lesen-Modus', () => {
  test('bietet keine Schreib-Tools an', async () => {
    const mock = await startMockWeclapp();
    const mcp = await startMcp(mock.baseUrl, true);
    const client = await connect(mcp.url, 'token-anna');
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 12);
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    } finally {
      await client.close();
      await mcp.close();
      await mock.close();
    }
  });
});
