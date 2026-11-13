import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailureLimiter, rateLimitKey } from '../src/auth.ts';
import { WriteBudget } from '../src/budget.ts';
import { loadWeclappConfig } from '../src/config.ts';
import { toEpochMs } from '../src/weclapp/format.ts';

test('rateLimitKey: IPv4 unverändert, IPv6 als /64-Netz, alles andere abgelehnt', () => {
  assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(rateLimitKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('[2001:db8:1:2::1]'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKey('::1'), '0:0:0:0::/64');
  assert.equal(rateLimitKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('2001:db8:1:3::1'));
  for (const junk of [undefined, '', 'unknown', 'evil.example', '1.2.3', '1.2.3.4.5', '203.0.113.7:1234', '2001:db8:::1', `${'a'.repeat(5000)}`]) {
    assert.equal(rateLimitKey(junk), undefined, String(junk).slice(0, 30));
  }
});

test('FailureLimiter: laufende Versuche zählen mit, derselbe Versuch nur einmal', () => {
  const limiter = new FailureLimiter({ max: 3, windowMs: 1000, now: () => 0 });
  assert.equal(limiter.begin('ip', 'a'), true);
  assert.equal(limiter.begin('ip', 'a'), true, 'derselbe Token parallel');
  assert.equal(limiter.begin('ip', 'b'), true);
  assert.equal(limiter.begin('ip', 'c'), true);
  assert.equal(limiter.begin('ip', 'd'), false, 'drei verschiedene Versuche laufen schon');
  assert.equal(limiter.begin('andere', 'd'), true);

  limiter.end('ip', 'a', false);
  assert.equal(limiter.begin('ip', 'd'), false, 'a läuft noch einmal');
  limiter.end('ip', 'a', false);
  assert.equal(limiter.begin('ip', 'd'), true, 'ein erfolgreicher Versuch gibt seinen Platz frei');

  limiter.end('ip', 'b', true);
  limiter.end('ip', 'c', true);
  limiter.end('ip', 'd', true);
  assert.ok(limiter.blockedFor('ip') > 0);
  assert.equal(limiter.begin('ip', 'e'), false);
});

test('WriteBudget: Kontingent pro Nutzer und Stunde, Rückgängig getrennt, 0 = unbegrenzt', () => {
  let now = 0;
  const budget = new WriteBudget(2, { now: () => now });
  budget.take('100');
  now = 10 * 60_000;
  budget.take('100');
  assert.throws(() => budget.take('100'), /Schreiblimit erreicht.*etwa 50 Minuten/);
  budget.take('200');
  budget.take('100', 'undo');
  budget.take('100', 'undo');
  assert.throws(() => budget.take('100', 'undo'), /Rückgängig-Aktionen/);
  now = 60 * 60_000 + 1;
  budget.take('100');
  assert.throws(() => budget.take('100'), /Schreiblimit/);

  const unlimited = new WriteBudget(0);
  for (let i = 0; i < 1000; i++) unlimited.take('100');
});

test('loadWeclappConfig: Schreiblimit und Protokollgröße mit sicheren Standardwerten', () => {
  const config = loadWeclappConfig({ WECLAPP_TENANT: 'acme' });
  assert.equal(config.maxWritesPerHour, 120);
  assert.equal(config.auditMaxBytes, 100 * 1024 * 1024);
  const custom = loadWeclappConfig({ WECLAPP_TENANT: 'acme', WECLAPP_MAX_WRITES_PER_HOUR: '0', WECLAPP_AUDIT_MAX_MB: '5' });
  assert.equal(custom.maxWritesPerHour, 0);
  assert.equal(custom.auditMaxBytes, 5 * 1024 * 1024);
  assert.throws(() => loadWeclappConfig({ WECLAPP_TENANT: 'acme', WECLAPP_MAX_WRITES_PER_HOUR: 'viele' }), /WECLAPP_MAX_WRITES_PER_HOUR/);
  assert.throws(() => loadWeclappConfig({ WECLAPP_TENANT: 'acme', WECLAPP_AUDIT_MAX_MB: '-1' }), /WECLAPP_AUDIT_MAX_MB/);
});

test('toEpochMs: nur ISO-8601 und Epoch-Millisekunden', () => {
  assert.equal(toEpochMs('2026-11-12'), Date.UTC(2026, 10, 12));
  assert.equal(toEpochMs(' 2026-11-12T09:30:00+01:00 '), Date.UTC(2026, 10, 12, 8, 30));
  assert.equal(toEpochMs('2026-11-12T08:30:00.123Z'), Date.UTC(2026, 10, 12, 8, 30, 0, 123));
  assert.equal(toEpochMs('2026-11-12 08:30:00Z'), Date.UTC(2026, 10, 12, 8, 30));
  assert.equal(toEpochMs('2024-02-29'), Date.UTC(2024, 1, 29));
  assert.equal(toEpochMs('1767225600000'), 1767225600000);
  for (const bad of ['01.12.2026', '12/01/2026', '2026-1-2', '2026-02-30', '2026-13-01', '2026-11-12T25:00', 'Ticket 5', 'morgen', '1', '20261112', '9'.repeat(17), '']) {
    assert.throws(() => toEpochMs(bad), /kein gültiges Datum/, bad);
  }
});
