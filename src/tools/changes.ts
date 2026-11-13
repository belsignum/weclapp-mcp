import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod';
import { CHANGE_ID_PATTERN, type ChangeEntry } from '../audit.ts';
import { WeclappError, type Entity } from '../weclapp/client.ts';
import { toEpochMs } from '../weclapp/format.ts';
import { READ, UPDATE, auditUser, auditedUpdate, dryRunArg, refArg, run, type ToolContext } from './common.ts';

/** Datentypen, die über diesen Server geändert werden – nur diese lassen sich zurücksetzen. */
const ENTITIES = ['article', 'ticket', 'contract', 'timeRecord', 'comment'] as const;
const ENTITY_SET = new Set<string>(ENTITIES);
const MANAGED_KEYS = new Set(['version', 'createdDate', 'lastModifiedDate']);

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** Entfernt von weclapp verwaltete Felder aus verschachtelten Einträgen. */
function stripManaged(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripManaged);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !MANAGED_KEYS.has(key))
        .map(([key, v]) => [key, stripManaged(v)]),
    );
  }
  return value;
}

/**
 * Baut die Werte zum Zurückschreiben. Listeneinträge, die es inzwischen nicht mehr gibt,
 * werden ohne id gesendet und so von weclapp neu angelegt.
 */
function restoreValues(before: Record<string, unknown>, current: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, old] of Object.entries(before)) {
    if (!Array.isArray(old)) {
      out[key] = stripManaged(old);
      continue;
    }
    const currentItems = Array.isArray(current[key]) ? (current[key] as unknown[]) : [];
    const existing = new Set(currentItems.map((item) => (item && typeof item === 'object' ? (item as Entity).id : undefined)).filter(Boolean));
    out[key] = old.map((item) => {
      const clean = stripManaged(item);
      if (clean && typeof clean === 'object' && !Array.isArray(clean)) {
        const { id, ...rest } = clean as Record<string, unknown>;
        return typeof id === 'string' && existing.has(id) ? clean : rest;
      }
      return clean;
    });
  }
  return out;
}

function summary(entry: ChangeEntry) {
  return {
    changeId: entry.id,
    time: entry.time,
    tool: entry.tool,
    kind: entry.kind,
    entity: entry.entity,
    entityId: entry.entityId,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.undoes ? { undoes: entry.undoes } : {}),
    ...(entry.undoneBy ? { undoneBy: entry.undoneBy } : {}),
    undoable: entry.status === 'done' && !entry.undoneBy && !entry.truncated && entry.kind !== 'delete' && ENTITY_SET.has(entry.entity),
    before: entry.before,
    after: entry.after,
    ...(entry.omitted ? { hinweis: 'Der alte bzw. neue Stand ist zu groß für diese Übersicht und wurde weggelassen. Das Rückgängigmachen ist davon nicht betroffen.' } : {}),
  };
}

export function registerChangeTools(ctx: ToolContext): void {
  const { server, client, audit, readOnly } = ctx;
  if (!audit) return;

  server.registerTool(
    'weclapp_list_changes',
    {
      title: 'Änderungsprotokoll anzeigen',
      description:
        'Zeigt die Änderungen, die mit dem eigenen weclapp-Nutzer über diesen MCP-Server gemacht wurden (neueste zuerst), mit altem und neuem Stand der betroffenen Felder. ' +
        'Änderungen direkt in weclapp oder über andere Wege stehen nicht im Protokoll.',
      inputSchema: z.object({
        entity: z.enum(ENTITIES).optional().describe('Nur Änderungen an diesem Datentyp.'),
        entityId: refArg('Nur Änderungen an diesem Datensatz.'),
        since: z.string().max(40).optional().describe('Nur Änderungen ab diesem Zeitpunkt (ISO-8601).'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximale Anzahl (Standard 25).'),
      }),
      annotations: { ...READ, openWorldHint: false },
    },
    ({ entity, entityId, since, limit }) => run(async () => {
      const me = await auditUser(client);
      const entries = await audit.list({ userId: me.id, entity, entityId, since: since ? toEpochMs(since, 'since') : undefined, limit });
      return { count: entries.length, result: entries.map(summary) };
    }),
  );

  if (readOnly) return;

  server.registerTool(
    'weclapp_undo_change',
    {
      title: 'Änderung rückgängig machen',
      description:
        'Macht eine eigene Änderung aus dem Protokoll rückgängig: geänderte Felder werden auf den alten Stand gesetzt, angelegte Zeitbuchungen, Kommentare oder Artikel wieder gelöscht. ' +
        'Bricht ab, wenn der Datensatz seit der Änderung anders verändert wurde. Vorher dem Nutzer zeigen, was zurückgesetzt wird, und bestätigen lassen; dryRun: true zeigt eine Vorschau. ' +
        'Ein bereits vom Kunden gesehener öffentlicher Kommentar lässt sich nur löschen, nicht ungesehen machen.',
      inputSchema: z.object({
        changeId: z.string().regex(CHANGE_ID_PATTERN, 'Erwartet wird eine changeId aus weclapp_list_changes.').describe('Die changeId aus weclapp_list_changes oder aus dem Ergebnis eines Schreib-Tools.'),
        dryRun: dryRunArg,
      }),
      annotations: UPDATE,
    },
    ({ changeId, dryRun }) => run(async () => {
      const me = await auditUser(client);

      const undo = async () => {
        // Fremde und unbekannte IDs liefern bewusst dieselbe Meldung
        const entry = await audit.get(changeId, me.id);
        if (!entry) throw new Error('Diese Änderung gibt es im eigenen Protokoll nicht.');
        if (entry.status !== 'done') throw new Error(`Diese Änderung hat den Status "${entry.status}" und kann nicht rückgängig gemacht werden.`);
        if (entry.undoneBy) throw new Error(`Diese Änderung wurde bereits rückgängig gemacht (changeId ${entry.undoneBy}).`);
        if (entry.truncated) throw new Error('Der alte Stand war zu groß für das Protokoll; diese Änderung lässt sich nicht automatisch zurücksetzen.');
        if (!ENTITY_SET.has(entry.entity) || !entry.entityId) throw new Error('Dieser Protokolleintrag lässt sich nicht zurücksetzen.');
        const { entity, entityId } = entry;

        let current: Entity;
        try {
          current = await client.get<Entity>(entity, entityId);
        } catch (error) {
          if (error instanceof WeclappError && error.status === 404) throw new Error('Der Datensatz existiert in weclapp nicht mehr.');
          throw error;
        }

        // Wird erst nach der Aktion in weclapp aufgerufen: ein Fehler beim Vermerken darf sie nicht als gescheitert melden
        const mark = (by: string) =>
          audit.markUndone(entry.id, by).then(
            () => ({}),
            () => ({ warning: 'Die Änderung wurde zurückgesetzt, konnte im Protokoll aber nicht als rückgängig gemacht vermerkt werden.' }),
          );

        if (entry.kind === 'update') {
          const before = entry.before ?? {};
          const after = entry.after ?? {};
          const conflicts = Object.keys(before).filter((key) => !isDeepStrictEqual(current[key] ?? null, after[key] ?? null));
          if (conflicts.length > 0) {
            const details = conflicts.map((key) => `${key}: nach der Änderung ${preview(after[key])}, jetzt ${preview(current[key])}`).join('; ');
            throw new Error(`Abgebrochen: Der Datensatz wurde seit der Änderung anders verändert (${details}). Bitte manuell prüfen.`);
          }
          const restore = restoreValues(before, current);
          const outcome = await auditedUpdate(ctx, 'weclapp_undo_change', entity, entityId, restore, { version: current.version, dryRun, undoes: entry.id });
          const marked = 'changeId' in outcome ? await mark(outcome.changeId) : {};
          return { undone: !dryRun, restored: restore, ...outcome, ...marked };
        }

        if (entry.kind === 'create') {
          if (entry.versionAfter && current.version !== entry.versionAfter) {
            throw new Error('Abgebrochen: Der angelegte Datensatz wurde inzwischen verändert. Bitte manuell prüfen.');
          }
          if (dryRun) return { dryRun: true, wouldDelete: { entity, entityId } };
          ctx.writeBudget.take(me.id, 'undo');
          const id = await audit.begin({ user: me, tool: 'weclapp_undo_change', kind: 'delete', entity, entityId, before: current, versionBefore: current.version, undoes: entry.id });
          try {
            await client.delete(entity, entityId);
          } catch (error) {
            await audit.end(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }).catch(() => {});
            if (entity === 'article') throw new Error(`${error instanceof Error ? error.message : error} – Ein bereits verwendeter Artikel lässt sich nicht löschen; stattdessen mit weclapp_update_article auf "active": false setzen.`);
            throw error;
          }
          await audit.end(id, { status: 'done' }).catch(() => {});
          return { undone: true, changeId: id, deleted: { entity, entityId }, ...(await mark(id)) };
        }

        throw new Error('Löschungen lassen sich nicht rückgängig machen.');
      };

      // Dieselbe Änderung nie zweimal gleichzeitig zurücksetzen (die Vorschau ändert nichts und braucht keine Sperre)
      return dryRun ? undo() : audit.exclusive(`undo:${changeId}`, undo);
    }),
  );
}
