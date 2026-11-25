/**
 * Geführter Rauchtest für Projekte gegen den echten weclapp-Mandanten.
 *
 *   node scripts/smoke-project.ts
 *
 * Startet den MCP-Server lokal (nur auf 127.0.0.1) und liest über die MCP-Tools ein Projekt mit Team,
 * Projektschritten und Zeitbuchungen. Danach lässt es weclapp, nach Rückfrage, sechs Schreibaktionen im Probelauf
 * prüfen (dryRun: true): Zeit buchen, Projekt und Schritt ändern, Schritt und Projekt anlegen. So zeigt sich, welche
 * Angaben dein Mandant verlangt.
 *
 * Laut API-Doku speichert weclapp im Probelauf nichts. /project und /projectTask stehen aber nicht in der Doku.
 * Das Skript prüft deshalb nach jedem Probelauf, ob wirklich nichts entstanden oder verändert ist, und sagt es laut,
 * falls doch. Mandant und Token wie in smoke-common.ts.
 */
import type { Client } from '@modelcontextprotocol/client';
import { ask, call, confirm, must, runSmoke, say, startSession, type Outcome } from './smoke-common.ts';

type Row = Record<string, any> & { id: string };

const PROBE_NAME = `MCP-Probelauf ${new Date().toISOString().slice(0, 19)}`;
const distinct = (rows: Row[], key: string) => [...new Set(rows.map((row) => row[key]).filter((value) => value !== undefined))].join(', ') || '-';

function report(step: string, outcome: Outcome): void {
  if (outcome.ok) say(`   angenommen: ${step}`);
  else say(`   ABGELEHNT: ${step}\n      ${outcome.error.slice(0, 400)}`);
}

/** Meldet laut, wenn ein Probelauf doch etwas hinterlassen hat. */
function expectUnchanged(what: string, unchanged: boolean): void {
  say(unchanged ? `      Gegenprobe: ${what} unverändert` : `      ACHTUNG: ${what} hat sich trotz Probelauf geändert. Bitte in weclapp prüfen und keinen weiteren Probelauf senden.`);
  if (!unchanged) throw new Error(`Der Probelauf hat etwas gespeichert (${what}).`);
}

async function pickProject(client: Client): Promise<Row | undefined> {
  const all: Row[] = must('weclapp_search_projects', await call(client, 'weclapp_search_projects', { template: false, pageSize: 200 })).result;
  say(`   ${all.length} Projekte (ohne Vorlagen); Status-Werte: ${distinct(all, 'status')}`);
  const shown = all.slice(0, 15);
  shown.forEach((project, index) => say(`   ${index + 1}) ${project.projectNumber ?? '(ohne Nummer)'} ${project.name ?? ''} [id ${project.id}, ${project.status}]`));
  if (shown.length === 0) return undefined;
  const picked = Number(await ask('   Welches Projekt? [1] ')) || 1;
  return shown[picked - 1] ?? shown[0];
}

async function main(): Promise<void> {
  say('Rauchtest: Projekte lesen, Schreibaktionen nur im Probelauf');
  say('==========================================================');
  const { client, close } = await startSession('smoke-project');
  const readProject = async (id: string) => must('weclapp_get_project', await call(client, 'weclapp_get_project', { id }));
  const newestBookings = async (projectId: string): Promise<string[]> =>
    must('weclapp_list_time_records', await call(client, 'weclapp_list_time_records', { projectId, pageSize: 5 })).result.map((record: Row) => record.id);

  try {
    say();
    say('1. Projekte (zuletzt geändert zuerst)');
    const project = await pickProject(client);
    if (!project) {
      say('   Kein Projekt gefunden.');
      return;
    }

    say();
    say(`2. Projekt ${project.id} lesen`);
    const read = await readProject(project.id);
    const team: Row[] = read.project.teamMembers ?? [];
    const tasks: Row[] = read.tasks ?? [];
    say(`   Team: ${team.length} Mitglieder, Rollen: ${distinct(team, 'role')}`);
    say(`   Projektschritte: ${tasks.length}${read.tasksTruncated ? ' (abgeschnitten)' : ''}; Status: ${distinct(tasks, 'status')}; Priorität: ${distinct(tasks, 'priority')}; Art: ${distinct(tasks, 'type')}`);
    for (const task of tasks.slice(0, 5)) say(`   Schritt ${task.id}: Position ${task.positionNumber ?? '-'}, ${task.status}, Zeiterfassung ${task.allowTimeTracking}, Artikel ${task.articleId ?? '-'}`);

    say();
    say('3. Zeitbuchungen des Projekts');
    const bookingsBefore = await newestBookings(project.id);
    say(`   jüngste: ${bookingsBefore.join(', ') || 'keine'}`);

    say();
    say('4. Probeläufe (dryRun: true)');
    say('   weclapp prüft dabei die Angaben und soll nichts speichern. Nach jedem Probelauf prüft das Skript das nach.');
    if (!(await confirm('   Probeläufe jetzt senden?'))) return;

    const booking = { minutes: 15, description: PROBE_NAME, dryRun: true };
    const task = tasks.find((candidate) => candidate.allowTimeTracking === true) ?? tasks[0];
    if (task) {
      report(`Zeit auf Projektschritt ${task.id}`, await call(client, 'weclapp_book_time', { ...booking, projectTaskId: task.id }));
      expectUnchanged('die Zeitbuchungen des Projekts', JSON.stringify(await newestBookings(project.id)) === JSON.stringify(bookingsBefore));
    }
    report('Zeit auf das Projekt, ohne Schritt', await call(client, 'weclapp_book_time', { ...booking, projectId: project.id }));
    expectUnchanged('die Zeitbuchungen des Projekts', JSON.stringify(await newestBookings(project.id)) === JSON.stringify(bookingsBefore));

    report('Projekt ändern (Name unverändert zurückschreiben)', await call(client, 'weclapp_update_project', { id: project.id, fields: { name: read.project.name }, dryRun: true }));
    expectUnchanged('die Version des Projekts', (await readProject(project.id)).project.version === read.project.version);

    if (task) {
      const versionOf = async () => must('weclapp_search_project_tasks', await call(client, 'weclapp_search_project_tasks', { filter: `id-eq=${task.id}`, allFields: true })).result[0]?.version;
      const before = await versionOf();
      report(`Projektschritt ${task.id} ändern (Name unverändert zurückschreiben)`, await call(client, 'weclapp_update_project_task', { id: task.id, fields: { name: task.name }, dryRun: true }));
      expectUnchanged('die Version des Projektschritts', (await versionOf()) === before);
    }

    report('neuer Projektschritt', await call(client, 'weclapp_create_project_task', { projectId: project.id, name: PROBE_NAME, dryRun: true }));
    const leftoverTasks: Row[] = must('weclapp_search_project_tasks', await call(client, 'weclapp_search_project_tasks', { projectId: project.id, query: PROBE_NAME })).result;
    expectUnchanged('die Liste der Projektschritte', leftoverTasks.length === 0);

    const created = await call(client, 'weclapp_create_project', { name: PROBE_NAME, customerId: read.project.customerId, dryRun: true });
    report('neues Projekt für denselben Kunden', created);
    if (created.ok) say(`      weclapp setzt dabei: status=${created.data.result?.status}, billable=${created.data.result?.billable}, template=${created.data.result?.template}`);
    const leftoverProjects: Row[] = must('weclapp_search_projects', await call(client, 'weclapp_search_projects', { query: PROBE_NAME })).result;
    expectUnchanged('die Liste der Projekte', leftoverProjects.length === 0);

    say();
    say('5. Im Protokoll steht nichts von diesem Lauf');
    const changes = must('weclapp_list_changes', await call(client, 'weclapp_list_changes', { limit: 1 }));
    say(`   jüngster Eintrag: ${changes.result[0] ? `${changes.result[0].time} ${changes.result[0].tool}` : 'keiner'}`);
  } finally {
    await close();
  }
}

runSmoke(main);
