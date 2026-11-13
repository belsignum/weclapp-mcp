/**
 * Änderungsprotokoll: jede Schreibaktion wird VOR der Ausführung protokolliert
 * (phase "begin") und danach mit dem Ergebnis ergänzt (phase "end").
 *
 * Format: JSON Lines, eine Datei pro Monat (YYYY-MM.jsonl), nur anhängend.
 * Der weclapp-Token wird nie protokolliert.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
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
const DAY_MS = 86_400_000;
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

export class AuditLog {
  readonly dir: string;
  readonly #retentionDays: number;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #pruneTimer: NodeJS.Timeout | undefined;

  private constructor(dir: string, retentionDays: number, now: () => Date) {
    this.dir = dir;
    this.#retentionDays = retentionDays;
    this.#now = now;
  }

  /** Legt das Verzeichnis an, prüft die Schreibbarkeit und räumt alte Monatsdateien auf. */
  static async open(dir: string, options: { retentionDays?: number; now?: () => Date } = {}): Promise<AuditLog> {
    const log = new AuditLog(dir, options.retentionDays ?? 365, options.now ?? (() => new Date()));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    await log.#append(log.#now(), ''); // schlägt hier fehl, wenn das Verzeichnis nicht beschreibbar ist
    await log.prune();
    log.#pruneTimer = setInterval(() => void log.prune().catch(() => {}), DAY_MS);
    log.#pruneTimer.unref();
    return log;
  }

  close(): void {
    clearInterval(this.#pruneTimer);
  }

  #append(time: Date, line: string): Promise<void> {
    const file = join(this.dir, monthFile(time));
    const write = this.#queue.then(() => appendFile(file, line, { mode: 0o600 }));
    this.#queue = write.catch(() => {});
    return write;
  }

  #event(phase: string, id: string, data: object): Promise<void> {
    const time = this.#now();
    return this.#append(time, `${JSON.stringify({ v: 1, phase, id, time: time.toISOString(), ...data })}\n`);
  }

  /** Protokolliert eine bevorstehende Änderung. Schlägt das fehl, darf die Änderung nicht ausgeführt werden. */
  async begin(input: BeginInput): Promise<string> {
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

  /** Liest alle Einträge und führt begin/end/undone je Änderung zusammen. */
  async #readAll(): Promise<Map<string, ChangeEntry>> {
    await this.#queue;
    const entries = new Map<string, ChangeEntry>();
    for (const name of await this.#files()) {
      const text = await readFile(join(this.dir, name), 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        let event: Record<string, any>;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // beschädigte Zeile überspringen
        }
        if (typeof event?.id !== 'string' || !CHANGE_ID_PATTERN.test(event.id)) continue;
        if (event.phase === 'begin') {
          if (typeof event.user?.id !== 'string') continue;
          entries.set(event.id, {
            id: event.id,
            time: event.time,
            user: { id: event.user.id, name: String(event.user.name ?? '') },
            tool: String(event.tool),
            kind: event.kind,
            entity: String(event.entity),
            entityId: event.entityId,
            status: 'pending',
            before: event.before,
            versionBefore: event.versionBefore,
            undoes: event.undoes,
            truncated: event.truncated,
          });
          continue;
        }
        const entry = entries.get(event.id);
        if (!entry) continue;
        if (event.phase === 'end') {
          entry.status = event.status === 'done' ? 'done' : 'failed';
          entry.entityId = event.entityId ?? entry.entityId;
          entry.after = event.after;
          entry.versionAfter = event.versionAfter;
          entry.error = event.error;
          entry.truncated = entry.truncated || event.truncated;
        } else if (event.phase === 'undone') {
          entry.undoneBy = event.by;
        }
      }
    }
    return entries;
  }

  /** Änderungen eines Nutzers, neueste zuerst. */
  async list(filter: ListFilter): Promise<ChangeEntry[]> {
    const all = [...(await this.#readAll()).values()].filter(
      (e) =>
        e.user.id === filter.userId &&
        (!filter.entity || e.entity === filter.entity) &&
        (!filter.entityId || e.entityId === filter.entityId) &&
        (!filter.since || Date.parse(e.time) >= filter.since),
    );
    all.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    return all.slice(0, filter.limit ?? 25);
  }

  /** Eine Änderung – nur, wenn sie dem angegebenen Nutzer gehört. */
  async get(id: string, userId: string): Promise<ChangeEntry | undefined> {
    if (!CHANGE_ID_PATTERN.test(id)) return undefined;
    const entry = (await this.#readAll()).get(id);
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
  }
}
