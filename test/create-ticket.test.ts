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
  /** Betreff, Kunde und Priorität: das verlangt das Tool immer. */
  const ticket = (subject: string, more: Record<string, unknown> = {}) => ({ subject, partyId: '50', ticketPriorityId: '9', ...more });
  const posts = () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/ticket');
  const statusLookups = () => mock.requests.filter((r) => r.method === 'GET' && r.path === '/ticketStatus').length;
  const changes = async () => json(await call('weclapp_list_changes', { entity: 'ticket', limit: 100 })).result as any[];
  const exists = (id: string) => mock.data.ticket.some((t) => t.id === id);

  test('Betreff, Kunde und Priorität genügen: Zuweisung an den Token-Nutzer mit passendem Status, Protokolleintrag mit changeId', async () => {
    mock.requests.length = 0;
    const created = json(await call('weclapp_create_ticket', ticket('  Newsletter-Anmeldung defekt ')));
    const expected = { subject: 'Newsletter-Anmeldung defekt', partyId: '50', ticketPriorityId: '9', assignedUserId: '100', ticketStatusId: '2' };

    assert.equal(posts().length, 1);
    assert.deepEqual(posts()[0].body, expected);
    assert.equal(posts()[0].query.dryRun, undefined);
    assert.match(created.changeId, CHANGE_ID_PATTERN);
    assert.equal(created.result.ticketNumber, `T-${created.result.id}`);
    assert.equal(created.result.ticketChannelId, '12', 'den Kanal ergänzt weclapp');
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

  test('zugewiesenes Ticket ohne Statusangabe: erster Status der Reihenfolge mit internem Status IN_PROGRESS', async () => {
    const statuses = mock.data.ticketStatus;
    try {
      mock.data.ticketStatus = [
        { id: '1', name: 'Noch nicht zugewiesen', internalTicketStatus: 'UNASSIGNED', positionNumber: 1 },
        { id: '5', name: 'In Bearbeitung', internalTicketStatus: 'IN_PROGRESS', positionNumber: 3 },
        { id: '4', name: 'Zugewiesen', internalTicketStatus: 'IN_PROGRESS', positionNumber: 2 },
        { id: '6', name: 'Wartend', internalTicketStatus: 'WAITING', positionNumber: 4 },
      ];
      mock.requests.length = 0;
      json(await call('weclapp_create_ticket', ticket('Zuweisung mit Status', { dryRun: true })));
      assert.equal((posts()[0].body as Record<string, unknown>).ticketStatusId, '4');

      // Gibt es keinen solchen Status, bleibt er weg, und die Ablehnung von weclapp kommt beim Aufrufer an
      mock.data.ticketStatus = [{ id: '1', name: 'Noch nicht zugewiesen', internalTicketStatus: 'UNASSIGNED', positionNumber: 1 }];
      mock.requests.length = 0;
      const rejected = await call('weclapp_create_ticket', ticket('Zuweisung ohne passenden Status', { dryRun: true }));
      assert.equal((posts()[0].body as Record<string, unknown>).ticketStatusId, undefined);
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), /assignedUserId: assigned user must be null for internal ticket status: UNASSIGNED/);
    } finally {
      mock.data.ticketStatus = statuses;
    }
  });

  test('optionale Angaben und fields: benannte Angaben haben Vorrang, Datum wird Epoch-ms, geschützte Felder entfallen', async () => {
    mock.requests.length = 0;
    json(
      await call('weclapp_create_ticket', {
        subject: 'Relaunch Startseite',
        partyId: '50',
        description: '<p>Neue Bühne</p>',
        ticketStatusId: '3',
        ticketPriorityId: '9',
        ticketCategoryId: '11',
        ticketChannelId: '13',
        assignedUserId: '200',
        contactId: '51',
        billable: false,
        fields: JSON.parse('{"ticketTypeId":"815","solutionDueDate":"2026-12-01","subject":"aus fields","billable":true,"id":"999","version":"7","createdDate":"2020-01-01","__proto__":{"polluted":true}}'),
      }),
    );
    assert.deepEqual(posts()[0].body, {
      subject: 'Relaunch Startseite',
      partyId: '50',
      description: '<p>Neue Bühne</p>',
      ticketStatusId: '3',
      ticketPriorityId: '9',
      ticketCategoryId: '11',
      ticketChannelId: '13',
      assignedUserId: '200',
      contactId: '51',
      billable: false,
      ticketTypeId: '815',
      solutionDueDate: Date.parse('2026-12-01'),
    });
    assert.equal(statusLookups(), 0, 'ein angegebener Status wird nicht nachgeschlagen');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test('fields: "assignedUserId": null lässt das Ticket unzugewiesen und ohne Status, ein Status aus fields bleibt stehen', async () => {
    mock.requests.length = 0;
    const unassigned = json(await call('weclapp_create_ticket', ticket('Für die Gruppe', { fields: { assignedUserId: null, assignedPoolingGroupId: '70' } })));
    assert.deepEqual(posts()[0].body, { subject: 'Für die Gruppe', partyId: '50', ticketPriorityId: '9', assignedUserId: null, assignedPoolingGroupId: '70' });
    assert.equal(unassigned.result.ticketStatusId, '1', 'den Status "nicht zugewiesen" setzt weclapp');

    json(await call('weclapp_create_ticket', ticket('Status aus fields', { fields: { ticketStatusId: '3' } })));
    assert.deepEqual(posts()[1].body, { subject: 'Status aus fields', partyId: '50', ticketPriorityId: '9', assignedUserId: '100', ticketStatusId: '3' });
    assert.equal(statusLookups(), 0);
  });

  test('dryRun: weclapp prüft, es wird nichts gespeichert und nichts protokolliert', async () => {
    const tickets = mock.data.ticket.length;
    const logged = (await changes()).length;
    mock.requests.length = 0;

    const preview = json(await call('weclapp_create_ticket', ticket('Nur prüfen', { dryRun: true })));
    assert.equal(posts()[0].query.dryRun, 'true');
    assert.deepEqual(posts()[0].body, { subject: 'Nur prüfen', partyId: '50', ticketPriorityId: '9', assignedUserId: '100', ticketStatusId: '2' });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.changeId, undefined);
    assert.equal(preview.result.subject, 'Nur prüfen');
    assert.equal(preview.result.ticketChannelId, '12', 'die Vorschau zeigt, was weclapp ergänzt');
    assert.equal(preview.result.id, undefined);
    assert.equal(preview.result.ticketNumber, undefined);

    const rejected = await call('weclapp_create_ticket', ticket('Nur prüfen', { partyId: '999', dryRun: true }));
    assert.equal(rejected.isError, true);
    assert.match(text(rejected), /partyId: referenced entity not found/);

    assert.equal(mock.data.ticket.length, tickets);
    assert.equal((await changes()).length, logged);
  });

  test('lehnt weclapp das Ticket ab, nennt die Meldung das Feld und der Eintrag steht als "failed" im Protokoll', async () => {
    const tickets = mock.data.ticket.length;
    const result = await call('weclapp_create_ticket', ticket('Unbekannter Kunde', { partyId: '999' }));
    assert.equal(result.isError, true);
    assert.match(text(result), /HTTP 400.*partyId: referenced entity not found/);
    assert.equal(mock.data.ticket.length, tickets);

    const failed = (await changes())[0];
    assert.deepEqual({ tool: failed.tool, kind: failed.kind, status: failed.status, undoable: failed.undoable }, { tool: 'weclapp_create_ticket', kind: 'create', status: 'failed', undoable: false });
    assert.match(failed.error, /partyId/);
    assert.match(text(await call('weclapp_undo_change', { changeId: failed.changeId })), /Status "failed"/);

    // Status "nicht zugewiesen" und eine Zuweisung schließen sich in weclapp aus
    const conflict = await call('weclapp_create_ticket', ticket('Zugewiesen, aber Status "nicht zugewiesen"', { ticketStatusId: '1' }));
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /assigned user must be null for internal ticket status: UNASSIGNED/);
    assert.equal(mock.data.ticket.length, tickets);
  });

  test('ungültige Angaben erreichen weclapp nicht', async () => {
    mock.requests.length = 0;
    for (const args of [
      { partyId: '50', ticketPriorityId: '9' },
      { subject: 'Ohne Kunde', ticketPriorityId: '9' },
      { subject: 'Ohne Priorität', partyId: '50' },
      ticket('   '),
      ticket('x'.repeat(151)),
      ticket('x', { partyId: '../50' }),
      ticket('x', { ticketPriorityId: 'hoch' }),
      ticket('x', { assignedUserId: 'anna' }),
      ticket('x', { ticketStatusId: '1?dryRun=true' }),
      ticket('x', { fields: { followUpDate: '01.12.2026' } }),
    ]) {
      const result = await call('weclapp_create_ticket', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(mock.requests.length, 0);
  });

  test('Undo löscht das angelegte Ticket wieder', async () => {
    const created = json(await call('weclapp_create_ticket', ticket('Versehentlich angelegt')));
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
    const created = json(await call('weclapp_create_ticket', ticket('Schon in Arbeit')));
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

    json(await call('weclapp_update_ticket', { id, fields: { ticketStatusId: '3' } }));
    assert.match(text(await undo()), /inzwischen verändert/);

    assert.ok(exists(id));
    assert.equal(mock.requests.filter((r) => r.method === 'DELETE' && r.path === `/ticket/id/${id}`).length, 0);
  });
});

test('Ticket anlegen zählt zum Schreiblimit, der Probelauf nicht', async () => {
  const mock = await startMockWeclapp();
  const mcp = await startMcp(mock.baseUrl, { maxWritesPerHour: 2 });
  const anna = await connect(mcp.url, 'token-anna');
  const create = (subject: string, dryRun = false) => anna.callTool({ name: 'weclapp_create_ticket', arguments: { subject, partyId: '50', ticketPriorityId: '9', dryRun } });
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
