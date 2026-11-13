/**
 * Hilfsfunktionen zwischen MCP-Tools und weclapp:
 * Zeitstempel (weclapp: Epoch-Millisekunden, Tools: ISO-8601) und Filter.
 */

const DATE_KEY = /Date$/;
/** Schlüssel, die beim Zuweisen den Prototyp eines Objekts verändern könnten. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Ersetzt Epoch-Millisekunden in Feldern auf "...Date" rekursiv durch ISO-8601-Strings. */
export function datesToIso(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(datesToIso);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = DATE_KEY.test(key) && typeof v === 'number' ? new Date(v).toISOString() : datesToIso(v);
    }
    return out;
  }
  return value;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i;
/** Größter Zeitwert, den ein Date darstellen kann. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * Wandelt ISO-Datumsangaben in einen Epoch-Millisekunden-Wert.
 *
 * Bewusst streng: Date.parse allein liest auch "01.12.2026" (als 12. Januar) oder "Ticket 5" (als Mai 2001)
 * klaglos ein. Ein falsch verstandenes Datum landet sonst unbemerkt in Verträgen, Tickets und Zeitbuchungen.
 */
export function toEpochMs(value: string, field = 'Datum'): number {
  const trimmed = value.trim();
  const invalid = () => new Error(`${field} "${value.slice(0, 60)}" ist kein gültiges Datum (erwartet ISO-8601, z. B. 2026-11-12 oder 2026-11-12T09:30:00+01:00).`);
  if (/^\d{10,16}$/.test(trimmed)) {
    const epoch = Number(trimmed);
    if (epoch > MAX_EPOCH_MS) throw invalid();
    return epoch;
  }
  const match = ISO_DATE.exec(trimmed);
  if (!match) throw invalid();
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Den Kalendertag prüfen: der 31. Februar würde sonst stillschweigend zum 3. März
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw invalid();
  const ms = Date.parse(trimmed.replace(' ', 'T'));
  if (Number.isNaN(ms)) throw invalid();
  return ms;
}

/** Wandelt ISO-Strings in Feldern auf "...Date" rekursiv in Epoch-Millisekunden (für Schreibzugriffe). */
export function datesFromIso(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(datesFromIso);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = DATE_KEY.test(key) && typeof v === 'string' && v.trim() !== '' ? toEpochMs(v, key) : datesFromIso(v);
    }
    return out;
  }
  return value;
}

const FILTER_KEY = /^[A-Za-z][A-Za-z0-9_.]*-(eq|ne|lt|gt|le|ge|null|notnull|like|notlike|ilike|notilike|in|notin)$/;

/**
 * Zerlegt einen weclapp-Filterstring wie "name-ilike=%foo%&active-eq=true"
 * in Query-Parameter. Erlaubt nur echte Filter, keine anderen Parameter.
 */
export function parseFilter(filter: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!filter?.trim()) return result;
  for (const part of filter.split('&')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const key = (eq === -1 ? part : part.slice(0, eq)).trim();
    const value = eq === -1 ? '' : part.slice(eq + 1).trim();
    if (!FILTER_KEY.test(key)) {
      throw new Error(`Ungültiger Filter "${key}". Erwartet: feld-operator=wert, z. B. "name-ilike=%abc%" (Operatoren: eq, ne, lt, gt, le, ge, like, ilike, notlike, notilike, in, notin, null, notnull).`);
    }
    result[key] = value;
  }
  return result;
}

const SORT_PATTERN = /^-?[A-Za-z][A-Za-z0-9_.]*(,-?[A-Za-z][A-Za-z0-9_.]*)*$/;

/** Prüft eine Sortierangabe wie "-lastModifiedDate" oder "name,-id". */
export function checkSort(sort: string | undefined): string | undefined {
  if (sort === undefined || sort.trim() === '') return undefined;
  if (!SORT_PATTERN.test(sort.trim())) throw new Error(`Ungültige Sortierung "${sort.slice(0, 60)}". Erwartet: Feldname, optional mit "-" davor.`);
  return sort.trim();
}

/** Entfernt undefined-Werte, damit nur gesetzte Filter an weclapp gehen. */
export function compact<T extends Record<string, unknown>>(obj: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  return out;
}

/** Escaped %/_ nicht – weclapp-like-Filter nutzen % als Platzhalter; wir umschließen den Suchbegriff. */
export function contains(text: string): string {
  return `%${text.trim()}%`;
}
