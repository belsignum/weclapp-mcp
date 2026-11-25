import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import { connect, json, startMcp, text } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

type Mock = Awaited<ReturnType<typeof startMockWeclapp>>;

describe('HTTP-Server mit Bearer-Weitergabe', () => {
  let mock: Mock;
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let anna: Client;

  before(async () => {
    mock = await startMockWeclapp();
    mcp = await startMcp(mock.baseUrl, { allowPublicComments: true });
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
    assert.deepEqual(await response.json(), { status: 'ok' });
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

  test('listet alle 22 Tools', async () => {
    const { tools } = await anna.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.equal(names.length, 22, names.join(', '));
    for (const name of ['weclapp_search_articles', 'weclapp_create_article', 'weclapp_update_article', 'weclapp_search_sales_invoices', 'weclapp_get_ticket', 'weclapp_create_ticket', 'weclapp_update_ticket', 'weclapp_book_time', 'weclapp_update_contract', 'weclapp_list_changes', 'weclapp_undo_change']) {
      assert.ok(names.includes(name), `${name} fehlt`);
    }
    const update = tools.find((t) => t.name === 'weclapp_update_ticket');
    assert.equal(update?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'weclapp_get_ticket')?.annotations?.readOnlyHint, true);
  });

  test('reicht den Token des jeweiligen Requests an weclapp weiter', async () => {
    const ben = await connect(mcp.url, 'token-ben');
    try {
      assert.equal(json(await anna.callTool({ name: 'weclapp_whoami', arguments: {} })).firstName, 'Anna');
      assert.equal(json(await ben.callTool({ name: 'weclapp_whoami', arguments: {} })).firstName, 'Ben');
      mock.requests.length = 0;
      await anna.callTool({ name: 'weclapp_get_article', arguments: { id: '1' } });
      await ben.callTool({ name: 'weclapp_get_article', arguments: { id: '1' } });
      assert.deepEqual(mock.requests.map((r) => `${r.token} ${r.path}`), ['token-anna /article/id/1', 'token-ben /article/id/1']);
    } finally {
      await ben.close();
    }
  });

  test('ungültiger Token wird schon am Eingang mit 401 abgewiesen', async () => {
    await assert.rejects(connect(mcp.url, 'falscher-token'), /401|Unauthorized|erforderlich/i);
  });

  test('Artikelsuche: ODER-Suche, kompakte Felder, ISO-Datum', async () => {
    mock.requests.length = 0;
    const data = json(await anna.callTool({ name: 'weclapp_search_articles', arguments: { query: 'wartung', active: true } }));
    const queries = mock.requests.filter((r) => r.path === '/article').map((r) => r.query);
    assert.equal(queries.length, 1, 'eine Abfrage: die ODER-Verknüpfung übernimmt weclapp');
    assert.equal(queries[0]['or-name-ilike'], '%wartung%');
    assert.equal(queries[0]['or-articleNumber-ilike'], '%wartung%');
    assert.ok(queries[0]['active-eq'] === 'true' && queries[0].properties?.includes('articleNumber'));
    assert.equal(data.result.length, 1);
    assert.equal(data.result[0].lastModifiedDate, '2026-01-01T00:00:00.000Z');
  });

  test('ODER-Suche über mehrere Seiten: kein Treffer geht verloren, die Sortierung gilt für alle', async () => {
    const pad = (n: number) => String(n).padStart(3, '0');
    const own = await startMockWeclapp();
    const server = await startMcp(own.baseUrl);
    const client = await connect(server.url, 'token-anna');
    try {
      // 20 Artikel passen im Namen, 20 andere in der Nummer
      own.data.article = [
        ...Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), articleNumber: `Z-${pad(i)}`, name: `Kabel ${pad(i)}` })),
        ...Array.from({ length: 20 }, (_, i) => ({ id: String(200 + i), articleNumber: `KABEL-${pad(i)}`, name: `Stecker ${pad(i)}` })),
      ];
      const first = json(await client.callTool({ name: 'weclapp_search_articles', arguments: { query: 'kabel' } }));
      const second = json(await client.callTool({ name: 'weclapp_search_articles', arguments: { query: 'kabel', page: 2 } }));
      assert.deepEqual([first.count, first.hasMore, second.count, second.hasMore], [25, true, 15, false]);
      const numbers = [...first.result, ...second.result].map((article: { articleNumber: string }) => article.articleNumber);
      assert.equal(new Set(numbers).size, 40, 'alle 40 Treffer, keiner doppelt');
      assert.deepEqual(numbers, [...numbers].sort(), 'nach Artikelnummer sortiert, über beide Seiten hinweg');
    } finally {
      await client.close();
      await server.close();
      await own.close();
    }
  });

  test('Artikel anlegen: Standard-Steuersatz wird gesetzt', async () => {
    const created = json(await anna.callTool({ name: 'weclapp_create_article', arguments: { articleNumber: 'A-2000', name: 'Neu', articleType: 'BASIC', unitId: '8' } }));
    assert.match(created.changeId, /^[0-9a-f-]{36}$/);
    assert.equal(created.result.id, '1000');
    assert.equal(created.result.taxRateType, 'STANDARD');
  });

  test('Artikel ändern: PUT mit ignoreMissingProperties, version und dryRun', async () => {
    mock.requests.length = 0;
    const updated = json(await anna.callTool({ name: 'weclapp_update_article', arguments: { id: '1', fields: { name: 'Wartung (neu)' }, version: '3', dryRun: true } }));
    const put = mock.requests.find((r) => r.method === 'PUT');
    assert.equal(put?.path, '/article/id/1');
    assert.equal(put?.query.ignoreMissingProperties, 'true');
    assert.equal(put?.query.dryRun, 'true');
    assert.deepEqual(put?.body, { name: 'Wartung (neu)', version: '3' });
    assert.equal(updated.dryRun, true);
    assert.equal(updated.changeId, undefined, 'dryRun wird nicht protokolliert');
    assert.equal(updated.result.name, 'Wartung (neu)');
    assert.equal(mock.data.article[0].name, 'Wartungsstunde', 'dryRun ändert nichts');
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
    json(await anna.callTool({ name: 'weclapp_update_contract', arguments: { id: '60', fields: { endDate: '2026-12-31', contractItems: [{ id: '601', servicePeriodToDate: '2026-12-31T00:00:00Z' }] } } }));
    const body = mock.requests.find((r) => r.method === 'PUT')!.body as any;
    assert.equal(body.endDate, Date.parse('2026-12-31'));
    assert.equal(body.contractItems[0].servicePeriodToDate, Date.parse('2026-12-31T00:00:00Z'));
    assert.equal(body.version, '2', 'schreibt mit der zuvor gelesenen Version');
  });

  test('ungültige Filter werden abgelehnt, bevor weclapp gefragt wird', async () => {
    mock.requests.length = 0;
    const result = await anna.callTool({ name: 'weclapp_search_contracts', arguments: { filter: 'properties=id' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Ungültiger Filter/);
    assert.equal(mock.requests.length, 0);
  });

  test('Filter "null" und "notnull" erreichen weclapp auch ohne Wert', async () => {
    // Das Ticket des Nachbaus hat keinen zugewiesenen Nutzer
    for (const [filter, expected] of [['assignedUserId-null', 1], ['assignedUserId-null=', 1], ['assignedUserId-notnull', 0]] as const) {
      mock.requests.length = 0;
      const data = json(await anna.callTool({ name: 'weclapp_search_tickets', arguments: { filter } }));
      const query = mock.requests.find((r) => r.path === '/ticket')!.query;
      assert.equal(query[filter.replace('=', '')], 'true', `${filter} wird gesendet`);
      assert.equal(data.count, expected, filter);
    }
    mock.requests.length = 0;
    const empty = await anna.callTool({ name: 'weclapp_search_tickets', arguments: { filter: 'assignedUserId-eq=' } });
    assert.equal(empty.isError, true);
    assert.match(text(empty), /braucht einen Wert/);
    assert.equal(mock.requests.length, 0);
  });

  test('Stammdaten-Suche filtert nach Namen', async () => {
    const data = json(await anna.callTool({ name: 'weclapp_lookup', arguments: { resource: 'unit', query: 'stun' } }));
    assert.deepEqual(data.result.map((u: { name: string }) => u.name), ['Stunde']);
  });

  test('Ticket-Prioritäten nachschlagen', async () => {
    mock.requests.length = 0;
    const data = json(await anna.callTool({ name: 'weclapp_lookup', arguments: { resource: 'ticketPriority', query: 'norm' } }));
    assert.deepEqual(data.result, [{ id: '9', name: 'Normal', active: true, positionNumber: 2 }]);
    const request = mock.requests.find((r) => r.path === '/ticketPriority')!;
    assert.equal(request.query.properties, 'id,name,active,positionNumber');
  });
});

describe('Nur-Lesen-Modus', () => {
  async function toolNames(options: Parameters<typeof startMcp>[1]) {
    const mock = await startMockWeclapp();
    const mcp = await startMcp(mock.baseUrl, options);
    const client = await connect(mcp.url, 'token-anna');
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await mcp.close();
      await mock.close();
    }
  }

  test('ohne Änderungsprotokoll gibt es keine Schreib-Tools', async () => {
    const tools = await toolNames({ withAudit: false });
    assert.equal(tools.length, 12);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  });

  test('readOnly mit Protokoll: nur lesen, Protokoll bleibt einsehbar', async () => {
    const tools = await toolNames({ readOnly: true });
    assert.equal(tools.length, 13);
    assert.ok(tools.some((t) => t.name === 'weclapp_list_changes'));
    assert.ok(!tools.some((t) => t.name === 'weclapp_undo_change'));
  });
});
