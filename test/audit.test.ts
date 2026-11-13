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
});
