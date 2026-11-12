import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { WeclappError, type Entity, type ListOptions, type WeclappClient } from '../weclapp/client.ts';
import { datesFromIso, datesToIso, parseFilter } from '../weclapp/format.ts';

export interface ToolContext {
  server: McpServer;
  client: WeclappClient;
  readOnly: boolean;
}

export const DEFAULT_PAGE_SIZE = 25;

export const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
export const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

// ---- gemeinsame Argumente -------------------------------------------------

export const idArg = z.string().min(1).describe('Die interne weclapp-ID (numerischer String), nicht die Belegnummer.');

export const pagingArgs = {
  page: z.number().int().min(1).optional().describe('Seite, beginnend bei 1 (Standard 1).'),
  pageSize: z.number().int().min(1).max(200).optional().describe(`Treffer pro Seite (Standard ${DEFAULT_PAGE_SIZE}, max. 200).`),
};

export const filterArg = z
  .string()
  .optional()
  .describe('Zusätzliche weclapp-Filter als "feld-operator=wert", mehrere mit & verbunden, z. B. "tags-in=[VIP]&lastModifiedDate-gt=1767225600000". Operatoren: eq, ne, lt, gt, le, ge, like, ilike, notlike, notilike, in, notin, null, notnull. Datumsfelder erwarten hier Epoch-Millisekunden.');

export const sortArg = z.string().optional().describe('Sortierfeld, mit "-" davor absteigend, z. B. "-lastModifiedDate".');

export const allFieldsArg = z.boolean().optional().describe('true liefert alle Felder statt der kompakten Übersicht.');

export const dryRunArg = z
  .boolean()
  .optional()
  .describe('true: weclapp prüft die Änderung und antwortet so, als wäre sie gespeichert, speichert aber nichts. Gut als Vorschau.');

export const versionArg = z
  .string()
  .optional()
  .describe('Das Feld "version" aus dem zuletzt gelesenen Datensatz. Dann lehnt weclapp die Änderung ab, wenn jemand anderes den Datensatz inzwischen geändert hat.');

export const fieldsArg = (examples: string) =>
  z
    .record(z.string(), z.unknown())
    .describe(
      `Zu ändernde Felder mit ihren weclapp-Namen, z. B. ${examples}. Nur geänderte Felder senden; nicht gesendete Felder bleiben unverändert. ` +
        'Listenfelder werden als Ganzes ersetzt: Einträge, die fehlen, löscht weclapp. Bestehende Einträge mit ihrer "id" mitschicken. ' +
        'Datumsfelder (Name endet auf "Date") als ISO-8601-String.',
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
 * Listet Datensätze. `alternatives` ermöglicht eine ODER-Suche (z. B. Name ODER Nummer):
 * jede Variante wird parallel abgefragt und das Ergebnis nach id zusammengeführt.
 */
export async function search(
  client: WeclappClient,
  entity: string,
  input: SearchInput,
  options: { filters?: Record<string, string>; alternatives?: Array<Record<string, string>>; compactFields: string; defaultSort?: string; extra?: ListOptions['extra'] },
) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const base: ListOptions = {
    page,
    pageSize,
    sort: input.sort ?? options.defaultSort,
    properties: input.allFields ? undefined : options.compactFields,
    extra: options.extra,
  };
  const filters = { ...options.filters, ...parseFilter(input.filter) };
  const variants = options.alternatives?.length ? options.alternatives : [{}];

  const responses = await Promise.all(variants.map((alt) => client.list<Entity>(entity, { ...base, filters: { ...filters, ...alt } })));
  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const response of responses) {
    for (const item of response.result ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  const hasMore = responses.some((r) => (r.result?.length ?? 0) >= pageSize);
  return { page, pageSize, count: Math.min(merged.length, pageSize), hasMore, result: merged.slice(0, pageSize) };
}

/** Wandelt Schreib-Felder für weclapp um (ISO-Datum → Epoch-ms) und entfernt undefined. */
export function toWeclappBody(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return datesFromIso(out) as Record<string, unknown>;
}
