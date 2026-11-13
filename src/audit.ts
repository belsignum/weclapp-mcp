/**
 * Änderungsprotokoll: jede Schreibaktion wird VOR der Ausführung protokolliert
 * (phase "begin") und danach mit dem Ergebnis ergänzt (phase "end").
 *
 * Format: JSON Lines, eine Datei pro Monat (YYYY-MM.jsonl), nur anhängend.
 * Der weclapp-Token wird nie protokolliert.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type ChangeKind = 'create' | 'update' | 'delete';
export type ChangeStatus = 'pending' | 'done' | 'failed';

export interface AuditUser {
  id: string;
  name: string;
}

export interface ChangeEntry {
  id: string;
  time: string;
  user: AuditUser;
  tool: string;
  kind: ChangeKind;
  entity: string;
  entityId?: string;
  status: ChangeStatus;
  /** Werte der betroffenen Felder vor der Änderung. */
  before?: Record<string, unknown>;
  /** Werte der betroffenen Felder nach der Änderung (laut weclapp-Antwort). */
  after?: Record<string, unknown>;
  versionBefore?: string;
  versionAfter?: string;
  error?: string;
  /** Diese Änderung macht die genannte Änderung rückgängig. */
  undoes?: string;
  /** Diese Änderung wurde durch die genannte Änderung rückgängig gemacht. */
  undoneBy?: string;
  /** Der Stand war zu groß fürs Protokoll; Rückgängigmachen ist nicht möglich. */
  truncated?: boolean;
  /** Nur in list(): Vorher-/Nachher-Stand ist zu groß für die Übersicht und wurde weggelassen (get() liefert ihn vollständig). */
  omitted?: boolean;
}

export interface BeginInput {
  user: AuditUser;
  tool: string;
  kind: ChangeKind;
  entity: string;
  entityId?: string;
  before?: Record<string, unknown>;
  versionBefore?: string;
  undoes?: string;
}

export interface EndInput {
  status: 'done' | 'failed';
  entityId?: string;
  after?: Record<string, unknown>;
  versionAfter?: string;
  error?: string;
}

export interface ListFilter {
  userId: string;
  entity?: string;
  entityId?: string;
  since?: number;
  limit?: number;
}

const FILE_PATTERN = /^(\d{4})-(\d{2})\.jsonl$/;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** Protokollzeilen über dieser Länge liefert list() ohne Vorher-/Nachher-Stand, damit die Übersicht klein bleibt. */
const LIST_SNAPSHOT_MAX_CHARS = 32 * 1024;
/** So viele begonnene, nie abgeschlossene Einträge merkt sich list() höchstens zusätzlich. */
const LIST_MAX_OPEN = 1000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DAY_MS = 86_400_000;
const KINDS = new Set<unknown>(['create', 'update', 'delete']);
export const CHANGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function monthFile(time: Date): string {
  return `${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
}

/** Begrenzt die Größe eines protokollierten Standes. */
function snapshot(value: Record<string, unknown> | undefined): { value?: Record<string, unknown>; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SNAPSHOT_BYTES) return { value: { _truncated: true }, truncated: true };
  return { value, truncated: false };
}

type LogEvent = Record<string, any>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Baut aus einer "begin"-Zeile einen Eintrag. Die Datei könnte beschädigt oder von Hand verändert sein:
 * Zeilen mit unerwarteten Typen werden verworfen statt ungeprüft weiterverwendet (etwa beim Rückgängigmachen).
 */
function entryFromBegin(event: LogEvent, withSnapshot: boolean): ChangeEntry | undefined {
  const userId = text(event.user?.id);
  const time = text(event.time);
  const entity = text(event.entity);
  if (userId === undefined || time === undefined || entity === undefined || !KINDS.has(event.kind)) return undefined;
  return {
    id: event.id,
    time,
    user: { id: userId, name: String(event.user.name ?? '') },
    tool: String(event.tool),
    kind: event.kind,
    entity,
    entityId: text(event.entityId),
    status: 'pending',
    before: withSnapshot ? record(event.before) : undefined,
    versionBefore: text(event.versionBefore),
    undoes: text(event.undoes),
    truncated: event.truncated === true || undefined,
    omitted: (!withSnapshot && event.before !== undefined) || undefined,
  };
}

function applyEnd(entry: ChangeEntry, event: LogEvent, withSnapshot: boolean): void {
  entry.status = event.status === 'done' ? 'done' : 'failed';
  entry.entityId = text(event.entityId) ?? entry.entityId;
  entry.after = withSnapshot ? record(event.after) : undefined;
  entry.versionAfter = text(event.versionAfter);
  entry.error = text(event.error);
  entry.truncated = entry.truncated || event.truncated === true || undefined;
  entry.omitted = entry.omitted || (!withSnapshot && event.after !== undefined) || undefined;
}

export class AuditLog {
  readonly dir: string;
  readonly #retentionDays: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #pruneTimer: NodeJS.Timeout | undefined;
  /** Aktuelle Gesamtgröße aller Monatsdateien. */
  #bytes = 0;
  readonly #locks = new Set<string>();

  private constructor(dir: string, retentionDays: number, maxBytes: number, now: () => Date) {
    this.dir = dir;
    this.#retentionDays = retentionDays;
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  /** Legt das Verzeichnis an, prüft die Schreibbarkeit und räumt alte Monatsdateien auf. */
  static async open(dir: string, options: { retentionDays?: number; maxBytes?: number; now?: () => Date } = {}): Promise<AuditLog> {
    const log = new AuditLog(dir, options.retentionDays ?? 365, options.maxBytes ?? DEFAULT_MAX_BYTES, options.now ?? (() => new Date()));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    await log.#append(log.#now(), ''); // schlägt hier fehl, wenn das Verzeichnis nicht beschreibbar ist
    // Auch bereits vorhandene Dateien (z. B. aus einem Backup zurückgespielt) nur für den Besitzer lesbar machen
    for (const name of await log.#files()) await chmod(join(dir, name), 0o600).catch(() => {});
    await log.prune();
    await log.#measure();
    log.#pruneTimer = setInterval(() => void log.prune().catch(() => {}), DAY_MS);
    log.#pruneTimer.unref();
    return log;
  }

  close(): void {
    clearInterval(this.#pruneTimer);
  }

  #append(time: Date, line: string): Promise<void> {
    const file = join(this.dir, monthFile(time));
    const write = this.#queue.then(async () => {
      await appendFile(file, line, { mode: 0o600 });
      this.#bytes += Buffer.byteLength(line);
    });
    this.#queue = write.catch(() => {});
    return write;
  }

  async #measure(): Promise<void> {
    await this.#queue;
    let total = 0;
    for (const name of await this.#files()) total += (await stat(join(this.dir, name)).catch(() => undefined))?.size ?? 0;
    this.#bytes = total;
  }

  /**
   * Führt fn nur aus, wenn unter demselben Schlüssel gerade nichts läuft.
   * Verhindert, dass dieselbe Änderung zweimal gleichzeitig rückgängig gemacht wird.
   */
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.#locks.has(key)) throw new Error('Für diese Änderung läuft bereits ein Vorgang. Bitte das Ergebnis abwarten.');
    this.#locks.add(key);
    try {
      return await fn();
    } finally {
      this.#locks.delete(key);
    }
  }

  #event(phase: string, id: string, data: object): Promise<void> {
    const time = this.#now();
    return this.#append(time, `${JSON.stringify({ v: 1, phase, id, time: time.toISOString(), ...data })}\n`);
  }

  /** Protokolliert eine bevorstehende Änderung. Schlägt das fehl, darf die Änderung nicht ausgeführt werden. */
  async begin(input: BeginInput): Promise<string> {
    if (this.#maxBytes > 0 && this.#bytes >= this.#maxBytes) {
      throw new Error(
        `Das Änderungsprotokoll hat seine Maximalgröße erreicht (${Math.round(this.#maxBytes / 1024 / 1024)} MB, WECLAPP_AUDIT_MAX_MB). ` +
          'Ohne Protokoll wird nichts geändert. Bitte den Betreiber des Servers informieren.',
      );
    }
    const id = randomUUID();
    const before = snapshot(input.before);
    await this.#event('begin', id, {
      user: input.user,
      tool: input.tool,
      kind: input.kind,
      entity: input.entity,
      entityId: input.entityId,
      before: before.value,
      versionBefore: input.versionBefore,
      undoes: input.undoes,
      truncated: before.truncated || undefined,
    });
    return id;
  }

  async end(id: string, input: EndInput): Promise<void> {
    const after = snapshot(input.after);
    await this.#event('end', id, {
      status: input.status,
      entityId: input.entityId,
      after: after.value,
      versionAfter: input.versionAfter,
      error: input.error?.slice(0, 2000),
      truncated: after.truncated || undefined,
    });
  }

  markUndone(id: string, by: string): Promise<void> {
    return this.#event('undone', id, { by });
  }

  async #files(): Promise<string[]> {
    return (await readdir(this.dir)).filter((name) => FILE_PATTERN.test(name)).sort();
  }

  /**
   * Liest das Protokoll Zeile für Zeile, ohne es als Ganzes in den Speicher zu laden.
   * `wanted` filtert Zeilen schon vor dem Parsen.
   */
  async #scan(visit: (event: LogEvent, size: number) => void, wanted?: (line: string) => boolean): Promise<void> {
    await this.#queue;
    for (const name of await this.#files()) {
      const handle = await open(join(this.dir, name), 'r').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined; // inzwischen aufgeräumt
        throw error;
      });
      if (!handle) continue;
      try {
        for await (const line of handle.readLines({ encoding: 'utf8' })) {
          if (!line || (wanted && !wanted(line))) continue;
          let event: LogEvent;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // beschädigte Zeile überspringen
          }
          if (typeof event?.id !== 'string' || !CHANGE_ID_PATTERN.test(event.id)) continue;
          visit(event, line.length);
        }
      } finally {
        await handle.close().catch(() => {});
      }
    }
  }

  /**
   * Änderungen eines Nutzers, neueste zuerst. Im Speicher liegen dabei nie mehr als die
   * angeforderten Einträge; sehr große Stände werden weggelassen (omitted).
   */
  async list(filter: ListFilter): Promise<ChangeEntry[]> {
    const limit = filter.limit ?? 25;
    const pending = new Map<string, ChangeEntry>(); // begonnen, "end" steht noch aus
    const finished = new Map<string, ChangeEntry>();
    const wanted = (entry: ChangeEntry) => !filter.entityId || entry.entityId === filter.entityId;

    await this.#scan((event, size) => {
      const withSnapshot = size <= LIST_SNAPSHOT_MAX_CHARS;
      if (event.phase === 'begin') {
        if (pending.has(event.id) || finished.has(event.id)) return; // eine id gehört dem ersten Eintrag
        const entry = entryFromBegin(event, withSnapshot);
        if (!entry || entry.user.id !== filter.userId) return;
        if (filter.entity && entry.entity !== filter.entity) return;
        if (filter.since && !(Date.parse(entry.time) >= filter.since)) return;
        pending.set(entry.id, entry);
        if (pending.size > limit + LIST_MAX_OPEN) pending.delete(pending.keys().next().value!);
      } else if (event.phase === 'end') {
        const entry = pending.get(event.id);
        if (!entry) return;
        pending.delete(event.id);
        applyEnd(entry, event, withSnapshot);
        if (!wanted(entry)) return;
        finished.set(entry.id, entry);
        if (finished.size > limit) {
          // Der älteste kann nicht mehr unter den neuesten `limit` Einträgen sein
          let oldest = entry;
          for (const candidate of finished.values()) if (candidate.time < oldest.time) oldest = candidate;
          finished.delete(oldest.id);
        }
      } else if (event.phase === 'undone') {
        const entry = finished.get(event.id);
        if (entry) entry.undoneBy = text(event.by);
      }
    });

    const all = [...finished.values(), ...[...pending.values()].filter(wanted)];
    all.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    return all.slice(0, limit);
  }

  /** Eine Änderung mit vollständigem Vorher-/Nachher-Stand – nur, wenn sie dem angegebenen Nutzer gehört. */
  async get(id: string, userId: string): Promise<ChangeEntry | undefined> {
    if (!CHANGE_ID_PATTERN.test(id)) return undefined;
    let entry: ChangeEntry | undefined;
    let ended = false;
    await this.#scan(
      (event) => {
        if (event.id !== id) return;
        if (event.phase === 'begin') {
          entry ??= entryFromBegin(event, true);
        } else if (!entry) {
          return;
        } else if (event.phase === 'end' && !ended) {
          applyEnd(entry, event, true);
          ended = true;
        } else if (event.phase === 'undone') {
          entry.undoneBy = text(event.by);
        }
      },
      (line) => line.includes(id),
    );
    return entry && entry.user.id === userId ? entry : undefined;
  }

  /** Löscht Monatsdateien, die vollständig älter als die Aufbewahrungsfrist sind. */
  async prune(): Promise<void> {
    if (this.#retentionDays <= 0) return;
    const cutoff = this.#now().getTime() - this.#retentionDays * DAY_MS;
    for (const name of await this.#files()) {
      const match = FILE_PATTERN.exec(name)!;
      const endOfMonth = Date.UTC(Number(match[1]), Number(match[2]), 1); // erster Tag des Folgemonats
      if (endOfMonth <= cutoff) await rm(join(this.dir, name), { force: true });
    }
    await this.#measure();
  }
}
