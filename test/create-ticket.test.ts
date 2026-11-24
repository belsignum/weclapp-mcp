import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { CHANGE_ID_PATTERN } from '../src/audit.ts';
import { connect, json, startMcp, text } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

type Mock = Awaited<ReturnType<typeof startMockWeclapp>>;

describe('Ticket anlegen', () => {
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

  const call = (name: string, args: Record<string, unknown> = {}) => anna.callTool({ name, arguments: args });
  const posts = () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/ticket');
  const changes = async () => json(await call('weclapp_list_changes', { entity: 'ticket', limit: 100 })).result as any[];
  const exists = (id: string) => mock.data.ticket.some((t) => t.id === id);

  test('Betreff und Kunde genügen: Zuweisung an den Token-Nutzer, Protokolleintrag mit changeId', async () => {
    mock.requests.length = 0;
    const created = json(await call('weclapp_create_ticket', { subject: '  Newsletter-Anmeldung defekt ', partyId: '50' }));
    const expected = { subject: 'Newsletter-Anmeldung defekt', partyId: '50', assignedUserId: '100' };

    assert.equal(posts().length, 1);
    assert.deepEqual(posts()[0].body, expected);
    assert.equal(posts()[0].query.dryRun, undefined);
    assert.match(created.changeId, CHANGE_ID_PATTERN);
    assert.equal(created.result.ticketNumber, `T-${created.result.id}`);
    assert.ok(exists(created.result.id));

    const entry = (await changes()).find((e) => e.changeId === created.changeId);
    assert.deepEqual(
      { tool: entry.tool, kind: entry.kind, entity: entry.entity, entityId: entry.entityId, status: entry.status, undoable: entry.undoable },
      { tool: 'weclapp_create_ticket', kind: 'create', entity: 'ticket', entityId: created.result.id, status: 'done', undoable: true },
    );
    assert.equal(entry.before, undefined);
    assert.deepEqual(entry.after, expected);

    // In der Protokolldatei: erst die Absicht, dann das Ergebnis mit der neuen Ticket-ID
    const file = join(mcp.auditDir!, (await readdir(mcp.auditDir!))[0]);
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.id === created.changeId);
    assert.deepEqual(lines.map((line) => line.phase), ['begin', 'end']);
    assert.equal(lines[0].user.id, '100');
    assert.equal(lines[0].entityId, undefined);
    assert.equal(lines[1].entityId, created.result.id);
  });

  test('optionale Angaben und fields: benannte Angaben haben Vorrang, Datum wird Epoch-ms, geschützte Felder entfallen', async () => {
    mock.requests.length = 0;
    json(
      await call('weclapp_create_ticket', {
        subject: 'Relaunch Startseite',
        partyId: '50',
        description: '<p>Neue Bühne</p>',
        ticketStatusId: '2',
        ticketPriorityId: '9',
        ticketCategoryId: '11',
        ticketChannelId: '12',
        assignedUserId: '200',
        contactId: '51',
        billable: true,
        fields: JSON.parse('{"ticketTypeId":"815","solutionDueDate":"2026-12-01","subject":"aus fields","billable":false,"id":"999","version":"7","createdDate":"2020-01-01","__proto__":{"polluted":true}}'),
      }),
    );
    assert.deepEqual(posts()[0].body, {
      subject: 'Relaunch Startseite',
      partyId: '50',
      description: '<p>Neue Bühne</p>',
      ticketStatusId: '2',
      ticketPriorityId: '9',
      ticketCategoryId: '11',
      ticketChannelId: '12',
      assignedUserId: '200',
      contactId: '51',
      billable: true,
      ticketTypeId: '815',
      solutionDueDate: Date.parse('2026-12-01'),
    });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test('fields allein: nicht angegebene Angaben verdrängen nichts, "assignedUserId": null lässt das Ticket unzugewiesen', async () => {
    mock.requests.length = 0;
    json(await call('weclapp_create_ticket', { subject: 'Für die Gruppe', partyId: '50', fields: { assignedUserId: null, assignedPoolingGroupId: '70', ticketStatusId: '2' } }));
    assert.deepEqual(posts()[0].body, { subject: 'Für die Gruppe', partyId: '50', assignedUserId: null, assignedPoolingGroupId: '70', ticketStatusId: '2' });
  });

  test('dryRun: weclapp prüft, es wird nichts gespeichert und nichts protokolliert', async () => {
    const tickets = mock.data.ticket.length;
    const logged = (await changes()).length;
    mock.requests.length = 0;

    const preview = json(await call('weclapp_create_ticket', { subject: 'Nur prüfen', partyId: '50', dryRun: true }));
    assert.equal(posts()[0].query.dryRun, 'true');
    assert.deepEqual(posts()[0].body, { subject: 'Nur prüfen', partyId: '50', assignedUserId: '100' });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.changeId, undefined);
    assert.equal(preview.result.subject, 'Nur prüfen');
    assert.equal(preview.result.ticketStatusId, '1', 'die Vorschau zeigt, was weclapp ergänzt');
    assert.equal(preview.result.id, undefined);

    const rejected = await call('weclapp_create_ticket', { subject: 'Nur prüfen', partyId: '999', dryRun: true });
    assert.equal(rejected.isError, true);
    assert.match(text(rejected), /partyId: referenced entity not found/);

    assert.equal(mock.data.ticket.length, tickets);
    assert.equal((await changes()).length, logged);
  });

  test('lehnt weclapp das Ticket ab, nennt die Meldung das Feld und der Eintrag steht als "failed" im Protokoll', async () => {
    const tickets = mock.data.ticket.length;
    const result = await call('weclapp_create_ticket', { subject: 'Unbekannter Kunde', partyId: '999' });
    assert.equal(result.isError, true);
    assert.match(text(result), /HTTP 400.*partyId: referenced entity not found/);
    assert.equal(mock.data.ticket.length, tickets);

    const failed = (await changes())[0];
    assert.deepEqual({ tool: failed.tool, kind: failed.kind, status: failed.status, undoable: failed.undoable }, { tool: 'weclapp_create_ticket', kind: 'create', status: 'failed', undoable: false });
    assert.match(failed.error, /partyId/);
    assert.match(text(await call('weclapp_undo_change', { changeId: failed.changeId })), /Status "failed"/);
  });

  test('ungültige Angaben erreichen weclapp nicht', async () => {
    mock.requests.length = 0;
    for (const args of [
      { partyId: '50' },
      { subject: 'Ohne Kunde' },
      { subject: '   ', partyId: '50' },
      { subject: 'x'.repeat(151), partyId: '50' },
      { subject: 'x', partyId: '../50' },
      { subject: 'x', partyId: '50', assignedUserId: 'anna' },
      { subject: 'x', partyId: '50', ticketStatusId: '1?dryRun=true' },
      { subject: 'x', partyId: '50', fields: { followUpDate: '01.12.2026' } },
    ]) {
      const result = await call('weclapp_create_ticket', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(mock.requests.length, 0);
  });

  test('Undo löscht das angelegte Ticket wieder', async () => {
    const created = json(await call('weclapp_create_ticket', { subject: 'Versehentlich angelegt', partyId: '50' }));
    const id = created.result.id;

    const preview = json(await call('weclapp_undo_change', { changeId: created.changeId, dryRun: true }));
    assert.deepEqual(preview, { dryRun: true, wouldDelete: { entity: 'ticket', entityId: id } });
    assert.ok(exists(id), 'die Vorschau löscht nichts');

    const undo = json(await call('weclapp_undo_change', { changeId: created.changeId }));
    assert.equal(undo.undone, true);
    assert.deepEqual(undo.deleted, { entity: 'ticket', entityId: id });
    assert.ok(!exists(id));

    const entry = (await changes()).find((e) => e.changeId === created.changeId);
    assert.equal(entry.undoneBy, undo.changeId);
    assert.equal(entry.undoable, false);
  });

  test('Undo lässt ein Ticket stehen, an dem Zeiten oder Kommentare hängen oder das inzwischen geändert wurde', async () => {
    const created = json(await call('weclapp_create_ticket', { subject: 'Schon in Arbeit', partyId: '50' }));
    const id = created.result.id;
    const undo = (dryRun = false) => call('weclapp_undo_change', { changeId: created.changeId, dryRun });

    const booked = json(await call('weclapp_book_time', { ticketId: id, minutes: 15, description: 'Analyse' }));
    for (const attempt of [await undo(true), await undo()]) {
      assert.equal(attempt.isError, true);
      assert.match(text(attempt), /Abgebrochen.*Zeitbuchungen/);
    }
    json(await call('weclapp_undo_change', { changeId: booked.changeId }));

    const comment = json(await call('weclapp_add_ticket_comment', { ticketId: id, text: 'Rückfrage an den Kunden' }));
    assert.match(text(await undo()), /Abgebrochen.*Kommentare/);
    json(await call('weclapp_undo_change', { changeId: comment.changeId }));
    assert.equal(json(await undo(true)).dryRun, true, 'ohne Zeiten und Kommentare wäre das Löschen wieder möglich');

    json(await call('weclapp_update_ticket', { id, fields: { ticketStatusId: '2' } }));
    assert.match(text(await undo()), /inzwischen verändert/);

    assert.ok(exists(id));
    assert.equal(mock.requests.filter((r) => r.method === 'DELETE' && r.path === `/ticket/id/${id}`).length, 0);
  });
});

test('Ticket anlegen zählt zum Schreiblimit, der Probelauf nicht', async () => {
  const mock = await startMockWeclapp();
  const mcp = await startMcp(mock.baseUrl, { maxWritesPerHour: 2 });
  const anna = await connect(mcp.url, 'token-anna');
  const create = (subject: string, dryRun = false) => anna.callTool({ name: 'weclapp_create_ticket', arguments: { subject, partyId: '50', dryRun } });
  try {
    json(await create('Erstes'));
    json(await create('Zweites'));
    const blocked = await create('Drittes');
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /Schreiblimit erreicht/);
    assert.deepEqual(mock.data.ticket.map((t) => t.subject), ['Drucker streikt', 'Erstes', 'Zweites']);
    assert.equal(json(await create('Drittes', true)).dryRun, true);
  } finally {
    await anna.close();
    await mcp.close();
    await mock.close();
  }
});
