/**
 * Hilfsfunktionen zwischen MCP-Tools und weclapp:
 * Zeitstempel (weclapp: Epoch-Millisekunden, Tools: ISO-8601) und Filter.
 */

const DATE_KEY = /Date$/;

/** Ersetzt Epoch-Millisekunden in Feldern auf "...Date" rekursiv durch ISO-8601-Strings. */
export function datesToIso(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(datesToIso);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = DATE_KEY.test(key) && typeof v === 'number' ? new Date(v).toISOString() : datesToIso(v);
    }
    return out;
  }
  return value;
}

/** Wandelt ISO-Datumsangaben in einen Epoch-Millisekunden-Wert. */
export function toEpochMs(value: string, field = 'Datum'): number {
  const trimmed = value.trim();
  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`${field} "${value}" ist kein gültiges Datum (erwartet ISO-8601, z. B. 2026-11-12 oder 2026-11-12T09:30:00+01:00).`);
  }
  return ms;
}

/** Wandelt ISO-Strings in Feldern auf "...Date" rekursiv in Epoch-Millisekunden (für Schreibzugriffe). */
export function datesFromIso(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(datesFromIso);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
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
