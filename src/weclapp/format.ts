/**
 * Hilfsfunktionen zwischen MCP-Tools und weclapp:
 * Zeitstempel (weclapp: Epoch-Millisekunden, Tools: ISO-8601) und Filter.
 */

const DATE_KEY = /Date$/;
/** Schlüssel, die beim Zuweisen den Prototyp eines Objekts verändern könnten. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Größter Zeitwert, den ein Date darstellen kann. */
const MAX_EPOCH_MS = 8.64e15;

// ---- Zeitzone des Mandanten -----------------------------------------------

/**
 * Zeitzone, in der der Mandant arbeitet (IANA-Name, z. B. "Europe/Berlin").
 *
 * weclapp speichert reine Datumsangaben wie Rechnungsdatum oder Vertragsende als Mitternacht dieser Zone, nicht als
 * Mitternacht UTC. Deshalb gelten Angaben ohne Zeitzone in dieser Zone, und die Ausgabe trägt ihren Offset: nur so
 * stimmt der Datumsteil mit dem Tag überein, der in weclapp steht.
 *
 * Gilt für den ganzen Prozess: ein Server spricht mit genau einem Mandanten.
 */
let timeZone = 'UTC';
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(zone, format);
  }
  return format;
}

/** Prüft einen IANA-Zeitzonennamen und gibt ihn zurück. */
export function checkTimeZone(zone: string): string {
  try {
    formatter(zone);
  } catch {
    throw new Error(`Unbekannte Zeitzone "${zone.slice(0, 60)}". Erwartet wird ein IANA-Name wie "Europe/Berlin" oder "UTC".`);
  }
  return zone;
}

export function setTimeZone(zone: string): void {
  timeZone = checkTimeZone(zone);
}

export function currentTimeZone(): string {
  return timeZone;
}

/** Abstand der Zeitzone des Mandanten zu UTC in Millisekunden, zum angegebenen Zeitpunkt (Sommerzeit eingerechnet). */
function offsetMs(epochMs: number): number {
  if (timeZone === 'UTC') return 0;
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) parts[part.type] = Number(part.value);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Rechnet eine Uhrzeit in der Zeitzone des Mandanten in einen Zeitpunkt um. `wallMs` ist die Uhrzeit, als wäre sie UTC.
 * Der Offset wird am Ergebnis nachgeprüft, damit die Rechnung auch am Tag der Zeitumstellung stimmt.
 */
function wallTimeToEpochMs(wallMs: number): number {
  const guess = wallMs - offsetMs(wallMs);
  return wallMs - offsetMs(guess);
}

/** ISO-8601 mit dem Offset der Zeitzone des Mandanten, bei UTC wie gewohnt mit "Z". */
function toIso(epochMs: number): string {
  if (timeZone === 'UTC') return new Date(epochMs).toISOString();
  const offset = offsetMs(epochMs);
  const minutes = Math.abs(offset) / 60_000;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${new Date(epochMs + offset).toISOString().slice(0, -1)}${offset < 0 ? '-' : '+'}${pad(minutes / 60)}:${pad(minutes % 60)}`;
}

/** Ersetzt Epoch-Millisekunden in Feldern auf "...Date" rekursiv durch ISO-8601-Strings. */
export function datesToIso(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(datesToIso);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = DATE_KEY.test(key) && typeof v === 'number' && Math.abs(v) <= MAX_EPOCH_MS ? toIso(v) : datesToIso(v);
    }
    return out;
  }
  return value;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Wandelt ISO-Datumsangaben in einen Epoch-Millisekunden-Wert. Ohne Zeitzone ("2026-11-12", "2026-11-12T09:30")
 * gilt die Angabe in der Zeitzone des Mandanten.
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
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone] = match;
  // Den Kalendertag prüfen: der 31. Februar würde sonst stillschweigend zum 3. März
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) throw invalid();
  // Die Uhrzeit, als wäre sie UTC; Date.parse prüft dabei Stunde, Minute und Sekunde
  const wall = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0').slice(0, 3)}Z`);
  if (Number.isNaN(wall)) throw invalid();
  if (!zone) return wallTimeToEpochMs(wall);
  if (zone.toUpperCase() === 'Z') return wall;
  const [zoneHours, zoneMinutes] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
  if (zoneHours > 23 || zoneMinutes > 59) throw invalid();
  return wall - (zone.startsWith('-') ? -1 : 1) * (zoneHours * 60 + zoneMinutes) * 60_000;
}

/**
 * Wie toEpochMs, für das Ende eines Zeitraums "bis einschließlich": eine reine Datumsangabe meint den ganzen Tag
 * und ergibt dessen letzte Millisekunde (in der Zeitzone des Mandanten, auch an Tagen mit 23 oder 25 Stunden).
 */
export function toEpochMsInclusive(value: string, field = 'Datum'): number {
  const start = toEpochMs(value, field);
  const trimmed = value.trim();
  if (!DATE_ONLY.test(trimmed)) return start;
  const [year, month, day] = trimmed.split('-').map(Number);
  return wallTimeToEpochMs(Date.UTC(year, month - 1, day + 1)) - 1;
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
/** Operatoren ohne Wert: "feld-null" und "feld-notnull". */
const WITHOUT_VALUE = /-(null|notnull)$/;

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
    if (WITHOUT_VALUE.test(key)) {
      // weclapp wertet bei diesen Operatoren nur den Namen aus. Ein fester Wert sorgt dafür, dass der Parameter gesendet wird
      result[key] = 'true';
      continue;
    }
    if (value === '') {
      const field = key.slice(0, key.lastIndexOf('-'));
      throw new Error(`Filter "${key}" braucht einen Wert. Für leere Felder "${field}-null" verwenden, für gefüllte "${field}-notnull".`);
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
