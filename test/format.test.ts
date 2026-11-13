import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesFromIso, datesToIso, parseFilter } from '../src/weclapp/format.ts';
import { loadWeclappConfig } from '../src/config.ts';
import { bearerToken } from '../src/http.ts';

test('datesToIso wandelt nur Felder auf "Date" um', () => {
  assert.deepEqual(datesToIso({ createdDate: 0, durationSeconds: 60, items: [{ servicePeriodFromDate: 86_400_000 }] }), {
    createdDate: '1970-01-01T00:00:00.000Z',
    durationSeconds: 60,
    items: [{ servicePeriodFromDate: '1970-01-02T00:00:00.000Z' }],
  });
});

test('datesFromIso wandelt ISO-Strings zurück und meldet Unsinn', () => {
  assert.deepEqual(datesFromIso({ endDate: '1970-01-02', name: 'x' }), { endDate: 86_400_000, name: 'x' });
  assert.throws(() => datesFromIso({ endDate: 'morgen' }), /kein gültiges Datum/);
});

test('parseFilter erlaubt nur echte weclapp-Filter', () => {
  assert.deepEqual(parseFilter('name-ilike=%a%&active-eq=true'), { 'name-ilike': '%a%', 'active-eq': 'true' });
  assert.throws(() => parseFilter('pageSize=1000'), /Ungültiger Filter/);
  assert.deepEqual(parseFilter('customerNumber-null'), { 'customerNumber-null': '' });
});

test('loadWeclappConfig baut die URL aus dem Mandanten und prüft ihn', () => {
  assert.equal(loadWeclappConfig({ WECLAPP_TENANT: 'acme' }).baseUrl, 'https://acme.weclapp.com/webapp/api/v2');
  assert.equal(loadWeclappConfig({ WECLAPP_TENANT: 'acme', WECLAPP_READ_ONLY: 'true' }).readOnly, true);
  assert.throws(() => loadWeclappConfig({ WECLAPP_TENANT: 'evil.com/x' }), /ungültig/);
  assert.throws(() => loadWeclappConfig({}), /WECLAPP_TENANT fehlt/);
});

test('bearerToken liest nur echte Bearer-Header mit zulässigen Zeichen', () => {
  assert.equal(bearerToken('Bearer abc-12345'), 'abc-12345');
  assert.equal(bearerToken('bearer abc-12345'), 'abc-12345');
  assert.equal(bearerToken('Basic abc-12345'), undefined);
  assert.equal(bearerToken('Bearer kurz'), undefined);
  assert.equal(bearerToken('Bearer abc-12345\r\nX-Evil: 1'), undefined);
  assert.equal(bearerToken(`Bearer ${'a'.repeat(513)}`), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test('loadWeclappConfig: sichere Standardwerte und Prüfung der Basis-URL', () => {
  const config = loadWeclappConfig({ WECLAPP_TENANT: 'acme' });
  assert.equal(config.allowPublicComments, false);
  assert.equal(config.auditDir, undefined);
  assert.equal(config.auditRetentionDays, 365);
  assert.throws(() => loadWeclappConfig({ WECLAPP_BASE_URL: 'http://evil.example/api' }), /https/);
  assert.throws(() => loadWeclappConfig({ WECLAPP_BASE_URL: 'https://user:pw@acme.weclapp.com/webapp/api/v2' }), /Zugangsdaten/);
  assert.equal(loadWeclappConfig({ WECLAPP_BASE_URL: 'http://127.0.0.1:1234/webapp/api/v2' }).baseUrl, 'http://127.0.0.1:1234/webapp/api/v2');
});
