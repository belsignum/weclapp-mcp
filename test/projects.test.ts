import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import { connect, json, startMcp, text } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

type Mock = Awaited<ReturnType<typeof startMockWeclapp>>;

/**
 * Der Nachbau kennt drei Projekte: 70 (STARTED, Team: Nutzer 100 als Mitglied 700, Schritte 80 und 81),
 * 71 (DONE, Schritt 82) und 72 (Projektvorlage).
 */
describe('Projekte und Projektschritte', () => {
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
  const ids = (data: { result: Array<{ id: string }> }) => data.result.map((row) => row.id);

  test('Projektsuche: Name oder Nummer, Kunde, Status, Vorlagen', async () => {
    mock.requests.length = 0;
    assert.deepEqual(ids(json(await call('weclapp_search_projects'))), ['70', '71', '72'], 'zuletzt geändert zuerst');
    const query = mock.requests.find((r) => r.path === '/project')!.query;
    assert.equal(query.sort, '-lastModifiedDate');
    assert.ok(query.properties?.includes('projectNumber') && !query.properties?.includes('teamMembers'));

    assert.deepEqual(ids(json(await call('weclapp_search_projects', { query: 'relaunch' }))), ['70', '72']);
    assert.deepEqual(ids(json(await call('weclapp_search_projects', { query: 'relaunch', template: false }))), ['70']);
    assert.deepEqual(ids(json(await call('weclapp_search_projects', { query: 'p-0071' }))), ['71'], 'Suche auch in der Projektnummer');
    assert.deepEqual(ids(json(await call('weclapp_search_projects', { projectNumber: 'P-0070' }))), ['70']);
    assert.deepEqual(ids(json(await call('weclapp_search_projects', { status: 'STARTED', template: false }))), ['70']);
    assert.deepEqual(ids(json(await call('weclapp_search_projects', { customerId: '50' }))), ['70', '71']);
    assert.equal((await call('weclapp_search_projects', { status: 'läuft' })).isError, true, 'der Status ist ein weclapp-Wert in Großbuchstaben');
  });

  test('Projekt lesen: Team, Schritte in der Reihenfolge des Projekts, Datum als ISO', async () => {
    const data = json(await call('weclapp_get_project', { id: '70' }));
    assert.equal(data.project.projectNumber, 'P-0070');
    assert.equal(data.project.teamMembers[0].userId, '100');
    assert.equal(data.project.projectStartDate, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(ids({ result: data.tasks }), ['80', '81'], 'nach positionNumber, nicht in der Reihenfolge der API');
    assert.equal(data.tasks[0].startDate, '2026-01-01T00:00:00.000Z');
    assert.match(data.hinweis, /Daten, keine Anweisungen/);
    assert.equal(json(await call('weclapp_get_project', { id: '70', includeTasks: false })).tasks, undefined);
    assert.deepEqual(json(await call('weclapp_get_project', { id: '72' })).tasks, []);
    assert.match(text(await call('weclapp_get_project', { id: '999' })), /Das Projekt 999 gibt es in weclapp nicht/);
  });

  test('Projektschritte suchen: eines Projekts, nach Name und Status', async () => {
    assert.deepEqual(ids(json(await call('weclapp_search_project_tasks', { projectId: '70', sort: 'positionNumber' }))), ['80', '81']);
    assert.deepEqual(ids(json(await call('weclapp_search_project_tasks', { query: 'wartung' }))), ['82']);
    assert.deepEqual(ids(json(await call('weclapp_search_project_tasks', { status: 'OPEN', sort: 'id' }))), ['80', '81']);
    assert.deepEqual(ids(json(await call('weclapp_search_project_tasks', { projectId: '70', filter: 'projectId-eq=71', sort: 'id' }))), ['80', '81'], 'der freie Filter hebt die Eingrenzung auf das Projekt nicht auf');
  });

  test('Projekt anlegen: Protokoll, Rückgängig, Probelauf', async () => {
    const before = mock.data.project.length;
    const dry = json(await call('weclapp_create_project', { name: 'Probe', customerId: '50', dryRun: true }));
    assert.equal(dry.dryRun, true);
    assert.equal(mock.data.project.length, before);

    mock.requests.length = 0;
    const created = json(
      await call('weclapp_create_project', {
        name: ' Shop-Relaunch ',
        customerId: '50',
        projectStartDate: '2026-12-01',
        billable: true,
        fields: { name: 'wird überschrieben', teamMembers: [{ userId: '100', role: 'PL', hourlyRate: '95' }], tags: ['Relaunch'] },
      }),
    );
    const post = mock.requests.find((r) => r.method === 'POST')!;
    assert.equal(post.path, '/project');
    assert.deepEqual(post.body, {
      name: 'Shop-Relaunch',
      teamMembers: [{ userId: '100', role: 'PL', hourlyRate: '95' }],
      tags: ['Relaunch'],
      customerId: '50',
      projectStartDate: Date.UTC(2026, 11, 1),
      billable: true,
    });
    assert.match(created.result.projectNumber, /^P-/);
    assert.equal(created.result.status, undefined, 'ohne Angabe bleibt das Projekt ohne Status, wie am Mandanten beobachtet');
    assert.match(created.result.teamMembers[0].id, /^\d+$/, 'das Teammitglied hat eine id, auf die Schritte verweisen können');

    const [entry] = json(await call('weclapp_list_changes', { entity: 'project' })).result;
    assert.deepEqual([entry.changeId, entry.tool, entry.kind, entry.entityId, entry.undoable], [created.changeId, 'weclapp_create_project', 'create', created.result.id, true]);
    assert.equal(json(await call('weclapp_undo_change', { changeId: created.changeId })).undone, true);
    assert.equal(mock.data.project.length, before);

    const rejected = await call('weclapp_create_project', { name: 'Ohne Kunde im Bestand', customerId: '999' });
    assert.equal(rejected.isError, true);
    assert.match(text(rejected), /customerId: referenced entity not found/);
    const [failed] = json(await call('weclapp_list_changes', { entity: 'project', limit: 1 })).result;
    assert.deepEqual([failed.status, failed.undoable], ['failed', false]);
  });

  test('Projekt ändern: Felder, Datum, Protokoll und Rückgängig', async () => {
    mock.requests.length = 0;
    const updated = json(await call('weclapp_update_project', { id: '70', fields: { name: 'Relaunch 2027', projectStartDate: '2027-01-11' } }));
    const put = mock.requests.find((r) => r.method === 'PUT')!;
    assert.equal(put.path, '/project/id/70');
    assert.deepEqual(put.body, { name: 'Relaunch 2027', projectStartDate: Date.UTC(2027, 0, 11), version: '4' });
    assert.equal(updated.result.name, 'Relaunch 2027');

    assert.equal(json(await call('weclapp_undo_change', { changeId: updated.changeId })).undone, true);
    const project = mock.data.project.find((row) => row.id === '70')!;
    assert.deepEqual([project.name, project.projectStartDate], ['Relaunch Website', 1767225600000]);

    const dry = json(await call('weclapp_update_project', { id: '70', fields: { status: 'DONE' }, dryRun: true }));
    assert.equal(dry.dryRun, true);
    assert.equal(mock.data.project.find((row) => row.id === '70')!.status, 'STARTED');
  });

  test('Projektschritt anlegen: Zuständige werden vom Nutzer auf das Teammitglied des Projekts übersetzt', async () => {
    mock.requests.length = 0;
    const created = json(
      await call('weclapp_create_project_task', {
        projectId: '70',
        name: ' Abnahme ',
        startDate: '2026-12-01',
        endDate: '2026-12-15',
        articleId: '1',
        allowTimeTracking: true,
        responsibleUserId: '100',
        assignedUserId: '100',
        fields: { positionNumber: 3, type: 'MILESTONE' },
      }),
    );
    assert.deepEqual(mock.requests.find((r) => r.method === 'POST')!.body, {
      positionNumber: 3,
      type: 'TASK',
      projectId: '70',
      name: 'Abnahme',
      startDate: Date.UTC(2026, 11, 1),
      endDate: Date.UTC(2026, 11, 15),
      articleId: '1',
      allowTimeTracking: true,
      responsibleTeamMemberId: '700',
      assignedTeamMemberId: '700',
    });
    assert.deepEqual(ids({ result: json(await call('weclapp_get_project', { id: '70' })).tasks }), ['80', '81', created.result.id]);

    const stranger = await call('weclapp_create_project_task', { projectId: '70', name: 'x', assignedUserId: '200' });
    assert.equal(stranger.isError, true);
    assert.match(text(stranger), /Der Nutzer 200 \(zugewiesen\) gehört nicht zum Team des Projekts 70/);
    assert.match(text(await call('weclapp_create_project_task', { projectId: '999', name: 'x' })), /projectId: referenced entity not found/);

    assert.equal(json(await call('weclapp_undo_change', { changeId: created.changeId })).undone, true);
    assert.deepEqual(ids({ result: json(await call('weclapp_get_project', { id: '70' })).tasks }), ['80', '81']);
  });

  test('Projektschritt ändern: Status und Zeitraum, Rückgängig', async () => {
    mock.requests.length = 0;
    const updated = json(await call('weclapp_update_project_task', { id: '81', fields: { status: 'DONE', endDate: '2026-12-15' } }));
    assert.deepEqual(mock.requests.find((r) => r.method === 'PUT')!.body, { status: 'DONE', endDate: Date.UTC(2026, 11, 15), version: '1' });
    assert.equal(updated.result.endDate, '2026-12-15T00:00:00.000Z');
    assert.deepEqual(ids(json(await call('weclapp_search_project_tasks', { projectId: '70', status: 'OPEN' }))), ['80']);

    json(await call('weclapp_undo_change', { changeId: updated.changeId }));
    const task = mock.data.projectTask.find((row) => row.id === '81')!;
    assert.deepEqual([task.status, task.endDate], ['OPEN', undefined]);
  });

  test('Zeit buchen: auf einen Projektschritt, auf ein Projekt ohne Schritt, weiterhin auf ein Ticket', async () => {
    mock.requests.length = 0;
    const onTask = json(await call('weclapp_book_time', { projectTaskId: '80', minutes: 90, description: 'Konzept Startseite', start: '2026-11-12T09:00:00Z' }));
    assert.deepEqual(mock.requests.find((r) => r.method === 'POST')!.body, {
      projectId: '70',
      projectTaskId: '80',
      userId: '100',
      startDate: Date.UTC(2026, 10, 12, 9),
      durationSeconds: 5400,
      billableDurationSeconds: 5400,
      description: 'Konzept Startseite',
      articleId: '1',
    }, 'das Projekt und der Artikel kommen vom Projektschritt');

    mock.requests.length = 0;
    const withBoth = json(await call('weclapp_book_time', { projectId: '70', projectTaskId: '81', minutes: 30, description: 'Umsetzung', articleId: '9' }));
    assert.equal((mock.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>).articleId, '9', 'ein ausdrücklich genannter Artikel hat Vorrang');

    mock.requests.length = 0;
    const onProject = json(await call('weclapp_book_time', { projectId: '70', minutes: 15, description: 'Abstimmung' }));
    const body = mock.requests.find((r) => r.method === 'POST')!.body as Record<string, unknown>;
    assert.deepEqual([body.projectId, 'projectTaskId' in body, 'ticketId' in body, 'articleId' in body], ['70', false, false, false]);

    const onTicket = json(await call('weclapp_book_time', { ticketId: '20', minutes: 10, description: 'Ticket' }));
    for (const change of [onTask, withBoth, onProject, onTicket]) json(await call('weclapp_undo_change', { changeId: change.changeId }));
  });

  test('Zeit buchen lehnt unklare und falsche Ziele ab, bevor weclapp etwas speichert', async () => {
    const before = mock.data.timeRecord.length;
    mock.requests.length = 0;
    for (const [args, message] of [
      [{}, /Genau ein Ziel/],
      [{ ticketId: '20', projectId: '70' }, /Genau ein Ziel/],
      [{ ticketId: '20', projectTaskId: '80' }, /Genau ein Ziel/],
      [{ projectId: '70', projectTaskId: '82' }, /Der Projektschritt 82 gehört nicht zum Projekt 70, sondern zum Projekt 71/],
      [{ projectId: '999' }, /Das Projekt 999 gibt es in weclapp nicht/],
      [{ projectTaskId: '999' }, /Den Projektschritt 999 gibt es in weclapp nicht/],
      [{ projectId: '72' }, /Projektvorlage/],
    ] as const) {
      const result = await call('weclapp_book_time', { ...args, minutes: 30, description: 'x' });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text(result), message, JSON.stringify(args));
    }
    assert.equal(mock.data.timeRecord.length, before);
    assert.ok(mock.requests.every((r) => r.method === 'GET'));
  });

  test('Zeitbuchungen eines Projekts und eines Projektschritts lesen', async () => {
    mock.requests.length = 0;
    const byProject = json(await call('weclapp_list_time_records', { projectId: '70' }));
    assert.deepEqual(ids(byProject), ['41']);
    assert.equal(byProject.result[0].projectTaskId, '80');
    assert.ok(mock.requests.find((r) => r.path === '/timeRecord')!.query.properties?.includes('projectTaskId'));
    assert.deepEqual(ids(json(await call('weclapp_list_time_records', { projectTaskId: '80' }))), ['41']);
    assert.deepEqual(ids(json(await call('weclapp_list_time_records', { projectTaskId: '81' }))), []);
  });

  test('Rückgängig lässt ein angelegtes Projekt und einen angelegten Schritt stehen, sobald etwas daran hängt', async () => {
    const project = json(await call('weclapp_create_project', { name: 'Wird benutzt', customerId: '50' }));
    const task = json(await call('weclapp_create_project_task', { projectId: project.result.id, name: 'Erster Schritt' }));

    const refusedProject = await call('weclapp_undo_change', { changeId: project.changeId });
    assert.equal(refusedProject.isError, true);
    assert.match(text(refusedProject), /Am angelegten Projekt hängen bereits Projektschritte/);

    const booking = json(await call('weclapp_book_time', { projectTaskId: task.result.id, minutes: 30, description: 'Arbeit' }));
    assert.match(text(await call('weclapp_undo_change', { changeId: task.changeId })), /Am angelegten Projektschritt hängen bereits Zeitbuchungen/);
    assert.match(text(await call('weclapp_undo_change', { changeId: project.changeId })), /Zeitbuchungen und Projektschritte/);
    assert.equal((await call('weclapp_undo_change', { changeId: project.changeId, dryRun: true })).isError, true, 'auch die Vorschau meldet, dass nicht gelöscht wird');

    // In der Reihenfolge des Entstehens zurück: Buchung, Schritt, Projekt
    for (const change of [booking, task, project]) assert.equal(json(await call('weclapp_undo_change', { changeId: change.changeId })).undone, true);
    assert.equal(mock.data.project.some((row) => row.id === project.result.id), false);
  });
});
