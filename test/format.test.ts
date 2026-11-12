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

test('bearerToken liest nur echte Bearer-Header', () => {
  assert.equal(bearerToken('Bearer abc-123'), 'abc-123');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Basic abc'), undefined);
  assert.equal(bearerToken(undefined), undefined);
});
