import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AuditLog, AuditUser } from '../audit.ts';
import type { WriteBudget } from '../budget.ts';
import { ID_PATTERN, WeclappError, type Entity, type ListOptions, type WeclappClient } from '../weclapp/client.ts';
import { checkSort, datesFromIso, datesToIso, parseFilter } from '../weclapp/format.ts';

export interface ToolContext {
  server: McpServer;
  client: WeclappClient;
  /** true: keine Schreib-Tools (ausdrücklich so konfiguriert oder kein Änderungsprotokoll vorhanden). */
  readOnly: boolean;
  allowPublicComments: boolean;
  audit: AuditLog | undefined;
  /** Schreiblimit pro Nutzer und Stunde. */
  writeBudget: WriteBudget;
}

export const DEFAULT_PAGE_SIZE = 25;

export const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
export const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

// ---- gemeinsame Argumente -------------------------------------------------

export const idArg = z
  .string()
  .regex(ID_PATTERN, 'Erwartet wird die numerische weclapp-ID.')
  .describe('Die interne weclapp-ID (numerischer String), nicht die Belegnummer.');

/** Optionale ID als Filterwert. */
export const refArg = (description: string) => z.string().regex(ID_PATTERN, 'Erwartet wird die numerische weclapp-ID.').optional().describe(description);

export const pagingArgs = {
  page: z.number().int().min(1).max(100_000).optional().describe('Seite, beginnend bei 1 (Standard 1).'),
  pageSize: z.number().int().min(1).max(200).optional().describe(`Treffer pro Seite (Standard ${DEFAULT_PAGE_SIZE}, max. 200).`),
};

export const filterArg = z
  .string()
  .max(2000)
  .optional()
  .describe('Zusätzliche weclapp-Filter als "feld-operator=wert", mehrere mit & verbunden, z. B. "tags-in=[VIP]&lastModifiedDate-gt=1767225600000". Operatoren: eq, ne, lt, gt, le, ge, like, ilike, notlike, notilike, in, notin, null, notnull. Datumsfelder erwarten hier Epoch-Millisekunden.');

export const sortArg = z.string().max(200).optional().describe('Sortierfeld, mit "-" davor absteigend, z. B. "-lastModifiedDate".');

export const allFieldsArg = z.boolean().optional().describe('true liefert alle Felder statt der kompakten Übersicht.');

export const dryRunArg = z
  .boolean()
  .optional()
  .describe('true: weclapp prüft die Änderung und antwortet so, als wäre sie gespeichert, speichert aber nichts. Gut als Vorschau.');

export const versionArg = z
  .string()
  .max(40)
  .optional()
  .describe('Das Feld "version" aus dem zuletzt gelesenen Datensatz. Dann lehnt weclapp die Änderung ab, wenn jemand anderes den Datensatz inzwischen geändert hat.');

export const fieldsArg = (examples: string) =>
  z
    .record(z.string(), z.unknown())
    .describe(
      `Zu ändernde Felder mit ihren weclapp-Namen, z. B. ${examples}. Nur geänderte Felder senden; nicht gesendete Felder bleiben unverändert. ` +
        'Listenfelder werden als Ganzes ersetzt: Einträge, die fehlen, löscht weclapp. Bestehende Einträge mit ihrer "id" mitschicken. ' +
        'Datumsfelder (Name endet auf "Date", dazu servicePeriodFrom/To, dateFrom/To, dateValue) als ISO-8601-String.',
    );

// ---- Ergebnisse -----------------------------------------------------------

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: 'text', text: JSON.stringify(datesToIso(data), null, 1) }] };
}

export function fail(error: unknown): TextResult {
  const message = error instanceof WeclappError || error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Führt einen Tool-Handler aus und übersetzt Fehler in ein MCP-Fehlerergebnis. */
export async function run(fn: () => Promise<unknown>): Promise<TextResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

// ---- Listen ---------------------------------------------------------------

export interface SearchInput {
  page?: number;
  pageSize?: number;
  sort?: string;
  filter?: string;
  allFields?: boolean;
}

/**
 * Listet Datensätze. `anyOf` ist eine ODER-Suche (z. B. Name ODER Nummer): mindestens einer dieser Filter muss passen.
 *
 * Die ODER-Verknüpfung übernimmt weclapp selbst, über das Präfix "or-" (API-Doku, Abschnitt '"Or" condition filtering').
 * Nur so blättert und sortiert weclapp über die ganze Treffermenge. Je Variante einzeln abzufragen und die Seiten
 * zusammenzulegen verliert Treffer: was beim Kürzen auf die Seitengröße wegfällt, kommt auf keiner späteren Seite wieder.
 */
export async function search(
  client: WeclappClient,
  entity: string,
  input: SearchInput,
  options: {
    filters?: Record<string, string>;
    /** Filter, die der freie `filter` des Aufrufers nicht überschreiben kann (grenzen ein Tool auf seinen Gegenstand ein). */
    fixed?: Record<string, string>;
    anyOf?: Record<string, string>;
    compactFields: string;
    defaultSort?: string;
    extra?: ListOptions['extra'];
  },
) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const anyOf = Object.fromEntries(Object.entries(options.anyOf ?? {}).map(([key, value]) => [`or-${key}`, value]));
  const response = await client.list<Entity>(entity, {
    page,
    pageSize,
    sort: checkSort(input.sort) ?? options.defaultSort,
    properties: input.allFields ? undefined : options.compactFields,
    extra: options.extra,
    filters: { ...options.filters, ...parseFilter(input.filter), ...anyOf, ...options.fixed },
  });
  const result = response.result ?? [];
  return { page, pageSize, count: result.length, hasMore: result.length >= pageSize, result };
}

// ---- Schreiben mit Protokoll ----------------------------------------------

/** Felder, die ein Aufrufer nie selbst setzen darf (weclapp verwaltet sie bzw. sie stehen im Pfad). */
const PROTECTED_FIELDS = new Set(['id', 'version', 'createdDate', 'lastModifiedDate']);

/** Wandelt Schreib-Felder für weclapp um (ISO-Datum → Epoch-ms), entfernt undefined und geschützte Felder. */
export function toWeclappBody(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && !PROTECTED_FIELDS.has(key)) out[key] = value;
  }
  return datesFromIso(out) as Record<string, unknown>;
}

export async function auditUser(client: WeclappClient): Promise<AuditUser> {
  const me = await client.currentUser();
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || String(me.username ?? me.email ?? '');
  return { id: String(me.id), name };
}

function pick(record: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = record?.[key] ?? null;
  return out;
}

function requireAudit(ctx: ToolContext): AuditLog {
  if (!ctx.audit || ctx.readOnly) throw new Error('Dieser Server ist im Nur-Lesen-Modus (kein Änderungsprotokoll konfiguriert).');
  return ctx.audit;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ändert einen Datensatz und protokolliert vorher den alten und nachher den neuen Stand
 * der betroffenen Felder. Mit dryRun wird nichts protokolliert.
 */
export async function auditedUpdate(
  ctx: ToolContext,
  tool: string,
  entity: string,
  id: string,
  fields: Record<string, unknown>,
  options: { version?: string; dryRun?: boolean; undoes?: string } = {},
) {
  const body = toWeclappBody(fields);
  const keys = Object.keys(body);
  if (keys.length === 0) throw new Error('Keine änderbaren Felder angegeben.');
  if (options.dryRun) {
    return { dryRun: true, result: await ctx.client.update(entity, id, body, { version: options.version, dryRun: true }) };
  }

  const audit = requireAudit(ctx);
  const [user, before] = await Promise.all([auditUser(ctx.client), ctx.client.get<Entity>(entity, id)]);
  ctx.writeBudget.take(user.id, options.undoes ? 'undo' : 'write');
  const changeId = await audit.begin({
    user,
    tool,
    kind: 'update',
    entity,
    entityId: id,
    before: pick(before, keys),
    versionBefore: before.version,
    undoes: options.undoes,
  });

  let result: Entity;
  try {
    // Mit der eben gelesenen Version schreiben: so passt der protokollierte Vorher-Stand sicher zur Änderung
    result = await ctx.client.update<Entity>(entity, id, body, { version: options.version ?? before.version });
  } catch (error) {
    await audit.end(changeId, { status: 'failed', error: errorText(error) }).catch(() => {});
    throw error;
  }
  const logged = await audit
    .end(changeId, { status: 'done', after: pick(result, keys), versionAfter: result?.version })
    .then(() => true, () => false);
  return { changeId, ...(logged ? {} : { warning: 'Die Änderung wurde gespeichert, das Protokoll konnte aber nicht vervollständigt werden.' }), result };
}

/** Legt einen Datensatz an und protokolliert ihn. Mit dryRun wird nichts protokolliert. */
export async function auditedCreate(ctx: ToolContext, tool: string, entity: string, fields: Record<string, unknown>, dryRun = false) {
  const body = toWeclappBody(fields);
  if (dryRun) return { dryRun: true, result: await ctx.client.create(entity, body, true) };

  const audit = requireAudit(ctx);
  const user = await auditUser(ctx.client);
  ctx.writeBudget.take(user.id);
  const changeId = await audit.begin({ user, tool, kind: 'create', entity });

  let result: Entity;
  try {
    result = await ctx.client.create<Entity>(entity, body);
  } catch (error) {
    await audit.end(changeId, { status: 'failed', error: errorText(error) }).catch(() => {});
    throw error;
  }
  const logged = await audit
    .end(changeId, { status: 'done', entityId: result?.id, after: pick(result, Object.keys(body)), versionAfter: result?.version })
    .then(() => true, () => false);
  return { changeId, ...(logged ? {} : { warning: 'Der Datensatz wurde angelegt, das Protokoll konnte aber nicht vervollständigt werden.' }), result };
}
