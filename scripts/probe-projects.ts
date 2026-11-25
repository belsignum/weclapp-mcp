/**
 * Probe am echten weclapp-Mandanten: Welcher Datentyp steckt hinter projectId und projectTaskId einer Zeitbuchung?
 *
 *   node scripts/probe-projects.ts
 *
 * Liest nur (GET) und ändert nichts. Ausgegeben werden IDs, Feldnamen, Status und Zählungen,
 * keine Namen, Texte oder Beträge. Mandant und Token wie in smoke-common.ts (Token verdeckt).
 *
 * Ergebnis am 25.11.2026 an einem Mandanten: projectId zeigt auf /project, projectTaskId auf /projectTask. Beide
 * Datentypen stehen nicht in der OpenAPI-Spezifikation, die API liefert sie aber in v2 und v1 samt Liste und Zählung.
 * Ein Auftrag (/salesOrder) oder eine Aufgabe (/task) sind sie nicht.
 */
import { WeclappError, type Entity, type WeclappClient } from '../src/weclapp/client.ts';
import { openWeclapp, runSmoke, say } from './smoke-common.ts';

const keys = (value: unknown) => (value && typeof value === 'object' ? Object.keys(value).sort().join(', ') : String(value));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Bezüge eines Datensatzes: Felder auf "Id" mit ihrem Wert. Namen und Texte bleiben draußen. */
function references(row: Entity): string {
  const refs = Object.entries(row).filter(([key, value]) => /Id$/.test(key) && (typeof value === 'string' || typeof value === 'number'));
  return refs.map(([key, value]) => `${key}=${value}`).join(', ') || '-';
}

/** Felder mit schlichten Werten, die keine Texte sind: Wahrheitswerte, Zahlen und Aufzählungswerte in Großbuchstaben. */
function flags(row: Entity): string {
  const plain = Object.entries(row).filter(([key, value]) => !/Id$|Date$|^version$/.test(key) && (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value))));
  return plain.map(([key, value]) => `${key}=${value}`).join(', ') || '-';
}

async function step<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  say();
  say(title);
  try {
    return await fn();
  } catch (error) {
    say(`   FEHLER: ${errorText(error)}`);
    return undefined;
  }
}

/** Liest einen Datensatz; undefined, wenn es den Datentyp oder die id nicht gibt. */
async function tryGet(client: WeclappClient, entity: string, id: string): Promise<Entity | undefined> {
  try {
    return await client.get<Entity>(entity, id);
  } catch (error) {
    // 401 kommt hier nicht vom Token (der ist seit Schritt 1 bestätigt), sondern von Datentypen, die es in dieser API-Version nicht gibt
    if (error instanceof WeclappError && [400, 401, 403, 404, 405].includes(error.status)) return undefined;
    throw error;
  }
}

async function count(client: WeclappClient, entity: string, filters: Record<string, string> = {}): Promise<number> {
  return (await client.request<{ result: number }>('GET', `/${entity}/count`, { query: filters })).result;
}

const CANDIDATES = ['project', 'projectTask', 'projectPhase', 'projectMilestone', 'projectOrder', 'projectTemplate', 'salesOrder', 'salesOrderItem', 'orderItem', 'task', 'taskList', 'quotation', 'contract', 'opportunity', 'productionOrder', 'ticket', 'serviceQuota', 'costUnit', 'costCenter', 'article'];

async function main(): Promise<void> {
  say('Probe: Welcher Datentyp sind die Projekte? (nur lesend)');
  say('======================================================');
  const { client, v1 } = await openWeclapp();

  const booking = await step('1. Jüngste Projektbuchung mit Aufgabe', async () => {
    const [record] = (await client.list<Entity>('timeRecord', { filters: { 'projectId-notnull': 'true', 'projectTaskId-notnull': 'true' }, sort: '-startDate', pageSize: 1 })).result;
    if (!record) throw new Error('keine Zeitbuchung mit projectId und projectTaskId gefunden');
    say(`   Zeitbuchung ${record.id}: projectId=${record.projectId}, projectTaskId=${record.projectTaskId}`);
    return { projectId: String(record.projectId), projectTaskId: String(record.projectTaskId) };
  });
  if (!booking) return;

  const resources = await step('2. Datentypen, die die API dieses Mandanten anbietet (/meta/resources)', async () => {
    const response = await client.request<{ result: unknown }>('GET', '/meta/resources');
    const result = response.result;
    const names = Array.isArray(result) ? result.map((entry) => (typeof entry === 'string' ? entry : String((entry as Entity).name ?? (entry as Entity).resource ?? ''))) : Object.keys(result as object);
    say(`   insgesamt ${names.length}; Aufbau der Antwort: ${Array.isArray(result) ? `Liste, erster Eintrag ${JSON.stringify(result[0]).slice(0, 120)}` : 'Objekt mit Namen als Schlüsseln'}`);
    say(`   mit project/task/order/phase im Namen: ${names.filter((name) => /project|task|order|phase|milestone/i.test(name)).sort().join(', ') || '-'}`);
    return names.filter(Boolean);
  });

  const wanted = [...new Set([...CANDIDATES, ...(resources ?? []).filter((name) => /project|task|phase|milestone/i.test(name))])].filter((name) => /^[a-z][A-Za-z]{1,60}$/.test(name));
  for (const [label, id] of [['projectId', booking.projectId], ['projectTaskId', booking.projectTaskId]] as const) {
    await step(`3. Wo gibt es einen Datensatz mit der id ${id} (${label})?`, async () => {
      let found = false;
      for (const [version, api] of [['v2', client], ['v1', v1]] as const) {
        for (const entity of wanted) {
          const row = await tryGet(api, entity, id);
          if (!row) continue;
          found = true;
          say(`   TREFFER in ${version}: /${entity}/id/${id}`);
          say(`      Felder: ${keys(row)}`);
          say(`      Bezüge: ${references(row)}`);
          say(`      Schalter und Status: ${flags(row)}`);
          for (const [key, value] of Object.entries(row)) {
            if (Array.isArray(value) && value[0] && typeof value[0] === 'object') say(`      Liste ${key} (${value.length}): Felder ${keys(value[0])}; Bezüge ${references(value[0] as Entity)}`);
          }
        }
      }
      if (!found) say(`   kein Treffer in: ${wanted.join(', ')}`);
    });
  }

  await step('4. Löst weclapp die Bezüge selbst auf? (includeReferencedEntities)', async () => {
    const response = await client.request<{ result: Entity[]; referencedEntities?: Record<string, Entity[]> }>('GET', '/timeRecord', {
      query: { 'projectTaskId-eq': booking.projectTaskId, pageSize: 1, properties: 'id,projectId,projectTaskId', includeReferencedEntities: 'projectId,projectTaskId' },
    });
    const referenced = response.referencedEntities ?? {};
    say(`   Datentypen in referencedEntities: ${Object.keys(referenced).join(', ') || '-'}`);
    for (const [entity, rows] of Object.entries(referenced)) {
      for (const row of rows.slice(0, 2)) say(`   ${entity} ${row.id}: Felder ${keys(row)}; Bezüge ${references(row)}`);
    }
  });

  await step('5. Gibt es die Datentypen als Liste?', async () => {
    for (const [version, api] of [['v2', client], ['v1', v1]] as const) {
      for (const entity of ['project', 'projectTask']) {
        try {
          say(`   ${version} /${entity}: ${await count(api, entity)} Datensätze`);
        } catch (error) {
          say(`   ${version} /${entity}: ${errorText(error)}`);
        }
      }
    }
  });

  await step('6. Wie verteilen sich die Projektbuchungen?', async () => {
    say(`   Buchungen mit projectId: ${await count(client, 'timeRecord', { 'projectId-notnull': 'true' })}, auf projectId ${booking.projectId}: ${await count(client, 'timeRecord', { 'projectId-eq': booking.projectId })}, auf projectTaskId ${booking.projectTaskId}: ${await count(client, 'timeRecord', { 'projectTaskId-eq': booking.projectTaskId })}`);
    const recent = (await client.list<Entity>('timeRecord', { filters: { 'projectId-notnull': 'true' }, sort: '-startDate', pageSize: 200, properties: 'id,projectId,projectTaskId' })).result;
    const projects = new Map<string, Set<string>>();
    for (const record of recent) {
      const tasks = projects.get(String(record.projectId)) ?? new Set<string>();
      if (record.projectTaskId) tasks.add(String(record.projectTaskId));
      projects.set(String(record.projectId), tasks);
    }
    say(`   in den jüngsten ${recent.length} Projektbuchungen: ${projects.size} verschiedene Projekte`);
    for (const [projectId, tasks] of [...projects].slice(0, 8)) say(`   Projekt ${projectId}: ${tasks.size} verschiedene Aufgaben (${[...tasks].slice(0, 6).join(', ')}${tasks.size > 6 ? ', …' : ''})`);
  });
}

runSmoke(main);
