import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import { loadWeclappConfig } from '../src/config.ts';
import { datesToIso, setTimeZone, toEpochMs, toEpochMsInclusive } from '../src/weclapp/format.ts';
import { connect, json, startMcp } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

describe('Zeitzone des Mandanten: Umrechnung', () => {
  before(() => setTimeZone('Europe/Berlin'));
  after(() => setTimeZone('UTC'));

  test('ein reines Datum ist Mitternacht beim Mandanten, nicht Mitternacht UTC', () => {
    assert.equal(toEpochMs('2026-11-20'), Date.UTC(2026, 10, 19, 23), 'Winter: +01:00');
    assert.equal(toEpochMs('2026-07-01'), Date.UTC(2026, 5, 30, 22), 'Sommer: +02:00');
  });

  test('eine Uhrzeit ohne Offset gilt beim Mandanten, mit Offset oder Z bleibt sie, wie sie ist', () => {
    assert.equal(toEpochMs('2026-11-12T09:00:00'), Date.UTC(2026, 10, 12, 8));
    assert.equal(toEpochMs('2026-11-12 09:00'), Date.UTC(2026, 10, 12, 8));
    assert.equal(toEpochMs('2026-07-01T09:00'), Date.UTC(2026, 6, 1, 7));
    assert.equal(toEpochMs('2026-11-12T09:00:00Z'), Date.UTC(2026, 10, 12, 9));
    assert.equal(toEpochMs('2026-11-12T09:00:00-05:00'), Date.UTC(2026, 10, 12, 14));
    assert.equal(toEpochMs('2026-11-12T09:00:00.250+05:30'), Date.UTC(2026, 10, 12, 3, 30, 0, 250));
    assert.throws(() => toEpochMs('2026-11-12T09:00:00+25:00'), /kein gültiges Datum/);
  });

  test('"bis einschließlich": ein reines Datum meint den ganzen Tag, auch bei Zeitumstellung', () => {
    assert.equal(toEpochMsInclusive('2026-11-20'), Date.UTC(2026, 10, 20, 23) - 1);
    // 29.03.2026 hat 23 Stunden, 25.10.2026 hat 25
    assert.equal(toEpochMs('2026-03-29'), Date.UTC(2026, 2, 28, 23));
    assert.equal(toEpochMsInclusive('2026-03-29'), Date.UTC(2026, 2, 29, 22) - 1);
    assert.equal(toEpochMs('2026-10-25'), Date.UTC(2026, 9, 24, 22));
    assert.equal(toEpochMsInclusive('2026-10-25'), Date.UTC(2026, 9, 25, 23) - 1);
    assert.equal(toEpochMsInclusive('2026-11-20T12:00:00'), Date.UTC(2026, 10, 20, 11), 'ein Zeitpunkt bleibt ein Zeitpunkt');
  });

  test('die Ausgabe trägt den Offset: der Datumsteil ist der Tag in weclapp', () => {
    const invoiceDate = Date.UTC(2026, 10, 19, 23); // so speichert weclapp den 20.11.2026
    assert.deepEqual(datesToIso({ invoiceDate, items: [{ startDate: Date.UTC(2026, 6, 1, 7, 30) }] }), {
      invoiceDate: '2026-11-20T00:00:00.000+01:00',
      items: [{ startDate: '2026-07-01T09:30:00.000+02:00' }],
    });
    assert.equal(toEpochMs('2026-11-20T00:00:00.000+01:00'), invoiceDate, 'die Ausgabe lässt sich unverändert zurückgeben');
  });

  test('westlich von UTC und UTC selbst', () => {
    setTimeZone('America/New_York');
    assert.equal(toEpochMs('2026-11-20'), Date.UTC(2026, 10, 20, 5));
    assert.deepEqual(datesToIso({ endDate: Date.UTC(2026, 10, 20, 5) }), { endDate: '2026-11-20T00:00:00.000-05:00' });
    setTimeZone('UTC');
    assert.equal(toEpochMs('2026-11-20T09:00'), Date.UTC(2026, 10, 20, 9));
    assert.deepEqual(datesToIso({ endDate: 0 }), { endDate: '1970-01-01T00:00:00.000Z' });
    setTimeZone('Europe/Berlin');
  });
});

test('WECLAPP_TIMEZONE: Standard Europe/Berlin, unbekannte Namen werden beim Start abgelehnt', () => {
  assert.equal(loadWeclappConfig({ WECLAPP_TENANT: 'acme' }).timeZone, 'Europe/Berlin');
  assert.equal(loadWeclappConfig({ WECLAPP_TENANT: 'acme', WECLAPP_TIMEZONE: 'UTC' }).timeZone, 'UTC');
  assert.throws(() => loadWeclappConfig({ WECLAPP_TENANT: 'acme', WECLAPP_TIMEZONE: 'Mitteleuropa' }), /WECLAPP_TIMEZONE/);
});

describe('Zeitzone des Mandanten: Tools', () => {
  let mock: Awaited<ReturnType<typeof startMockWeclapp>>;
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let anna: Client;

  before(async () => {
    mock = await startMockWeclapp();
    // So legt weclapp ein reines Datum ab: Mitternacht beim Mandanten
    mock.data.salesInvoice = [
      { id: '10', invoiceNumber: 'RE-19', invoiceDate: Date.UTC(2026, 10, 18, 23) },
      { id: '11', invoiceNumber: 'RE-20', invoiceDate: Date.UTC(2026, 10, 19, 23) },
      { id: '12', invoiceNumber: 'RE-01-12', invoiceDate: Date.UTC(2026, 10, 30, 23) },
    ];
    mcp = await startMcp(mock.baseUrl, { timeZone: 'Europe/Berlin' });
    anna = await connect(mcp.url, 'token-anna');
  });

  after(async () => {
    await anna?.close();
    await mcp?.close();
    await mock?.close();
  });

  const invoices = async (from: string, to: string) => json(await anna.callTool({ name: 'weclapp_search_sales_invoices', arguments: { invoiceDateFrom: from, invoiceDateTo: to, sort: 'invoiceDate' } })).result;

  test('Rechnungssuche trifft den Tag, der in weclapp steht', async () => {
    assert.deepEqual((await invoices('2026-11-20', '2026-11-20')).map((invoice: { id: string }) => invoice.id), ['11']);
    assert.deepEqual((await invoices('2026-11-19', '2026-11-19')).map((invoice: { id: string }) => invoice.id), ['10']);
    assert.deepEqual((await invoices('2026-11-01', '2026-11-30')).map((invoice: { id: string }) => invoice.id), ['10', '11'], 'der 1.12. gehört nicht zum November');
    assert.equal((await invoices('2026-11-20', '2026-11-20'))[0].invoiceDate, '2026-11-20T00:00:00.000+01:00');
  });

  test('Zeit buchen und Zeiten filtern: Angaben ohne Offset gelten beim Mandanten', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_book_time', arguments: { ticketId: '20', minutes: 30, description: 'Test', start: '2026-11-12T09:00:00' } }));
    assert.equal((mock.requests.find((r) => r.method === 'POST')!.body as { startDate: number }).startDate, Date.UTC(2026, 10, 12, 8));

    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_list_time_records', arguments: { from: '2026-11-01', to: '2026-12-01' } }));
    const query = mock.requests.find((r) => r.path === '/timeRecord')!.query;
    assert.equal(query['startDate-ge'], String(Date.UTC(2026, 9, 31, 23)));
    assert.equal(query['startDate-lt'], String(Date.UTC(2026, 10, 30, 23)));
  });

  test('Datum in fields: Vertragsende landet auf Mitternacht beim Mandanten', async () => {
    mock.requests.length = 0;
    json(await anna.callTool({ name: 'weclapp_update_contract', arguments: { id: '60', fields: { endDate: '2026-12-31' } } }));
    assert.equal((mock.requests.find((r) => r.method === 'PUT')!.body as { endDate: number }).endDate, Date.UTC(2026, 11, 30, 23));
  });

  test('die Hinweise des Servers nennen die Zeitzone', () => {
    assert.match(anna.getInstructions() ?? '', /Zeitzone des Mandanten \(Europe\/Berlin\)/);
  });

  test('ein Server ohne Angabe bleibt bei UTC', async () => {
    const plain = await startMcp(mock.baseUrl);
    const client = await connect(plain.url, 'token-anna');
    try {
      const result = json(await client.callTool({ name: 'weclapp_search_sales_invoices', arguments: { invoiceDateFrom: '2026-11-19', invoiceDateTo: '2026-11-19' } })).result;
      assert.deepEqual(result.map((invoice: { id: string; invoiceDate: string }) => [invoice.id, invoice.invoiceDate]), [['11', '2026-11-19T23:00:00.000Z']]);
      assert.match(client.getInstructions() ?? '', /in UTC/);
    } finally {
      await client.close();
      await plain.close();
    }
  });
});
