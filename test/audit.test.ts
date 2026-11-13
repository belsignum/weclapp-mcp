import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { AuditLog } from '../src/audit.ts';
import { connect, json, startMcp, text } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

type Mock = Awaited<ReturnType<typeof startMockWeclapp>>;

describe('Änderungsprotokoll und Rückgängig', () => {
  let mock: Mock;
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let anna: Client;
  let ben: Client;

  before(async () => {
    mock = await startMockWeclapp();
    mcp = await startMcp(mock.baseUrl);
    anna = await connect(mcp.url, 'token-anna');
    ben = await connect(mcp.url, 'token-ben');
  });

  after(async () => {
    await anna?.close();
    await ben?.close();
    await mcp?.close();
    await mock?.close();
  });

  const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const ticket = () => mock.data.ticket[0];

  test('Änderung wird mit Vorher/Nachher protokolliert und lässt sich zurücksetzen', async () => {
    const change = json(await call(anna, 'weclapp_update_ticket', { id: '20', fields: { subject: 'Drucker läuft wieder', ticketStatusId: '2' } }));
    assert.equal(ticket().subject, 'Drucker läuft wieder');

    const listed = json(await call(anna, 'weclapp_list_changes', { entity: 'ticket', entityId: '20' }));
    const entry = listed.result.find((e: any) => e.changeId === change.changeId);
    assert.equal(entry.status, 'done');
    assert.equal(entry.undoable, true);
    assert.deepEqual(entry.before, { subject: 'Drucker streikt', ticketStatusId: '1' });
    assert.deepEqual(entry.after, { subject: 'Drucker läuft wieder', ticketStatusId: '2' });

    const preview = json(await call(anna, 'weclapp_undo_change', { changeId: change.changeId, dryRun: true }));
    assert.equal(preview.undone, false);
    assert.equal(ticket().subject, 'Drucker läuft wieder', 'Vorschau ändert nichts');

    const undo = json(await call(anna, 'weclapp_undo_change', { changeId: change.changeId }));
    assert.equal(undo.undone, true);
    assert.equal(ticket().subject, 'Drucker streikt');
    assert.equal(ticket().ticketStatusId, '1');

    const again = await call(anna, 'weclapp_undo_change', { changeId: change.changeId });
    assert.equal(again.isError, true);
    assert.match(text(again), /bereits rückgängig/);

    const afterUndo = json(await call(anna, 'weclapp_list_changes', {}));
    assert.equal(afterUndo.result.find((e: any) => e.changeId === change.changeId).undoneBy, undo.changeId);
    assert.equal(afterUndo.result.find((e: any) => e.changeId === undo.changeId).undoes, change.changeId);
  });

  test('Undo bricht ab, wenn der Datensatz inzwischen anders geändert wurde', async () => {
    const change = json(await call(anna, 'weclapp_update_ticket', { id: '20', fields: { subject: 'Zwischenstand' } }));
    ticket().subject = 'Von jemand anderem geändert';
    const undo = await call(anna, 'weclapp_undo_change', { changeId: change.changeId });
    assert.equal(undo.isError, true);
    assert.match(text(undo), /Abgebrochen.*subject/);
    assert.equal(ticket().subject, 'Von jemand anderem geändert', 'fremde Änderung bleibt erhalten');
    ticket().subject = 'Drucker streikt';
  });

  test('Feld, das vorher leer war, wird beim Undo wieder geleert', async () => {
    const change = json(await call(anna, 'weclapp_update_ticket', { id: '20', fields: { followUpDate: '2026-12-01' } }));
    assert.equal(ticket().followUpDate, Date.parse('2026-12-01'));
    json(await call(anna, 'weclapp_undo_change', { changeId: change.changeId }));
    assert.equal(ticket().followUpDate, undefined);
  });

  test('angelegte Zeitbuchung wird beim Undo gelöscht', async () => {
    const booked = json(await call(anna, 'weclapp_book_time', { ticketId: '20', minutes: 15, description: 'Test' }));
    const id = booked.result.id;
    assert.ok(mock.data.timeRecord.some((t) => t.id === id));
    const undo = json(await call(anna, 'weclapp_undo_change', { changeId: booked.changeId }));
    assert.deepEqual(undo.deleted, { entity: 'timeRecord', entityId: id });
    assert.ok(!mock.data.timeRecord.some((t) => t.id === id));
  });

  test('gelöschte Vertragsposition kommt beim Undo zurück', async () => {
    const change = json(await call(anna, 'weclapp_update_contract', { id: '60', fields: { contractItems: [{ id: '601' }] } }));
    assert.equal((mock.data.contract[0].contractItems as unknown[]).length, 1);
    json(await call(anna, 'weclapp_undo_change', { changeId: change.changeId }));
    const items = mock.data.contract[0].contractItems as Array<Record<string, unknown>>;
    assert.deepEqual(items.map((i) => i.title), ['Wartung', 'Hotline']);
    assert.equal(items[0].id, '601', 'bestehende Position behält ihre id');
    assert.notEqual(items[1].id, '602', 'gelöschte Position wird neu angelegt');
  });

  test('fehlgeschlagene Änderung steht als "failed" im Protokoll und ist nicht rücksetzbar', async () => {
    const result = await call(anna, 'weclapp_update_ticket', { id: '20', fields: { subject: 'x' }, version: '1' });
    assert.equal(result.isError, true);
    const failed = json(await call(anna, 'weclapp_list_changes', { limit: 1 })).result[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.undoable, false);
    assert.match(failed.error, /409/);
    const undo = await call(anna, 'weclapp_undo_change', { changeId: failed.changeId });
    assert.match(text(undo), /Status "failed"/);
  });

  test('jeder sieht und ändert nur die eigenen Protokolleinträge', async () => {
    const change = json(await call(anna, 'weclapp_update_article', { id: '1', fields: { name: 'Annas Änderung' } }));
    assert.equal(json(await call(ben, 'weclapp_list_changes', {})).count, 0);
    const foreign = await call(ben, 'weclapp_undo_change', { changeId: change.changeId });
    const unknown = await call(ben, 'weclapp_undo_change', { changeId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(foreign.isError, true);
    assert.equal(text(foreign), text(unknown), 'fremde und unbekannte IDs sind nicht unterscheidbar');
    assert.equal(mock.data.article[0].name, 'Annas Änderung');
  });

  test('Protokolldatei: nur für den Besitzer lesbar, ohne Token', async () => {
    const files = await readdir(mcp.auditDir!);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}\.jsonl$/);
    const file = join(mcp.auditDir!, files[0]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(mcp.auditDir!)).mode & 0o777, 0o700);
    const content = await readFile(file, 'utf8');
    assert.ok(!content.includes('token-anna') && !content.includes('token-ben'));
    assert.ok(content.split('\n').filter(Boolean).every((line) => JSON.parse(line).v === 1));
  });
});

describe('AuditLog', () => {
  test('ohne beschreibbares Verzeichnis startet das Protokoll nicht', async () => {
    await assert.rejects(AuditLog.open('/dev/null/audit'));
  });

  test('beschädigte und gefälschte Zeilen werden ignoriert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      const log = await AuditLog.open(dir);
      const id = await log.begin({ user: { id: '1', name: 'A' }, tool: 't', kind: 'update', entity: 'ticket', entityId: '5', before: { a: 1 } });
      await log.end(id, { status: 'done', after: { a: 2 } });
      const file = join(dir, (await readdir(dir))[0]);
      await writeFile(file, '{kaputt\n{"v":1,"phase":"begin","id":"../../etc/passwd","user":{"id":"1"}}\n', { flag: 'a' });
      const entries = await log.list({ userId: '1' });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, 'done');
      assert.equal(await log.get('../../etc/passwd', '1'), undefined);
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('zu große Stände werden gekürzt und sind nicht rücksetzbar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      const log = await AuditLog.open(dir);
      const id = await log.begin({ user: { id: '1', name: 'A' }, tool: 't', kind: 'update', entity: 'ticket', entityId: '5', before: { big: 'x'.repeat(300_000) } });
      await log.end(id, { status: 'done', after: { big: 'y' } });
      const entry = await log.get(id, '1');
      assert.equal(entry?.truncated, true);
      assert.deepEqual(entry?.before, { _truncated: true });
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('alte Monatsdateien werden nach der Aufbewahrungsfrist gelöscht', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      await writeFile(join(dir, '2025-01.jsonl'), '');
      await writeFile(join(dir, '2026-10.jsonl'), '');
      await writeFile(join(dir, 'notizen.txt'), 'bleibt');
      const log = await AuditLog.open(dir, { retentionDays: 90, now: () => new Date('2026-11-13T00:00:00Z') });
      assert.deepEqual((await readdir(dir)).sort(), ['2026-10.jsonl', '2026-11.jsonl', 'notizen.txt']);
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---- Zweites Audit (13.11.2026) ----

  test('bestehende Protokolldateien werden beim Start auf den Besitzer beschränkt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      await writeFile(join(dir, '2026-10.jsonl'), '', { mode: 0o644 });
      const log = await AuditLog.open(dir, { now: () => new Date('2026-11-13T00:00:00Z') });
      assert.equal((await stat(join(dir, '2026-10.jsonl'))).mode & 0o777, 0o600);
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('Maximalgröße: neue Änderungen werden abgelehnt, begonnene lassen sich noch abschließen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      const input = { user: { id: '1', name: 'A' }, tool: 't', kind: 'update', entity: 'ticket', entityId: '5', before: { text: 'x'.repeat(600) } } as const;
      const log = await AuditLog.open(dir, { maxBytes: 1_000 });
      const first = await log.begin(input);
      const second = await log.begin(input);
      await assert.rejects(log.begin(input), /Maximalgröße/);
      await log.end(second, { status: 'done', after: { text: 'y' } });
      assert.equal((await log.get(second, '1'))?.status, 'done');
      assert.equal((await log.get(first, '1'))?.status, 'pending');
      log.close();

      // Die Größe wird auch nach einem Neustart aus den Dateien ermittelt
      const reopened = await AuditLog.open(dir, { maxBytes: 1_000 });
      await assert.rejects(reopened.begin(input), /Maximalgröße/);
      reopened.close();
      const unlimited = await AuditLog.open(dir, { maxBytes: 0 });
      await unlimited.begin(input);
      unlimited.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('list liefert genau die neuesten Einträge, auch bei vielen Einträgen und Filtern', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      let clock = Date.parse('2026-11-01T00:00:00Z');
      const log = await AuditLog.open(dir, { now: () => new Date((clock += 1000)) });
      const ids: string[] = [];
      for (let i = 0; i < 60; i++) {
        const user = { id: i % 2 ? '1' : '2', name: 'N' };
        const create = i % 3 === 0;
        const id = await log.begin({ user, tool: 't', kind: create ? 'create' : 'update', entity: i % 4 === 0 ? 'article' : 'ticket', entityId: create ? undefined : '5', before: create ? undefined : { n: i } });
        // bei Anlagen steht die ID des Datensatzes erst im "end"
        if (i !== 59) await log.end(id, { status: 'done', entityId: create ? String(900 + i) : undefined, after: { n: i + 1 } });
        ids.push(id);
      }
      const mine = await log.list({ userId: '1', limit: 5 });
      assert.deepEqual(mine.map((e) => e.id), [59, 57, 55, 53, 51].map((i) => ids[i]));
      assert.equal(mine[0].status, 'pending', 'begonnene Einträge ohne Abschluss erscheinen ebenfalls');
      assert.deepEqual(mine[2].before, { n: 55 });
      assert.deepEqual(mine[2].after, { n: 56 });

      const created = await log.list({ userId: '1', entityId: '927', limit: 5 });
      assert.deepEqual(created.map((e) => e.id), [ids[27]]);
      const tickets = await log.list({ userId: '2', entity: 'article', limit: 100 });
      assert.deepEqual(tickets.map((e) => e.id), [56, 52, 48, 44, 40, 36, 32, 28, 24, 20, 16, 12, 8, 4, 0].map((i) => ids[i]));
      const since = await log.list({ userId: '2', since: Date.parse('2026-11-01T00:01:40Z'), limit: 100 });
      assert.ok(since.length > 0 && since.every((e) => Date.parse(e.time) >= Date.parse('2026-11-01T00:01:40Z')));

      await log.markUndone(ids[57], ids[59]);
      assert.equal((await log.list({ userId: '1', limit: 5 }))[1].undoneBy, ids[59]);
      assert.equal((await log.get(ids[57], '1'))?.undoneBy, ids[59]);
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('gefälschte Zeilen können weder einen Eintrag übernehmen noch ungeprüfte Werte einschleusen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-'));
    try {
      const log = await AuditLog.open(dir);
      const id = await log.begin({ user: { id: '1', name: 'A' }, tool: 't', kind: 'update', entity: 'ticket', entityId: '5', before: { a: 1 } });
      await log.end(id, { status: 'done', after: { a: 2 } });
      const file = join(dir, (await readdir(dir))[0]);
      const forged = [
        // dieselbe id noch einmal, diesmal für einen anderen Nutzer und mit anderem Ziel
        { v: 1, phase: 'begin', id, time: '2099-01-01T00:00:00.000Z', user: { id: '2', name: 'B' }, tool: 't', kind: 'update', entity: 'contract', entityId: '60', before: { name: 'gekapert' } },
        { v: 1, phase: 'end', id, time: '2099-01-01T00:00:01.000Z', status: 'done', after: { name: 'x' } },
        // unerwartete Typen
        { v: 1, phase: 'begin', id: '00000000-0000-4000-8000-000000000001', time: '2026-11-13T00:00:00.000Z', user: { id: '1' }, tool: 't', kind: 'drop', entity: 'ticket', entityId: '5' },
        { v: 1, phase: 'begin', id: '00000000-0000-4000-8000-000000000002', time: 20261113, user: { id: '1' }, tool: 't', kind: 'update', entity: 'ticket', entityId: '5' },
        { v: 1, phase: 'begin', id: '00000000-0000-4000-8000-000000000003', time: '2026-11-13T00:00:00.000Z', user: { id: '1' }, tool: 't', kind: 'update', entity: 'ticket', entityId: { $ne: 1 }, before: ['kein', 'Objekt'] },
        null,
        [1, 2, 3],
      ];
      await writeFile(file, forged.map((line) => `${JSON.stringify(line)}\n`).join(''), { flag: 'a' });

      const mine = await log.get(id, '1');
      assert.equal(mine?.entity, 'ticket');
      assert.deepEqual(mine?.before, { a: 1 });
      assert.deepEqual(mine?.after, { a: 2 });
      // get() ist die Grundlage fürs Rückgängigmachen: dort gilt immer die erste Zeile zu einer id
      assert.equal(await log.get(id, '2'), undefined, 'der Eintrag bleibt beim ursprünglichen Nutzer');
      assert.equal(await log.get('00000000-0000-4000-8000-000000000001', '1'), undefined);
      assert.equal(await log.get('00000000-0000-4000-8000-000000000002', '1'), undefined);
      const odd = await log.get('00000000-0000-4000-8000-000000000003', '1');
      assert.equal(odd?.entityId, undefined);
      assert.equal(odd?.before, undefined);
      assert.deepEqual((await log.list({ userId: '1' })).map((e) => e.id).sort(), [id, '00000000-0000-4000-8000-000000000003'].sort());
      log.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
