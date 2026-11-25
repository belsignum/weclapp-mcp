/**
 * Geführter Rauchtest gegen den echten weclapp-Mandanten.
 *
 * Startet den MCP-Server lokal (nur auf 127.0.0.1), legt über die MCP-Tools ein Test-Ticket an
 * und löscht es auf Wunsch wieder. Vor jedem Schreiben wird nachgefragt.
 *
 *   node scripts/smoke-ticket.ts
 *
 * Das Ticket verbraucht eine Ticketnummer, auch wenn es danach wieder gelöscht wird. Als Kunde
 * am besten die eigene Firma oder einen Testkunden wählen; die E-Mail-Vorlagen sind für das
 * Ticket abgeschaltet (disableEmailTemplates). Mandant, Token und Protokoll wie in smoke-common.ts.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Client } from '@modelcontextprotocol/client';
import { ask, call, confirm, must, runSmoke, say, startSession } from './smoke-common.ts';

type Item = { id: string; name?: string; active?: boolean; internalTicketStatus?: string };
type Party = { id: string; company?: string; firstName?: string; lastName?: string; customerNumber?: string };

/** Felder, die sich bei jeder Änderung ohnehin bewegen. */
const MANAGED = new Set(['version', 'lastModifiedDate']);

const partyName = (party: Party) => party.company || [party.firstName, party.lastName].filter(Boolean).join(' ') || '(ohne Namen)';

async function lookup(client: Client, resource: string): Promise<Item[]> {
  return must(`weclapp_lookup ${resource}`, await call(client, 'weclapp_lookup', { resource })).result;
}

/** Zeigt eine nummerierte Auswahl; Enter nimmt den Vorschlag. */
async function choose<T>(question: string, items: T[], label: (item: T) => string, preferred = 0): Promise<T> {
  items.forEach((item, index) => say(`   ${index + 1}) ${label(item)}`));
  const picked = Number(await ask(`   ${question} [${preferred + 1}] `)) || preferred + 1;
  return items[picked - 1] ?? items[preferred];
}

async function pickParty(client: Client): Promise<Party> {
  for (;;) {
    const query = await ask('   Suchbegriff (Teil des Firmen- oder Nachnamens): ');
    if (!query) throw new Error('Kein Kunde gewählt.');
    const found: Party[] = must('weclapp_search_parties', await call(client, 'weclapp_search_parties', { query, pageSize: 15 })).result;
    if (found.length > 0) {
      return choose('Welcher Kunde?', found, (party) => `${partyName(party)}${party.customerNumber ? `, Kundennummer ${party.customerNumber}` : ''} [id ${party.id}]`);
    }
    say('   Kein Treffer.');
  }
}

async function main(): Promise<void> {
  say('Rauchtest: Test-Ticket in weclapp anlegen');
  say('=========================================');
  say('Das Ticket verbraucht eine Ticketnummer, auch wenn es danach wieder gelöscht wird.');

  const { client, close } = await startSession('smoke-ticket');

  try {
    say();
    say('1. Wer bin ich?');
    const me = must('weclapp_whoami', await call(client, 'weclapp_whoami'));
    say(`   ${me.firstName ?? ''} ${me.lastName ?? ''} (Nutzer-ID ${me.id})`);

    say('2. Kunde für das Test-Ticket (am besten die eigene Firma oder ein Testkunde)');
    const party = await pickParty(client);

    say('3. Priorität und Kategorie');
    const usable = (items: Item[]) => items.filter((item) => item.active !== false);
    const named = (item: Item) => `${item.name ?? '(ohne Namen)'} [id ${item.id}]`;
    const priorities = usable(await lookup(client, 'ticketPriority'));
    if (priorities.length === 0) throw new Error('weclapp liefert keine Ticket-Prioritäten; ohne Priorität lässt sich kein Ticket anlegen.');
    const priority = await choose('Welche Priorität?', priorities, named, Math.max(0, priorities.findIndex((item) => /normal|mittel|medium/i.test(item.name ?? ''))));
    // Ob weclapp eine Kategorie verlangt, hängt vom Mandanten ab; mit Kategorie klappt es in beiden Fällen
    const categories = usable(await lookup(client, 'ticketCategory'));
    const category = categories.length > 0 ? await choose('Welche Kategorie?', categories, named) : undefined;
    const statuses = await lookup(client, 'ticketStatus');
    const statusName = (id: unknown) => {
      const status = statuses.find((item) => item.id === id);
      return status ? `"${status.name}" (${status.internalTicketStatus})` : `id ${id}`;
    };

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const ticket = {
      subject: `MCP-Testticket ${stamp} (kann gelöscht werden)`,
      description: 'Rauchtest des weclapp-MCP-Servers. Dieses Ticket kann gelöscht werden.',
      partyId: party.id,
      ticketPriorityId: priority.id,
      ...(category ? { ticketCategoryId: category.id } : {}),
      fields: { disableEmailTemplates: true },
    };
    const exists = async () =>
      (must('weclapp_search_tickets', await call(client, 'weclapp_search_tickets', { query: stamp })).result as Array<{ subject?: string }>).some(
        (found) => found.subject === ticket.subject,
      );

    say('4. Geplantes Ticket');
    say(`   Betreff "${ticket.subject}"`);
    say(`   Kunde ${partyName(party)}, Priorität ${priority.name}, Kategorie ${category?.name ?? 'keine'}, zugewiesen an mich, E-Mail-Vorlagen abgeschaltet`);

    say('5. Probelauf (dryRun: weclapp prüft, speichert aber nicht)');
    const dry = await call(client, 'weclapp_create_ticket', { ...ticket, dryRun: true });
    if (!dry.ok) throw new Error(`weclapp lehnt das Ticket schon im Probelauf ab: ${dry.error}`);
    say(`   weclapp nimmt die Daten an: Status ${statusName(dry.data.result.ticketStatusId)}, zugewiesen an Nutzer ${dry.data.result.assignedUserId ?? '–'}`);
    say(`   Nach dem Probelauf in weclapp vorhanden: ${(await exists()) ? 'JA (dryRun hat gespeichert!)' : 'nein, wie erwartet'}`);

    say();
    if (!(await confirm('6. Ticket jetzt wirklich in weclapp anlegen?'))) {
      say('   Nichts angelegt.');
      return;
    }
    const created = must('weclapp_create_ticket', await call(client, 'weclapp_create_ticket', ticket));
    const id = String(created.result.id);
    const number = created.result.ticketNumber ?? '(ohne Nummer in der Antwort)';
    say(`   Angelegt: Ticket ${number}, Ticket-ID ${id}, changeId ${created.changeId}`);
    if (created.warning) say(`   Warnung: ${created.warning}`);

    say('7. Zurücklesen');
    const read = must('weclapp_get_ticket', await call(client, 'weclapp_get_ticket', { id }));
    const stored = read.ticket;
    say(`   ${stored.ticketNumber} | ${stored.subject} | Status ${statusName(stored.ticketStatusId)} | zugewiesen an Nutzer ${stored.assignedUserId ?? '–'} | Version ${stored.version}`);
    // Zieht weclapp nach dem Anlegen selbst etwas nach, ändert sich die Version: dann löscht weclapp_undo_change das Ticket nicht mehr
    if (stored.version === created.result.version) {
      say('   Von weclapp seit dem Anlegen geändert: nichts (Version unverändert)');
    } else {
      const changed = Object.keys({ ...created.result, ...stored }).filter((key) => !MANAGED.has(key) && !isDeepStrictEqual(created.result[key], stored[key]));
      say(`   Von weclapp seit dem Anlegen geändert: Version ${created.result.version} → ${stored.version}, Felder: ${changed.join(', ') || 'keine erkennbar'}`);
    }
    say(`   Kommentare am Ticket: ${read.comments.length}, Zeitbuchungen: ${read.timeRecords.length}`);
    const changes = must('weclapp_list_changes', await call(client, 'weclapp_list_changes'));
    say(`   Im Änderungsprotokoll: ${JSON.stringify(changes).includes(created.changeId) ? 'ja' : 'NEIN'}`);

    say('8. Vorschau des Rückgängigmachens (weclapp_undo_change mit dryRun)');
    const previewed = await call(client, 'weclapp_undo_change', { changeId: created.changeId, dryRun: true });
    say(previewed.ok ? '   Das Ticket würde gelöscht.' : `   Würde abbrechen: ${previewed.error}`);

    say();
    if (!(await confirm('9. Test-Ticket wieder löschen (weclapp_undo_change)?'))) {
      say(`   Das Ticket bleibt bestehen: ${number}. Später in weclapp von Hand schließen oder löschen.`);
      return;
    }
    const undone = await call(client, 'weclapp_undo_change', { changeId: created.changeId });
    if (undone.ok) {
      const gone = await call(client, 'weclapp_get_ticket', { id, includeComments: false, includeTimeRecords: false });
      say(`   Rückgängig gemacht. Ticket noch vorhanden: ${gone.ok ? 'JA' : 'nein'}`);
      return;
    }
    say(`   Rückgängig fehlgeschlagen: ${undone.error}`);

    // Der Ausweg, den auch die Meldung des Tools nennt: schließen statt löschen
    const closed = statuses.find((status) => status.internalTicketStatus === 'CLOSED');
    if (!closed || !(await confirm(`   Ticket stattdessen schließen (Status "${closed.name}")?`))) {
      say(`   Das Ticket bleibt offen: ${number}. Bitte in weclapp von Hand schließen oder löschen.`);
      return;
    }
    const shut = await call(client, 'weclapp_update_ticket', { id, fields: { ticketStatusId: closed.id } });
    say(shut.ok ? `   Geschlossen: Ticket ${number}, changeId ${shut.data.changeId}` : `   Schließen fehlgeschlagen: ${shut.error} Bitte Ticket ${number} in weclapp von Hand schließen.`);
  } finally {
    await close();
  }
}

runSmoke(main);
